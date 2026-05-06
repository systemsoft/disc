# Disc-Original Features

Things Disc would build that Gel doesn't have and isn't planning. Each is a deliberate departure — features that justify Disc as a fork rather than a port.

> **Status:** Mixed. **Shipped: #4 single-binary distribution** (Bundle I, 2026-05-06), **#2 schema-derived REST surface** (Bundle J, 2026-05-06), **#3a live schema diff in admin UI** (Bundle K, 2026-05-06), **#3c live data subscriptions in admin UI** (Bundle L, 2026-05-06), and **#1 codegen-free TypeScript query builder** (Bundle M, 2026-05-06). The remaining items (3b/3d UI differentiators, #5 Deno-perm policies) are proposals — rough scoping but no design doc, no scheduled milestone. Use this as the seed list for picking next-up direction once the upstream-parity work is done (see `future-triage.md`).

---

## 1. Codegen-free TypeScript query builder — **SHIPPED 2026-05-06**

> **Status:** Shipped in Bundle M. Live behavior is documented in `sdk/README.md` and the source lives at `sdk/query-builder.ts` + `sdk/schema-types.ts`. The doc below is preserved as historical context; the shipped design diverges from the original sketch in two ways noted at the bottom.

**The problem.** Gel's TypeScript client requires running `npx @gel/generate edgeql-js` after every schema change to produce a typed query builder. The generated module is a build artifact: it needs to be checked in, regenerated, kept in sync. In a Deno-native stack this is friction that doesn't need to exist.

**The bet.** Because Disc is TypeScript end-to-end and runs on Deno (which compiles TS at import time), the query builder can be a runtime module that reads the live schema and returns a structurally-typed builder. No codegen-on-every-change. Schema changes flow through with no rebuild.

**How it shipped.**

```typescript
import { createClient, createQueryBuilder, defineSchema, t } from "jsr:@disc/db/sdk";

const schema = defineSchema({
  User: {
    email: t.str(),
    name: t.str(),
    bio: t.optional(t.str()),
    posts: t.multi("Post"),
  },
  Post: {
    title: t.str(),
    body: t.str(),
    author: t.single("User"),
  },
});

const client = createClient();
const qb = createQueryBuilder(client, schema);

// Fully typed: rows is { email: string; posts: { title: string }[] }[]
const users = await qb.User.select({
  email: true,
  posts: { title: true },
}).filter((u) => u.email.eq("user@example.com"));
```

The `t` namespace covers all primary scalars (`str`, `bool`, `int16/32/64`, `float32/64`, `bigint`, `datetime`, `bytes`, `uuid`, `json`), `t.optional(inner)` for nullable wrappers, and `t.single(target)` / `t.multi(target)` for links. The typed `createQueryBuilder<S>(client, schema)` overload narrows every chain method: `select<Sh>(shape)` returns a chain whose awaited row type is computed from the shape, and `filter`/`orderBy` predicates get typed FieldRefs so `u.email.eq(...)` only accepts `string`.

**What Gel has instead.** A `@gel/generate` codegen package that emits a static `./dbschema/edgeql-js/` directory.

**Two divergences from the original sketch.**

1. **No `import "./schema.disc" with { type: "disc-schema" }` import.** That syntax depends on a Deno custom-MIME loader that doesn't exist in stable Deno. Schema-of-record stays in `.disc` (the SDL is what the server applies and what `disc migrate` diffs); the TS file is a thin re-declaration — either hand-written or generated once by `disc codegen` and committed. Either way, no codegen step on every change.
2. **Phase 3 dropped — no template-literal SDL parsing.** The original "type the schema straight from the SDL string" idea hits TS recursion limits on real schemas, balloons compile times, and produces inscrutable error messages. The marker-based `defineSchema()` approach delivers full inference without the type-system fragility.

**Effort.** L (as predicted). The type-level work was the hard part — the runtime DSL is a Proxy + EdgeQL string emitter (~270 LOC); the type machinery is `defineSchema()` markers + recursive mapped types in `ResolveSelected` / `SelectShape` / `TypedSelectChain`.

---

## 2. Schema-derived REST surface (auto-generated) — **SHIPPED 2026-05-06**

> **Status:** Shipped in Bundle J. Live behavior is documented in `docs/rest-api.md` (`server/rest/router.ts`, `server/rest/openapi.ts`). The doc below is preserved as historical context.

**The problem.** Gel exposes EdgeQL over HTTP and GraphQL via `ext::graphql`, but it doesn't generate a conventional REST surface. Many integrations (n8n, Zapier, mobile apps with locked-down clients, anything that wants OpenAPI) assume REST.

**The bet.** Every object type in a Disc schema has obvious REST mappings:

- `GET /api/User` → list with filter/order/limit query params
- `GET /api/User/:id` → single object
- `POST /api/User` → insert
- `PATCH /api/User/:id` → update
- `DELETE /api/User/:id` → delete
- `GET /api/User/:id/posts` → linked collection

Disc auto-generates these from the schema, runs them through the same access-policy and auth pipeline as EdgeQL queries, and emits a matching OpenAPI spec at `/api/openapi.json`.

**Customization.** SDL annotations gate which types are exposed and which fields are returned in default shapes:

```
type User {
  required email: str { @rest::hidden };
  required name: str;
  multi posts: Post { @rest::expand };
}
```

**What Gel has instead.** GraphQL via extension. EdgeQL over HTTP for raw queries. No OpenAPI emission, no REST conventions.

**Effort.** M. The compiler already generates SQL for arbitrary EdgeQL — REST handlers are a thin layer of `route → EdgeQL string → existing pipeline`. The hard part is the OpenAPI generator and the SDL annotation grammar.

---

## 3. Visual differentiators in the admin UI (TRON-themed, Gel-UI doesn't have them)

The existing admin UI plan in `docs/admin-ui.md` already covers schema browser, data viewer, query editor, and REPL. These match Gel-UI feature-for-feature. The bets here are features Gel-UI does **not** have:

### 3a. Live schema diff — **SHIPPED 2026-05-06**

> **Status:** Shipped in Bundle K. Live behavior is documented in `docs/admin-ui.md` ("Live Schema Diff" section) and the source lives under `server/admin/schema-{diff,watch,apply}.ts` + `ui/src/routes/admin/schema/+page.svelte`.

Watch `.disc` files in real time. Show the unsaved-but-edited schema next to the current applied schema, with a visual diff (added types in green grid, removed in red, modified with side-by-side property lists). Click "apply" to generate and run the migration in-line.

Gel-UI shows applied schema only; you switch to your editor and CLI to make changes. Disc routes the watcher's events through SSE at `/admin/schema-watch` and exposes `POST /admin/schema-apply` which runs through the standard `MigrationEngine` so the lock-timeout pragma, advisory-lock serialization, and unsafe/ambiguous-op gate compose for free.

### 3b. Visual query builder (drag-and-drop, not autocomplete)

Drag types onto a canvas, drop fields into a result shape, draw filters as visual nodes. Generate EdgeQL underneath. The point isn't to replace text EdgeQL — it's to teach EdgeQL to people who don't know it yet, and to let non-developers build read-only queries for dashboards.

Gel-UI has a text editor with autocomplete. No visual builder.

### 3c. Live data subscriptions in the browser — **SHIPPED 2026-05-06**

> **Status:** Shipped in Bundle L. Live behavior is documented in `docs/admin-ui.md` ("Live Data Subscriptions" section); source lives under `server/admin/data-watch{,-ddl,-registry}.ts` + `ui/src/lib/stores/live-query.ts` + `ui/src/routes/data/+page.svelte`.

Query results update in real time when underlying rows change. The data viewer's "Live" toggle subscribes to `/admin/data-watch?tables=…`; the SSE endpoint emits an `invalidate` event for the affected tables and the client refetches via the standard `/query` pipeline. The pattern is **invalidate-then-refetch** (à la SWR / React Query) — server says *what* changed, client re-runs the query so access policies + read-only mode + auth gate compose for free.

Server-side: an idempotent `bootstrapDataWatch()` writes a `disc_change_log` table + `disc_log_change()` PL/pgSQL function and attaches `AFTER INSERT/UPDATE/DELETE … FOR EACH STATEMENT` triggers to every Disc-managed table. A polling `DataWatchRegistry` reads the log on a 250 ms cadence and fans invalidations to subscribers whose interested-tables set intersects the affected set, with a per-subscriber 250 ms debounce that coalesces bursts.

Client-side: the data viewer pulses a green border around the rows pane on each invalidate (TRON aesthetic) and re-runs `loadRows()`. The reusable `liveQuery({ edgeql, tables })` Svelte store wraps the same pattern for ad-hoc query subscriptions in custom routes.

Gel has subscriptions in the SDK but Gel-UI doesn't surface them.

### 3d. Identity-disc visualization

The TRON metaphor taken seriously: a visualization of an object's outgoing and incoming links rendered as a literal disc — the object at the center, link types as luminous radii, linked objects orbiting. Click a linked object to recenter on it. This is closer to a graph database UI than a relational one, but the data is already there in Disc's schema.

**Effort.** M each, parallelizable. 3a depends on a server endpoint that streams schema-diff events. 3c depends on the existing live-query plumbing. 3d is mostly Svelte + a graph layout library; no backend work.

---

## 4. Single-binary distribution (server + UI + Postgres) — **SHIPPED 2026-05-06**

> **Status:** Shipped in Bundle I (commits [`fcebdb1`](../) UI embedding, Phase 2 PG embedding). The doc below is preserved as historical context; live behavior is documented in `docs/cli.md` (`disc build`) and `postgres/embedded-pg.ts`.

**The problem.** Self-hosting Gel involves: install Gel server, install PostgreSQL separately (or use a managed one), point Gel at it, install Gel-UI separately if you want the admin UI, configure all three to talk to each other.

**The bet.** Disc ships **one binary** that contains:

- The Disc server (already built via `deno compile`)
- The compiled SvelteKit UI as embedded assets
- The PostgreSQL binary for the target platform

Running `./disc` on a fresh machine gives you a fully working database server with admin UI on `:3000`, no installation steps. Like Caddy. Like SQLite. Like Tailscale's `tailscaled`.

**How it shipped.** `deno compile --include` embeds both the SvelteKit `ui/build/` directory and the cached PostgreSQL distribution under `<DISC_HOME>/postgres/<version>/`. At runtime:

- `/ui` is served from the embedded asset manifest (`server/ui-asset-manifest.ts` + `server/ui-assets.ts`); `index.html` falls back for SPA routes.
- `postgres/embedded-pg.ts` extracts PG to `<DISC_HOME>/embedded-postgres/<version>/` on first start (idempotent via marker file). After extraction, the existing `PostgresInstance.pgBinDir` plumbing skips the network downloader.

**Trade-offs documented as decisions.**

- **Extract-on-first-run** rather than running PG from a virtual fs — PG is a native binary that needs a real `fd → on-disk` to fork from.
- **Manifest auto-regenerated at build time** (`cli/build.ts:refreshEmbeddedPgManifest`) — the repo ships an empty default; running `disc build` rewrites the manifest in place from the build machine's local PG cache. Don't commit a regenerated manifest; the `file://` URLs are abs paths from the build machine.
- **Opt-out via `DISC_BUILD_NO_BUNDLE_PG=1`** for size-conscious headless builds — falls back to the network downloader at runtime.

**Binary size (darwin-arm64):** ~83 MB (UI only) → ~217 MB (UI + PG distribution).

**Open follow-ups.** Reproducible cross-platform builds (the build machine's PG cache only has its own platform); a `dist/embedded-pg/<platform>/` staging step would let CI build all four platforms from one runner. Tracked in the ledger.

---

## 5. Deno-permission-aware access policies

**The problem.** Database access policies (Gel's `access policy`, Postgres's RLS) gate row visibility based on application-defined identity. They can't see runtime trust: an extension running with full filesystem access has the same access-policy treatment as one running sandboxed.

**The bet.** Because Disc runs on Deno, every running piece of code already has a runtime permission set (`--allow-net`, `--allow-read=...`, etc.). Access policies can reference these permissions:

```
type SecretConfig {
  required value: str;
  access policy admin_only allow select using (
    global current_user.is_admin
    and runtime::has_permission("read:secrets")
  );
}
```

The `runtime::has_permission(...)` builtin is true only if the calling Deno worker was launched with the corresponding `--allow-*` flag. An extension that accidentally tries to read `SecretConfig` without the right permissions gets an empty result — even if the application-level user is an admin.

This composes with existing access policies. It's a defense-in-depth layer for the case where application code is compromised but the runtime sandbox is not.

**What Gel has instead.** Application-level identity only. No runtime-permission check, because the Python/Rust runtime doesn't have a structured permission model.

**Effort.** M. Need: a `runtime::has_permission()` builtin in the access-policy evaluator, a way to propagate the calling worker's permission set into the query session, and SDL grammar for the new function. The composability is the interesting part — applies to existing access policies without redesign.

---

## How these get picked

Each item is independently scopeable. The natural ordering by **how much it justifies Disc-as-a-fork**:

1. ~~**#4 single-binary** — biggest UX delta for self-hosters, smallest engineering cost.~~ **Shipped 2026-05-06.**
2. ~~**#2 REST surface** — broadest integration story, modest cost.~~ **Shipped 2026-05-06.**
3. ~~**#1 codegen-free builder** — biggest DX delta for application developers, but most type-system work.~~ **Shipped 2026-05-06.**
4. **#3 admin-UI differentiators** — best demo material; can be staged 3a → 3c → 3d → 3b. ~~**3a (live schema diff) shipped 2026-05-06.**~~ ~~**3c (live data subscriptions) shipped 2026-05-06.**~~ Remaining: 3b visual query builder, 3d identity-disc visualization.
5. **#5 Deno-perm policies** — most novel, narrowest applicability.

When `future-triage.md`'s BUILD column runs out (or sooner if one of these is more compelling than what's left upstream), pick from here.
