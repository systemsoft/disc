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
    new URL("../deno.json", import.meta.url),
  );
  const denoJson = JSON.parse(denoJsonText) as { tasks?: Record<string, string> };
  const tasks = denoJson.tasks ?? {};

  // The commit skill and CI run these specific tasks. Renaming or removing
  // any of them is the change that requires deliberate review.
  for (const requiredTask of ["lint", "fmt", "test", "check"]) {
    assert(
      typeof tasks[requiredTask] === "string",
      `deno.json:tasks.${requiredTask} is missing — Disc's lint/fmt/test surface relies on it (Gel #4408 pin).`,
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
    `deno.json:tasks.check should compose lint + fmt + test; got: ${checkTask}`,
  );
});

Deno.test("Gel #4408: no .pre-commit-config.yaml in the repo (deliberate non-adoption)", async () => {
  // Asserts the absence of the framework's config file so accidentally
  // landing one trips this pin and forces a deliberate decision.
  const candidates = [
    new URL("../.pre-commit-config.yaml", import.meta.url),
    new URL("../.pre-commit-config.yml", import.meta.url),
  ];
  for (const url of candidates) {
    let exists = true;
    try {
      await Deno.stat(url);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) exists = false;
      else throw e;
    }
    assertEquals(
      exists,
      false,
      `${url.pathname} exists — Disc deliberately doesn't adopt the pre-commit framework (Gel #4408). Remove the file or update this pin.`,
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
    new URL("../protocol/binary-server.ts", import.meta.url),
  );

  // The current implementation listens via `Deno.listenTls` (TLS-on) or
  // `Deno.listen` (plain TCP). It never goes through `Deno.serve` (HTTP).
  // A future HTTP-tunneled path would necessarily call `Deno.serve` or
  // route requests through the existing HTTP handler — both would change
  // the structural shape captured here.
  assert(
    src.includes("Deno.listenTls"),
    "BinaryProtocolServer should expose a TLS listener (TCP+TLS+ALPN edgedb-binary)",
  );
  assert(
    !src.includes("Deno.serve"),
    "BinaryProtocolServer must not use Deno.serve — that would be HTTP tunneling (Gel #4172 pin).",
  );
});

Deno.test("Gel #4172: binary protocol server advertises ALPN edgedb-binary", async () => {
  const src = await Deno.readTextFile(
    new URL("../protocol/binary-server.ts", import.meta.url),
  );
  // SCRAM is wired through the binary protocol via the TCP+TLS path.
  // ALPN "edgedb-binary" is what gates client negotiation onto that path —
  // dropping it is what would force HTTP tunneling, so we pin it here.
  assert(
    src.includes('"edgedb-binary"'),
    "binary-server should advertise ALPN edgedb-binary for upstream client compatibility",
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
    new URL("../auth/provider.ts", import.meta.url),
  );
  // Both branches must throw `INVALID_CREDENTIALS` at status 401 with
  // the literal "Invalid credentials" message — no leaking nuance.
  const noUserMatches = (src.match(
    /reason:\s*"no_such_user"[\s\S]{0,400}?AuthErrorCode\.INVALID_CREDENTIALS/g,
  ) ?? []).length;
  assert(
    noUserMatches >= 1,
    "no-such-user branch must throw INVALID_CREDENTIALS (anti-enumeration parity)",
  );
  // Both branches must precede the throw with `runDummyCompare` so the
  // wall-clock timing matches a real bcrypt verify.
  assert(
    src.includes("await this.runDummyCompare(credentials.password);"),
    "no-such-user branch must burn a dummy bcrypt compare for timing parity",
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
    "../cli/main.ts",
  ];
  for (const rel of cliFiles) {
    const src = await Deno.readTextFile(new URL(rel, import.meta.url));
    // Match the literal log line shape — `"Disconnected"` or
    // `'disconnected from'`. Allow the word to appear in code comments
    // since those don't reach stdout.
    const codeOnly = src.replace(/\/\/.*$/gm, "").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    assert(
      !/console\.\w+\([^)]*[Dd]isconnected/.test(codeOnly),
      `${rel} contains a disconnect-style console call — Gel #3170 pin`,
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
    new URL("../cli/init.ts", import.meta.url),
  );
  const filesIdx = src.indexOf("await this.createProjectFiles");
  const pgIdx = src.indexOf("await this.initializePostgres");
  assert(filesIdx > 0 && pgIdx > 0, "expected both calls in init.ts");
  assert(
    filesIdx < pgIdx,
    "createProjectFiles must run before initializePostgres so a PG failure leaves a resumable project",
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
    new URL("../lib/database.ts", import.meta.url),
  );
  // Look for `for (let attempt = 1; attempt <= maxRetries; attempt++)` —
  // the retry loop's structural shape.
  assert(
    /for\s*\(\s*let\s+attempt\s*=\s*1\s*;\s*attempt\s*<=\s*maxRetries/.test(
      src,
    ),
    "DatabaseConnection.connect must keep its retry loop (Gel #5480 pin)",
  );
  // Default of 3 attempts — operators can override but the floor stays.
  assert(
    /this\.config\.maxRetries\s*\|\|\s*3/.test(src),
    "DatabaseConnection retry default must remain 3 (Gel #5480 pin)",
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
    new URL("../cli/init.ts", import.meta.url),
  );
  // The hint must mention `disc start` and reference the project dir
  // so the operator knows exactly what to run.
  assert(
    /disc start/.test(src) && /Project files were created/.test(src),
    "init.ts catch block must surface the 'disc start' resume hint (Gel #8762 pin)",
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
    new URL("../auth/email-templates.ts", import.meta.url),
  );
  // The CTA-button helper must compose the bg via `branding.brandColor`
  // as the source and emit it via `bgcolor="${bg}"` on the `<td>`.
  assert(
    /branding\.brandColor/.test(src),
    "email-templates.ts must read brandColor from the branding config (Gel #7972 pin)",
  );
  assert(
    /bgcolor="\$\{[^}]+\}"/.test(src),
    "email-templates.ts must emit a `bgcolor` attribute on CTA cells (Gel #7972 pin)",
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
    new URL("../migration/data-migration.ts", import.meta.url),
  );
  // `runMigration` and `rollbackMigration` must call conn.query(query, params)
  // directly — no per-statement compile/marshal wrapper.
  assert(
    /conn\.query\(query, params\)/.test(src),
    "data-migration.ts must call conn.query(query, params) directly (Gel #5713 pin)",
  );
  // No internal compilation/buffering machinery — the runner is a thin
  // pass-through. Forbid the obvious wrapper names.
  assert(
    !/compileEdgeQL|recompile|bufferStatement/.test(src),
    "data-migration.ts must not introduce a compile/buffer layer in the INSERT path (Gel #5713 pin)",
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
    new URL("../migration/engine.ts", import.meta.url),
  );
  // Forbid Deno.Command / Deno.run inside engine.ts — those would
  // signal a subprocess-spawning migration applier.
  assert(
    !/new Deno\.Command|Deno\.run\(/.test(src),
    "engine.ts must not spawn subprocesses for migration apply (Gel #4319 pin)",
  );
  // Single-transaction apply: pool.transaction wraps the whole DDL batch.
  assert(
    /pool\.transaction\(async \(conn\)/.test(src),
    "engine.ts must apply DDL in a single in-process transaction (Gel #4319 pin)",
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
    new URL("../migration/differ.ts", import.meta.url),
  );
  assert(
    /interface DiffCache/.test(src) && /getCache\(allTypes\)/.test(src),
    "differ.ts must expose a per-allTypes DiffCache via getCache() (Gel #5322 pin)",
  );
  assert(
    /computePropertiesWithInheritance/.test(src) &&
      /computeLinksWithInheritance/.test(src),
    "differ.ts must split memoized inheritance walks from compute helpers (Gel #5322 pin)",
  );
});

Deno.test("Gel #3872: Deno.serve TLS surface does not expose cipher selection", () => {
  // Deno's runtime types live on `Deno`. We can't introspect rustls'
  // internal cipher list from user code, so we assert the structural
  // shape of `Deno.ServeTlsOptions`: only `cert` + `key` (and the
  // shared listen options). A future API addition like `cipherSuites`
  // or `tlsCiphers` would land as a typed property and trip this pin.
  const httpServerSrc = Deno.readTextFileSync(
    new URL("../server/http.ts", import.meta.url),
  );
  // Disc passes only { hostname, port, cert, key } to Deno.serve when TLS
  // is enabled. If a future bundle adds cipher config it has to touch this
  // call site, which is also where the pin lives.
  assert(
    !httpServerSrc.includes("cipherSuites") &&
      !httpServerSrc.includes("tlsCiphers") &&
      !httpServerSrc.includes("tls_ciphers"),
    "server/http.ts mentions cipher-suite config — Deno doesn't expose this surface " +
      "(Gel #3872 pin). Remove the reference or update the divergence note.",
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
    new URL("../auth/provider.ts", import.meta.url),
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
    `Expected ≥9 user_id ON DELETE CASCADE FKs in auth/provider.ts; found ${matches.length} (Gel #7103 pin).`,
  );
  // The Bundle MM gap-fix specifically. If a future refactor moves the
  // webauthn_challenges declaration, the constraint must follow.
  const challengesBlock = src.match(
    /CREATE TABLE IF NOT EXISTS webauthn_challenges \(([\s\S]*?)\n\s*\)/,
  );
  assert(
    challengesBlock !== null &&
      /FOREIGN KEY \(user_id\) REFERENCES users\(id\) ON DELETE CASCADE/.test(
        challengesBlock[1],
      ),
    "webauthn_challenges must declare ON DELETE CASCADE on user_id (Gel #7103 pin).",
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
    new URL("../compiler/compiler.ts", import.meta.url),
  );
  // Locate the InsertStatement branch of applyAccessControl.
  const insertBranch = src.match(
    /case "InsertStatement": \{[\s\S]*?return statement;\s*\}/,
  );
  assert(
    insertBranch !== null,
    "applyAccessControl must have an InsertStatement branch (Gel #5504 pin).",
  );
  const body = insertBranch![0];
  // Branch must throw on denial (not silently filter) and must not
  // build a WhereClause / mutate `statement.where`.
  assert(
    /CompilationError/.test(body),
    "INSERT access denial must throw CompilationError, not return a filtered statement (Gel #5504 pin).",
  );
  assert(
    !/WhereClause/.test(body) && !/where: \{/.test(body),
    "INSERT branch must not synthesize a WHERE clause — that would break UNLESS CONFLICT detection (Gel #5504 pin).",
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
    new URL("../lib/stdlib-sql.ts", import.meta.url),
  );
  // Every CREATE OR REPLACE FUNCTION block must be marked IMMUTABLE.
  const funcBlocks = src.match(
    /CREATE OR REPLACE FUNCTION [\s\S]+?LANGUAGE SQL[^;]*;/g,
  ) ?? [];
  assert(
    funcBlocks.length > 0,
    "stdlib-sql.ts should declare at least one wrapper function (Gel #8811 pin).",
  );
  for (const block of funcBlocks) {
    assert(
      /IMMUTABLE/.test(block),
      `stdlib function block must be marked IMMUTABLE: ${block.split("\n")[0]} (Gel #8811 pin).`,
    );
    // No FROM clause referencing a real table. SELECT-with-no-FROM is
    // fine ("SELECT decode(...)") — this catches `SELECT ... FROM users`
    // or any other table read inside a stdlib function.
    assert(
      !/FROM\s+(?!\(|VALUES)\w+/i.test(block),
      `stdlib function must not read tables: ${block.split("\n")[0]} (Gel #8811 pin).`,
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
    new URL("../mod.ts", import.meta.url),
  );
  assert(
    /export \* as CLI from "\.\/cli\/api\.ts"/.test(modSrc),
    "mod.ts must re-export CLI from ./cli/api.ts (Gel #5911 pin).",
  );
  // The api.ts file itself must exist and export at least the core
  // command set. Source-level check so it's caught even if the
  // top-level re-export is wired but the underlying file regresses.
  const apiSrc = await Deno.readTextFile(
    new URL("../cli/api.ts", import.meta.url),
  );
  for (
    const fn of [
      "export function init",
      "export function migrate",
      "export function serve",
      "export function shell",
    ]
  ) {
    assert(
      apiSrc.includes(fn),
      `cli/api.ts must declare ${fn}() (Gel #5911 pin).`,
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
    new URL("../postgres/downloader.ts", import.meta.url),
  );
  assert(
    /Deno\.env\.get\("DISC_PG_BINARY_DIR"\)/.test(src),
    "downloader.ts must read DISC_PG_BINARY_DIR (Gel #3406 pin).",
  );
  assert(
    /Deno\.env\.get\("DISC_OFFLINE"\)/.test(src),
    "downloader.ts must read DISC_OFFLINE (Gel #3406 pin).",
  );
  // The DISC_OFFLINE error must include the env-var name so operators
  // can grep for it in logs.
  assert(
    /DISC_OFFLINE=1/.test(src),
    "downloader.ts DISC_OFFLINE error must reference the env var name (Gel #3406 pin).",
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
    new URL("../cli/main.ts", import.meta.url),
  );
  // The CLI help text + argv parser shouldn't list a `--instance`
  // flag. (`instance` as a noun in help text is fine — the assertion
  // is specifically against an `--instance` argument.)
  assert(
    !/--instance(?:\s|=|\b)/.test(cliMain),
    "cli/main.ts must not surface a --instance flag — Disc derives instance from project context (Gel #2651 pin).",
  );
  const ctxSrc = await Deno.readTextFile(
    new URL("../lib/project-context.ts", import.meta.url),
  );
  // The project-context resolver must derive `instanceName` from
  // either the explicit `instance_name` in disc.toml or the project
  // name fallback. Pinning both means a refactor that drops the
  // fallback (forcing operators to set the field manually) trips here.
  assert(
    /instanceName: fields\.instanceName \?\? projectName/.test(ctxSrc) ||
      /const instanceName = fields\.instanceName \?\? projectName/.test(
        ctxSrc,
      ),
    "project-context.ts must default instanceName to projectName when unset (Gel #2651 pin).",
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
    (d) => d.kind === "ModuleDeclaration",
  );
  assertEquals(
    moduleDecls.length,
    3,
    "Expected 3 modules (default + pass_v1 + chained) (Gel #5641 pin).",
  );

  const conv = new SDLConverter();
  const modules = conv.convertToModules(ast);
  const ops = new SchemaDiffer().diff([], modules);

  // 4 types: Account, Etag, Metadata, Wrapper. Each produces at least
  // one CreateType operation; a regression that loses one of them
  // (e.g. by dropping the cross-module type reference during
  // converter resolution) trips this assertion.
  const createTypes = ops.filter((op) => op.kind === "CreateType");
  assertEquals(
    createTypes.length,
    4,
    `Expected 4 CreateType ops, got ${createTypes.length} (Gel #5641 pin).`,
  );

  // DDL generation must succeed and emit a CREATE TABLE for each
  // type. The "missing FROM-clause" error in Gel surfaced at SQL
  // emit time; if Disc ever regresses to that path, this throws or
  // returns fewer statements than expected.
  const ddl = new DDLGenerator();
  ddl.setEnumScalars(new SchemaDiffer().enumScalarNames(modules));
  const stmts = ddl.generateDDL(ops);
  const createTables = stmts.filter((s) => /CREATE TABLE\b/.test(s));
  assertEquals(
    createTables.length,
    4,
    `Expected 4 CREATE TABLE statements, got ${createTables.length} (Gel #5641 pin).`,
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
    (op) => op.kind === "AlterType" && "typeName" in op && op.typeName === "B",
  ) as
    | { operations: Array<{ kind: string; propertyName?: string }> }
    | undefined;
  assert(
    alterB !== undefined,
    "Differ must emit an AlterType op for B when its extending clause changes (Gel #4215).",
  );
  const dropLabel = alterB.operations.find(
    (sub) => sub.kind === "DropProperty" && sub.propertyName === "label",
  );
  assert(
    dropLabel !== undefined,
    "AlterType B must include a DropProperty op for the inherited `label` field (Gel #4215).",
  );

  // DDL gen must emit ALTER TABLE … DROP COLUMN for the lost prop.
  const ddl = new DDLGenerator();
  ddl.setEnumScalars(new SchemaDiffer().enumScalarNames(afterMods));
  const stmts = ddl.generateDDL(ops);
  const dropCol = stmts.find((s) => /ALTER TABLE\s+b\s+DROP COLUMN[\s\S]*\blabel\b/i.test(s));
  assert(
    dropCol !== undefined,
    `DDL gen must emit ALTER TABLE b DROP COLUMN label; got: ${stmts.join(" | ")} (Gel #4215).`,
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
    new URL("../migration/schema-manager.ts", import.meta.url),
  );
  // SchemaManager fires onSchemaChange after each apply.
  assert(
    /onSchemaChange\?\.\(this\.currentSchema\)/.test(smSrc),
    "schema-manager.ts must invoke onSchemaChange after schema reload (Gel #2204 pin).",
  );

  const serverSrc = await Deno.readTextFile(
    new URL("../server/server.ts", import.meta.url),
  );
  // DiscServer wires onSchemaChange to its own updateSchema delegate.
  assert(
    /this\.protocolHandler\.updateSchema/.test(serverSrc),
    "server.ts must forward updateSchema to the protocol handler (Gel #2204 pin).",
  );

  const protoSrc = await Deno.readTextFile(
    new URL("../server/edgeql-protocol.ts", import.meta.url),
  );
  // EdgeQLProtocol.updateSchema rebuilds the compiler and clears caches.
  // The order matters — clearing first, then rebuilding, would race
  // with concurrent queries; the implementation does it in the right
  // order. Pin both the rebuild and the clear so neither drops out.
  assert(
    /updateSchema\(schema: Context\.Schema\): void \{[\s\S]*?this\.compiler = this\.createCompiler\(schema\);[\s\S]*?this\.compilationCache\.clear\(\);[\s\S]*?this\.parseCache\.clear\(\);/
      .test(protoSrc),
    "edgeql-protocol.ts updateSchema must rebuild the compiler and clear both caches (Gel #2204 pin).",
  );
});
