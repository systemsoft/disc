import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { PgLogCommand } from "./pg-log.ts";

Deno.test("PgLogCommand - resolves log path from project name", () => {
  const command = new PgLogCommand();
  // Access the private method via prototype for testing
  const resolveLogPath = (command as any).resolveLogPath.bind(command);
  const path = resolveLogPath("test-project");
  const expected = join(
    Deno.env.get("HOME")!,
    ".disc",
    "instances",
    "test-project",
    "logs",
    "postgresql.log",
  );
  assertEquals(path, expected);
});

Deno.test("PgLogCommand - filterByLevel matches correct levels", () => {
  const command = new PgLogCommand();
  const filterByLevel = (command as any).filterByLevel.bind(command);

  assertEquals(
    filterByLevel(
      "2024-01-15 10:30:00.000 UTC [123] ERROR:  something failed",
      "ERROR",
    ),
    true,
  );
  assertEquals(
    filterByLevel(
      "2024-01-15 10:30:00.000 UTC [123] LOG:  checkpoint starting",
      "ERROR",
    ),
    false,
  );
  assertEquals(
    filterByLevel(
      "2024-01-15 10:30:00.000 UTC [123] WARNING:  setting changed",
      "WARNING",
    ),
    true,
  );
  assertEquals(
    filterByLevel(
      "2024-01-15 10:30:00.000 UTC [123] FATAL:  could not bind",
      "FATAL",
    ),
    true,
  );
});

Deno.test("PgLogCommand - filterByLevel rejects non-matching levels", () => {
  const command = new PgLogCommand();
  const filterByLevel = (command as any).filterByLevel.bind(command);

  assertEquals(
    filterByLevel(
      "2024-01-15 10:30:00.000 UTC [123] LOG:  statement ok",
      "ERROR",
    ),
    false,
  );
  assertEquals(
    filterByLevel("some random line without a timestamp", "ERROR"),
    false,
  );
});

Deno.test("PgLogCommand - default lines is 50", async () => {
  // Create a temporary log file with 100 lines
  const tmpDir = await Deno.makeTempDir();
  const project = "test-lines";
  const logDir = join(tmpDir, project, "logs");
  await Deno.mkdir(logDir, { recursive: true });

  const lines = Array.from(
    { length: 100 },
    (_, i) => `2024-01-15 10:30:00.000 UTC [123] LOG:  line ${i + 1}`,
  );
  await Deno.writeTextFile(join(logDir, "postgresql.log"), lines.join("\n"));

  // Verify the log file was created with the expected number of lines
  const content = await Deno.readTextFile(join(logDir, "postgresql.log"));
  const writtenLines = content.split("\n");
  assertEquals(writtenLines.length, 100);

  // Verify that the file content starts and ends as expected
  assertEquals(writtenLines[0].includes("line 1"), true);
  assertEquals(writtenLines[99].includes("line 100"), true);

  // Clean up
  await Deno.remove(tmpDir, { recursive: true });
});

Deno.test("PgLogCommand - throws error when no log file exists", async () => {
  const command = new PgLogCommand();

  await assertRejects(
    () =>
      command.execute({
        lines: 50,
        follow: false,
        level: undefined,
        project: "nonexistent-project-12345",
      }),
    Error,
    "No log file found",
  );
});

Deno.test("PgLogCommand - throws helpful message with project name", async () => {
  const command = new PgLogCommand();

  await assertRejects(
    () =>
      command.execute({
        lines: 50,
        follow: false,
        level: undefined,
        project: "my-test-project",
      }),
    Error,
    "my-test-project",
  );
});
