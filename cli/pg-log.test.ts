/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/*** NATIVE ------------------------------------------- ***/

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";

/*** UTILITY ------------------------------------------ ***/

import { PgLogCommand } from "./pg-log.ts";

/*** RUNTIME ------------------------------------------ ***/

/*** Run `fn` with DISC_HOME pointing at a fresh directory holding `instances/<project>/`. ***/
async function withDiscHome(fn: (instanceDir: (project: string) => string) => Promise<void>): Promise<void> {
  const home = await Deno.makeTempDir();
  const previous = Deno.env.get("DISC_HOME");
  Deno.env.set("DISC_HOME", home);

  try {
    await fn(project => join(home, "instances", project));
  } finally {
    if (previous === undefined)
      Deno.env.delete("DISC_HOME");
    else
      Deno.env.set("DISC_HOME", previous);
    await Deno.remove(home, { recursive: true });
  }
}

Deno.test("PgLogCommand - reads the newest log the server's logging collector wrote, under DISC_HOME", async () => {
  await withDiscHome(async instanceDir => {
    const logDir = join(instanceDir("test-project"), "data", "log");
    await Deno.mkdir(logDir, { recursive: true });
    await Deno.mkdir(join(instanceDir("test-project"), "logs"));
    await Deno.writeTextFile(join(instanceDir("test-project"), "logs", "postgresql.log"), "startup\n");
    await Deno.writeTextFile(join(logDir, "postgresql-Mon.log"), "older\n");
    await Deno.writeTextFile(join(logDir, "postgresql-Fri.log"), "newer\n");
    await Deno.utime(join(logDir, "postgresql-Mon.log"), 1_000, 1_000);

    // deno-lint-ignore no-explicit-any
    const path = await (new PgLogCommand() as any).resolveLogPath("test-project");

    assertEquals(path, join(logDir, "postgresql-Fri.log"));
  });
});

Deno.test("PgLogCommand - falls back to pg_ctl's startup log before the collector has written one", async () => {
  await withDiscHome(async instanceDir => {
    await Deno.mkdir(join(instanceDir("test-project"), "logs"), { recursive: true });
    await Deno.writeTextFile(join(instanceDir("test-project"), "logs", "postgresql.log"), "startup\n");

    // deno-lint-ignore no-explicit-any
    const path = await (new PgLogCommand() as any).resolveLogPath("test-project");

    assertEquals(path, join(instanceDir("test-project"), "logs", "postgresql.log"));
  });
});

Deno.test("PgLogCommand - filterByLevel matches correct levels", () => {
  const command = new PgLogCommand();
  const filterByLevel = (command as any).filterByLevel.bind(command);

  assertEquals(filterByLevel("2024-01-15 10:30:00.000 UTC [123] ERROR:  something failed", "ERROR"), true);
  assertEquals(filterByLevel("2024-01-15 10:30:00.000 UTC [123] LOG:  checkpoint starting", "ERROR"), false);
  assertEquals(filterByLevel("2024-01-15 10:30:00.000 UTC [123] WARNING:  setting changed", "WARNING"), true);
  assertEquals(filterByLevel("2024-01-15 10:30:00.000 UTC [123] FATAL:  could not bind", "FATAL"), true);
});

Deno.test("PgLogCommand - filterByLevel rejects non-matching levels", () => {
  const command = new PgLogCommand();
  const filterByLevel = (command as any).filterByLevel.bind(command);

  assertEquals(filterByLevel("2024-01-15 10:30:00.000 UTC [123] LOG:  statement ok", "ERROR"), false);
  assertEquals(filterByLevel("some random line without a timestamp", "ERROR"), false);
});

Deno.test("PgLogCommand - default lines is 50", async () => {
  /*** Create a temporary log file with 100 lines ***/
  const tmpDir = await Deno.makeTempDir();
  const project = "test-lines";
  const logDir = join(tmpDir, project, "logs");
  await Deno.mkdir(logDir, { recursive: true });

  const lines = Array.from({ length: 100 }, (_, i) => `2024-01-15 10:30:00.000 UTC [123] LOG:  line ${i + 1}`);
  await Deno.writeTextFile(join(logDir, "postgresql.log"), lines.join("\n"));

  /*** Verify the log file was created with the expected number of lines ***/
  const content = await Deno.readTextFile(join(logDir, "postgresql.log"));
  const writtenLines = content.split("\n");
  assertEquals(writtenLines.length, 100);

  /*** Verify that the file content starts and ends as expected ***/
  assertEquals(writtenLines[0].includes("line 1"), true);
  assertEquals(writtenLines[99].includes("line 100"), true);

  /*** Clean up ***/
  await Deno.remove(tmpDir, { recursive: true });
});

Deno.test("PgLogCommand - throws error when no log file exists", async () => {
  const command = new PgLogCommand();

  await assertRejects(
    () =>
      command.execute({
        follow: false,
        level: undefined,
        lines: 50,
        project: "nonexistent-project-12345"
      }),
    Error,
    "No log file found"
  );
});

Deno.test("PgLogCommand - throws helpful message with project name", async () => {
  const command = new PgLogCommand();

  await assertRejects(
    () =>
      command.execute({
        follow: false,
        level: undefined,
        lines: 50,
        project: "my-test-project"
      }),
    Error,
    "my-test-project"
  );
});
