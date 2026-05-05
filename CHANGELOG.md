# Changelog

All notable changes to Disc are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com), and the project uses
[ChronVer](https://chronver.org) (`YYYY.MM.DD`) versioning.

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
  + ALPN (`edgedb-binary`); supports Python and Node Gel clients.
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
  + User-Agent for anomaly detection on refresh (P2-21).
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
