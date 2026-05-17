/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/*** NATIVE ------------------------------------------- ***/

import { assertEquals, assertRejects } from "@std/assert";

/*** UTILITY ------------------------------------------ ***/

import {
  buildPgDumpArgs,
  buildPgRestoreArgs,
  buildPsqlArgs,
  DbCommand,
  isCustomFormatDump
} from "./db.ts";

/*** RUNTIME ------------------------------------------ ***/

/*** --- Name validation tests --- ***/

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

/*** --- Create tests (validation-only, no PG connection) --- ***/

Deno.test("DbCommand - create rejects invalid name", async () => {
  const command = new DbCommand();

  await assertRejects(
    () =>
      command.create({
        databaseUrl: "postgresql://localhost:5432/disc",
        name: "Invalid_Name"
      }),
    Error,
    "Invalid database name"
  );
});

Deno.test("DbCommand - create rejects name starting with digit", async () => {
  const command = new DbCommand();

  await assertRejects(
    () =>
      command.create({
        databaseUrl: "postgresql://localhost:5432/disc",
        name: "123abc"
      }),
    Error,
    "Invalid database name"
  );
});

/*** --- Drop tests (validation-only, no PG connection) --- ***/

Deno.test("DbCommand - drop rejects without force flag", async () => {
  const command = new DbCommand();

  await assertRejects(
    () =>
      command.drop({
        databaseUrl: "postgresql://localhost:5432/disc",
        force: false,
        name: "my_app"
      }),
    Error,
    "--force"
  );
});

Deno.test("DbCommand - drop rejects dropping default disc database", async () => {
  const command = new DbCommand();

  await assertRejects(
    () =>
      command.drop({
        databaseUrl: "postgresql://localhost:5432/disc",
        force: true,
        name: "disc"
      }),
    Error,
    "Cannot drop the default \"disc\" database"
  );
});

/*** --- Wipe tests (validation-only, no PG connection) --- ***/

Deno.test("DbCommand - wipe rejects without force flag", async () => {
  const command = new DbCommand();

  await assertRejects(
    () =>
      command.wipe({
        databaseUrl: "postgresql://localhost:5432/disc",
        force: false,
        name: "my_app"
      }),
    Error,
    "--force"
  );
});

Deno.test("DbCommand - wipe rejects wiping default disc database", async () => {
  const command = new DbCommand();

  await assertRejects(
    () =>
      command.wipe({
        databaseUrl: "postgresql://localhost:5432/disc",
        force: true,
        name: "disc"
      }),
    Error,
    "Cannot wipe the default \"disc\" database"
  );
});

Deno.test("DbCommand - wipe rejects invalid name", async () => {
  const command = new DbCommand();

  await assertRejects(
    () =>
      command.wipe({
        databaseUrl: "postgresql://localhost:5432/disc",
        force: true,
        name: "Bad-Name"
      }),
    Error,
    "Invalid database name"
  );
});

/*** --- Dump tests (validation-only, no PG connection) --- ***/

Deno.test("DbCommand - dump rejects invalid name", async () => {
  const command = new DbCommand();

  await assertRejects(
    () =>
      command.dump({
        databaseUrl: "postgresql://localhost:5432/disc",
        name: "Invalid-Name"
      }),
    Error,
    "Invalid database name"
  );
});

/*** --- Restore tests (validation-only, no PG connection) --- ***/

Deno.test("DbCommand - restore rejects invalid name", async () => {
  const command = new DbCommand();

  await assertRejects(
    () =>
      command.restore({
        databaseUrl: "postgresql://localhost:5432/disc",
        name: "Invalid-Name"
      }),
    Error,
    "Invalid database name"
  );
});

/*** --- Argument-construction tests --- ***/

Deno.test("buildPgDumpArgs - plain format includes expected flags", () => {
  const args = buildPgDumpArgs("/tmp/sock", "disc_my_app", "plain");

  assertEquals(args, [
    "--host",
    "/tmp/sock",
    "--username",
    "disc",
    "--no-owner",
    "--no-acl",
    "--format=plain",
    "disc_my_app"
  ]);
});

Deno.test("buildPgDumpArgs - custom format threads through", () => {
  const args = buildPgDumpArgs("/tmp/sock", "disc_my_app", "custom");

  assertEquals(args.includes("--format=custom"), true);
  assertEquals(args[args.length - 1], "disc_my_app");
});

Deno.test("buildPsqlArgs - includes --quiet and --dbname", () => {
  const args = buildPsqlArgs("/tmp/sock", "disc_my_app");

  assertEquals(args, [
    "--host",
    "/tmp/sock",
    "--username",
    "disc",
    "--dbname",
    "disc_my_app",
    "--quiet"
  ]);
});

Deno.test("buildPgRestoreArgs - includes --no-owner and --no-acl", () => {
  const args = buildPgRestoreArgs("/tmp/sock", "disc_my_app");

  assertEquals(args.includes("--no-owner"), true);
  assertEquals(args.includes("--no-acl"), true);
  assertEquals(args.includes("--dbname"), true);
});

/*** --- Format-peek detector tests --- ***/

Deno.test("isCustomFormatDump - detects PGDMP magic bytes", () => {
  /*** "PGDMP\x01\x02" ***/
  const buf = new Uint8Array([0x50, 0x47, 0x44, 0x4d, 0x50, 0x01, 0x02]);
  assertEquals(isCustomFormatDump(buf), true);
});

Deno.test("isCustomFormatDump - returns false for plain SQL", () => {
  const buf = new TextEncoder().encode("--\nCREATE TABLE\n");
  assertEquals(isCustomFormatDump(buf), false);
});

Deno.test("isCustomFormatDump - returns false for short buffer", () => {
  const buf = new Uint8Array([0x50, 0x47, 0x44]);
  assertEquals(isCustomFormatDump(buf), false);
});

Deno.test("isCustomFormatDump - returns false for almost-matching prefix", () => {
  /*** "PGDMx" — last byte differs ***/
  const buf = new Uint8Array([0x50, 0x47, 0x44, 0x4d, 0x78]);
  assertEquals(isCustomFormatDump(buf), false);
});

Deno.test("isCustomFormatDump - returns false for empty buffer", () => {
  assertEquals(isCustomFormatDump(new Uint8Array()), false);
});
