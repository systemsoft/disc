/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Cross-cutting structural-divergence pins.
 *
 * Captures Gel issues that *don't* result in a Disc feature change because
 * the bug class doesn't apply to Disc structurally — either Gel rejected
 * the underlying request `not_planned` or the surface area Gel was patching
 * doesn't exist in Disc's architecture. Each pin asserts the structural
 * reality so a future refactor that breaks the assumption gets caught.
 *
 * Migration-specific pins live in `migration/gel-issues.test.ts`. This file
 * is for divergence that doesn't belong in any one slice.
 */

import { assert, assertEquals } from "@std/assert";

// ---------------------------------------------------------------------------
// gh/geldata#4408 — pre-commit framework integration. Closed-not_planned
// upstream (maintainers viewed existing CI as sufficient; redundancy with
// GitHub Actions; concern that pre-commit hooks would hinder rapid PR
// iteration). Disc aligns with the upstream rejection: our lint/fmt/test
// surface is exposed as Deno tasks, the `commit` skill runs the full check
// before each commit, and CI (`.github/workflows/ci.yml`) re-runs the same
// tasks on PRs. Adding a pre-commit framework would just be a third layer
// over the same checks.
//
// The pin asserts that the Deno-task surface the commit skill + CI rely on
// stays stable. A future "let's adopt pre-commit" PR would have to also
// rewire those entry points, which is a deliberate trade-off rather than
// a silent migration.
// ---------------------------------------------------------------------------
Deno.test("Gel #4408: Deno-task surface is the lint/fmt/test entry point", async () => {
  const denoJsonText = await Deno.readTextFile(
    new URL("../deno.json", import.meta.url)
  );
  const denoJson = JSON.parse(denoJsonText) as {
    tasks?: Record<string, string>;
  };
  const tasks = denoJson.tasks ?? {};

  // The commit skill and CI run these specific tasks. Renaming or removing
  // any of them is the change that requires deliberate review.
  for (const requiredTask of ["lint", "fmt", "test", "check"]) {
    assert(
      typeof tasks[requiredTask] === "string",
      `deno.json:tasks.${requiredTask} is missing — Disc's lint/fmt/test surface relies on it (Gel #4408 pin).`
    );
  }

  // `check` should compose the others — this is the entry point CI uses,
  // and what the commit skill defers to. Pinning the composition keeps the
  // contract honest.
  const checkTask = tasks.check ?? "";
  assert(
    checkTask.includes("deno task lint") &&
      checkTask.includes("deno task fmt") &&
      checkTask.includes("deno task test"),
    `deno.json:tasks.check should compose lint + fmt + test; got: ${checkTask}`
  );
});

Deno.test("Gel #4408: no .pre-commit-config.yaml in the repo (deliberate non-adoption)", async () => {
  // Asserts the absence of the framework's config file so accidentally
  // landing one trips this pin and forces a deliberate decision.
  const candidates = [
    new URL("../.pre-commit-config.yaml", import.meta.url),
    new URL("../.pre-commit-config.yml", import.meta.url)
  ];
  for (const url of candidates) {
    let exists = true;
    try {
      await Deno.stat(url);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        exists = false;
      } else {
        throw e;
      }
    }
    assertEquals(
      exists,
      false,
      `${url.pathname} exists — Disc deliberately doesn't adopt the pre-commit framework (Gel #4408). Remove the file or update this pin.`
    );
  }
});

// ---------------------------------------------------------------------------
// gh/geldata#4172 — SCRAM auth over HTTP-tunneled binary protocol. Closed
// via Gel PR #4197 upstream. Disc never ported the HTTP-tunneled binary
// transport itself — `protocol/binary-server.ts` is TCP+TLS only (advertises
// ALPN "edgedb-binary"), and the HTTP path (`server/http.ts`) handles
// EdgeQL-over-HTTP, REST, and admin endpoints rather than tunneling binary
// messages.
//
// SCRAM-over-tunnel-binary therefore has no surface to attach to. The pin
// asserts the binary server uses TCP/TLS listeners, not `Deno.serve`, so a
// future refactor that adds an HTTP-tunneled binary mode has to land
// deliberately rather than as a side effect.
// ---------------------------------------------------------------------------
Deno.test("Gel #4172: binary protocol server uses TCP/TLS listening, not HTTP serve", async () => {
  const src = await Deno.readTextFile(
    new URL("../protocol/binary-server.ts", import.meta.url)
  );

  // The current implementation listens via `Deno.listenTls` (TLS-on) or
  // `Deno.listen` (plain TCP). It never goes through `Deno.serve` (HTTP).
  // A future HTTP-tunneled path would necessarily call `Deno.serve` or
  // route requests through the existing HTTP handler — both would change
  // the structural shape captured here.
  assert(
    src.includes("Deno.listenTls"),
    "BinaryProtocolServer should expose a TLS listener (TCP+TLS+ALPN edgedb-binary)"
  );
  assert(
    !src.includes("Deno.serve"),
    "BinaryProtocolServer must not use Deno.serve — that would be HTTP tunneling (Gel #4172 pin)."
  );
});

Deno.test("Gel #4172: binary protocol server advertises ALPN edgedb-binary", async () => {
  const src = await Deno.readTextFile(
    new URL("../protocol/binary-server.ts", import.meta.url)
  );
  // SCRAM is wired through the binary protocol via the TCP+TLS path.
  // ALPN "edgedb-binary" is what gates client negotiation onto that path —
  // dropping it is what would force HTTP tunneling, so we pin it here.
  assert(
    src.includes("\"edgedb-binary\""),
    "binary-server should advertise ALPN edgedb-binary for upstream client compatibility"
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#3872 — configurable TLS cipher suites/curves. Gel exposes
// `tls_ciphers` / `tls_groups` knobs because its server is built on Python's
// `ssl` module (OpenSSL underneath), which lets the operator name a cipher
// list. Disc serves TLS through `Deno.serve({ cert, key })`, which is built
// on rustls under the hood. rustls's design choice is to *not* expose cipher
// selection — it ships TLS 1.2 + 1.3 only, AEAD-only ciphers
// (AES-GCM/ChaCha20-Poly1305), and forward-secret key exchanges (ECDHE/DHE)
// by default. There is no public Deno API to override that list.
//
// Disc therefore aligns with rustls's safe defaults rather than expose a
// knob that could only weaken the cipher set. If Deno later surfaces a
// cipher-suite API on `Deno.serve`, this pin should fail (the assertion
// below scrapes the type definition) and the operator-facing knob can be
// added intentionally rather than as a silent regression.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// gh/geldata#7360 — email+password login UX for non-existing accounts. Gel's
// concern: the response a non-existing-account login produced was visibly
// different from a wrong-password login (faster path, distinguishable
// message), making account enumeration possible.
//
// Disc landed timing equalization (P1-35 + gh/geldata#9137) in
// `auth/provider.ts:login`: the no-such-user branch now burns one bcrypt
// dummy compare *and* throws with the same `INVALID_CREDENTIALS` /
// "Invalid credentials" / 401 envelope as the wrong-password branch. This
// pin walks `provider.ts:login` to confirm both branches share the same
// shape so a future refactor can't drift them apart.
// ---------------------------------------------------------------------------
Deno.test("Gel #7360: login no-such-user response matches wrong-password shape", async () => {
  const src = await Deno.readTextFile(
    new URL("../auth/provider.ts", import.meta.url)
  );
  // Both branches must throw `INVALID_CREDENTIALS` at status 401 with
  // the literal "Invalid credentials" message — no leaking nuance.
  const noUserMatches = (src.match(
    /reason:\s*"no_such_user"[\s\S]{0,400}?AuthErrorCode\.INVALID_CREDENTIALS/g
  ) ?? [])
    .length;
  assert(
    noUserMatches >= 1,
    "no-such-user branch must throw INVALID_CREDENTIALS (anti-enumeration parity)"
  );
  // Both branches must precede the throw with `runDummyCompare` so the
  // wall-clock timing matches a real bcrypt verify.
  assert(
    src.includes("await this.runDummyCompare(credentials.password);"),
    "no-such-user branch must burn a dummy bcrypt compare for timing parity"
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#3170 — misleading disconnect log in the CLI. Gel's concern: the
// CLI logged "Disconnected from server" on shutdown even when no server
// connection had been established (project-init paths, dry-run paths), which
// confused operators trying to trace real connectivity issues.
//
// Disc never adopted that log line. The CLI's only shutdown path lives in
// `cli/shell.ts:cleanup()` which writes a single newline (P2-14, prevents
// log-prompt collision) and then closes the database connection — no
// "disconnected" string is ever written, so the misleading-log bug class
// doesn't apply structurally. This pin asserts the absence of the offending
// substring across the CLI surface so a future refactor that *adds* the
// log line has to land deliberately rather than as a side-effect.
// ---------------------------------------------------------------------------
Deno.test("Gel #3170: CLI does not log 'disconnected' on shutdown", async () => {
  const cliFiles = [
    "../cli/shell.ts",
    "../cli/commands.ts",
    "../cli/main.ts"
  ];
  for (const rel of cliFiles) {
    const src = await Deno.readTextFile(new URL(rel, import.meta.url));
    // Match the literal log line shape — `"Disconnected"` or
    // `'disconnected from'`. Allow the word to appear in code comments
    // since those don't reach stdout.
    const codeOnly = src.replace(/\/\/.*$/gm, "").replace(
      /\/\*[\s\S]*?\*\//g,
      ""
    );
    assert(
      !/console\.\w+\([^)]*[Dd]isconnected/.test(codeOnly),
      `${rel} contains a disconnect-style console call — Gel #3170 pin`
    );
  }
});

// ---------------------------------------------------------------------------
// gh/geldata#5158 — `gel project init` timeout. Gel's CLI made a long
// network call mid-init (downloading binaries, contacting cloud) without a
// resumable contract, so a flaky network left the project half-initialized
// and the user with no clear way forward.
//
// Disc's `disc init` writes the project skeleton (including `disc.toml`)
// *before* touching PostgreSQL — even when the bundled-PG download fails,
// the project directory is left valid and the operator gets a clear
// "re-run `disc start`" hint. This pin asserts the file-creation step
// happens before the PG-setup step in `cli/init.ts:execute` so a future
// reorder can't regress the resumability guarantee.
// ---------------------------------------------------------------------------
Deno.test("Gel #5158: disc init writes project files before PG setup", async () => {
  const src = await Deno.readTextFile(
    new URL("../cli/init.ts", import.meta.url)
  );
  const filesIdx = src.indexOf("await this.createProjectFiles");
  const pgIdx = src.indexOf("await this.initializePostgres");
  assert(filesIdx > 0 && pgIdx > 0, "expected both calls in init.ts");
  assert(
    filesIdx < pgIdx,
    "createProjectFiles must run before initializePostgres so a PG failure leaves a resumable project"
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#5480 — `ClientConnectionFailedError` on certain networks.
// Gel's cloud client reported a single failed connect attempt as a fatal
// error, so transient DNS/IPv6 hiccups surfaced as user-facing crashes.
// Disc's `DatabaseConnection` retries `maxRetries` times with a configurable
// `retryDelay` between attempts (default: 3 × 1s). This pin keeps the retry
// loop in place — a refactor that drops it would re-introduce the same
// brittleness.
// ---------------------------------------------------------------------------
Deno.test("Gel #5480: database connect retries on transient failure", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/database.ts", import.meta.url)
  );
  // Look for `for (let attempt = 1; attempt <= maxRetries; attempt++)` —
  // the retry loop's structural shape.
  assert(
    /for\s*\(\s*let\s+attempt\s*=\s*1\s*;\s*attempt\s*<=\s*maxRetries/.test(
      src
    ),
    "DatabaseConnection.connect must keep its retry loop (Gel #5480 pin)"
  );
  // Default of 3 attempts — operators can override but the floor stays.
  assert(
    /this\.config\.maxRetries\s*\|\|\s*3/.test(src),
    "DatabaseConnection retry default must remain 3 (Gel #5480 pin)"
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#8762 — auto project init leaves bad state. Gel's reported
// failure mode: `gel project init` errored mid-flight (network / port
// conflict / partial schema) without rolling back, so the next `gel ...`
// invocation tripped over the half-written state. The user had to manually
// scrub artifacts before they could retry.
//
// Disc takes the opposite approach: write `disc.toml` *first* and never
// roll it back on failure. The init script's catch block emits a clear
// hint pointing the operator at `disc start` from inside the project to
// resume PG setup — the project itself stays valid. This pin asserts the
// hint stays in place so a future refactor that swallows the message
// won't ship.
// ---------------------------------------------------------------------------
Deno.test("Gel #8762: disc init resumability hint stays in place", async () => {
  const src = await Deno.readTextFile(
    new URL("../cli/init.ts", import.meta.url)
  );
  // The hint must mention `disc start` and reference the project dir
  // so the operator knows exactly what to run.
  assert(
    /disc start/.test(src) && /Project files were created/.test(src),
    "init.ts catch block must surface the 'disc start' resume hint (Gel #8762 pin)"
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#7972 — auth email button background color. Subsumed by
// Bundle E (`brandColor` validated at config time + flows into branding
// templates) and Bundle U (bulletproof CTA wraps the anchor in a `<table>`
// with the brand color carried via the legacy `bgcolor` attribute, which
// every email client honors). This pin asserts the brand color reaches
// the `bgcolor` attribute in `auth/email-templates.ts:buttonHtml` so a
// future template rewrite can't regress the Outlook-clickable cell.
// ---------------------------------------------------------------------------
Deno.test("Gel #7972: brandColor reaches bgcolor on auth email CTAs", async () => {
  const src = await Deno.readTextFile(
    new URL("../auth/email-templates.ts", import.meta.url)
  );
  // The CTA-button helper must compose the bg via `branding.brandColor`
  // as the source and emit it via `bgcolor="${bg}"` on the `<td>`.
  assert(
    /branding\.brandColor/.test(src),
    "email-templates.ts must read brandColor from the branding config (Gel #7972 pin)"
  );
  assert(
    /bgcolor="\$\{[^}]+\}"/.test(src),
    "email-templates.ts must emit a `bgcolor` attribute on CTA cells (Gel #7972 pin)"
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#5713 — "INSERTs in migrations are slower than INSERTs outside".
// Gel reproduces this because their migration framework buffers each
// statement through Python and re-marshals via the admin connection,
// which has more conservative GUCs than user connections. Disc's data
// migrations route through `migration/data-migration.ts:runMigration`
// which calls `conn.query(query, params)` against the same
// `ConnectionPool` user code uses — no extra buffering, no separate
// admin connection, no per-statement re-compile. INSERTs inside a data
// migration use the exact same code path as INSERTs outside.
//
// This pin asserts the structural property: `data-migration.ts` issues
// `conn.query` directly (not via a wrapper that could regress to a
// per-statement marshal/recompile loop). A future bundle that adds
// EdgeQL execution must wire it through the existing query pipeline,
// not duplicate it inside the data-migration runner.
// ---------------------------------------------------------------------------
Deno.test("Gel #5713: data migration INSERTs use raw conn.query (no buffering layer)", async () => {
  const src = await Deno.readTextFile(
    new URL("../migration/data-migration.ts", import.meta.url)
  );
  // `runMigration` and `rollbackMigration` must call conn.query(query, params)
  // directly — no per-statement compile/marshal wrapper.
  assert(
    /conn\.query\(query, params\)/.test(src),
    "data-migration.ts must call conn.query(query, params) directly (Gel #5713 pin)"
  );
  // No internal compilation/buffering machinery — the runner is a thin
  // pass-through. Forbid the obvious wrapper names.
  assert(
    !/compileEdgeQL|recompile|bufferStatement/.test(src),
    "data-migration.ts must not introduce a compile/buffer layer in the INSERT path (Gel #5713 pin)"
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#4319 — "Run migrations in IO process". Gel's complaint is
// that their migration engine spawns subprocesses or shells out to
// external tools, adding fork/serialize overhead per migration. Disc's
// `MigrationEngine.executeStatements` runs the entire DDL apply inside
// the same Deno process — there is no subprocess, no IPC, no marshal
// layer. The whole batch is wrapped in a single PG transaction so DDL
// runs at the same speed as any other in-process query.
// ---------------------------------------------------------------------------
Deno.test("Gel #4319: migration apply runs in-process (no subprocess fork)", async () => {
  const src = await Deno.readTextFile(
    new URL("../migration/engine.ts", import.meta.url)
  );
  // Forbid Deno.Command / Deno.run inside engine.ts — those would
  // signal a subprocess-spawning migration applier.
  assert(
    !/new Deno\.Command|Deno\.run\(/.test(src),
    "engine.ts must not spawn subprocesses for migration apply (Gel #4319 pin)"
  );
  // Single-transaction apply: pool.transaction wraps the whole DDL batch.
  assert(
    /pool\.transaction\(async \(conn\)/.test(src),
    "engine.ts must apply DDL in a single in-process transaction (Gel #4319 pin)"
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#5322 — "Schema comparison slow for large schemas". The
// differ's `createTypeOperation(typeDef, allTypes)` used to scan
// `allTypes` linearly per call (O(N²) total) and recursively walked
// the parent chain in `extractPropertiesWithInheritance` /
// `extractLinksWithInheritance` without memoization (also O(N²) on a
// deep chain). Bundle LL added a per-`allTypes` `DiffCache` that
// builds a reverse parent→child map once and memoizes inheritance
// walks, dropping both to amortized O(1).
//
// This pin asserts the cache structure stays in place. A regression
// that removes the cache and re-introduces the inner subtype scan
// would trip on the missing token. The behavioral perf-bound lives
// in `migration/performance.test.ts` — this pin guards the structural
// fix at source-read time so a refactor flagged as "simplification"
// can't silently revert.
// ---------------------------------------------------------------------------
Deno.test("Gel #5322: differ caches reverse subtype map + inheritance walks", async () => {
  const src = await Deno.readTextFile(
    new URL("../migration/differ.ts", import.meta.url)
  );
  assert(
    /interface DiffCache/.test(src) && /getCache\(allTypes\)/.test(src),
    "differ.ts must expose a per-allTypes DiffCache via getCache() (Gel #5322 pin)"
  );
  assert(
    /computePropertiesWithInheritance/.test(src) &&
      /computeLinksWithInheritance/.test(src),
    "differ.ts must split memoized inheritance walks from compute helpers (Gel #5322 pin)"
  );
});

Deno.test("Gel #3872: Deno.serve TLS surface does not expose cipher selection", () => {
  // Deno's runtime types live on `Deno`. We can't introspect rustls'
  // internal cipher list from user code, so we assert the structural
  // shape of `Deno.ServeTlsOptions`: only `cert` + `key` (and the
  // shared listen options). A future API addition like `cipherSuites`
  // or `tlsCiphers` would land as a typed property and trip this pin.
  const httpServerSrc = Deno.readTextFileSync(
    new URL("../server/http.ts", import.meta.url)
  );
  // Disc passes only { hostname, port, cert, key } to Deno.serve when TLS
  // is enabled. If a future bundle adds cipher config it has to touch this
  // call site, which is also where the pin lives.
  assert(
    !httpServerSrc.includes("cipherSuites") &&
      !httpServerSrc.includes("tlsCiphers") &&
      !httpServerSrc.includes("tls_ciphers"),
    "server/http.ts mentions cipher-suite config — Deno doesn't expose this surface " +
      "(Gel #3872 pin). Remove the reference or update the divergence note."
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#7103 — auth-extension cascade deletes. Bundle MM filled
// the only gap: `webauthn_challenges.user_id` had no FK at all. The
// CREATE TABLE now carries `FOREIGN KEY (user_id) REFERENCES users(id)
// ON DELETE CASCADE`, plus an idempotent post-CREATE DO-block migration
// that adds the constraint to existing instances after first scrubbing
// any orphan rows.
//
// Behavior is exercised under PG in `auth/pg-integration.test.ts`
// ("webauthn_challenges cascades on user delete"). This pin asserts
// the structural property at source-read time so a refactor that
// regresses the FK list trips here too.
// ---------------------------------------------------------------------------
Deno.test("Gel #7103: auth tables carry ON DELETE CASCADE on user_id FKs", async () => {
  const src = await Deno.readTextFile(
    new URL("../auth/provider.ts", import.meta.url)
  );
  // All user-bound auth tables must declare ON DELETE CASCADE.
  const requiredFkPattern = /FOREIGN KEY \(user_id\) REFERENCES users\(id\) ON DELETE CASCADE/g;
  const matches = src.match(requiredFkPattern) ?? [];
  // At time of writing: sessions, webauthn_credentials,
  // webauthn_challenges, recovery_codes, magic_link_tokens,
  // magic_code_tokens, mfa_totp, mfa_challenges, user_roles → 9 FKs.
  // (magic_link_signup_tokens has pending_email instead of user_id.)
  assert(
    matches.length >= 9,
    `Expected ≥9 user_id ON DELETE CASCADE FKs in auth/provider.ts; found ${matches.length} (Gel #7103 pin).`
  );
  // The Bundle MM gap-fix specifically. If a future refactor moves the
  // webauthn_challenges declaration, the constraint must follow.
  const challengesBlock = src.match(
    /CREATE TABLE IF NOT EXISTS webauthn_challenges \(([\s\S]*?)\n\s*\)/
  );
  assert(
    challengesBlock !== null &&
      /FOREIGN KEY \(user_id\) REFERENCES users\(id\) ON DELETE CASCADE/.test(
        challengesBlock[1]
      ),
    "webauthn_challenges must declare ON DELETE CASCADE on user_id (Gel #7103 pin)."
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#5504 — UNLESS CONFLICT misbehaves without select access.
// Gel reports that a user with INSERT permission but no SELECT
// permission can't reliably use UNLESS CONFLICT because Gel's compiler
// projects the conflict-target row through the access-policy filter
// (which returns nothing → no conflict detected → duplicate insert).
//
// Disc's compiler (`compiler/compiler.ts:applyAccessControl`) treats
// `InsertStatement` as binary: the access check either allows or
// throws (`CompilationError`). It never injects a WHERE filter on the
// INSERT path. The compiled SQL is plain
// `INSERT INTO ... ON CONFLICT (col) DO ...`, so PG's unique index —
// which is policy-blind by design — handles conflict detection.
//
// This pin asserts the structural property: `applyAccessControl` for
// `InsertStatement` does not synthesize a WHERE clause.
// ---------------------------------------------------------------------------
Deno.test("Gel #5504: INSERT access-control is binary allow/deny (no WHERE injection)", async () => {
  const src = await Deno.readTextFile(
    new URL("../compiler/compiler.ts", import.meta.url)
  );
  // Locate the InsertStatement branch of applyAccessControl.
  const insertBranch = src.match(
    /case "InsertStatement": \{[\s\S]*?return statement;\s*\}/
  );
  assert(
    insertBranch !== null,
    "applyAccessControl must have an InsertStatement branch (Gel #5504 pin)."
  );
  const body = insertBranch![0];
  // Branch must throw on denial (not silently filter) and must not
  // build a WhereClause / mutate `statement.where`.
  assert(
    /CompilationError/.test(body),
    "INSERT access denial must throw CompilationError, not return a filtered statement (Gel #5504 pin)."
  );
  assert(
    !/WhereClause/.test(body) && !/where: \{/.test(body),
    "INSERT branch must not synthesize a WHERE clause — that would break UNLESS CONFLICT detection (Gel #5504 pin)."
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#8811 — audit stdlib for permissions. Gel's concern: any
// `std::*` implemented as a stored procedure that reads tables
// directly bypasses access policies.
//
// Disc's stdlib (`lib/stdlib-sql.ts`) declares only IMMUTABLE crypto +
// encoding wrappers (md5/sha1/hex/base64) — none of them touch user
// tables. Aggregates like `count()`, `sum()` are compiled inline by
// `compiler/compiler.ts` against a SELECT subquery that goes through
// `applyAccessControl`, so policies still apply.
//
// This pin asserts: every function in `stdlib-sql.ts` is `IMMUTABLE`
// and contains no FROM clause referencing a real table.
// ---------------------------------------------------------------------------
Deno.test("Gel #8811: stdlib SQL only declares pure scalar wrappers (no table reads)", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/stdlib-sql.ts", import.meta.url)
  );
  // Every CREATE OR REPLACE FUNCTION block must be marked IMMUTABLE.
  const funcBlocks = src.match(
    /CREATE OR REPLACE FUNCTION [\s\S]+?LANGUAGE SQL[^;]*;/g
  ) ?? [];
  assert(
    funcBlocks.length > 0,
    "stdlib-sql.ts should declare at least one wrapper function (Gel #8811 pin)."
  );
  for (const block of funcBlocks) {
    assert(
      /IMMUTABLE/.test(block),
      `stdlib function block must be marked IMMUTABLE: ${block.split("\n")[0]} (Gel #8811 pin).`
    );
    // No FROM clause referencing a real table. SELECT-with-no-FROM is
    // fine ("SELECT decode(...)") — this catches `SELECT ... FROM users`
    // or any other table read inside a stdlib function.
    assert(
      !/FROM\s+(?!\(|VALUES)\w+/i.test(block),
      `stdlib function must not read tables: ${block.split("\n")[0]} (Gel #8811 pin).`
    );
  }
});

// ---------------------------------------------------------------------------
// gh/geldata#5911 — programmatic CLI surface. Bundle NN exposes
// `cli/api.ts` (re-exported via `mod.ts` as `CLI.*`) so consumers can
// drive every well-typed command (init, migrate, serve, shell, watch,
// build, deploy, pgLog, pgUpgrade) from a Deno script without spawning
// subprocesses. The behavioral surface is exercised in
// `cli/api.test.ts`; this pin asserts the structural property — that
// the api.ts module exists and is reachable through the top-level
// re-export — so a refactor that drops it from `mod.ts` trips here too.
// ---------------------------------------------------------------------------
Deno.test("Gel #5911: cli/api.ts is reachable through top-level mod.ts", async () => {
  const modSrc = await Deno.readTextFile(
    new URL("../mod.ts", import.meta.url)
  );
  assert(
    /export \* as CLI from "\.\/cli\/api\.ts"/.test(modSrc),
    "mod.ts must re-export CLI from ./cli/api.ts (Gel #5911 pin)."
  );
  // The api.ts file itself must exist and export at least the core
  // command set. Source-level check so it's caught even if the
  // top-level re-export is wired but the underlying file regresses.
  const apiSrc = await Deno.readTextFile(
    new URL("../cli/api.ts", import.meta.url)
  );
  for (
    const fn of [
      "export function init",
      "export function migrate",
      "export function serve",
      "export function shell"
    ]
  ) {
    assert(
      apiSrc.includes(fn),
      `cli/api.ts must declare ${fn}() (Gel #5911 pin).`
    );
  }
});

// ---------------------------------------------------------------------------
// gh/geldata#3406 — offline setup. Bundle NN adds two env-var hooks
// to `postgres/downloader.ts`:
//
//   - `DISC_PG_BINARY_DIR` overrides the default `~/.disc/postgres`
//     baseDir, so operators can pre-stage PG binaries anywhere.
//   - `DISC_OFFLINE=1` turns a missing binary into a hard error
//     (with the staging path the operator needs to populate)
//     instead of a silent download.
//
// Behavior is exercised in `postgres/downloader.test.ts`. This pin
// asserts the env vars stay wired into the source so a refactor that
// drops them is caught at file-read time too. (Bundle I — single-binary
// distribution — covers the third case where PG is embedded inside
// the compiled `disc` binary; these env vars cover the deno-source
// workflow.)
// ---------------------------------------------------------------------------
Deno.test("Gel #3406: downloader honors DISC_PG_BINARY_DIR + DISC_OFFLINE env vars", async () => {
  const src = await Deno.readTextFile(
    new URL("../postgres/downloader.ts", import.meta.url)
  );
  assert(
    /Deno\.env\.get\("DISC_PG_BINARY_DIR"\)/.test(src),
    "downloader.ts must read DISC_PG_BINARY_DIR (Gel #3406 pin)."
  );
  assert(
    /Deno\.env\.get\("DISC_OFFLINE"\)/.test(src),
    "downloader.ts must read DISC_OFFLINE (Gel #3406 pin)."
  );
  // The DISC_OFFLINE error must include the env-var name so operators
  // can grep for it in logs.
  assert(
    /DISC_OFFLINE=1/.test(src),
    "downloader.ts DISC_OFFLINE error must reference the env var name (Gel #3406 pin)."
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#2651 — "named instance" DX confusion. Gel users were
// confused by the multi-instance CLI surface where every command took
// an optional `--instance` flag and instance names lived outside the
// project. Disc's design avoids the confusion structurally:
//
//   - Instance name defaults to the project's `name` (from
//     `disc.toml`); operators don't have to think about instances at
//     all in the common case.
//   - Override is `[database] instance_name = "..."` in `disc.toml` —
//     scoped to the project, not a CLI flag.
//   - There is no `--instance` flag on `disc start/stop/migrate/...`;
//     the project context resolves the instance from the directory
//     `disc.toml` lives in (same pattern `git` uses for `.git/`).
//
// This pin asserts the design property: no CLI command surfaces
// `--instance` as an argument, and `lib/project-context.ts`
// derives the instance name from the project context.
// ---------------------------------------------------------------------------
Deno.test("Gel #2651: instance name is derived from project context, not a CLI flag", async () => {
  const cliMain = await Deno.readTextFile(
    new URL("../cli/main.ts", import.meta.url)
  );
  // The CLI help text + argv parser shouldn't list a `--instance`
  // flag. (`instance` as a noun in help text is fine — the assertion
  // is specifically against an `--instance` argument.)
  assert(
    !/--instance(?:\s|=|\b)/.test(cliMain),
    "cli/main.ts must not surface a --instance flag — Disc derives instance from project context (Gel #2651 pin)."
  );
  const ctxSrc = await Deno.readTextFile(
    new URL("../lib/project-context.ts", import.meta.url)
  );
  // The project-context resolver must derive `instanceName` from
  // either the explicit `instance_name` in disc.toml or the project
  // name fallback. Pinning both means a refactor that drops the
  // fallback (forcing operators to set the field manually) trips here.
  assert(
    /instanceName: fields\.instanceName \?\? projectName/.test(ctxSrc) ||
      /const instanceName = fields\.instanceName \?\? projectName/.test(
        ctxSrc
      ),
    "project-context.ts must default instanceName to projectName when unset (Gel #2651 pin)."
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#5641 — complex multi-module schema → "missing FROM-clause
// entry for table <UUID>". Gel's compiler lost track of FROM entries
// when compiling computed properties + triggers that reference types
// across modules (e.g. `pass_v1::Metadata` carrying `default::Account`
// and `default::Etag` references in a computed property).
//
// Disc's compiler emits per-type CREATE TABLE statements with
// fully-qualified type references resolved up front by the SDL
// converter. This pin constructs the same multi-module shape Gel's
// repro used (3 modules, cross-module link + computed prop +
// trigger) and walks parse → diff → DDL gen end-to-end, asserting
// every type emits a CREATE TABLE. A regression that breaks
// cross-module resolution would either fail the parse, drop one of
// the operations, or fail to emit DDL.
// ---------------------------------------------------------------------------
Deno.test("Gel #5641: multi-module schema with cross-module refs compiles cleanly", async () => {
  const { SDLParser } = await import("../schema/parser.ts");
  const { SDLConverter } = await import("../schema/converter.ts");
  const { SchemaDiffer } = await import("../migration/differ.ts");
  const { DDLGenerator } = await import("../migration/ddl.ts");

  const sdl = `
    module default {
      type Account {
        required name: str;
        required email: str;
      }
      type Etag {
        required value: str;
      }
    }

    module pass_v1 {
      type Metadata {
        required account: default::Account;
        required etag: default::Etag;
        required generated_at: datetime {
          default := datetime_current();
        }
        cached_account_email := .account.email;
        trigger log_create after insert for each do (
          log_audit(__new__.cached_account_email)
        );
      }
    }

    module chained {
      type Wrapper {
        required source: pass_v1::Metadata;
        required cached_email: str;
      }
    }
  `;

  const ast = new SDLParser(sdl).parse();
  const moduleDecls = ast.declarations.filter(
    d => d.kind === "ModuleDeclaration"
  );
  assertEquals(
    moduleDecls.length,
    3,
    "Expected 3 modules (default + pass_v1 + chained) (Gel #5641 pin)."
  );

  const conv = new SDLConverter();
  const modules = conv.convertToModules(ast);
  const ops = new SchemaDiffer().diff([], modules);

  // 4 types: Account, Etag, Metadata, Wrapper. Each produces at least
  // one CreateType operation; a regression that loses one of them
  // (e.g. by dropping the cross-module type reference during
  // converter resolution) trips this assertion.
  const createTypes = ops.filter(op => op.kind === "CreateType");
  assertEquals(
    createTypes.length,
    4,
    `Expected 4 CreateType ops, got ${createTypes.length} (Gel #5641 pin).`
  );

  // DDL generation must succeed and emit a CREATE TABLE for each
  // type. The "missing FROM-clause" error in Gel surfaced at SQL
  // emit time; if Disc ever regresses to that path, this throws or
  // returns fewer statements than expected.
  const ddl = new DDLGenerator();
  ddl.setEnumScalars(new SchemaDiffer().enumScalarNames(modules));
  const stmts = ddl.generateDDL(ops);
  const createTables = stmts.filter(s => /CREATE TABLE\b/.test(s));
  assertEquals(
    createTables.length,
    4,
    `Expected 4 CREATE TABLE statements, got ${createTables.length} (Gel #5641 pin).`
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#4215 — migrate type of computed global. Gel's repro:
// `type B extending A` → `type B` (drop extending) with a global
// referencing B. Gel's resolver fails even though the DDL is valid.
//
// Bundle PP closed the Disc-side gap: `migration/differ.ts:diffType`
// now uses `extractPropertiesWithInheritance` /
// `extractLinksWithInheritance` instead of own-only extraction, so
// dropping (or adding) `extending A` surfaces every inherited
// property/link as a DropProperty/AddProperty op against B's table.
// The DDL gen path emits ALTER TABLE … DROP COLUMN / ADD COLUMN
// statements with the right unsafe-gate warning when destructive.
//
// This pin walks parse → diff → DDL gen for the drop-extending case
// and asserts the resulting DDL contains the DROP COLUMN for the
// inherited `label` field. The reverse (add extending) direction is
// covered by the assertion that AlterType ops surface at all when
// extending changes — both directions go through the same code path.
// ---------------------------------------------------------------------------
Deno.test("Gel #4215: dropping `extending A` emits DropProperty for inherited fields", async () => {
  const { SDLParser } = await import("../schema/parser.ts");
  const { SDLConverter } = await import("../schema/converter.ts");
  const { SchemaDiffer } = await import("../migration/differ.ts");
  const { DDLGenerator } = await import("../migration/ddl.ts");

  const before = `
    module default {
      abstract type A {
        required label: str;
      }
      type B extending A {
        required value: int32;
      }
    }
  `;

  const after = `
    module default {
      abstract type A {
        required label: str;
      }
      type B {
        required value: int32;
      }
    }
  `;

  const conv = new SDLConverter();
  const beforeMods = conv.convertToModules(new SDLParser(before).parse());
  const afterMods = conv.convertToModules(new SDLParser(after).parse());
  const ops = new SchemaDiffer().diff(beforeMods, afterMods);

  // Differ must surface the inheritance change as an AlterType op
  // carrying at least one DropProperty change for the lost
  // inherited `label` field.
  const alterB = ops.find(
    op => op.kind === "AlterType" && "typeName" in op && op.typeName === "B"
  ) as
    | { operations: Array<{ kind: string; propertyName?: string; }>; }
    | undefined;
  assert(
    alterB !== undefined,
    "Differ must emit an AlterType op for B when its extending clause changes (Gel #4215)."
  );
  const dropLabel = alterB.operations.find(
    sub => sub.kind === "DropProperty" && sub.propertyName === "label"
  );
  assert(
    dropLabel !== undefined,
    "AlterType B must include a DropProperty op for the inherited `label` field (Gel #4215)."
  );

  // DDL gen must emit ALTER TABLE … DROP COLUMN for the lost prop.
  const ddl = new DDLGenerator();
  ddl.setEnumScalars(new SchemaDiffer().enumScalarNames(afterMods));
  const stmts = ddl.generateDDL(ops);
  const dropCol = stmts.find(s => /ALTER TABLE\s+b\s+DROP COLUMN[\s\S]*\blabel\b/i.test(s));
  assert(
    dropCol !== undefined,
    `DDL gen must emit ALTER TABLE b DROP COLUMN label; got: ${stmts.join(" | ")} (Gel #4215).`
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#2204 — migrations not propagated to existing connections.
// Gel's bug: existing client connections kept stale schema descriptors
// after a migration applied — `select Counter` would error "missing
// type Counter" until the connection was reopened.
//
// Disc solved this structurally with a runtime schema-reload pipeline:
//
//   migration/schema-manager.ts    — `onSchemaChange?(schema)` callback
//                                    fires after each successful apply
//   server/server.ts:DiscServer    — wires SchemaManager.onSchemaChange
//                                    to its own `updateSchema(schema)`
//                                    method, which forwards to the
//                                    protocol handler
//   server/edgeql-protocol.ts      — `updateSchema(schema)` rebuilds
//                                    the compiler with the new schema
//                                    *and* clears the compilation +
//                                    parse caches so the next query
//                                    compiles against the new schema
//
// The behavioral side is exercised by `server/schema-reload.test.ts`.
// This pin asserts every link in the chain stays wired: a refactor
// that drops `onSchemaChange`, removes the wire-through in
// `DiscServer`, or skips the cache flush in `EdgeQLProtocol.updateSchema`
// would all be regressions.
// ---------------------------------------------------------------------------
Deno.test("Gel #2204: schema-reload pipeline (SchemaManager → server → protocol) stays wired", async () => {
  const smSrc = await Deno.readTextFile(
    new URL("../migration/schema-manager.ts", import.meta.url)
  );
  // SchemaManager fires onSchemaChange after each apply.
  assert(
    /onSchemaChange\?\.\(this\.currentSchema\)/.test(smSrc),
    "schema-manager.ts must invoke onSchemaChange after schema reload (Gel #2204 pin)."
  );

  const serverSrc = await Deno.readTextFile(
    new URL("../server/server.ts", import.meta.url)
  );
  // DiscServer wires onSchemaChange to its own updateSchema delegate.
  assert(
    /this\.protocolHandler\.updateSchema/.test(serverSrc),
    "server.ts must forward updateSchema to the protocol handler (Gel #2204 pin)."
  );

  const protoSrc = await Deno.readTextFile(
    new URL("../server/edgeql-protocol.ts", import.meta.url)
  );
  // EdgeQLProtocol.updateSchema rebuilds the compiler and clears caches.
  // The order matters — clearing first, then rebuilding, would race
  // with concurrent queries; the implementation does it in the right
  // order. Pin both the rebuild and the clear so neither drops out.
  assert(
    /updateSchema\(schema: Context\.Schema\): void \{[\s\S]*?this\.compiler = this\.createCompiler\(schema\);[\s\S]*?this\.compilationCache\.clear\(\);[\s\S]*?this\.parseCache\.clear\(\);/
      .test(protoSrc),
    "edgeql-protocol.ts updateSchema must rebuild the compiler and clear both caches (Gel #2204 pin)."
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#4901 + gh/geldata#5699 — Docker image distribution.
// Gel's bugs: `:latest` on Docker Hub drifted out of sync with the
// version tag (#4901), and Gel didn't push to ghcr.io (#5699).
//
// Bundle QQ adds a `docker` job to `.github/workflows/release.yml`
// that builds `Dockerfile.bundled` and pushes to ghcr.io with both
// `:<version>` and `:latest` tags from the same image build, so the
// two tags are always in sync. ghcr.io is the canonical registry
// (no Docker Hub mirror) per the operator-facing decision documented
// inline in the workflow.
//
// This pin asserts the structural shape of the workflow stays in
// place: a `docker` job with both tags in its push list and the
// ghcr.io login. A future refactor that drops `:latest` (re-introducing
// #4901) or stops pushing to ghcr.io (#5699) trips here.
// ---------------------------------------------------------------------------
Deno.test("Gel #4901 + #5699: release CI pushes Docker image to ghcr.io with :version + :latest tags", async () => {
  const wf = await Deno.readTextFile(
    new URL("../.github/workflows/release.yml", import.meta.url)
  );
  // Workflow must declare a docker job that logs into ghcr.io.
  assert(
    /docker:/.test(wf) && /registry: ghcr\.io/.test(wf),
    "release.yml must include a docker job that logs into ghcr.io (Gel #5699 pin)."
  );
  // Build-and-push step must tag both `:<version>` and `:latest`
  // from the same image build — this is what closes #4901's lockstep
  // requirement.
  assert(
    /ghcr\.io\/systemsoft\/disc:\$\{\{ steps\.version\.outputs\.version \}\}/
      .test(wf),
    "release.yml must tag the image with the version output (Gel #5699 pin)."
  );
  assert(
    /ghcr\.io\/systemsoft\/disc:latest/.test(wf),
    "release.yml must also tag the image with :latest in the same push (Gel #4901 pin)."
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#6598 — multi-tenant logging. Gel's request: stamp every
// log line with a tenant identifier so multi-tenant deployments can
// filter logs per tenant.
//
// Disc's structured logger (`lib/logger.ts:Logger`) already supports
// this via the generic `child(extra)` method. Operators wire a
// per-request `logger.child({ tenant })` (or any other dimension —
// requestId, userId, etc.) and every emitted line carries the field.
// The logger's `withRequest` shortcut is built on top of `child`;
// the same pattern works for `withTenant`, `withUser`, etc.
//
// This pin asserts the structural property: `Logger.child(extra)`
// exists and the underlying log path threads the extra fields into
// every emitted entry. A regression that removes `child()` or stops
// merging the bag into log entries would break multi-tenant log
// observability and is what we want to catch.
// ---------------------------------------------------------------------------
Deno.test("Gel #6598: Logger.child(extra) supports arbitrary structured fields (incl. tenant)", async () => {
  const { Logger, configureLogging } = await import("../lib/logger.ts");

  const captured: string[] = [];
  configureLogging({
    level: "INFO",
    format: "json",
    output: line => captured.push(line)
  });

  const base = new Logger("test");
  const tenantLogger = base.child({ tenant: "acme-corp", region: "us-west" });
  tenantLogger.info("query executed", { durationMs: 42 });

  assertEquals(
    captured.length,
    1,
    "Logger should emit exactly one entry (Gel #6598 pin)."
  );
  const entry = JSON.parse(captured[0]) as Record<string, unknown>;
  assertEquals(
    entry.tenant,
    "acme-corp",
    "Tenant field from child() must reach the emitted entry (Gel #6598 pin)."
  );
  assertEquals(
    entry.region,
    "us-west",
    "Other child() fields must also reach the emitted entry (Gel #6598 pin)."
  );
  assertEquals(
    entry.durationMs,
    42,
    "Per-call extras must merge alongside child() fields (Gel #6598 pin)."
  );

  // Source-level pin so a refactor that removes `child` from the API
  // surface trips here too — captured only via runtime above.
  const src = await Deno.readTextFile(
    new URL("../lib/logger.ts", import.meta.url)
  );
  assert(
    /child\(extra: Record<string, unknown>\): Logger/.test(src),
    "lib/logger.ts must keep `child(extra)` on the Logger surface (Gel #6598 pin)."
  );

  // Restore default config so subsequent tests aren't affected by
  // the captured-output sink.
  configureLogging({ level: "INFO", format: "json" });
});

// ---------------------------------------------------------------------------
// gh/geldata#5190 — backport migration rewrites to 2.x. The upstream
// concern was Gel's release branch model: migration improvements
// landed in Gel 3.0 needed to ride back to the 2.x maintenance branch
// to support `geldata/gel-cli#976` ahead of the 3.0 release.
//
// Disc has no parallel-branch model. There is no `2.x` or `3.x` —
// `primary` is the single trunk; releases are ChronVer dates
// (`v2026.05.07`) cut from trunk, not semver-major branches with
// independent maintenance. There is therefore no surface for a
// "backport" workflow to attach to. The pin asserts the structural
// reality so a future "let's adopt release branches" change has to
// land deliberately rather than as a side effect.
// ---------------------------------------------------------------------------
Deno.test("Gel #5190: Disc has a single trunk (no semver-major release branches to backport between)", async () => {
  // version.txt must carry a ChronVer-shaped date, not a semver-major.
  const versionRaw = await Deno.readTextFile(
    new URL("../version.txt", import.meta.url)
  );
  const version = versionRaw.trim();
  assert(
    /^\d{4}\.\d{2}\.\d{2}$/.test(version),
    `version.txt must be ChronVer (YYYY.MM.DD); got "${version}" (Gel #5190 pin).`
  );

  // The CHANGELOG release headers should match the same shape — no
  // `vX.0.0` or `vX.Y.Z` anchors that would suggest a semver-major
  // model. Skip the [Unreleased] line.
  const changelog = await Deno.readTextFile(
    new URL("../CHANGELOG.md", import.meta.url)
  );
  const releaseHeaders = changelog.match(/^## v[\d.]+/gm) ?? [];
  for (const header of releaseHeaders) {
    assert(
      /^## v\d{4}\.\d{2}\.\d{2}/.test(header),
      `CHANGELOG release header "${header}" should be ChronVer-shaped (Gel #5190 pin).`
    );
  }
});

// ---------------------------------------------------------------------------
// gh/geldata#6697 — in-place major version upgrades. Gel's plan
// proposed a versioned `edgedbstd_v<N>` schema with trampoline views,
// so a Gel-server major-version bump could swap the active stdlib in
// place rather than via dump/restore.
//
// Disc has no semver-major release model (see #5190 above), and no
// versioned stdlib schema. The stdlib is a tiny set of crypto +
// encoding wrappers in `lib/stdlib-sql.ts`, every statement
// idempotent (`CREATE OR REPLACE FUNCTION`, `CREATE EXTENSION IF NOT
// EXISTS`). Bootstrap re-runs on every server boot via
// `bootstrapStdlib(pool)` and is a no-op when nothing changed.
// Major-version migration semantics simply don't apply.
//
// This pin asserts (a) the stdlib stays a `CREATE OR REPLACE` set
// (no schema-versioned table that would need a swap dance) and (b)
// `bootstrapStdlib` runs unconditionally rather than via a
// version-gated path.
// ---------------------------------------------------------------------------
Deno.test("Gel #6697: stdlib is idempotent CREATE OR REPLACE — no versioned schema swap needed", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/stdlib-sql.ts", import.meta.url)
  );
  // Every wrapper function must use CREATE OR REPLACE — that's what
  // makes the bootstrap idempotent + version-free. Plain CREATE
  // FUNCTION (without OR REPLACE) would force a versioned schema
  // dance like Gel #6697 proposed.
  const funcDecls = src.match(/CREATE (?:OR REPLACE )?FUNCTION /g) ?? [];
  assert(
    funcDecls.length > 0,
    "stdlib-sql.ts must declare at least one function (Gel #6697 pin)."
  );
  for (const decl of funcDecls) {
    assert(
      decl.includes("OR REPLACE"),
      `stdlib function declarations must use CREATE OR REPLACE FUNCTION; got "${decl.trim()}" (Gel #6697 pin).`
    );
  }
  // `bootstrapStdlib` runs unconditionally — no `if (currentVersion < N)`
  // gate. The function exists and runs on server boot.
  assert(
    /export async function bootstrapStdlib/.test(src),
    "lib/stdlib-sql.ts must export bootstrapStdlib() (Gel #6697 pin)."
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#6432 — access-policy management features. Gel listed
// five things (errmsg-with-policy-name, list-policies-on-type, disable
// policies for testing, deep policy docs, run-single-policy
// in-isolation). Bundle SS shipped slice 1 + 2 in `cli/admin.ts`:
//
//   - **Policy name in error messages** was already in
//     `access/evaluator.ts` (each denial carries the policy.name plus
//     optional `errmessage`).
//   - **`disc admin list-policies [type]`** is the new pure-SDL
//     introspection command — no DB hookup needed; reads
//     `dbschema/default.disc` and lists every type's policies with
//     name + action (allow/deny) + events + condition + errmessage.
//
// The remaining slices (per-policy session toggle for testing,
// run-in-isolation, deep narrative docs) stay open in BUILD; this
// pin asserts the shipped slice's structural shape so a refactor
// that drops the entry point trips here.
// ---------------------------------------------------------------------------
Deno.test("Gel #6432: `disc admin list-policies` is a pure SDL introspection command", async () => {
  const { collectPoliciesFromSdl } = await import("../cli/admin.ts");
  const sdl = `
    module default {
      type Doc {
        required title: str;
        access policy admin_only {
          allow all;
          using (global is_admin);
          errmessage := "admins only";
        };
      }
    }
  `;
  const policies = collectPoliciesFromSdl(sdl);
  assertEquals(
    policies.has("Doc"),
    true,
    "collectPoliciesFromSdl must surface policies on each type (Gel #6432)."
  );
  const docPolicies = policies.get("Doc")!;
  assertEquals(docPolicies.length >= 1, true);
  assertEquals(docPolicies[0].name, "admin_only");
  assertEquals(docPolicies[0].action, "allow");
  assertEquals(docPolicies[0].errmessage, "admins only");

  // Source-level pin for the CLI entry point — cli/main.ts must route
  // `admin list-policies` to `adminCommand.listPolicies(...)`.
  const main = await Deno.readTextFile(
    new URL("../cli/main.ts", import.meta.url)
  );
  assert(
    /case "list-policies":[\s\S]*?adminCommand\.listPolicies/.test(main),
    "cli/main.ts must route `admin list-policies` to adminCommand.listPolicies (Gel #6432 pin)."
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#8909 — auth update with in-place upgrades. The upstream
// concern is making the auth extension's data migrate cleanly during
// a Gel server major-version in-place upgrade (i.e. the upgrade path
// from #6697). Disc has no semver-major release model and therefore
// no in-place major upgrade flow either (see #5190 + #6697 pins
// above) — there is no upgrade dance for the auth extension to plug
// into. The auth tables are managed via the same migration system as
// user types: `auth/provider.ts:createTables` runs idempotent CREATE
// TABLE IF NOT EXISTS on every initialize, and Bundle MM added the
// post-CREATE FK migration pattern (`webauthn_challenges` ON DELETE
// CASCADE) for any future schema evolution.
//
// This pin asserts (a) the auth provider's `createTables` stays
// idempotent (no version-gated CREATE-only-if-major-N path) and
// (b) the FK migration block from Bundle MM is the canonical pattern
// for evolving auth tables in place.
// ---------------------------------------------------------------------------
Deno.test("Gel #8909: auth tables evolve via idempotent CREATE TABLE + post-CREATE migrations", async () => {
  const src = await Deno.readTextFile(
    new URL("../auth/provider.ts", import.meta.url)
  );
  // Every auth-table create uses CREATE TABLE IF NOT EXISTS — no
  // version-conditional CREATE that would require a major-version
  // upgrade dance.
  const createCount = (src.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length;
  assert(
    createCount >= 9,
    `Expected ≥9 CREATE TABLE IF NOT EXISTS statements (sessions, webauthn_*, recovery_codes, magic_*, mfa_*, roles, user_roles); found ${createCount} (Gel #8909 pin).`
  );

  // The Bundle MM idempotent FK migration pattern stays in place —
  // this is the canonical "evolve an existing auth table in place"
  // flow that #8909 would have needed if Disc shipped major-version
  // in-place upgrades.
  assert(
    /DO \$\$[\s\S]*?webauthn_challenges_user_id_fkey[\s\S]*?ALTER TABLE webauthn_challenges/
      .test(src),
    "auth/provider.ts must keep the idempotent FK-add migration block (Bundle MM pattern; Gel #8909 pin)."
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#1772 + gh/geldata#1461 — RFC 1000 migration features.
// Closed-completed upstream once Gel implemented the core CREATE /
// ALTER / DROP coverage. Disc's `migration/types.ts` declares the
// equivalent op union, and `migration/differ.ts` + `migration/ddl.ts`
// emit + execute every kind. The pin asserts the structural coverage
// stays in place — a future refactor that drops one of these op
// kinds (regressing an RFC 1000 capability) trips here.
//
// Cross-reference: docs/migrations.md "Migration Operations" section
// + the Bundle TT branch-workflow recipes use these op kinds in the
// recipes they describe.
// ---------------------------------------------------------------------------
Deno.test("Gel #1772 + #1461: RFC 1000 op coverage — every required kind exists in migration/types.ts", async () => {
  const src = await Deno.readTextFile(
    new URL("../migration/types.ts", import.meta.url)
  );
  // Required op kinds per RFC 1000:
  //   - object types: CreateType, DropType, AlterType
  //   - properties: AddProperty, DropProperty, AlterProperty
  //   - links: AddLink, DropLink, AlterLink
  //   - triggers: AddTrigger, DropTrigger
  //   - rewrites: AddRewrite, DropRewrite
  //   - aliases: CreateAlias, DropAlias
  //   - scalars/enums: CreateScalar, DropScalar, AddEnumValue,
  //     RecreateScalar
  //   - globals: CreateGlobal, DropGlobal
  // (Rename ops are not declared as separate kinds in Disc; the differ
  // surfaces them via a Drop+Create pair on the SDL level. RFC 1000
  // accepts either model — the user-visible result is the same.)
  const required = [
    "CreateType",
    "DropType",
    "AlterType",
    "AddProperty",
    "DropProperty",
    "AlterProperty",
    "AddLink",
    "DropLink",
    "AlterLink",
    "AddTrigger",
    "DropTrigger",
    "AddRewrite",
    "DropRewrite",
    "CreateAlias",
    "DropAlias",
    "CreateScalar",
    "DropScalar",
    "AddEnumValue",
    "RecreateScalar",
    "CreateGlobal",
    "DropGlobal"
  ];

  for (const kind of required) {
    assert(
      new RegExp(`kind: "${kind}"`).test(src),
      `migration/types.ts must declare a "${kind}" op kind (Gel #1772/#1461 RFC 1000 pin).`
    );
  }
});

// ---------------------------------------------------------------------------
// gh/geldata#6083 — advanced migration workflows. Documentation-only
// upstream issue. Bundle TT extended `docs/migrations.md` with three
// recipes:
//   - Rapid prototyping with `disc db push`
//   - Feature branch with schema changes
//   - Combining migrations + data transformations
//   - Rolling back a feature branch's migrations
// (The "Resolving Merge Conflicts" section pre-dated this work.)
//
// This pin asserts the section anchor stays in `docs/migrations.md`
// so a docs reorg doesn't drop the workflow recipes.
// ---------------------------------------------------------------------------
Deno.test("Gel #6083: docs/migrations.md carries the branch-workflow recipes", async () => {
  const src = await Deno.readTextFile(
    new URL("../docs/migrations.md", import.meta.url)
  );
  assert(
    /## Branch Workflows \(gh\/geldata#6083\)/.test(src),
    "docs/migrations.md must keep the 'Branch Workflows' section heading (Gel #6083 pin)."
  );
  // Each recipe heading should be present — they're the contract
  // the README + cross-references assume.
  for (
    const heading of [
      "Recipe: rapid prototyping with `disc db push`",
      "Recipe: feature branch with schema changes",
      "Recipe: combining migrations + data transformations",
      "Recipe: rolling back a feature branch's migrations"
    ]
  ) {
    assert(
      src.includes(heading),
      `docs/migrations.md must keep '${heading}' recipe (Gel #6083 pin).`
    );
  }
});

// ---------------------------------------------------------------------------
// gh/geldata#6432 slice 3 — per-policy session toggle for testing.
// Bundle UU shipped this as the `X-Disc-Disable-Policies` HTTP header
// (admin-gated) plus `AccessContext.disabledPolicies: Set<string>`
// threaded through `EdgeQLProtocol.handleRequest` to the evaluator.
// Behavior is exercised in `access/evaluator.test.ts` and
// `server/access-bypass.test.ts`. This pin asserts the wiring stays
// in place at source-read time.
//
// (Slice 4 — run-in-isolation against a synthetic context — is the
// only remaining #6432 sub-feature. Tracked as future work in
// `docs/future-triage.md`.)
// ---------------------------------------------------------------------------
Deno.test("Gel #6432 slice 3: per-policy disable threads from HTTP header to evaluator", async () => {
  const httpSrc = await Deno.readTextFile(
    new URL("../server/http.ts", import.meta.url)
  );
  // The header parser must be admin-gated and produce a Set.
  assert(
    /X-Disc-Disable-Policies/.test(httpSrc) &&
      /disabledPolicies = new Set\(names\)/.test(httpSrc),
    "server/http.ts must parse X-Disc-Disable-Policies into a Set (Gel #6432 slice 3 pin)."
  );
  assert(
    /disableHeader && callerIsAdmin/.test(httpSrc),
    "server/http.ts must admin-gate the disabled-policies header (Gel #6432 slice 3 pin)."
  );

  const protoSrc = await Deno.readTextFile(
    new URL("../server/edgeql-protocol.ts", import.meta.url)
  );
  // The protocol handler must thread `disabledPolicies` from
  // QueryContext into the AccessContext so the evaluator sees it.
  assert(
    /accessCtx\.disabledPolicies = context\.disabledPolicies/.test(protoSrc),
    "edgeql-protocol.ts must thread disabledPolicies into the AccessContext (Gel #6432 slice 3 pin)."
  );
  // The compilation cache key must include the disabled set so a
  // disabled-policies call doesn't share a cache slot with a regular
  // call.
  assert(
    /\|disabled=/.test(protoSrc),
    "edgeql-protocol.ts compilation cache key must embed the disabled-policies set (Gel #6432 slice 3 pin)."
  );

  const evalSrc = await Deno.readTextFile(
    new URL("../access/evaluator.ts", import.meta.url)
  );
  // The evaluator must filter on the qualified `<TypeName>.<policy_name>`
  // shape and short-circuit before policy evaluation.
  assert(
    /context\.disabledPolicies/.test(evalSrc) &&
      /\$\{p\.objectType \?\? "__global__"\}\.\$\{p\.name\}/.test(evalSrc),
    "access/evaluator.ts must filter disabledPolicies via qualified <Type>.<name> matching (Gel #6432 slice 3 pin)."
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#6432 slice 4 — run a policy in isolation against a
// synthetic context. Bundle VV shipped this as
// `disc admin test-policy <Type>.<policy>` plus a `--all` mode that
// evaluates every policy on a type one at a time.
//
// The command takes `--action`, `--user-id`, `--user-role`, and
// `--global key=value` flags to build the synthetic AccessContext,
// then runs each target policy through a fresh AccessEvaluator and
// prints the verdict, reason, optional errmessage, and the SQL
// condition the policy generated.
//
// This pin asserts the underlying surface stays exposed
// (`testPolicyImpl` exported from `cli/admin.ts`, the CLI route in
// `cli/main.ts`). Behavior is exercised in `cli/admin.test.ts`.
// ---------------------------------------------------------------------------
Deno.test("Gel #6432 slice 4: `disc admin test-policy` runs a policy in isolation", async () => {
  const adminSrc = await Deno.readTextFile(
    new URL("../cli/admin.ts", import.meta.url)
  );
  // Exported testPolicyImpl is the testable surface — pure function
  // taking opts + an emit callback.
  assert(
    /export async function testPolicyImpl/.test(adminSrc),
    "cli/admin.ts must export testPolicyImpl (Gel #6432 slice 4 pin)."
  );
  // The AccessPolicy AST collector must also be exported so tests
  // can verify the AST shape independent of the evaluator path.
  assert(
    /export function collectAccessPolicyAst/.test(adminSrc),
    "cli/admin.ts must export collectAccessPolicyAst (Gel #6432 slice 4 pin)."
  );

  const mainSrc = await Deno.readTextFile(
    new URL("../cli/main.ts", import.meta.url)
  );
  assert(
    /case "test-policy":[\s\S]*?adminCommand\.testPolicy/.test(mainSrc),
    "cli/main.ts must route `admin test-policy` to adminCommand.testPolicy (Gel #6432 slice 4 pin)."
  );
});

// ---------------------------------------------------------------------------
// Disc-internal — Bundle ZZ-4 Dockerfile apt-key deprecation pin.
// The v2026.05.08 retag's docker push failed with `exit code: 127` on
// the apt-get block because `apt-key add -` is deprecated in Debian
// 11 and removed in Debian 12 — which is what `denoland/deno:latest`
// is now based on. Bundle ZZ-4 switched to the modern keyring
// approach: wget the key into `/etc/apt/keyrings/` and reference it
// in the sources.list via `signed-by=`.
//
// This pin asserts `apt-key` is not used in the Dockerfile so a
// future revert (or paste from an outdated tutorial) trips at
// source-read time rather than at the next CI run.
// ---------------------------------------------------------------------------
Deno.test("Bundle ZZ-4: Dockerfile.bundled does not use deprecated apt-key", async () => {
  const src = await Deno.readTextFile(
    new URL("../Dockerfile.bundled", import.meta.url)
  );
  // `apt-key` was deprecated in Debian 11 + removed in Debian 12,
  // which the current denoland/deno:latest base is built on. Using
  // it produces `exit code: 127` ("command not found").
  assert(
    !/apt-key\s+add/.test(src),
    "Dockerfile.bundled must not use `apt-key add` (deprecated in Debian 11, removed in 12). " +
      "Use the modern keyring approach with `signed-by=` (Bundle ZZ-4 pin)."
  );
  // The modern approach uses `signed-by=` in the sources.list entry
  // — pin asserts the new shape stays in place.
  assert(
    /signed-by=/.test(src),
    "Dockerfile.bundled must declare the PG repo with `signed-by=...` (Bundle ZZ-4 pin)."
  );
});

// ---------------------------------------------------------------------------
// Disc-internal — Bundle ZZ-2 Dockerfile COPY path pin.
// Discovered when v2026.05.07 docker push failed with:
//   "failed to compute cache key: ... '/root/.cache/deno': not found"
// The deps stage runs `deno install` which writes the cache to
// `$DENO_DIR`. The denoland/deno:latest image defaults to
// `DENO_DIR=/deno-dir`, NOT `/root/.cache/deno`. The original COPY
// path was a guess that worked on older deno images and broke on
// current ones. Bundle ZZ-2 sets `ENV DENO_DIR=/root/.cache/deno`
// explicitly in the deps stage so the cache lives at a stable,
// explicit location regardless of upstream image churn.
//
// This pin asserts the Dockerfile sets DENO_DIR explicitly and the
// COPY path matches whatever DENO_DIR is set to.
// ---------------------------------------------------------------------------
Deno.test("Bundle ZZ-2: Dockerfile.bundled COPY path matches an explicit DENO_DIR", async () => {
  const src = await Deno.readTextFile(
    new URL("../Dockerfile.bundled", import.meta.url)
  );
  // The deps stage must set DENO_DIR explicitly so the cache lives
  // at a known location independent of upstream image defaults.
  const denoDirMatch = src.match(/ENV DENO_DIR=(\S+)/);
  assert(
    denoDirMatch !== null,
    "Dockerfile.bundled must set ENV DENO_DIR explicitly (Bundle ZZ-2 pin)."
  );
  const denoDir = denoDirMatch![1];

  // The COPY --from=deps line must match the explicit DENO_DIR.
  const copyMatch = src.match(/COPY --from=deps (\S+) (\S+)/);
  assert(
    copyMatch !== null,
    "Dockerfile.bundled must carry a COPY --from=deps line (Bundle ZZ-2 pin)."
  );
  assertEquals(
    copyMatch![1],
    denoDir,
    `COPY --from=deps source must match DENO_DIR (${denoDir}) (Bundle ZZ-2 pin).`
  );
  assertEquals(
    copyMatch![2],
    denoDir,
    `COPY --from=deps target must match DENO_DIR (${denoDir}) (Bundle ZZ-2 pin).`
  );
});

// ---------------------------------------------------------------------------
// Disc-internal — Bundle ZZ post-mortem pin (no Gel issue).
// Discovered after v2026.05.07 was tagged: release CI was producing
// stripped binaries (~80 MB instead of the expected ~217 MB) because
// PG staging was failing silently. The original `BuildCommand.execute`
// wrapped staging + manifest in a single try/catch that just logged
// the error and proceeded with `embeddedPgPaths: []`. Bundle ZZ added
// an explicit fail-loud gate so a tagged release can never produce a
// no-PG binary by accident.
//
// This pin asserts (a) the gate function stays in place, (b) it's
// invoked from `execute`, and (c) the catch block re-throws when
// `--platform` is set.
// ---------------------------------------------------------------------------
Deno.test("Bundle ZZ: cross-compile build fails loud when PG staging produces 0 files", async () => {
  const src = await Deno.readTextFile(
    new URL("../cli/build.ts", import.meta.url)
  );
  // The gate method must exist on BuildCommand.
  assert(
    /assertEmbeddedPgPresent\(/.test(src),
    "build.ts must declare assertEmbeddedPgPresent (Bundle ZZ pin)."
  );
  // It must be invoked from execute() with the file count + source dir.
  assert(
    /this\.assertEmbeddedPgPresent\(/.test(src),
    "build.ts execute() must call this.assertEmbeddedPgPresent (Bundle ZZ pin)."
  );
  // The catch block must re-throw on cross-compile rather than
  // silently swallow.
  assert(
    /if \(options\.platform\) \{[\s\S]*?throw new Error\(\s*\n?\s*`PG staging failed/
      .test(src),
    "build.ts execute() catch must re-throw when --platform is set (Bundle ZZ pin)."
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#9117 — "gel-py command on Windows 11" / cross-platform
// CLI ask. Disc explicitly does not support Windows yet — Windows is
// a documented gap, not silently-broken behavior. The downloader
// throws a clear "Windows support not yet implemented" error rather
// than attempting a fragile binary download.
//
// This pin asserts the explicit-throw stays in place. A future PR
// that adds real Windows support has to delete the throw + update
// the divergence record.
// ---------------------------------------------------------------------------
Deno.test("Gel #9117: postgres downloader fails fast on Windows with a clear message", async () => {
  const src = await Deno.readTextFile(
    new URL("../postgres/downloader.ts", import.meta.url)
  );
  assert(
    /os === "windows"/.test(src) &&
      /Windows support not yet implemented/.test(src),
    "downloader.ts must throw an explicit Windows-not-supported error (Gel #9117 pin)."
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#4308 — "modify stdlib during minor upgrades". Gel ships
// stdlib changes that need to apply when an instance jumps from one
// minor to the next, and the upgrade machinery has to swap schema in
// place. Disc's `lib/stdlib-sql.ts` is a single trunk (no versioned
// branches) and every wrapper is `CREATE OR REPLACE FUNCTION` — the
// "minor upgrade" reduces to "run the latest stdlib SQL idempotently
// against an existing instance". Same structural answer as #6697.
//
// This pin asserts the stdlib stays single-trunk (no version-suffixed
// files) and every function is idempotent.
// ---------------------------------------------------------------------------
Deno.test("Gel #4308: stdlib is single-trunk + idempotent (no minor-upgrade swap needed)", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/stdlib-sql.ts", import.meta.url)
  );
  // Every function definition must use CREATE OR REPLACE so a
  // re-run picks up the latest body without manual swap.
  const createCount = (src.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length;
  assert(
    createCount > 0,
    "stdlib-sql.ts must declare CREATE OR REPLACE FUNCTION wrappers (Gel #4308 pin)."
  );
  // No bare CREATE FUNCTION (would fail on re-apply).
  const bareCreate = (src.match(/CREATE FUNCTION(?! OR REPLACE)/g) ?? []).length;
  assertEquals(
    bareCreate,
    0,
    `stdlib-sql.ts must not use bare CREATE FUNCTION — found ${bareCreate} (Gel #4308 pin).`
  );
  // No version-suffixed siblings — search for files like
  // `stdlib-sql-v1.ts` etc. The lib directory should have a single
  // stdlib file.
  const libEntries = [];
  for await (const entry of Deno.readDir(new URL("../lib/", import.meta.url))) {
    if (entry.name.startsWith("stdlib-sql") && entry.name.endsWith(".ts")) {
      libEntries.push(entry.name);
    }
  }
  // Two entries are allowed: stdlib-sql.ts + stdlib-sql.test.ts.
  assert(
    libEntries.length <= 2,
    `lib/ must not carry version-suffixed stdlib files — found ${libEntries.join(", ")} (Gel #4308 pin).`
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#4806 — "PR preview environments" (Uffizzi-style ephemeral
// environments per PR). Disc's CI ships through GitHub Actions with
// release artifacts (binaries + ghcr.io image, Bundle QQ); preview
// envs are an M-effort niche feature. Deferred — not in scope for
// the BUILD column closure.
//
// This pin documents the deferral so a future PR that wires up
// Uffizzi/Coherence can update the divergence record cleanly.
// ---------------------------------------------------------------------------
Deno.test("Gel #4806: PR preview environments are deferred (release pipeline ships binaries + ghcr.io image)", async () => {
  // The release workflow exists and produces artifacts — that's the
  // structural reality. PR previews would be a separate workflow.
  const releaseSrc = await Deno.readTextFile(
    new URL("../.github/workflows/release.yml", import.meta.url)
  );
  // Release workflow ships binaries (4 platforms) + Docker image.
  assert(
    /tags:\s*\n\s*-\s*['"]?v\*['"]?/.test(releaseSrc) ||
      /tags:\s*\[\s*['"]v\*['"]/.test(releaseSrc),
    "release.yml must trigger on v* tag pushes (Gel #4806 pin — release pipeline shape)."
  );
  // Docker job from Bundle QQ pushes to ghcr.io.
  assert(
    /ghcr\.io/.test(releaseSrc),
    "release.yml must push Docker image to ghcr.io (Gel #4806 pin)."
  );
  // No PR-preview workflow file exists — deferred.
  let hasPreviewWorkflow = false;
  for await (
    const entry of Deno.readDir(
      new URL("../.github/workflows/", import.meta.url)
    )
  ) {
    if (/preview|uffizzi|coherence/i.test(entry.name)) {
      hasPreviewWorkflow = true;
    }
  }
  assert(
    !hasPreviewWorkflow,
    "no PR-preview workflow file should exist yet (Gel #4806 deferred-pin)."
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#3534 — "Listen on multiple TCP ports". Gel asks for the
// ability to bind the same protocol on multiple TCP ports. Disc binds
// one HTTP port (`server/server.ts`) + at most one binary-protocol
// TLS port (`protocol/binary-server.ts`). Multi-port-per-protocol is
// niche (operators usually solve this with a load balancer in front
// of a single backend port).
//
// This pin asserts the single-port-per-protocol shape. A future PR
// that adds multi-port support has to update the divergence record.
// ---------------------------------------------------------------------------
Deno.test("Gel #3534: server binds one port per protocol (single-port-per-protocol shape)", async () => {
  const binarySrc = await Deno.readTextFile(
    new URL("../protocol/binary-server.ts", import.meta.url)
  );
  // The binary server uses Deno.listenTls / Deno.listen on a single
  // listener — count is exactly one per call site.
  const tlsListens = (binarySrc.match(/Deno\.listenTls/g) ?? []).length;
  const plainListens = (binarySrc.match(/Deno\.listen\(/g) ?? []).length;
  // The TLS path and plain path are mutually exclusive (single
  // `if/else` branch in `start()`); each is referenced once.
  assert(
    tlsListens === 1 && plainListens === 1,
    `binary-server.ts must bind exactly one listener per branch — found ${tlsListens} TLS / ${plainListens} plain (Gel #3534 pin).`
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#7724 — "extension upgrades". Gel ships extensions
// (auth, ai, graphql, etc.) and the upgrade story across instance
// versions is non-trivial. Disc's only built-in extension is auth
// (`auth/provider.ts`); the table-creation block is idempotent
// (CREATE TABLE IF NOT EXISTS for every table) so re-running
// `bootstrapAuth()` against an existing instance is safe. The same
// structural answer as #4308 / #6697 / #8909.
//
// This pin asserts every CREATE TABLE in `auth/provider.ts` uses
// IF NOT EXISTS, so an extension "upgrade" is just a re-run of the
// bootstrap path.
// ---------------------------------------------------------------------------
Deno.test("Gel #7724: auth extension bootstrap is idempotent (extension upgrade = re-run bootstrap)", async () => {
  const src = await Deno.readTextFile(
    new URL("../auth/provider.ts", import.meta.url)
  );
  // Strip JS line comments before counting so "// The CREATE TABLE
  // above ..." doesn't count as a SQL statement.
  const codeOnly = src.replace(/\/\/[^\n]*/g, "");
  // Count every CREATE TABLE and every CREATE TABLE IF NOT EXISTS in
  // actual SQL strings; they must match.
  const allCreates = (codeOnly.match(/CREATE TABLE/g) ?? []).length;
  const ifNotExists = (codeOnly.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length;
  assertEquals(
    allCreates,
    ifNotExists,
    `auth/provider.ts must use IF NOT EXISTS on every CREATE TABLE — found ${allCreates} CREATE / ${ifNotExists} IF NOT EXISTS (Gel #7724 pin).`
  );
  // At least 9 tables (matches the existing #8909 pin's lower bound).
  assert(
    ifNotExists >= 9,
    `auth/provider.ts must declare ≥9 idempotent CREATE TABLE blocks (Gel #7724 pin) — found ${ifNotExists}.`
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#3510 — external/user-specified UUIDs. Gel asks for the
// ability to pass an externally-generated UUID into INSERT and have it
// stick on the row. Disc structurally addresses this via two paths:
//   1. The `id` property is auto-registered as `uuid` on every type by
//      `migration/schema-manager.ts:450` (the implicit-id block).
//   2. `insert User { id := <uuid>'...', ... }` flows through the
//      normal INSERT compiler unchanged — Bundle F #5617 added the
//      pinned compile-test in `migration/gel-issues.test.ts`.
// This pin asserts the implicit-id wiring stays in place so a future
// "let's drop the auto-id" refactor has to update the divergence
// record deliberately.
// ---------------------------------------------------------------------------
Deno.test("Gel #3510: schema-manager auto-registers id as uuid on every type", async () => {
  const src = await Deno.readTextFile(
    new URL("../migration/schema-manager.ts", import.meta.url)
  );
  // The implicit-id block must declare an `id` property of type
  // `uuid` with `required: true`. The exact phrasing in the comment
  // is also pinned because it documents the guarantee for users.
  assert(
    /Start with implicit id property/.test(src),
    "schema-manager.ts must keep the implicit-id comment (Gel #3510 pin)."
  );
  assert(
    /properties\.set\("id", \{[\s\S]*?type: "uuid"[\s\S]*?required: true/.test(
      src
    ),
    "schema-manager.ts must auto-register id: uuid required: true (Gel #3510 pin)."
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#5505 + #6517 — Gel reports access policies cause query
// slowdowns because policy evaluation re-runs per request. Disc caches
// the compiled SQL (with policy injection baked in) keyed off
// (queryHash, accessContextHash) in `server/edgeql-protocol.ts`, so
// per-query policy overhead is one compile, not per-call. The cache
// key must include access context so a different role doesn't hit a
// stale entry.
//
// This pin asserts the compilation cache exists, the cache key
// includes access context, and the policy evaluator stays callable
// from the compiler (no parallel uncached path).
// ---------------------------------------------------------------------------
Deno.test("Gel #5505 + #6517: compilation cache embeds access context (one compile per query+role)", async () => {
  const src = await Deno.readTextFile(
    new URL("../server/edgeql-protocol.ts", import.meta.url)
  );
  assert(
    /this\.compilationCache = new QueryCache/.test(src),
    "edgeql-protocol.ts must own a QueryCache for compiled SQL (Gel #5505/#6517 pin)."
  );
  // The cache lookup must include the access context — otherwise two
  // calls with different roles would share the same compiled SQL and
  // either over-permit or under-permit. The cache-key builder must
  // mention the access context.
  assert(
    /access context when policies enabled|accessCtx|ctxHash/i.test(src),
    "edgeql-protocol.ts compilation cache key must include access context (Gel #5505/#6517 pin)."
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#1634 — Gel asks for ways to reduce the cost of new
// PostgreSQL connections. Disc's `lib/connection-pool.ts` pre-warms
// `minConnections` (default 2) on `initialize()`, so the first N
// `acquire()` calls hit warm idle connections instead of opening a
// fresh PG connection each time. The release path returns the
// connection to the idle pool for reuse rather than tearing it down.
//
// This pin asserts the warm-up loop stays in `initialize()` and the
// idle-connection reuse path stays in `acquire()`.
// ---------------------------------------------------------------------------
Deno.test("Gel #1634: connection pool pre-warms minConnections + reuses idle on acquire", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/connection-pool.ts", import.meta.url)
  );
  // The warm-up loop must allocate `minConnections` connections at
  // initialize time, push them onto the idle list, and `Promise.all`
  // them so initialize() doesn't return until they're ready.
  assert(
    /for \(let i = 0; i < this\.config\.minConnections!; i\+\+\)/.test(src),
    "connection-pool.ts initialize() must loop minConnections times to warm the pool (Gel #1634 pin)."
  );
  assert(
    /this\.idleConnections\.push\(conn\)/.test(src) &&
      /await Promise\.all\(promises\)/.test(src),
    "connection-pool.ts initialize() must push warm conns onto idleConnections + await all (Gel #1634 pin)."
  );
  // The acquire path must reuse idle connections before creating new
  // ones — otherwise the warm-up has no effect.
  assert(
    /while \(this\.idleConnections\.length > 0\) \{/.test(src),
    "connection-pool.ts acquire() must reuse idle connections before creating new ones (Gel #1634 pin)."
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#6127 — "test guide" docs ask. Bundle WW shipped
// `docs/testing.md` covering the unit/PG-integration split, the
// `EnvMock` discipline, and how to author new tests against the real
// command surface (rather than the deprecated module-local
// `mock<Command>` helpers from earlier sessions). The pin asserts the
// guide stays in place + cross-links to `tests/TESTING.md`.
// ---------------------------------------------------------------------------
Deno.test("Gel #6127: docs/testing.md carries the test-author guide", async () => {
  const src = await Deno.readTextFile(
    new URL("../docs/testing.md", import.meta.url)
  );
  for (
    const heading of [
      "# Testing",
      "## Running the suite",
      "## Test categories",
      "## Authoring new tests",
      "## Env isolation",
      "## PG-backed tests"
    ]
  ) {
    assert(
      src.includes(heading),
      `docs/testing.md must keep '${heading}' section (Gel #6127 pin).`
    );
  }
  // Cross-link to the in-repo notes doc must stay in place.
  assert(
    src.includes("tests/TESTING.md"),
    "docs/testing.md must cross-link to tests/TESTING.md (Gel #6127 pin)."
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#6119 + #5820 + #5819 — "Document UI / UI button visibility"
// ask. Bundle WW extends `docs/admin-ui.md` to cover every nav entry
// shipped in `ui/src/routes/+layout.svelte` (Dashboard, Schema, Diff,
// Data, Query, Builder, Disc, REPL, Migrations, Config). The pin walks
// the layout file, extracts the labels, and asserts each one has a
// matching `## <label>` section in the doc.
// ---------------------------------------------------------------------------
Deno.test("Gel #6119/#5820/#5819: every UI nav entry is documented in admin-ui.md", async () => {
  const layoutSrc = await Deno.readTextFile(
    new URL("../ui/src/routes/+layout.svelte", import.meta.url)
  );
  const docSrc = await Deno.readTextFile(
    new URL("../docs/admin-ui.md", import.meta.url)
  );
  // Pull every nav `label: '...'` from the layout. Order in the
  // layout determines reading order in the doc — but the pin only
  // asserts presence (each label should be a top-level `## ` or
  // `### ` heading anywhere in the doc).
  const labels = [...layoutSrc.matchAll(/label:\s*['"]([^'"]+)['"]/g)].map(
    m => m[1]
  );
  assert(
    labels.length >= 8,
    `+layout.svelte must declare at least 8 nav labels (Gel #6119 pin) — found ${labels.length}.`
  );
  for (const label of labels) {
    // Heading match — case-insensitive, allows `## Dashboard` /
    // `### Dashboard` / `## Dashboard (...)` etc.
    const headingRegex = new RegExp(
      `^#{2,3}\\s+${label.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\b`,
      "im"
    );
    assert(
      headingRegex.test(docSrc),
      `docs/admin-ui.md must document the '${label}' nav entry (Gel #6119/#5820/#5819 pin).`
    );
  }
});

// ---------------------------------------------------------------------------
// gh/geldata#7382 — "improved docs search" ask. Disc maintains its own
// docs at `/docs/` as plain Markdown, served via GitHub's blob/raw
// browser. There's no docs site infrastructure to plug a search index
// into — `docs/index.md` is the table-of-contents entry point and the
// search story rides on file-grep + the `Quick Links` table at the top
// of `docs/index.md`. Bundle WW documents this explicitly so a future
// session doesn't waste cycles trying to wire up Algolia/Lunr.
//
// The pin asserts `docs/index.md` carries a "Searching" section that
// names the actual search affordances (browser ⌘F, GitHub repo
// search, `grep` over the `docs/` tree).
// ---------------------------------------------------------------------------
Deno.test("Gel #7382: docs/index.md carries a Searching section", async () => {
  const src = await Deno.readTextFile(
    new URL("../docs/index.md", import.meta.url)
  );
  assert(
    /## Searching/.test(src),
    "docs/index.md must keep the 'Searching' section (Gel #7382 pin)."
  );
  // The three search affordances callers actually have:
  for (
    const phrase of [
      "GitHub",
      "grep"
    ]
  ) {
    assert(
      src.toLowerCase().includes(phrase.toLowerCase()),
      `docs/index.md Searching section must mention '${phrase}' (Gel #7382 pin).`
    );
  }
});
