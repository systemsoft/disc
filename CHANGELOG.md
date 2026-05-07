# Changelog

All notable changes to Disc are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com), and the project uses
[ChronVer](https://chronver.org) (`YYYY.MM.DD`) versioning.

Sections per release: **Added** (new features), **Changed**
(behavior changes that aren't fixes), **Fixed** (bug fixes),
**Removed** (deletions), **Security** (vulnerability/posture
changes), **Docs** (docs-only changes), and **Internal** (refactors
not user-visible). New entries land under `## [Unreleased]` and are
moved into a dated `## vYYYY.MM.DD — short-summary` block when a
tag is cut.

## [Unreleased]

### Fixed

- **Bulletproof CTA buttons in auth emails** (gh/geldata#7629). Outlook
  on Windows renders HTML through Word, which silently drops
  `display: inline-block` and `padding` on `<a>`. The previous
  inline-anchor button collapsed to plain underlined text on the page
  background — when the brand color was the only fill providing
  contrast against the white text, the result was visually invisible.
  Each button-bearing template (verification, password reset, magic
  link) now wraps the anchor in a single-cell `<table>` carrying the
  background via the legacy `bgcolor` attribute and `mso-padding-alt`
  so the cell itself is clickable in Outlook even when the inner
  anchor's padding is dropped. The magic-code badge had the same
  white-on-white bug class and uses the same pattern. Modern clients
  still see the inline-block styling on the anchor, so no regression.

### Added

- **Embedded EdgeQL diagnostics in TS/JS files** (LSP Phase 5). The
  language server now scans `.ts/.tsx/.js/.jsx/.mts/.mjs/.cts/.cjs`
  files for tagged template literals tagged with `eql` and runs each
  one through the EdgeQL parser. Parse errors map back to the host
  file's coordinates and surface as standard LSP diagnostics with the
  `disc-eql` source — squiggles land on the right token even when the
  embedded EdgeQL spans multiple lines. v1 limitations: matches the
  `eql` tag only (not `client.query("...")` strings — that needs a
  TS AST), skips templates with `${...}` substitutions (runtime-
  dynamic content), diagnostics-only (hover/completion inside
  embedded strings are future work). New module
  `lsp/embedded-edgeql.ts`; URI-based dispatch in `lsp/server.ts`.
- **Migration robustness pins** (gh/geldata#3208, #5132, #2910). No
  behavior change — three regression pins in
  `migration/gel-issues.test.ts` that capture Disc's structural
  divergence from upstream Gel migration bugs:
  - #3208 (Gel's `migration create` answer-resolver getting stuck) —
    Disc's migrate engine is non-interactive by design; the pin walks
    every `MigrationEngine` method and asserts none hint at
    answer/question/prompt resolution.
  - #5132 (Gel's alias drop failing on internal
    `__<aliasName>__ObjectType__annotations` bookkeeping types) — Disc
    emits aliases as no-op DDL comments; the pin asserts `DropAlias`
    emits only comments and never references the upstream bookkeeping
    types.
  - #2910 (SIGTERM mid-migration leaving Gel in a half-applied state)
    — Disc's `pg_advisory_xact_lock` releases automatically on
    connection drop and the transaction rolls back; the pin asserts
    every migration tx still acquires the advisory lock so a future
    refactor can't silently break the SIGTERM-recovery path.
- **CLI flags for instance-level security toggles** (gh/geldata#5234).
  `disc serve` now accepts `--require-auth`, `--read-only`, and
  `--trust-proxy` flags; each maps to the corresponding `DISC_*` env
  var so the existing `buildEnvOptions` pipeline threads them into
  `ServerConfig` unchanged. CLI > env var > `disc.toml` > default.
  Closes the last "(none)" cells in the docs/server.md
  CLI/env/`disc.toml` matrix.
- **Magic-link implicit signup** (gh/geldata#7311). New
  `AuthConfig.allowImplicitSignup?: boolean` (default `false`). When
  enabled, `requestMagicLink(email)` for an unknown email persists the
  token in a new `magic_link_signup_tokens` table; `consumeMagicLink`
  creates the user (active, `email_verified=true`) and completes login
  on first redemption. Default-off preserves the existing
  anti-enumeration semantics. New `MagicLinkSignupRequested` webhook
  event (carries `pendingEmail` + `magicLinkToken`) for email senders
  that need to deliver to a not-yet-existing identity.
- **WebAuthn discoverable credentials** (gh/geldata#7196).
  `beginWebAuthnRegistration` now emits `authenticatorSelection:
  { residentKey: "preferred", userVerification: "preferred" }` so
  passkey-capable authenticators store user-handle metadata locally —
  future logins can start without the user typing their email first.
  New `WebAuthnConfig.requireResidentKey?: boolean` upgrades to
  `"required"` for security-sensitive deployments. Login already
  supported the discoverable-credential path; this only changes
  registration.
- **Deno-permission-aware access policies** (Disc-original feature #5
  from `docs/disc-original-features.md`). Access policies can now gate
  on the running Deno process's `--allow-*` permission set as a
  defense-in-depth layer — even an authorized application user gets an
  empty result if the runtime sandbox doesn't have the corresponding
  permission. New builtin `runtime::has_permission(<spec>)` accepts
  `read` / `read:/path`, `write` / `write:/path`, `net` / `net:host`
  (with optional `:port`), `env` / `env:VAR`, `run` / `run:cmd`, `sys`
  / `sys:KIND`, `ffi` / `ffi:/path`. Strict — unknown names and empty
  scopes throw at policy-load time so SDL typos fail fast rather than
  silently always-denying. The check is process-local: at SQL-emission
  time the function is pre-evaluated against `Deno.permissions
  .querySync(...)` and inlined as `TRUE`/`FALSE` in the generated
  WHERE clause. `AccessContext.permissionChecker` is the test seam.
  Closes the entire Disc-original-features roadmap.
- **Identity-disc visualization** (Disc-original feature #3d from
  `docs/disc-original-features.md`). New SvelteKit page at `/ui/disc`
  renders a row's outgoing links and incoming references as a literal
  disc — the centered object at the middle, links radiating outward
  as luminous radii, linked objects orbiting at the rim. Outgoing
  fills the right semicircle (30°–150° arc), incoming fills the left
  (210°–330°). Click any orbital to recenter on that object;
  breadcrumb tracks recent centers so navigation is reversible.
  Outgoing data comes from one query expanding every link; incoming
  data comes from a schema-walk for every type that links to the
  centered type, then a forward-filter query per (sourceType,
  linkName) pair. Multi-link clusters collapse to a single orbital
  with a `+N` count badge. Gel has no equivalent.
- **Visual query builder** (Disc-original feature #3b from
  `docs/disc-original-features.md`). New SvelteKit page at
  `/ui/query-builder` lets users pick a root type, check fields and
  links to include in the result shape, add filter rows (field +
  operator + value, auto-typed by the field's SDL scalar), set
  order/limit/offset. The synthesized EdgeQL renders live in a side
  pane with TRON-aesthetic glow; hitting Run sends it through the
  same `/query` endpoint as the text editor so access policies,
  read-only mode, and the auth gate compose for free. Filter values
  are parameterized as `$p0`, `$p1`, … with per-field type coercion.
  Form-based UX rather than canvas drag-and-drop — same educational
  value, much cheaper to build. Pure `synthesize()` core decoupled
  from the form, so a canvas overlay remains a future option.
- **Codegen-free TypeScript query builder** (Disc-original feature #1
  from `docs/disc-original-features.md`). New SDK module
  `sdk/query-builder.ts` ships a runtime EdgeQL emitter:
  `from(typeName)` returns a chainable `SelectChain` that emits
  `{ query, variables }` via `.toEdgeQL()`. `createQueryBuilder(client)`
  returns a Proxy where `qb.User.select({...}).filter(...)` is
  awaitable and runs through the existing `client.query()` pipeline.
  Operators: `eq`/`neq`/`lt`/`lte`/`gt`/`gte`/`exists`; multiple
  `.filter()` calls AND together; top-level `and`/`or`/`not`
  combinators; `orderBy` accepts a bare FieldRef (asc default) or
  `field.desc()`; `first()` adds `limit 1` and unwraps `T[] → T |
  null`. Companion type-level surface in `sdk/schema-types.ts`:
  `defineSchema()` + `t.*` namespace (`t.str()`, `t.int64()`,
  `t.optional(t.bool())`, `t.multi("Post")`, etc.) provide full TS
  inference on the runtime DSL. Schema-aware `createQueryBuilder<S>(
  client, schema)` overload narrows `select<Sh>(shape)` to return
  rows typed by the requested shape; filter predicates get typed
  FieldRefs so `u.email.eq(...)` only accepts `string`. Circular
  schemas (User.posts → Post.author → User…) type-check cleanly:
  `FieldType` resolves links to a shallow `LinkStub = { id: string }`
  placeholder; full link expansion happens only via `ResolveSelected`
  when the user explicitly nests in `select({ posts: { title: true }
  })`. Schema-of-record stays in `.disc`; the TS file is a thin
  re-declaration (hand-written or generated once via `disc codegen`
  and committed). Either way, no codegen step on every change.
- **Live data subscriptions in the admin UI** (Disc-original feature
  #3c from `docs/disc-original-features.md`). The data viewer's new
  **Live** toggle subscribes to `GET /admin/data-watch?tables=…` and
  re-fetches the visible rows whenever the underlying PG table
  receives an `INSERT`, `UPDATE`, or `DELETE` from any client. Server
  side, `bootstrapDataWatch()` writes a `disc_change_log` table plus
  a generic `disc_log_change()` PL/pgSQL trigger function and attaches
  statement-level AFTER triggers to every Disc-managed table; a
  polling `DataWatchRegistry` (250 ms cadence) demuxes invalidations
  to subscribers whose interested-table set intersects each poll's
  affected set, with a per-subscriber 250 ms debounce that coalesces
  bursts. The pattern is invalidate-then-refetch (à la SWR / React
  Query) — the refetch goes through the same pipeline as the initial
  load, so access policies, read-only mode, and the auth gate compose
  without extra work. Reusable Svelte store at
  `$lib/stores/live-query.ts`. New config knob: `enableDataWatch`
  (defaults to `true`); opt-out via `DISC_ENABLE_DATA_WATCH=false` or
  `disc.toml` `enable_data_watch = false`. Gel has subscriptions in
  the SDK but Gel-UI doesn't surface them — Disc does.
- **Live schema diff in the admin UI** (Disc-original feature #3a
  from `docs/disc-original-features.md`). New SvelteKit page at
  `/ui/admin/schema` subscribes to a Server-Sent Events stream at
  `/admin/schema-watch` and renders the diff between the running
  server's applied schema and whatever's currently in
  `dbschema/default.disc`. The page shows added types in green,
  removed in red, modified in yellow with a per-property breakdown
  (added / removed / changed, with before → after on changes), plus
  the same three groups for links. An "Apply Migration" button
  POSTs to `/admin/schema-apply` which runs the migration through
  the existing engine — `lock_timeout` pragma, `pg_advisory_xact_lock`
  serialization, and the unsafe/ambiguous classification gate
  compose for free. Default-refuses unsafe drops and ambiguous
  type/cardinality changes; pass `?force=true` (UI checkbox) to opt
  in. Watch loop coalesces `Deno.watchFs` events through a 250ms
  debounce; SSE picked over WebSocket because the channel is
  one-way. Gel's UI shows applied schema only — Disc keeps the
  edit → diff → apply loop inside the admin UI.
- **Schema-derived REST surface** (Disc-original feature #2 from
  `docs/disc-original-features.md`). Every non-abstract object type in
  the schema gets a conventional REST surface under `/api/<TypeName>`:
  `GET` list (with filter, `__in`, `__contains`, `order_by`, `limit`,
  `offset`), `GET` single, `POST` insert, `PATCH` update, `DELETE`
  delete, and `GET /api/<Type>/<id>/<linkName>` for linked
  collections. Routes synthesize EdgeQL strings and run them through
  the standard protocol pipeline so access policies, read-only mode,
  and the auth gate compose without extra work. SDL annotations
  `rest::hidden` (suppress a property from default GET shape) and
  `rest::expand` (inline a linked collection) gate visibility.
  OpenAPI 3.1 spec emitted at `/api/openapi.json`. Disabled via
  `disc.toml` `enable_rest = false` or `DISC_ENABLE_REST=false`;
  defaults on. JSON-only bodies; unknown body fields → 400.
- **Single-binary distribution** (Disc-original feature #4 from
  `docs/disc-original-features.md`). Compiled `disc` binary now
  embeds the SvelteKit admin UI under `/ui` and the platform's
  PostgreSQL distribution. On a fresh machine `./disc start` boots
  the server, admin UI, and bundled Postgres with no install steps
  and no network round-trip. PG is extracted on first run to
  `<DISC_HOME>/embedded-postgres/<version>/` (idempotent via marker
  file) and reused on subsequent starts. Opt out with
  `DISC_BUILD_NO_BUNDLE_PG=1` for size-conscious headless builds.
  Binary size: ~83 MB (UI only) → ~217 MB (UI + PG) on darwin-arm64.
- Env-var equivalents for `DISC_SHUTDOWN_DRAIN_TIMEOUT`,
  `DISC_REQUIRE_AUTH`, `DISC_READ_ONLY`, `DISC_TRUST_PROXY`,
  `DISC_BINARY_PORT`, `DISC_BINARY_PASSWORD`, plus `DISC_TLS_*_ENV`
  indirection for environments that ship PEM material as env strings
  (Kubernetes secrets, Fly.io, Render). (gh/geldata#5234, #7563, #4547)
- Anonymous / guest identity: `loginAnonymous` + `upgradeAnonymous`
  preserving the same row id across the upgrade (gh/geldata#8750 — open
  upstream, Disc shipped).
- TOTP MFA, magic links, recovery codes, WebAuthn / passkeys (#8186,
  #6725).
- File / blob storage with content-addressed dedup
  (`lib/file-storage/`).
- LSP server through Phase 4 (diagnostics, hover, completion, go-to,
  symbols, find-references, rename) (#7411, #655).
- Schema export (`disc schema export`) and PG introspection
  (`disc schema introspect`) (#702, #7469, #3452).
- Admin CLI: `disc admin {create-superuser,set-password,assign-role,
  list-roles}` (#1129, #5383, #6454, #1119, #4209).
- Multi-database routing (`X-Database` header / `?database=` query
  string) and `disc db {wipe,dump,restore}`.
- Generic OIDC + discovery factory (#6908, #7415).
- Server-wide read-only mode at AST level (#5524).
- HTTP auth gate (`requireAuth`) with public-route allowlist (#6345).
- TLS hot-reload via drain-and-swap on cert/key file change (#4277).
- Auth lifecycle webhooks (fire-and-forget) (#7484).
- Custom error-message clause on access policies (`errmessage`)
  threaded through both parsers, INSERT/UPDATE/DELETE deny throws,
  and SQL-injector throw sites (#4095).
- Resend verification token (#6503), `register()` returns
  `identity` snapshot (#7275), PKCE trailing-`=` normalization
  (#7596).
- Scalar/enum diffing with `RecreateScalar` op + DDL guard
  (#8517, #2564), ambiguous-op classification (#1840), advisory-lock
  - `lock_timeout` pragmas on every migration tx (#6304).
- Prometheus TLS cert-expiry gauges (#6205) + danger-band pin (#5405).
- Auth branding config (`AuthBrandingConfig` — appName, logoUrl,
  brandColor with OKLCH support) flowing through email templates
  (#7938, #6731, #6732, #8028).
- OAuth profile claim normalization (`emailVerified`, `givenName`,
  `familyName`, `locale`) with permissive `email_verified` parsing
  (#7344, #8026).
- `[server]` knobs in `disc.toml` (require_auth, read_only, enable_cors,
  cors_origins, cors_allow_credentials, trust_proxy, enable_websockets,
  enable_metrics, max_request_body_bytes, request_timeout,
  rate_limit_rpm) (#1325).
- REPL `\d` describer rewrite (lists types grouped by module, full
  per-type detail) (#1218).
- `-H` short alias for `--host` matching standard Unix conventions
  (#1030).

### Docs

- **Cross-device email verification** documented in `docs/auth.md`
  (gh/geldata#7483). `verifyEmail()` looks the user up purely by hashed
  token — no IP / user-agent / session-cookie check at redemption — so
  signing up on phone and clicking the link on laptop just works.
- Performance guide (`docs/performance.md`) covering indexing, EXPLAIN,
  parse/compile/EXPLAIN caches, pool tuning, Prometheus gauges (#6126).
- Production migration documentation (`docs/migrations.md` extended
  with classification table, RecreateScalar enum-removal flow,
  5-step rollout, advisory lock semantics, CI/CD pattern) (#6096,
  #2230).
- Programmatic migrations API guide (Lifecycle Overview, connection
  injection, inspecting the diff, safe-vs-unsafe gate, embed-in-app
  reference) in `docs/migrations.md` (#6094).
- Containerized local dev / docker-compose (`docs/docker-compose.md`)
  walking through the shipped `docker-compose.yml` (#4170, #6176).
- Auth doc finishing in `docs/auth.md` (TOTP/magic-link/recovery,
  WebAuthn, anonymous, OAuth, branding, webhooks, HTTP auth gate,
  RBAC) plus admin password management section (#1021, #8421).
- Secure TLS setup in `docs/production-deployment.md` (hot-reload +
  cert-expiry gauge alerting) (#4239).
- Documented previously-undocumented config options (`docs/server.md`)
  with full `DiscServerOptions` interface, env-var/`disc.toml`
  matrix (#4787, #8273).
- EdgeQL cheat sheet (`docs/edgeql-cheatsheet.md`) — one-page
  reference of common forms (#1163).
- Error code reference (`docs/error-codes.md`) — full catalog of
  Disc error classes + GEL_ERROR_CODES numeric table (#6648).

### Security

- SCRAM string compares are constant-time via `constantTimeEqualStr`
  closing the byte-by-byte timing leak on the server-nonce portion
  (gh/geldata#9137 — open upstream, Disc shipped).
- `InternalError` carries "please file an issue" tail with idempotent
  re-wrap detection (#930).

### Pinned (already correct in Disc)

- Property-level `DROP CONSTRAINT` (#4343 — Gel `not_planned`,
  Disc divergence documented).
- Abstract-extraction idempotency (#1147 — closed-completed upstream).
- Dump/restore round-trip (#2071 — closed-completed upstream).
- User-specified IDs in migrations (#5617 — already worked via
  `id := <uuid>'…'`).
- Auto-allow `redirect_uri` against `allowedRedirectUris` (#6433).
- PKCE RFC names already used (#7026).
- Parser accepts explicit `optional`/`single` qualifiers (#4406 —
  fix shipped: previously rejected, now no-op).
- First-migration prompts are non-interactive — Disc never prompts
  on migrations regardless of operation kind (#3733, #3414).

## v2026.05.04 — Initial tagged release

The first tagged Disc release. Everything below is the cumulative
state — there are no prior tags to diff against. Future entries will
be diff-shaped.

### Highlights

- **Schema-first TypeScript-native database** running on Deno, backed
  by bundled PostgreSQL 16+. EdgeQL preserved, Python/Rust core
  replaced.
- **Gel binary protocol compatibility** — Gel's official Python and
  Node.js clients connect and run their full smoke suites against
  Disc (14/14 each).
- **Full audit closure** — 14 P0, 49 P1, 36 P2, and 8 P3 items from
  the 18-module per-module audit landed. See `thoughts/shared/audits/`
  for the original walk-through and per-module reports.

### Server

- **HTTP API**: `/query` (EdgeQL), `/auth/*`, `/schema`, `/migrations`,
  `/health{,/live,/ready}`, `/stats`, `/metrics`, `/ext/*`.
- **WebSocket subscriptions** with timeout cleanup on unsubscribe
  (P1-11), reconnect-with-replay on the SDK side.
- **Binary protocol** (port 5656) speaks Gel's wire format with TLS
  - ALPN (`edgedb-binary`); supports Python and Node Gel clients.
- **Rate limiting** at the HTTP layer applies before extension routing,
  so every endpoint including `/ext/graphql/*` is protected
  (gh/geldata#718).
- **Body-size limits** on `/query` (P1-12) and message-size limits on
  the binary protocol (P0-08).

### EdgeQL

- Lexer + parser with error recovery (`parseWithRecovery` synchronizes
  on `;` or top-level keyword) (P2-06).
- Query compilation to SQL with bare-scalar SELECT support, polymorphic
  shapes, and inheritance.
- Triple-quoted strings (P1-06).
- Semantic analyzer (721 LOC, no longer a stub) (P3-02).

### Schema

- SDL parser, validator, type checker. Cardinality combinations
  formalized (`required multi`, etc.) (P3-01).
- Triggers, annotations, computed properties, indexes — all flow from
  SDL to migration plan and PG DDL (P0-12, P0-13, P0-14).

### Migrations

- **Schema-tracked, not file-tracked.** `disc migrate` plans + applies
  in one pass — there's no separate "create the migration first"
  step (gh/geldata#3465). The `disc_migrations` DB table is the
  source of truth.
- **Forward-direction unsafe-op gate** (`--unsafe`): destructive ops
  (DropType, DropTable, DropProperty, DropLink) refused by default
  with a clear list of what would be deleted (gh/geldata#1838,
  builds on P1-09).
- **Rollback safety classifier** matches the forward gate — same
  vocabulary in both directions.
- **Squashing** with restrictions for data migrations.
- **Merge conflicts**: documented in `docs/migrations.md`
  (gh/geldata#6085) — the only file-level merges happen in your
  schema source; `disc migrate` against the merged schema produces
  the right delta regardless of branch order.
- Migration tracker carries SHA-256 checksums (P1-08), `created_at` +
  `applied_at` columns (gh/geldata#2078), 32-bit-checksum upgraded.

### Auth (`auth/`)

- **JWT signing**: HS256 (default, ≥ 32-byte secret) and RS256
  (PEM-encoded PKCS#8 private + SPKI public, ≥ 2048-bit modulus)
  (P3-04). Cross-algorithm tokens reject. Rotation procedure
  documented in `auth/README.md`.
- **Sessions**: revocable via `revoked` flag, server-side
  `expires_at` checked on every verify (P1-33), bound to request IP
  - User-Agent for anomaly detection on refresh (P2-21).
- **Concurrent-session cap** (`maxSessionsPerUser`) — oldest session
  is revoked when a new one would exceed the cap (P2-22).
- **Audit log** for nine event classes (login_succeeded,
  login_failed, password_reset, password_reset_requested,
  registered, session_created, session_refreshed,
  session_refreshed_from_new_ip, token_verification_failed) (P2-23).
- **Token storage**: reset and verification tokens are SHA-256
  hashed before persistence (P0-03) — DB breach can't be used to
  reset other users' passwords.
- **Rate limits** on login / register / password-reset endpoints
  (P0-05).
- **CSRF + cookie security**: SameSite=Strict, Secure, HttpOnly
  cookies; CORS allowlist required when `credentials: true` (P0-04,
  P0-06, P1-34).
- **Email enumeration mitigations**: identical error messages and
  response timing for no-such-user vs wrong-password
  (P1-35 + gh/geldata#9137 — equalizes both via dummy bcrypt).
- **Password reset gating**: when `requireEmailVerification: true`,
  unverified accounts can't reset (gh/geldata#6502).
- **Disable new sign-ups** via `allowRegistration: false` while
  keeping existing auth functional (gh/geldata#7482).
- **Fail-fast config validation** at `initialize()` — every
  AuthConfig field gets a range check up-front
  (gh/geldata#7006).
- **Constructor refactor** (`{...DEFAULTS, ...overrides}`) ensures
  any future `AuthConfig` field is a compile error until defaulted —
  the silent-drop bug behind `maxSessionsPerUser` (P2-22) cannot
  recur.

### OAuth (`ext-oauth/`)

- Google, GitHub, Apple providers shipped (more via custom
  `OAuthProviderConfig`).
- **PKCE (S256)** by default (P1-41) — code verifier stored
  server-side, replayed at token exchange.
- **Wildcard subdomains in redirect-URI allowlist** for multi-tenant
  deployments (`https://*.example.com/cb`) (gh/geldata#7468). Strict:
  one DNS label, no suffix-as-string attacks, scheme/port/path
  exact-match.
- **Complete callback flow**: token exchange + `userinfo` fetch
  return `{provider, token, user, metadata}` to calling apps. Every
  failure path returns a structured `{error: {code, message,
  details?}}` (gh/geldata#7557, #8950).
- **Caller-supplied state metadata** (`?metadata=<json>`, capped at
  2 KB) round-trips through authorize → callback for post-login
  redirects and similar (gh/geldata#8841).

### Access Policies (`access/`)

- Object-level policies translated to SQL `WHERE` clauses.
- **SQL-injection-safe** policy compilation via shared
  `lib/sql-escape.ts` with `E'…'` literals + `assertSafeIdentifier`
  (P0-01, P0-02).
- Cache key includes `userId` only when policies on, with
  cardinality controls (P1-13).

### SDK (`sdk/`)

- HTTP client (`DiscClient`), `AuthManager` with auto-refresh,
  `Transaction` with auto-commit/rollback, `SubscriptionClient` with
  reconnect-and-replay.
- **Runtime validation hook**: `query<T>(eql, vars, { validate })`
  accepts a plain function or any
  [Standard Schema](https://standardschema.dev) (Zod 3.24+, Valibot,
  ArkType, Effect Schema). Throws `DiscValidationError` on rejection
  (P1-28, gh/geldata closes the audit P3-03 too).
- Retry backoff with ±25% jitter to avoid thundering herd (P1-30).
- Optional logger hooks for `warn`/`error` on retry attempts (P2-20).
- Eight specific error classes derived from `DiscClientError`.

### CLI (`cli/`)

- `disc init`, `start`, `stop`, `restart`, `status`, `serve`,
  `shell`, `migrate`, `codegen`, `watch`, `build`, `deploy`,
  `db {create,list,drop}`, `pg {upgrade,log}`.
- Per-subcommand `--help` (P1-16).
- `disc init --template` for project scaffolds.
- `disc start` runs daemonized by default (`--foreground` opt-in).
- `disc deploy` prompts for or generates `POSTGRES_PASSWORD` (P2-36).
- `disc build --lite` skips UI bundling (P2-35).
- `--rollback{,-to}` requires `--force`; `--unsafe` for forward
  destructive migrations (gh/geldata#1838).

### Codegen (`codegen/`)

- TypeScript types generated from the SDL schema.
- `int64` / `bigint` map to `bigint` in TS (P1-20).
- Watch mode reads the real schema (P1-19).
- Output dir: `./dbschema/disc-client/` (canonicalized — P2-29).

### UI (`ui/`)

- SvelteKit admin UI with TRON aesthetic. Schema browser, data
  viewer, query editor, REPL, migration history.
- Wired to real APIs (P1-23): `getStats()`, `getSchema()`,
  `getMigrations()`, `executeQuery()`, `executeREPL()`.
- API client persists JWT in localStorage with `Authorization: Bearer`
  on every request.
- `bun.lock` committed (P1-27); error message correctly references
  Bun (P1-18).

### Extensions

- **`ext::auth`** — built-in (see Auth above).
- **`ext::oauth`** — see OAuth above.
- **`ext::graphql`** — auto-generated GraphQL schema from SDL,
  fragments + `@skip`/`@include` directives, `__schema`/`__type`/
  `__typename` introspection short-circuited from cached schema
  (P2-24). HTTP rate-limited (gh/geldata#718).
- **`ext::vector`** — pgvector integration with dimension validation
  (P2-26).
- **`ext::fts`** — GIN-indexed full-text search; column rename/drop
  pitfalls documented in `ext-fts/README.md` (P2-25).
- **`ext::custom-functions`** — register PG-side SQL functions and
  expose them in EdgeQL.

### Test infrastructure

- 2160+ tests across 19 modules.
- Coverage tracked in CI (`.github/workflows/ci.yml` — P3-05).
- Gel-compat smoke suites: Python 14/14, Node 14/14.
- `EnvMock` for env-leak-safe CLI tests (P2-32).
- Skipped tests labeled `awaiting-pg` vs permanent (P2-34).

### Build & release

- ChronVer (`YYYY.MM.DD`) versioning. `version.txt` is the single
  source of truth (P1-48); `mod.ts` reads it at runtime.
- `disc build --platform <p>` produces native binaries for
  `darwin-{arm64,x64}` and `linux-{x64,arm64}`.
- `.github/workflows/release.yml` builds, checksums, and publishes
  binaries to GitHub releases on tag push (P3-06, P3-07).
- CI: `lint-and-test` + `e2e-tests` (Playwright) + `gel-compat`
  (Python + Node smoke) — all gating, none `continue-on-error`
  (P1-46).
