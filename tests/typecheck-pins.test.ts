/**
 * Pins that the four `deno check` errors fixed in Bundle JJ stay
 * fixed. These weren't behavior bugs — they were type-system holes
 * that prevented the whole project from passing `deno check` in CI.
 * Each pin re-runs `deno check` against one of the previously broken
 * files and fails the test if the file regresses.
 *
 * Tracking the actual `deno check` output (rather than asserting the
 * fix shape) makes the pins resilient to refactors that legitimately
 * change the surface — only an actual type error trips them.
 */

import { assert, assertEquals } from "@std/assert";

async function denoCheck(file: string): Promise<{
  ok: boolean;
  output: string;
}> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["check", file],
    stdout: "piped",
    stderr: "piped",
    cwd: new URL("..", import.meta.url).pathname,
  });
  const result = await cmd.output();
  const output = new TextDecoder().decode(result.stderr)
    + new TextDecoder().decode(result.stdout);
  return { ok: result.success, output };
}

Deno.test("Bundle JJ: migration/engine.ts type-checks (logger.warn signature)", async () => {
  const { ok, output } = await denoCheck("migration/engine.ts");
  assert(ok, `migration/engine.ts should pass deno check; output:\n${output}`);
});

Deno.test("Bundle JJ: smtp/client.ts type-checks (Uint8Array<ArrayBuffer> assignment)", async () => {
  const { ok, output } = await denoCheck("smtp/client.ts");
  assert(ok, `smtp/client.ts should pass deno check; output:\n${output}`);
});

Deno.test("Bundle JJ: server/rest/openapi.ts type-checks (LinkDef.computed access)", async () => {
  const { ok, output } = await denoCheck("server/rest/openapi.ts");
  assert(ok, `server/rest/openapi.ts should pass deno check; output:\n${output}`);
});

Deno.test("Bundle JJ: cli/admin.ts type-checks (RegisterData.username, not name)", async () => {
  // This one surfaced after the upstream fixes unblocked compilation.
  // Pin keeps it green so a future RegisterData change doesn't drift.
  const { ok, output } = await denoCheck("cli/admin.ts");
  assert(ok, `cli/admin.ts should pass deno check; output:\n${output}`);
});

Deno.test("Bundle JJ: PostgresLogger forwards a structured `extra` arg", async () => {
  // Pin the wrapper signature: a future PostgresLogger refactor that
  // drops the `extra` arg would silently swallow context fields again.
  const src = await Deno.readTextFile(
    new URL("../postgres/logger.ts", import.meta.url),
  );
  for (const level of ["debug", "info", "warn", "error"]) {
    assert(
      new RegExp(
        `${level}\\(message: string, extra\\?: Record<string, unknown>\\)`,
      ).test(src),
      `PostgresLogger.${level} must accept the structured 'extra' arg (Bundle JJ pin)`,
    );
  }
});

Deno.test("Bundle JJ: LinkDef carries a `computed` flag", async () => {
  // Pin the field on the compiler-context type so a future
  // re-narrowing doesn't reintroduce the openapi.ts crash.
  const src = await Deno.readTextFile(
    new URL("../compiler/context.ts", import.meta.url),
  );
  // Locate the LinkDef interface and confirm `computed` lives inside.
  const match = src.match(/export interface LinkDef \{[\s\S]+?\n\}/);
  assert(match, "could not locate LinkDef interface");
  assert(
    /computed\?: boolean/.test(match[0]),
    "LinkDef must declare `computed?: boolean` (Bundle JJ pin)",
  );
});

// Sanity check that the remaining pre-existing errors are still
// scoped (test files only). If a *production* file starts surfacing
// the same error class the pin will fail and a follow-up bundle is
// warranted.
Deno.test("Bundle JJ: production-source files (mod/cli/server entry points) type-check", async () => {
  for (const f of ["mod.ts", "cli/main.ts", "server/server.ts"]) {
    const { ok, output } = await denoCheck(f);
    assertEquals(
      ok,
      true,
      `${f} should pass deno check; output:\n${output.slice(0, 1200)}`,
    );
  }
});
