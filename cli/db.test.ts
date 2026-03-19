import { assertEquals, assertRejects } from "@std/assert";
import { DbCommand } from "./db.ts";

// =========================================================================
// Name validation tests
// =========================================================================

Deno.test("DbCommand - validateName accepts valid lowercase name", () => {
  const command = new DbCommand();
  assertEquals(command.validateName("my_app"), null);
});

Deno.test("DbCommand - validateName accepts single letter name", () => {
  const command = new DbCommand();
  assertEquals(command.validateName("a"), null);
});

Deno.test("DbCommand - validateName accepts name with digits", () => {
  const command = new DbCommand();
  assertEquals(command.validateName("app2"), null);
});

Deno.test("DbCommand - validateName rejects uppercase letters", () => {
  const command = new DbCommand();
  const result = command.validateName("MyApp");
  assertEquals(typeof result, "string");
  assertEquals(result!.includes("Invalid database name"), true);
});

Deno.test("DbCommand - validateName rejects names starting with digit", () => {
  const command = new DbCommand();
  const result = command.validateName("2app");
  assertEquals(typeof result, "string");
  assertEquals(result!.includes("Invalid database name"), true);
});

Deno.test("DbCommand - validateName rejects special characters", () => {
  const command = new DbCommand();
  const result = command.validateName("my-app");
  assertEquals(typeof result, "string");
  assertEquals(result!.includes("Invalid database name"), true);
});

Deno.test("DbCommand - validateName rejects empty string", () => {
  const command = new DbCommand();
  const result = command.validateName("");
  assertEquals(typeof result, "string");
  assertEquals(result!.includes("Invalid database name"), true);
});

// =========================================================================
// Create tests (validation-only, no PG connection)
// =========================================================================

Deno.test("DbCommand - create rejects invalid name", async () => {
  const command = new DbCommand();

  await assertRejects(
    () =>
      command.create({
        name: "Invalid_Name",
        databaseUrl: "postgresql://localhost:5432/disc",
      }),
    Error,
    "Invalid database name",
  );
});

Deno.test("DbCommand - create rejects name starting with digit", async () => {
  const command = new DbCommand();

  await assertRejects(
    () =>
      command.create({
        name: "123abc",
        databaseUrl: "postgresql://localhost:5432/disc",
      }),
    Error,
    "Invalid database name",
  );
});

// =========================================================================
// Drop tests (validation-only, no PG connection)
// =========================================================================

Deno.test("DbCommand - drop rejects without force flag", async () => {
  const command = new DbCommand();

  await assertRejects(
    () =>
      command.drop({
        name: "my_app",
        databaseUrl: "postgresql://localhost:5432/disc",
        force: false,
      }),
    Error,
    "--force",
  );
});

Deno.test("DbCommand - drop rejects dropping default disc database", async () => {
  const command = new DbCommand();

  await assertRejects(
    () =>
      command.drop({
        name: "disc",
        databaseUrl: "postgresql://localhost:5432/disc",
        force: true,
      }),
    Error,
    'Cannot drop the default "disc" database',
  );
});
