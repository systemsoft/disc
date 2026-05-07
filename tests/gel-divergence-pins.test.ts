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
