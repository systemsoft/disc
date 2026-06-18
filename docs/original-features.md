# Disc-Original Features

Features Disc has that Gel doesn't — the deliberate departures that justify Disc as a fork rather than a port. All eight are shipped and live in the codebase; each entry below describes current behavior and points at the source and reference docs.

---

## 1. Codegen-free TypeScript query builder

Reference: `sdk/README.md`. Source: `sdk/query-builder.ts`, `sdk/schema-types.ts`.

Gel's TypeScript client requires running `npx @gel/generate edgeql-js` after every schema change to regenerate a typed query builder that must be checked in and kept in sync. Disc's query builder is a runtime module: it reads a schema declaration and returns a structurally-typed builder, so schema changes flow through with no rebuild step.

```typescript
import {
  createClient,
  createQueryBuilder,
  defineSchema,
  t
} from "jsr:@disc/db/sdk";

const schema = defineSchema({
  User: {
    email: t.str(),
    name: t.str(),
    bio: t.optional(t.str()),
    posts: t.multi("Post")
  },
  Post: {
    title: t.str(),
    body: t.str(),
    author: t.single("User")
  }
});

const client = createClient();
const qb = createQueryBuilder(client, schema);

// Fully typed: rows is { email: string; posts: { title: string }[] }[]
const users = await qb
  .User
  .select({
    email: true,
    posts: { title: true }
  })
  .filter(u => u.email.eq("user@example.com"));
```

The `t` namespace covers all primary scalars (`str`, `bool`, `int16/32/64`, `float32/64`, `bigint`, `datetime`, `bytes`, `uuid`, `json`), `t.optional(inner)` for nullable wrappers, and `t.single(target)` / `t.multi(target)` for links. The typed `createQueryBuilder<S>(client, schema)` overload narrows every chain method: `select<Sh>(shape)` returns a chain whose awaited row type is computed from the shape, and `filter` / `orderBy` predicates get typed FieldRefs so `u.email.eq(...)` only accepts `string`.

Schema-of-record stays in `.disc` SDL — that is what the server applies and what `disc migrate` diffs. The TypeScript schema passed to `defineSchema()` is a thin re-declaration, either hand-written or generated once by `disc codegen` and committed. There is no codegen step on every change.

The runtime DSL is a Proxy plus an EdgeQL string emitter; the type machinery is `defineSchema()` markers plus recursive mapped types in `ResolveSelected` / `SelectShape` / `TypedSelectChain`.

---

## 2. Schema-derived REST surface (auto-generated)

Reference: `docs/rest-api.md`. Source: `server/rest/router.ts`, `server/rest/openapi.ts`.

Gel exposes EdgeQL over HTTP and GraphQL via `ext::graphql`, but generates no conventional REST surface. Many integrations (n8n, Zapier, locked-down mobile clients, anything that wants OpenAPI) assume REST. Disc auto-generates a REST surface from the schema, runs it through the same access-policy and auth pipeline as EdgeQL queries, and emits a matching OpenAPI 3.1 spec.

| Method   | Path                 | Behavior                              |
| -------- | -------------------- | ------------------------------------- |
| `GET`    | `/api/T`             | List with filter / order / pagination |
| `GET`    | `/api/T/{id}`        | Single object by id (`uuid`)          |
| `POST`   | `/api/T`             | Insert                                |
| `PATCH`  | `/api/T/{id}`        | Partial update                        |
| `DELETE` | `/api/T/{id}`        | Delete (idempotent: 204 either way)   |
| `GET`    | `/api/T/{id}/{link}` | Linked collection                     |
| `GET`    | `/api/openapi.json`  | OpenAPI 3.1 spec for the surface      |

SDL annotations gate which fields appear in default shapes:

```
type User {
  required email: str { annotation rest::hidden; };
  required name: str;
  multi posts: Post { annotation rest::expand; };
}
```

Properties annotated `rest::hidden` are excluded from default shapes; links annotated `rest::expand` are inlined (recursively, using the target type's own default REST shape) instead of requiring a follow-up request.

The compiler already generates SQL for arbitrary EdgeQL, so the REST handlers are a thin `route → EdgeQL string → existing pipeline` layer; the substantive work is the OpenAPI generator and the SDL annotation grammar.

---

## 3. Visual differentiators in the admin UI

The admin UI (`docs/admin-ui.md`) covers schema browser, data viewer, query editor, and REPL — matching Gel-UI feature-for-feature. The features below are ones Gel-UI does **not** have.

### 3a. Live schema diff

Reference: `docs/admin-ui.md` ("Diff"). Source: `server/admin/schema-{diff,watch,apply}.ts`, `ui/src/routes/diff/+page.svelte`.

Watches `.disc` files in real time and shows the unsaved-but-edited schema next to the currently applied schema as a visual diff (added types in green, removed in red, modified with side-by-side property lists). An "apply" button generates and runs the migration in-line. The watcher's events are streamed over SSE at `/admin/schema-watch`; `POST /admin/schema-apply` runs through `SchemaManager.applySchema()` — the same engine path the CLI's `disc migrate` uses — so the unsafe/ambiguous-op gate composes for free (it primes the applied-schema baseline first so drops aren't misread as additive).

Gel-UI shows applied schema only; you switch to your editor and CLI to make changes.

### 3b. Visual query builder

Reference: `docs/admin-ui.md` ("Builder"). Source: `ui/src/lib/query-builder-synth.ts` (pure EdgeQL synthesizer), `ui/src/routes/query-builder/+page.svelte`.

Pick a root type, check the fields and links to include, add filter rows (field + operator + value, auto-typed by the field's SDL scalar), and set order / limit / offset. The synthesized EdgeQL renders live in a side pane; Run sends it through the same `/query` endpoint as the text editor. The pure `synthesize()` core is decoupled from the form layout.

Gel-UI has a text editor with autocomplete and no visual builder.

### 3c. Live data subscriptions in the browser

Reference: `docs/admin-ui.md` ("Data" → "Live Mode"). Source: `server/admin/data-watch{,-ddl,-registry}.ts`, `ui/src/lib/stores/live-query.ts`, `ui/src/routes/data/+page.svelte`.

Query results update in real time when underlying rows change. The data viewer's "Live" toggle subscribes to `/admin/data-watch?tables=…`; the SSE endpoint emits an `invalidate` event for the affected tables and the client refetches via the standard `/query` pipeline. The pattern is **invalidate-then-refetch** (à la SWR / React Query) — the server says _what_ changed, the client re-runs the query, so access policies, read-only mode, and auth all compose for free.

Server-side, an idempotent `bootstrapDataWatch()` writes a `disc_change_log` table and a `disc_log_change()` PL/pgSQL function, and attaches `AFTER INSERT/UPDATE/DELETE … FOR EACH STATEMENT` triggers to every Disc-managed table. A polling `DataWatchRegistry` reads the log on a 250 ms cadence and fans invalidations to subscribers whose interested-tables set intersects the affected set, with a per-subscriber 250 ms debounce that coalesces bursts. Client-side, the data viewer pulses a green border around the rows pane on each invalidate and re-runs `loadRows()`; the reusable `liveQuery({ edgeql, tables })` Svelte store wraps the same pattern for ad-hoc subscriptions in custom routes.

Gel has subscriptions in the SDK but Gel-UI doesn't surface them.

### 3d. Identity-disc visualization

Reference: `docs/admin-ui.md` ("Disc"). Source: `ui/src/lib/identity-disc-layout.ts` (pure SVG geometry), `ui/src/routes/disc/+page.svelte`.

The identity-disc metaphor taken literally: a row's outgoing links and incoming references are rendered as a disc — the object at the center, link types as luminous radii, linked objects orbiting. Clicking an orbital recenters on that object; a breadcrumb tracks recent centers. Outgoing data comes from one query expanding every link's `id` plus a display field; incoming data comes from a schema-walk for every type that links to the centered type, then a parallel forward-filter query per (sourceType, linkName) pair.

The disc splits into two arcs: outgoing fills 30°–150° on the right semicircle, incoming fills 210°–330° on the left, so the visual half-plane unambiguously reads "things I link to" vs "things that link to me". Multi-link clusters (e.g. 12 posts) collapse to a single orbital with a `+11` count badge.

---

## 4. Single-binary distribution (server + UI + Postgres)

Reference: `docs/cli.md` (`disc build`). Source: `postgres/embedded-pg.ts`, `server/ui-asset-manifest.ts`, `server/ui-assets.ts`.

Self-hosting Gel means installing the Gel server, installing PostgreSQL separately (or using a managed one), pointing Gel at it, and installing Gel-UI separately for the admin UI. Disc ships **one binary** that contains the Disc server (via `deno compile`), the compiled SvelteKit UI as embedded assets, and the PostgreSQL binary for the target platform. Running `./disc` on a fresh machine gives a working database server with admin UI on `:5656` and no installation steps — like Caddy, SQLite, or Tailscale's `tailscaled`.

`deno compile --include` embeds both the SvelteKit `ui/build/` directory and the cached PostgreSQL distribution. At runtime:

- `/ui` is served from the embedded asset manifest (`server/ui-asset-manifest.ts` + `server/ui-assets.ts`); `index.html` falls back for SPA routes.
- `postgres/embedded-pg.ts` extracts PG to `<DISC_HOME>/embedded-postgres/<version>/` on first start (idempotent via a marker file). After extraction, the existing `PostgresInstance.pgBinDir` plumbing skips the network downloader.

Design decisions:

- **Extract-on-first-run** rather than running PG from a virtual filesystem — PG is a native binary that needs a real on-disk `fd` to fork from.
- **Manifest auto-regenerated at build time** (`cli/build.ts:refreshEmbeddedPgManifest`) — the repo ships an empty default; running `disc build` rewrites the manifest in place from the build machine's local PG cache. The regenerated manifest is not committed, because its `file://` URLs are absolute paths from the build machine.
- **Opt-out via `DISC_BUILD_NO_BUNDLE_PG=1`** for size-conscious headless builds — falls back to the network downloader at runtime.

Binary size (darwin-arm64): ~83 MB (UI only) → ~217 MB (UI + PG distribution).

Cross-platform builds remain limited: the build machine's PG cache only holds its own platform, so reproducible all-platform builds from one runner would need a `dist/embedded-pg/<platform>/` staging step.

---

## 5. Deno-permission-aware access policies

Reference: `access/README.md` ("`runtime::has_permission(...)`"). Source: `access/runtime-permissions.ts` (pure spec parser + checker), the `runtime::has_permission` cases in `access/evaluator.ts`.

Database access policies (Gel's `access policy`, Postgres's RLS) gate row visibility on application-defined identity but can't see runtime trust: code running with full filesystem access gets the same treatment as sandboxed code. Because Disc runs on Deno, every running piece of code already has a runtime permission set, and access policies can reference it:

```
type SecretConfig {
  required value: str;
  access policy admin_only allow select using (
    global current_user.is_admin
    and runtime::has_permission("read:secrets")
  );
}
```

`runtime::has_permission(<spec>)` is a builtin in the access-policy evaluator. The spec string is parsed at policy-load time into a `Deno.PermissionDescriptor`-shaped object, so SDL typos like `runtime::has_permission("filesystem")` fail loudly rather than silently denying. At SQL emission time the function is pre-evaluated against `Deno.permissions.querySync(...)` and inlined as `TRUE`/`FALSE` in the generated WHERE clause — Postgres can't call back into Deno, and the permission set is fixed for the life of the process. It composes with existing policies through the standard AND combinator, giving a defense-in-depth layer for the case where application code is compromised but the runtime sandbox is not.

Disc's extensions are currently TS modules that share the server's permission set, so the check is effectively a deployment-time gate. If Disc later grows worker-based extensions, a per-worker permission set can be threaded through `AccessContext.permissionChecker` without touching the SDL grammar.

Gel has application-level identity only; its Python/Rust runtime has no structured permission model to check against.
