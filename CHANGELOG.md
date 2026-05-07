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

### Added

- **Programmatic CLI surface** (Bundle NN — gh/geldata#5911).
  `cli/api.ts` re-exports the well-typed command set (`init`,
  `migrate`, `serve`, `shell`, `watch`, `build`, `deploy`, `pgLog`,
  `pgUpgrade`) with their Options interfaces. The top-level `mod.ts`
  re-exports the surface as `CLI.*`, so consumers can drive Disc from
  setup scripts / CI / test fixtures without spawning subprocesses.
  ```ts
  import { CLI } from "disc";
  await CLI.init({ name: "my-project", template: "basic" });
  await CLI.migrate({ schema: "./dbschema/default.disc" });
  ```
  `cli/api.test.ts` exercises every exported function. Bag-style
  commands (`db *`, `codegen`, `status`) are intentionally left to the
  binary entry point — they target argv-driven operator workflows.

- **Offline PostgreSQL setup** (Bundle NN — gh/geldata#3406).
  `postgres/downloader.ts` honors two new env vars:
  - **`DISC_PG_BINARY_DIR`** — overrides the default
    `<HOME>/.disc/postgres` baseDir so operators can pre-stage PG
    binaries anywhere on disk. Once `bin/postgres` exists at
    `<DIR>/<version>/bin/postgres`, the downloader skips the fetch.
  - **`DISC_OFFLINE=1`** — turns a missing binary into a hard error
    with the exact path needed (instead of a silent download). Pairs
    with `DISC_PG_BINARY_DIR` for air-gapped CI.

  Bundle I (single-binary distribution) already handled the third
  case where PG is embedded inside the compiled `disc` binary; these
  env vars cover the deno-source workflow.

### Fixed

- **#2651 (named-instance DX) pinned** (Bundle NN — gh/geldata#2651).
  Gel users were confused by a multi-instance CLI surface where every
  command took `--instance` and instance names lived outside the
  project. Disc's design avoids the confusion structurally: instance
  name defaults to the project's `name` (from `disc.toml`); the
  override is `[database] instance_name = "..."` in `disc.toml`; no
  `--instance` flag on any CLI command — the project context resolves
  the instance from the directory `disc.toml` lives in (same pattern
  `git` uses for `.git/`). Pin in `tests/gel-divergence-pins.test.ts`
  asserts no `--instance` flag in `cli/main.ts` and that
  `lib/project-context.ts` keeps the projectName fallback.

- **Auth-extension cascade-delete gap closed** (Bundle MM — gh/geldata#7103 fix; structural pins for #5504 and #8811).
  - **#7103 (real fix)**: `auth/provider.ts` declares 9 user-bound auth
    tables (sessions, webauthn_credentials, recovery_codes, etc.). Every
    table except **`webauthn_challenges`** carried
    `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`.
    Bundle MM closes the gap: the CREATE TABLE statement now carries
    the same FK, and an idempotent post-CREATE DO-block migration adds
    the constraint to existing instances after first scrubbing any
    orphan rows. (Login challenges with `user_id IS NULL` are
    unaffected — PG ignores null on the reference side.)
  - **`auth/pg-integration.test.ts`** — new `webauthn_challenges
    cascades on user delete` PG-backed test verifies the cascade
    behavior end-to-end.
  - **#5504 (UNLESS CONFLICT × access-policy) pin**: Gel reports
    UNLESS CONFLICT misbehaves when a user has INSERT permission but no
    SELECT permission, because Gel's compiler projects the
    conflict-target row through the access-policy filter (which
    returns nothing → no conflict → duplicate insert).
    Disc's `compiler/applyAccessControl` handles `InsertStatement` as
    binary allow/deny: it either lets the INSERT through unmodified or
    throws `CompilationError`. It never injects a WHERE filter on the
    INSERT path. The compiled SQL is plain
    `INSERT INTO ... ON CONFLICT (col) DO ...`, so PG's policy-blind
    unique index handles conflict detection. Pin asserts the
    `InsertStatement` branch never synthesizes a `WhereClause`.
  - **#8811 (stdlib permissions audit) pin**: Gel's concern is
    `std::*` implementations that read tables directly bypassing
    access policies. Disc's stdlib (`lib/stdlib-sql.ts`) declares only
    IMMUTABLE crypto + encoding wrappers (md5/sha1/hex/base64) — none
    touch user tables. Aggregates like `count()` / `sum()` compile
    inline against a SELECT subquery that goes through
    `applyAccessControl`. Pin asserts every wrapper is IMMUTABLE and
    contains no FROM clause referencing a real table.

- **Schema differ: linear scaling on initial-migration path** (Bundle LL —
  gh/geldata#5322 + structural pins for #5713 and #4319).
  `SchemaDiffer.createTypeOperation(typeDef, allTypes)` was O(N²) on the
  initial-migration path: each call linearly scanned `allTypes` for direct
  subtypes, and `extractPropertiesWithInheritance` /
  `extractLinksWithInheritance` recursively walked the parent chain
  without memoization. On a 2000-deep inheritance chain that was ~800ms;
  on a 4000-type flat schema it was ~83ms. Both cases scaled
  superlinearly and would have been seconds on >5k-type schemas.
  - New `DiffCache` (per-`allTypes` `WeakMap`) holds a reverse
    parent→child map built once, plus memoized inheritance walks for
    properties and links. Each parent's contribution is now computed
    once and reused by every descendant.
  - Post-fix scaling is linear: 2000-deep chain ≈ 6ms (330× faster);
    4000-type flat ≈ 4ms (21× faster).
  - **`migration/performance.test.ts`** — new `Performance - Initial
    Migration scales linearly with deep inheritance` test pins the
    bound at 500ms for n=2000 (≈100× headroom over the post-fix
    typical, ~1.5× the pre-fix 2000-type baseline → fails loud on
    quadratic regression).
  - **`tests/gel-divergence-pins.test.ts`** — three new pins:
    - **#5322 structural pin** asserts `interface DiffCache` +
      `getCache(allTypes)` + `compute{Properties,Links}WithInheritance`
      stay in place so a "simplification" refactor can't silently
      revert the cache.
    - **#5713 (insert speed in migrations) pin.** Gel reports inserts
      inside data migrations run slower than outside because their
      framework buffers each statement through Python and re-marshals
      via the admin connection. Disc's `migration/data-migration.ts`
      calls `conn.query(query, params)` directly against the same
      `ConnectionPool` user code uses — same code path, same speed.
      Pin asserts `data-migration.ts` issues raw `conn.query` and
      forbids any compile/buffer wrapper.
    - **#4319 (run migrations in IO process) pin.** Gel's complaint
      was that their migration applier shells out to subprocesses.
      Disc's `engine.executeStatements` runs the entire DDL apply
      in-process inside a single PG transaction. Pin asserts
      `engine.ts` never calls `Deno.Command` / `Deno.run` and keeps
      the `pool.transaction(async (conn) => ...)` single-tx wrapper.

- **Test-file TS errors cleared — `deno check` is now clean across the
  whole project** (Bundle KK). Bundle JJ fixed the four originally
  flagged production-source errors but unblocked compilation surfaced
  ~150 more across 51 test/legacy files. This bundle drives that down
  to zero. Notable changes:
  - **`LoginResult` union narrowing.** `auth/types.ts` now exports
    `isAuthResponse(result)` and `requireAuthResponse(result)` so
    tests can chain `.user`/`.token`/`.session` access after a single
    narrow rather than scattering type guards throughout. Applied to
    `auth/provider.test.ts`, `auth/anonymous.test.ts`,
    `auth/pg-integration.test.ts`, `auth/roles.test.ts` (21 errors).
  - **Result `<T, E>` narrowing.** Tests that called
    `parseResult.value` without first narrowing via
    `if (!parseResult.ok) throw parseResult.error;` now do — applied
    to compiler test fixtures across cal-types, annotations-stage39,
    tuple-access, pg-stage39, link-inheritance, pg-phase23,
    collection-types, secret-annotation, with-module,
    schema-export, sdl-serializer (32 errors).
  - **`Query` AST union narrowing.** `compiler/polymorphic.test.ts`
    and `compiler/tuple-access.test.ts` cast their parser results
    via `as SelectQuery` so `.expr` and `.shape` access type-checks
    (18 errors).
  - **`LinkDef.computed` propagation.** Bundle JJ added the field;
    Bundle KK threads it through the SDL converter so REST-route
    synthesis sees it.
  - **Legacy `protocol/server.ts` + `protocol/connection.ts` shims.**
    Both files target an older SCRAM API (`generateStoredKeys`,
    `ScramServer` class) that the live binary-protocol path
    superseded. Added compile-only shims in `protocol/scram.ts` so
    the dead code still type-checks; production imports remain on
    the functional API.
  - **Inline AST literals fixed.** `compiler/compiler.test.ts`,
    `migration/computed-properties.test.ts` now include the required
    `kind`/`type` discriminators on `Literal`, `FunctionArg`,
    `PathStep`, and `OrderByClause` nodes.
  - **`MigrationConfig` / `MigrationEngine` constructor** call sites
    in `migration/scalar-cascade.test.ts`, `migration/unsafe-gate.test.ts`,
    `migration/rewrite.test.ts` now pass the required fields
    (`migrationsDir`, `schemaFile`, `databaseUrl`, `dryRun`,
    `autoApprove`, `backupBeforeMigration`, `rollbackOnError`).
  - **`PostgresBinaryDownloader` etc.** Misc smaller fixes:
    deno-postgres `applicationName` thread-through, abstract types
    use `tableName: ""` placeholder, unused-variable cleanups across
    auth-e2e, auth-integration, sdk/types, sdk/client,
    extension-integration, query-execution, trigger, wire-integration,
    operators-stage37, pg-stage38, enum-literal, schema-reload,
    database-routing, websocket, migrations-endpoint, subscription,
    binary-server.
  - **Net result**: full project (excluding `ui/` Bun-managed code)
    type-checks under `deno check` with zero errors. Lint clean.
- **Pre-existing TS errors blocking `deno check` cleared** (Bundle JJ).
  Four production-source files now pass `deno check` for the first
  time in months:
  - **`migration/engine.ts:41`** — `logger.warn("...", { ... })` was a
    two-arg call against the wrapper's one-arg signature. Updated
    `postgres/logger.ts:PostgresLogger` to forward an optional
    `extra: Record<string, unknown>` to the structured logger so
    context fields no longer drop on the floor.
  - **`smtp/client.ts:334`** — `concatBytes(...)` returned the broader
    `Uint8Array` (defaults to `Uint8Array<ArrayBufferLike>` under
    modern lib types), incompatible with the field's
    `Uint8Array<ArrayBuffer>` type. Pinned the return type
    explicitly to match the field.
  - **`server/rest/openapi.ts:263, :368`** — read `link.computed` on
    a `LinkDef` that didn't declare the field. Added
    `computed?: boolean` to `LinkDef` in `compiler/context.ts` and
    populated it in the SDL converter (`migration/schema-manager.ts`)
    so computed links are now correctly skipped at REST-route
    synthesis time.
  - **`cli/admin.ts:64`** (surfaced after the above unblocked
    compilation) — passed `name` to `RegisterData`, which only
    declares `username`. Renamed at the call site.
  - 7 regression tests in `tests/typecheck-pins.test.ts` re-run
    `deno check` on each formerly-broken file so a future regression
    fails the pin rather than silently re-breaking CI.

### Added

- **TLS to external PostgreSQL via `?sslmode=...`** (Bundle II —
  gh/geldata#2292). `lib/database.ts:parseConnectionString` now
  surfaces the `sslmode` query parameter and `getClientConfig` maps
  it to the deno-postgres driver's `tls` option shape (mirrors
  `connection_params.ts:parseOptionsFromUri` upstream). Supported
  modes: `disable`, `prefer`, `require`, `verify-ca`, `verify-full`.
  Unknown values drop at parse time so a typo never silently
  downgrades a `require` connection to plaintext. Socket DSNs
  ignore `sslmode` (sockets don't carry TLS). New
  `lib/sslmode.test.ts` (7 tests) pins the parsing + mapping
  contract.
- **Drift detection in `disc migrate --status`** (Bundle HH —
  gh/geldata#8899). Status output now includes a `Schema status` line
  computed by parsing `dbschema/<project>.disc` and running it through
  the diff engine against the applied state. When the SDL matches the
  database, the line reads `Schema status: in sync`; when it doesn't,
  the line reads `Schema status: <N> pending operation(s)` followed
  by up to 5 ops with their safety classification (`safe` / `unsafe` /
  `ambiguous`) and a `Run disc migrate to apply.` hint. Operators who
  only run `--status` to peek at history get the same answer without
  changing their habit.
- **Pre-migrate preflight: running-server detection** (Bundle HH —
  gh/geldata#9034). Before each live migration, the CLI scans
  `pg_stat_activity` for connections tagged
  `application_name = 'disc-server'` (newly threaded via the
  `applicationName` config field on `DatabaseConfig` /
  `ConnectionPool`). When any are found it warns about stale-cache
  risk and suggests a follow-up reload (admin UI Diff page → Apply,
  or restart). Advisory-only — the migration still proceeds. The CLI
  itself tags its own pool `disc-cli` so the preflight excludes its
  own connection. Best-effort: silently no-ops if `pg_stat_activity`
  is restricted. New `SchemaManager.detectRunningServers()` and
  `SchemaManager.previewMigrationOps()` helpers underpin both items.

### Internal

- **Verification pins for four legacy bug-class reports** (Bundle II)
  now live in `tests/gel-divergence-pins.test.ts`:
  - **gh/geldata#5158** — `disc init` writes the project files (and
    `disc.toml`) before touching PostgreSQL, so a network failure
    mid-download leaves a resumable project rather than half-state.
    Pin asserts `createProjectFiles` runs before `initializePostgres`
    in `cli/init.ts:execute`.
  - **gh/geldata#5480** — `DatabaseConnection.connect` retries
    transient failures (default 3 × 1s with configurable
    `maxRetries`/`retryDelay`). Pin walks `lib/database.ts` for the
    retry loop's structural shape so a refactor that drops it would
    fail fast.
  - **gh/geldata#8762** — `disc init`'s catch block surfaces the
    "re-run `disc start` from inside the project to finish PG setup"
    hint. Pin asserts the message stays in `cli/init.ts` so a future
    refactor doesn't quietly swallow it.
  - **gh/geldata#7972** — `brandColor` reaches the `bgcolor`
    attribute on auth-email CTAs (subsumed by Bundle E +
    Bundle U's bulletproof `<table>` button). Pin asserts the
    `branding.brandColor` reference and the `bgcolor="${...}"`
    template emission both stay in `auth/email-templates.ts`.
- **Pinned divergence for `gh/geldata#7360`** (Bundle HH — login UX
  for non-existing accounts). Disc landed timing equalization in
  `auth/provider.ts:login` via P1-35 plus `gh/geldata#9137`. Both the
  no-such-user and wrong-password branches throw `INVALID_CREDENTIALS`
  at status 401 with the literal `"Invalid credentials"` message, and
  both call `runDummyCompare` so the wall-clock matches a real bcrypt
  verify. New pin in `tests/gel-divergence-pins.test.ts` walks
  `provider.ts:login` to confirm both branches share the shape so a
  future refactor can't drift them apart.
- **Pinned divergence for `gh/geldata#3170`** (Bundle HH — misleading
  disconnect log in CLI). Disc never adopted that log line; the CLI's
  only shutdown path lives in `cli/shell.ts:cleanup()`, which writes a
  single newline (P2-14) and closes the database without any
  user-visible disconnect chatter. New pin asserts the absence of
  `console.<level>([Dd]isconnected...)` calls across `cli/shell.ts`,
  `cli/commands.ts`, and `cli/main.ts` so a future refactor adding
  the log line lands deliberately rather than as a side-effect.

### Security

- **Router-level lockdown for `/auth/*` routes** (Bundle GG —
  gh/geldata#7525). The dispatcher in `server/http.ts` now classifies
  every `/auth/<route>` it knows about as either bootstrap-public
  (`register`, `login`, `anonymous`, `refresh`, `reset`, `verify`,
  `magic-link/{request,consume}`, `magic-code/{request,verify}`,
  `webauthn/login/{begin,finish}`, `mfa/{totp,recovery-codes}/login`)
  or authenticated (`logout`, `profile`, `password`, `upgrade`,
  `mfa/totp/{enroll,confirm,disable}`, `mfa/recovery-codes/generate`,
  `webauthn/register/{begin,finish}`, `webauthn/credentials`,
  `webauthn/credentials/delete`). Authenticated routes enforce a JWT
  at the router level — independent of `config.requireAuth` — so
  logout/profile/password etc. are protected even in permissive mode.
  A route reaching the dispatcher with no classification fails closed
  with 404 rather than shipping silently public. Existing per-handler
  `middleware.requireAuth()` wrappers stay as defense-in-depth.
- **Per-request access-policy override** (Bundle GG —
  gh/geldata#6358). New header `X-Disc-Apply-Access-Policies: false`
  opts out of policy injection for the upcoming query, mirroring
  Gel's `apply_access_policies := false` session config. Honored
  only when the caller carries an `admin` role in their JWT roles
  claim; non-admins setting the header have it silently dropped at
  the HTTP boundary so end-users can't escalate. The compilation
  cache key embeds the bypass flag so a bypassed result can't be
  served to a non-bypassed call (and vice versa). Compiler-side
  short-circuit lives in `compiler/compiler.ts:applyAccessControl`
  via the new `AccessContext.bypass` flag.

### Internal

- **TLS cipher-suite divergence pinned** (Bundle GG —
  gh/geldata#3872). Gel exposes operator-facing `tls_ciphers` /
  `tls_groups` knobs because its server runs on Python's `ssl`
  (OpenSSL). Disc serves TLS through `Deno.serve({ cert, key })`
  which is built on rustls — and rustls deliberately doesn't expose
  cipher selection. It ships TLS 1.2/1.3 only, AEAD-only ciphers
  (AES-GCM / ChaCha20-Poly1305), forward-secret key exchanges
  (ECDHE/DHE) by default. Disc aligns with rustls's safe defaults
  rather than expose a knob that could only weaken them. New pin in
  `tests/gel-divergence-pins.test.ts` asserts no cipher-config
  symbols leak into `server/http.ts` so a future Deno API change
  that lands cipher knobs has to be adopted deliberately rather than
  silently.

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

### Internal

- **CI now builds the UI before the non-PG test suite.** The
  `lint-and-test` job sets up Bun, runs `bun install --frozen-lockfile`,
  and `bun run build` so `server/ui-assets.test.ts` exercises the
  real embed-and-serve path. The four tests in that file previously
  probe-skipped (Bundle I pattern) because `ui/build/` is gitignored
  and CI never built it; they now run for real on every PR. Adds
  ~30s–1min to the job (install + build), well-cached on warm runs.
- **Phase 23 polymorphic test fixtures rewritten to per-subtype tables.**
  The two `compiler/pg-phase23.test.ts` polymorphism tests previously
  modeled their `Shape`/`Circle`/`Rectangle` hierarchy on a single
  `shapes` table with a `__type__` discriminator (single-table
  inheritance). Disc's production migration engine emits one physical
  table per concrete subtype — abstract types have no physical table —
  and `SELECT <Abstract>` lowers to `UNION ALL` across the subtype
  tables (the column projection comes from the abstract type's
  properties). The fixtures now match production semantics: per-subtype
  `circles`/`rectangles` tables, abstract `Shape` with no `tableName`,
  default `__type__` value carried by each subtype's `CREATE TABLE`.
  The `IS Type` filter test (Phase 23.5 part 1) un-ignored — passes
  green at 6/6 phase23 tests. The `[IS Circle].radius` polymorphic
  shape field test stays ignored with a precise comment pointing at
  the compiler gap (`compiler.ts:compilePolymorphicSelect` projects
  only the abstract type's columns; subtype-specific columns
  referenced by polymorphic shape fields aren't projected, so
  `<alias>.radius` errors with "column shape_1.radius does not
  exist"). Flipping the second test to active is a one-line change
  once the projection enhancement lands.
- **Structural-divergence pins** for two Gel issues that don't apply
  to Disc (gh/geldata#4408, #4172). No behavior change — the pins
  capture the structural reality so a future refactor that breaks the
  assumption gets caught:
  - #4408 (pre-commit framework integration) — Gel closed-not_planned;
    Disc aligns. The `commit` skill, CI, and the `deno task check`
    composition cover the same surface. Pin asserts the
    `lint`/`fmt`/`test`/`check` Deno tasks stay stable, and the
    absence of `.pre-commit-config.yaml`.
  - #4172 (SCRAM over HTTP-tunneled binary protocol) — Gel shipped
    via PR #4197 upstream, but Disc never ported the HTTP-tunneled
    binary transport itself. SCRAM-over-tunnel-binary has no surface
    to attach to. Pin asserts `BinaryProtocolServer` listens via
    `Deno.listenTls` (TCP+TLS) and not `Deno.serve` (HTTP), and that
    ALPN `edgedb-binary` stays advertised. Lives in new
    `tests/gel-divergence-pins.test.ts` (a cross-cutting home for
    structural-divergence pins that don't belong in any one slice).

### Added

- **Homebrew Formula** (gh/geldata#3437 — Disc-equivalent shipped).
  New `homebrew/disc.rb` Formula installs the `disc` binary on macOS
  and Linux via `brew install`. Builds from source by depending on
  `deno` + `oven-sh/bun/bun` and running the existing
  `deno task build` pipeline (UI bundled via `bun run build` first).
  Ships both a stable block (pinned to the latest tag) and a `head`
  block (`brew install --HEAD ...` against `primary`) so early
  adopters can track shipped bundles before the next tag.
  - **PG isn't bundled in the brew-built binary** — the build machine
    has no `<DISC_HOME>/postgres/` cache, so the embedded-PG manifest
    is empty. The runtime downloads PG on first `disc init` /
    `disc serve` (same as `DISC_BUILD_NO_BUNDLE_PG=1`).
  - **Tap repo (`github.com/systemsoft/homebrew-disc`) not yet
    published** — until it is, install via the direct-formula URL
    documented in `homebrew/README.md` and `docs/getting-started.md`.
    The Formula in this repo stays canonical; the tap repo
    eventually copies it into `Formula/disc.rb`.
  - `docs/getting-started.md` gained an "Install Disc" section
    documenting Homebrew (cutting-edge + stable paths) and from-source
    build alternatives.
  - The Formula's `sha256` for the stable block carries a clear
    `REPLACE_WITH_TAG_SHA256_AT_PUBLISH_TIME` placeholder. Set it
    when publishing the tap repo (or use `brew bump-formula-pr`).

- **Scalar/enum migration end-to-end** (gh/geldata#8517 full impl).
  Bundle F shipped scalar diffing (`CreateScalar` / `DropScalar` /
  `AddEnumValue` / `RecreateScalar`), but properties typed as a
  user-declared enum scalar still emitted columns of `TEXT` because
  `mapEdgeQLTypeToPostgreSQL` had no way to recognise user types. Two
  follow-ups close the gap:
  - **Column wiring via a scalar registry on `DDLGenerator`.** New
    `setEnumScalars(names)` method registers enum-scalar names so the
    type mapper resolves them to `disc_enum_<name>` instead of falling
    through to `TEXT`. The registry is checked after the built-in
    type map, so it can never shadow real types. `MigrationEngine.
    planMigration` primes it from the post-state schema's enum
    scalars, picking up both unqualified (`Status`) and qualified
    (`module::Status`) property type strings. Direct callers that
    don't set the registry get the historical TEXT-fallback behavior
    (back-compat).
  - **Cascade-aware operation ordering pass.** New `reorderForCascade`
    in `SchemaDiffer.diff` slots `CreateScalar` / `AddEnumValue`
    before object-type changes so column adds can reference a brand-
    new enum, and slots `DropScalar` / `RecreateScalar` after object-
    type changes so column drops or migrations remove the dependency
    before PG sees the type drop. Stable order within each bucket
    preserves the existing diff sequencing. New `enumScalarNames`
    helper used by the engine to extract the registry input.
  - 10 new tests in `migration/scalar-cascade.test.ts` covering
    column wiring (with/without registry, qualified-name handling),
    engine-level wiring (`planMigration` → `generateDDL` round-trip),
    and the four ordering invariants (CreateScalar-before-CreateType,
    DropScalar-after-AlterType, RecreateScalar-after-object-drops,
    AddEnumValue-grouped-with-creates).

### Docs

- **Documentation audit — medium + low gaps closed** (Bundle EE).
  Follow-up to Bundle DD — addresses the remaining ~11 audit findings:
  - `docs/server.md` gained an "Admin Features" env-var subsection
    (`DISC_ENABLE_DATA_WATCH`, `DISC_ENABLE_REST` — Bundles L + J).
  - `docs/auth.md` gained subsections for Bundle Q polish: implicit
    signup via magic link (`allowImplicitSignup` config + new
    `MagicLinkSignupRequested` webhook event) and WebAuthn
    discoverable credentials (`requireResidentKey` config; passkeys
    documented as the default).
  - `docs/migrations.md` gained an "Enum scalar columns wire through
    to the PG enum type" subsection demonstrating Bundle W's
    end-to-end behavior with concrete SDL → DDL example.
  - `docs/edgeql.md` Polymorphic Queries section gained a "How
    polymorphic SELECT compiles" subsection with a concrete UNION-ALL
    plus CASE example covering Bundle BB's subtype-specific column
    projection.
  - `docs/codegen.md` opener gained a callout pointing at the
    codegen-free runtime DSL (Bundle M) as an alternative to the
    generated-code path; `docs/client-sdk.md` gained a full
    "Codegen-free query builder" section that the callout links to.
  - `docs/production-deployment.md` env table gained
    `DISC_TLS_CERT_ENV` / `DISC_TLS_KEY_ENV` rows.
  - `docs/admin-ui.md` Live Mode mention now anchors at
    `server.md#admin-features`.
  - `docs/schema.md` Inheritance section gained a "Production
    semantics — per-subtype tables" callout linking to the EdgeQL
    polymorphic-queries explanation.
  - `docs/bundled-postgres.md` `disc pg upgrade` section now opens
    with a status callout flagging the pipeline as in development.
- **Documentation audit — high-severity gaps closed** (Bundle DD).
  Three issues identified by an end-to-end audit of `docs/` against
  current code state:
  - `docs/access-policies.md` gained a "Deno-Permission-Aware
    Policies" section covering `runtime::has_permission(<spec>)`
    (Bundle P, shipped since 2026-05-06). The function and spec
    grammar previously lived only in `docs/disc-original-features.md`,
    so the main reference omitted the feature entirely.
  - `docs/cli.md` `disc serve` table gained `--require-auth`,
    `--read-only`, `--trust-proxy` flag rows (Bundle R/H), and the
    env-var list gained `DISC_TLS_CERT_ENV`, `DISC_TLS_KEY_ENV`,
    `DISC_REQUIRE_AUTH`, `DISC_READ_ONLY`, `DISC_TRUST_PROXY`,
    `DISC_ENABLE_DATA_WATCH`, `DISC_ENABLE_REST`,
    `DISC_SHUTDOWN_DRAIN_TIMEOUT`. The `disc build` section gained
    a "Cross-platform PG staging" note explaining Bundle CC.
  - `docs/future-triage.md` header now flags that the DONE/BUILD
    snapshot predates Bundles I–CC; a new "post-Bundle-H sweep" table
    enumerates the 21 bundles shipped after the snapshot was taken
    and points readers at `CHANGELOG.md` `[Unreleased]` for the
    authoritative current state.

### Added

- **Cross-platform reproducible builds for `disc build --platform`.**
  Bundle I shipped single-binary distribution by walking
  `<DISC_HOME>/postgres/<version>/` for the embedded PG manifest, but
  that dir only ever holds one platform's PG (whichever the build
  machine downloaded). When `disc build --platform linux-x64` ran on a
  darwin-arm64 host, the resulting binary embedded darwin-arm64's PG —
  unable to extract or run on the target platform. The build command
  now stages the target platform's PG into
  `dist/embedded-pg/<platform>/<version>/` before regenerating the
  manifest, and `refreshEmbeddedPgManifest` accepts an optional
  `pgSourceDirOverride` to point at the staging dir. One CI runner can
  now produce all four platform binaries in sequence by reusing the
  per-platform staging caches. New `platformPgStagingDir` and
  `ensurePlatformPgStaging` helpers in `cli/build.ts`. The
  `PostgresBinaryDownloader` constructor accepts an opts shape
  (`{baseDir, platform}`) so it can be pinned to a target platform
  other than the host; the prior single-string form still works
  (back-compat).
- **Polymorphic shape fields in UNION'd subtype tables.** Bundle Y
  closed Phase 23 Test 1 (`IS Type` filter over a per-subtype-table
  hierarchy) but Test 2 — `[IS Circle].radius` selecting a
  subtype-specific column polymorphically — stayed ignored because
  the polymorphic UNION emitted by `compiler.ts:compilePolymorphicSelect`
  only projected the abstract type's columns. The outer CASE in
  `compilePolymorphicShapeElement` then resolved `<alias>.radius`
  against a column that wasn't in the union projection (PG: "column
  shape_1.radius does not exist"). The compiler now collects every
  `[IS Type].property` column referenced by the SELECT shape and
  extends each branch's projection: branches whose subtype owns the
  column emit the column normally; branches that don't emit
  `NULL::<pg-type> AS <colName>` so the union's column shape stays
  consistent across branches and PG can resolve the outer CASE.
  Phase 23 Test 2 un-ignored — `compiler/pg-phase23.test.ts` now 7
  passing + 0 ignored (was 6 passing + 1 ignored).
- **Cross-file SDL resolution from embedded EdgeQL** (LSP Phase 7).
  The Phase 6 limitation around user-defined types is closed: when
  the cursor sits on an identifier inside an `eql`-tagged template in
  a TS/JS host file, hover, completion, and go-to-definition now
  resolve user-declared type names from any open `.disc` document.
  Hover renders the same Markdown summary as the SDL-side hover (type
  kind + extends + property/link summaries — `findUserType` and
  `renderUserType` were extracted as a shared API). Completion
  appends user-type names with a `<kind> (from dbschema/foo.disc)`
  detail string; built-in scalars and EdgeQL keywords win on label
  collision. Go-to-definition jumps from the identifier to its
  declaration's selection range in the SDL file (URI + range from
  `buildSymbolIndex` so the result matches what `documentSymbol`
  exposes — single source of truth for type-decl locations).
  Resolution is editor-driven: the LSP scans `.disc` documents the
  editor has opened (most editors do this for known languages), no
  filesystem walk for the workspace. Falls back cleanly to Phase 6
  behavior (keywords + scalars only) when no SDL is open. 9 new unit
  tests + 2 server-routing tests.
- **Hover and completion inside embedded EdgeQL strings** (LSP Phase 6).
  When the cursor sits inside an eql-tagged template literal in a TS or
  JS host file, hover surfaces a Markdown description for EdgeQL
  keywords and built-in scalars; completion returns the same surface
  (47 keywords + 16 scalars) instead of the SDL keyword set. Routing is
  by URI extension — TS/JS extensions use the embedded provider,
  .disc keeps the existing SDL provider. New bidirectional cursor
  mapping primitive (`findEnclosingEmbeddedQuery`) resolves a host
  position into the enclosing query plus a position relative to the
  embedded string, shared by both providers. v1 limitations match
  Phase 5: matches the eql tag only, skips templates with `${...}`
  substitutions, user-defined types and go-to-definition into a paired
  SDL file are out of scope (would need cross-file resolution). 13 new
  unit tests + 3 server-routing tests.
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
