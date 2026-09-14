/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Behavioural pins for `install.sh`'s running-instance detection.
 *
 * Upgrading while a `disc serve` process is still alive used to corrupt the
 * install: `curl --output "$exe"` truncated the binary in place, reusing an
 * inode the kernel still had mapped as executable text, after which every
 * `disc` died with SIGKILL "Taskgated Invalid Signature". The installer now
 * renames into place instead, and warns about processes still running the
 * superseded binary so the operator knows to restart them.
 *
 * The detection has to key on *file identity*, not process name. This machine
 * legitimately carries several `disc` binaries at once (a Homebrew build, a
 * from-source dev build, the release install), and a check that flagged all of
 * them would train people to ignore it. `ps -o comm=` is no help here: a
 * process started as `disc serve` via a PATH lookup reports a bare `disc` with
 * no directory, so the path it was actually loaded from is unrecoverable.
 *
 * `install.sh` is a top-to-bottom script with no sourceable entry point, so
 * these tests lift the function out by name and exercise it in isolation.
 */

import { assert, assertEquals } from "@std/assert";

const INSTALL_SH = new URL("../install.sh", import.meta.url);

/**
 * Lift a POSIX shell function out of `install.sh` so it can run standalone.
 *
 * Relies on the file's house style: the body is indented and the closing brace
 * sits alone in column zero. A reformat that breaks that assumption fails here
 * with a clear message rather than silently extracting a truncated function.
 */
function extractShellFunction(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`);
  if (start === -1) {
    throw new Error(`install.sh does not define ${name}()`);
  }
  const end = source.indexOf("\n}\n", start);
  if (end === -1) {
    throw new Error(`install.sh: ${name}() has no closing brace in column zero`);
  }
  return source.slice(start, end + "\n}".length);
}

interface ShellResult {
  stderr: string;
  stdout: string;
}

/**
 * Invoke one extracted function with `args`, under `set -e` so a non-zero
 * status surfaces here the same way it would abort a real install.
 */
async function runShellFunction(
  name: string,
  args: string[]
): Promise<ShellResult> {
  const source = await Deno.readTextFile(INSTALL_SH);
  const script = `set -e\n${extractShellFunction(source, name)}\n` +
    `${name} "$@"\n`;

  const { code, stdout, stderr } = await new Deno.Command("sh", {
    args: ["-c", script, "sh", ...args]
  })
    .output();

  const result = {
    stderr: new TextDecoder().decode(stderr),
    stdout: new TextDecoder().decode(stdout)
  };
  assertEquals(code, 0, `${name} exited ${code}: ${result.stderr}`);
  return result;
}

/** Run the extracted detector against `exe` and return the PIDs it reports. */
async function runningDiscPids(exe: string): Promise<number[]> {
  const { stdout } = await runShellFunction("running_disc_pids", [exe]);
  return stdout
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(Number);
}

/**
 * Stand up two distinct executables both named `disc`, mimicking the
 * several-installs-at-once layout, and run one of each.
 *
 * The fixture copies the running Deno binary rather than a system tool:
 * copying something out of the signed system volume (`/bin/sleep`) produces a
 * binary macOS refuses to exec, which is the very failure mode under test and
 * would make the fixture, not the code, the thing that broke.
 */
async function withTwoInstalls(
  run: (target: string, other: string, targetPid: number) => Promise<void>
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "disc-install-sh-" });
  const target = `${dir}/target/disc`;
  const other = `${dir}/other/disc`;

  await Deno.mkdir(`${dir}/target`);
  await Deno.mkdir(`${dir}/other`);
  await Deno.copyFile(Deno.execPath(), target);
  await Deno.copyFile(Deno.execPath(), other);
  await Deno.chmod(target, 0o755);
  await Deno.chmod(other, 0o755);

  // Long enough to outlive the assertions, short enough that a leaked child
  // from a crashed test reaps itself instead of lingering on the machine.
  const idle = ["eval", "await new Promise((r) => setTimeout(r, 60_000))"];
  const targetProc = new Deno.Command(target, { args: idle }).spawn();
  const otherProc = new Deno.Command(other, { args: idle }).spawn();

  try {
    await run(target, other, targetProc.pid);
  } finally {
    targetProc.kill("SIGKILL");
    otherProc.kill("SIGKILL");
    await targetProc.status;
    await otherProc.status;
    await Deno.remove(dir, { recursive: true });
  }
}

/**
 * Wait for both children to finish exec'ing and mapping their text segment.
 * Spawn returns as soon as the fork lands, which is before the kernel has
 * anything to report, so a bare assertion here would flake.
 */
async function waitForDetection(exe: string, pid: number): Promise<number[]> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const pids = await runningDiscPids(exe);
    if (pids.includes(pid))
      return pids;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return await runningDiscPids(exe);
}

Deno.test("running_disc_pids reports a process running the target binary", async () => {
  await withTwoInstalls(async (target, _other, targetPid) => {
    const pids = await waitForDetection(target, targetPid);
    assert(
      pids.includes(targetPid),
      `expected pid ${targetPid} among [${pids}] for ${target}`
    );
  });
});

Deno.test("running_disc_pids ignores a different disc install", async () => {
  await withTwoInstalls(async (target, other, targetPid) => {
    await waitForDetection(target, targetPid);

    // The other install is running the whole time and is also called `disc`.
    // Nothing about it belongs in an upgrade warning for `target`.
    const pids = await runningDiscPids(target);
    const otherPids = await runningDiscPids(other);

    assert(
      !pids.includes(otherPids[0]),
      `detection for ${target} leaked a pid belonging to ${other}`
    );
    assertEquals(pids.includes(targetPid), true);
  });
});

Deno.test("running_disc_pids reports nothing for an unused path", async () => {
  await withTwoInstalls(async (target, _other, targetPid) => {
    await waitForDetection(target, targetPid);

    const unused = `${target}.not-installed`;
    assertEquals(await runningDiscPids(unused), []);
  });
});

Deno.test("warn_running_instances stays silent when nothing was running", async () => {
  // The overwhelmingly common case: a first install, or an upgrade with no
  // server up. A warning here would be noise on every clean run.
  const { stdout, stderr } = await runShellFunction("warn_running_instances", [""]);
  assertEquals(stdout, "");
  assertEquals(stderr, "");
});

Deno.test("warn_running_instances names every stale pid", async () => {
  const { stdout, stderr } = await runShellFunction(
    "warn_running_instances",
    ["4242 4243"]
  );
  const output = stdout + stderr;

  assert(output.includes("4242"), `missing pid 4242 in:\n${output}`);
  assert(output.includes("4243"), `missing pid 4243 in:\n${output}`);
  assert(
    /restart/i.test(output),
    `warning should say what to do about it:\n${output}`
  );
});
