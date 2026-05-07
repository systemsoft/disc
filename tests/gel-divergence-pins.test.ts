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
