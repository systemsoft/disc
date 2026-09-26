/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * `disc shell` exit codes.
 *
 * A query run with `-e`, or read from piped stdin, that fails stops the shell
 * and exits non-zero so scripts see the failure. Leaving the shell normally
 * (`\q`, `exit`, end of input) exits 0. These run the real CLI entry point in a
 * subprocess against a project whose disc.toml points at the test database.
 *
 * Requires PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { canRunPgTests, getTestDsn, tableExists } from "../tests/pg-test-harness.ts";
import { cleanupTempDir, createTempDir } from "../tests/test-utils.ts";

const CONFIG = fromFileUrl(new URL("../deno.json", import.meta.url));
const MAIN = fromFileUrl(new URL("./main.ts", import.meta.url));

interface ShellRun {
  code: number;
  stderr: string;
  stdout: string;
}

/*** Run `disc shell <args>` in a temp project connected to the test database, feeding `stdin`. ***/
async function runShell(args: string[], stdin = ""): Promise<ShellRun> {
  const dsn = await getTestDsn();
  const projectDir = await createTempDir();

  try {
    await Deno.writeTextFile(
      join(projectDir, "disc.toml"),
      `name = "shell-probe"\n\n[database]\nmanaged = false\nbackend_dsn = "${dsn}"\n`
    );

    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-all", "--no-check", "--config", CONFIG, MAIN, "shell", ...args],
      cwd: projectDir,
      stderr: "piped",
      stdin: "piped",
      stdout: "piped"
    })
      .spawn();

    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();

    const { code, stderr, stdout } = await child.output();
    const decoder = new TextDecoder();

    return { code, stderr: decoder.decode(stderr), stdout: decoder.decode(stdout) };
  } finally {
    await cleanupTempDir(projectDir);
  }
}

async function dropProbeTable(): Promise<void> {
  await runShell(["-e", "DROP TABLE IF EXISTS shell_exit_probe;"]);
}

Deno.test({
  name: "PG: disc shell -e exits 0 when the query succeeds",
  ignore: !canRunPgTests(),
  fn: async () => {
    const { code, stderr } = await runShell(["-e", "SELECT 1 AS one;"]);

    assertEquals(code, 0, stderr);
  }
});

Deno.test({
  name: "PG: disc shell -e exits non-zero and reports the error when the query fails",
  ignore: !canRunPgTests(),
  fn: async () => {
    const { code, stderr } = await runShell(["-e", "SELECT * FROM shell_exit_missing;"]);

    assertEquals(code, 1, stderr);
    assertStringIncludes(stderr, "shell_exit_missing");
  }
});

Deno.test({
  name: "PG: disc shell --execute stops at the first failing statement",
  ignore: !canRunPgTests(),
  fn: async () => {
    await dropProbeTable();

    const { code, stderr } = await runShell([
      "--execute",
      "SELECT 1; SELECT * FROM shell_exit_missing; CREATE TABLE shell_exit_probe (id int);"
    ]);

    assertEquals(code, 1, stderr);
    assertEquals(await tableExists(await getTestDsn(), "shell_exit_probe"), false);
  }
});

Deno.test({
  name: "PG: disc shell exits 0 on \\q",
  ignore: !canRunPgTests(),
  fn: async () => {
    const { code, stderr } = await runShell([], "SELECT 1;\n\\q\n");

    assertEquals(code, 0, stderr);
  }
});

Deno.test({
  name: "PG: disc shell exits 0 on exit",
  ignore: !canRunPgTests(),
  fn: async () => {
    const { code, stderr } = await runShell([], "exit\n");

    assertEquals(code, 0, stderr);
  }
});

Deno.test({
  name: "PG: disc shell exits 0 at end of input",
  ignore: !canRunPgTests(),
  fn: async () => {
    const { code, stderr } = await runShell([], "SELECT 1;\n");

    assertEquals(code, 0, stderr);
  }
});

Deno.test({
  name: "PG: disc shell with piped input stops and exits non-zero when a query fails",
  ignore: !canRunPgTests(),
  fn: async () => {
    await dropProbeTable();

    const { code, stderr } = await runShell(
      [],
      "SELECT * FROM shell_exit_missing;\nCREATE TABLE shell_exit_probe (id int);\n\\q\n"
    );

    assertEquals(code, 1, stderr);
    assertStringIncludes(stderr, "shell_exit_missing");
    assertEquals(await tableExists(await getTestDsn(), "shell_exit_probe"), false);
  }
});

Deno.test({
  name: "PG: disc shell with piped input exits non-zero when an \\i file fails",
  ignore: !canRunPgTests(),
  fn: async () => {
    const dir = await createTempDir();

    try {
      const file = join(dir, "bad.edgeql");
      await Deno.writeTextFile(file, "SELECT 1;\nSELECT * FROM shell_exit_missing;\n");

      const { code, stderr } = await runShell([], `\\i ${file}\n\\q\n`);

      assertEquals(code, 1, stderr);
      assertStringIncludes(stderr, "shell_exit_missing");
    } finally {
      await cleanupTempDir(dir);
    }
  }
});

/*** Run `disc shell <args>` outside any project, so only `--backend-dsn` / DATABASE_URL can reach the database. ***/
async function runShellWithoutProject(args: string[], env: Record<string, string> = {}): Promise<ShellRun> {
  const dir = await createTempDir();

  try {
    const { code, stderr, stdout } = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-all", "--no-check", "--config", CONFIG, MAIN, "shell", ...args],
      cwd: dir,
      env,
      stderr: "piped",
      stdin: "null",
      stdout: "piped"
    })
      .output();
    const decoder = new TextDecoder();

    return { code, stderr: decoder.decode(stderr), stdout: decoder.decode(stdout) };
  } finally {
    await cleanupTempDir(dir);
  }
}

Deno.test({
  name: "PG: disc shell connects with --backend-dsn",
  ignore: !canRunPgTests(),
  fn: async () => {
    const { code, stderr } = await runShellWithoutProject(["--backend-dsn", await getTestDsn(), "-e", "SELECT 1 AS one;"]);

    assertEquals(code, 0, stderr);
  }
});

Deno.test({
  name: "PG: disc shell connects with DATABASE_URL",
  ignore: !canRunPgTests(),
  fn: async () => {
    const { code, stderr } = await runShellWithoutProject(["-e", "SELECT 1 AS one;"], { DATABASE_URL: await getTestDsn() });

    assertEquals(code, 0, stderr);
  }
});
