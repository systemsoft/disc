/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Behavioural pins for `ui/build.sh`'s manifest refresh.
 *
 * `server/ui-asset-manifest.ts` is checked in and every asset name is
 * content-hashed, so a UI rebuild that isn't followed by a regen leaves the
 * two describing different files and the handler 404s paths whose bytes are
 * sitting right there on disk.
 *
 * `cli/build.test.ts` guards against that, but only when `ui/build/` exists.
 * Someone who never builds the UI locally sees green, pushes, and CI — which
 * does build it — fails on their behalf. Regenerating as part of the build
 * closes the window: whoever produced the new hashes also gets the manifest
 * that names them.
 *
 * Like `install-sh.test.ts`, this lifts the function out by name and runs it
 * in isolation rather than executing the whole build.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";

const BUILD_SH = new URL("../ui/build.sh", import.meta.url);

/**
 * Lift a shell function out of `build.sh` so it can run standalone. Relies on
 * the file's house style: indented body, closing brace alone in column zero.
 */
function extractShellFunction(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`);
  if (start === -1) {
    throw new Error(`ui/build.sh does not define ${name}()`);
  }
  const end = source.indexOf("\n}\n", start);
  if (end === -1) {
    throw new Error(`ui/build.sh: ${name}() has no closing brace in column zero`);
  }
  return source.slice(start, end + "\n}".length);
}

/**
 * Run `regenerate_manifest` with a stubbed `deno` on PATH. The stub records
 * its arguments and exits with `denoExitCode`; omit `denoExitCode` entirely
 * (pass null) to leave `deno` off PATH altogether.
 */
async function runRegenerate(
  options: { denoExitCode: number | null; }
): Promise<{ code: number; recordedArgs: string; stdout: string; }> {
  const source = await Deno.readTextFile(BUILD_SH);
  const fn = extractShellFunction(source, "regenerate_manifest");

  const tmp = await Deno.makeTempDir({ prefix: "disc-ui-build-sh-" });

  try {
    const binDir = join(tmp, "bin");
    const repoRoot = join(tmp, "repo");
    const recordPath = join(tmp, "deno-args.txt");
    await Deno.mkdir(binDir);
    await Deno.mkdir(repoRoot);

    if (options.denoExitCode !== null) {
      const stub = `#!/bin/bash\nprintf '%s ' "$@" > ${recordPath}\nexit ${options.denoExitCode}\n`;
      const denoStub = join(binDir, "deno");
      await Deno.writeTextFile(denoStub, stub);
      await Deno.chmod(denoStub, 0o755);
    }

    // A minimal PATH: the stub dir plus the basics `command -v` needs.
    const script = `#!/bin/bash
export PATH="${binDir}:/usr/bin:/bin"
${fn}
regenerate_manifest "${repoRoot}"
echo "EXIT:$?"
`;
    const scriptPath = join(tmp, "run.sh");
    await Deno.writeTextFile(scriptPath, script);
    await Deno.chmod(scriptPath, 0o755);

    const output = await new Deno.Command("bash", {
      args: [scriptPath],
      stderr: "piped",
      stdout: "piped"
    })
      .output();

    const stdout = new TextDecoder().decode(output.stdout);
    const exitMatch = /EXIT:(\d+)/.exec(stdout);

    let recordedArgs = "";
    try {
      recordedArgs = await Deno.readTextFile(recordPath);
    } catch {
      // Stub was never invoked.
    }

    return {
      code: exitMatch ? Number(exitMatch[1]) : -1,
      recordedArgs,
      stdout
    };
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

Deno.test("ui/build.sh defines regenerate_manifest", async () => {
  const source = await Deno.readTextFile(BUILD_SH);
  const fn = extractShellFunction(source, "regenerate_manifest");
  assert(fn.length > 0);
});

Deno.test("ui/build.sh calls it after a successful build", async () => {
  const source = await Deno.readTextFile(BUILD_SH);

  // The refresh has to describe the build that just ran, so it must come
  // after `bun run build` rather than before it.
  const buildAt = source.indexOf("bun run build");
  const callAt = source.indexOf("regenerate_manifest \"");
  assert(buildAt !== -1, "build.sh no longer runs `bun run build`");
  assert(callAt > buildAt, "regenerate_manifest must run after the build");
});

Deno.test("regenerate_manifest runs the ui:manifest task", async () => {
  const { code, recordedArgs } = await runRegenerate({ denoExitCode: 0 });

  assertEquals(code, 0);
  assertStringIncludes(recordedArgs, "task");
  assertStringIncludes(recordedArgs, "ui:manifest");
});

Deno.test("regenerate_manifest warns but succeeds when deno is missing", async () => {
  // The UI build itself already succeeded; failing here would punish someone
  // who built the assets on a machine without deno. Warn loudly instead.
  const { code, recordedArgs, stdout } = await runRegenerate({
    denoExitCode: null
  });

  assertEquals(code, 0);
  assertEquals(recordedArgs, "");
  assertStringIncludes(stdout, "deno task ui:manifest");
});

Deno.test("regenerate_manifest fails when the task fails", async () => {
  // deno is present and the regen genuinely broke — that is a real failure
  // and must not be swallowed.
  const { code } = await runRegenerate({ denoExitCode: 1 });
  assert(code !== 0, "a failing ui:manifest task must fail the build script");
});
