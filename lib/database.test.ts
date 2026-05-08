import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseConnectionString, replaceDsnDatabase } from "./database.ts";

Deno.test("parseConnectionString - TCP DSN", () => {
  const result = parseConnectionString(
    "postgresql://myuser:mypass@localhost:5432/mydb"
  );
  assertEquals(result.hostname, "localhost");
  assertEquals(result.port, 5432);
  assertEquals(result.user, "myuser");
  assertEquals(result.password, "mypass");
  assertEquals(result.database, "mydb");
  assertEquals(result.host_type, undefined);
});

Deno.test("parseConnectionString - TCP DSN without password", () => {
  const result = parseConnectionString(
    "postgresql://disc@localhost:5432/disc_dev"
  );
  assertEquals(result.hostname, "localhost");
  assertEquals(result.port, 5432);
  assertEquals(result.user, "disc");
  assertEquals(result.password, "");
  assertEquals(result.database, "disc_dev");
});

Deno.test("parseConnectionString - Unix socket DSN", () => {
  const result = parseConnectionString(
    "postgresql://disc@/disc-project?host=/Users/me/.disc/instances/disc-project/socket"
  );
  assertEquals(
    result.hostname,
    "/Users/me/.disc/instances/disc-project/socket"
  );
  assertEquals(result.user, "disc");
  assertEquals(result.password, "");
  assertEquals(result.database, "disc-project");
  assertEquals(result.host_type, "socket");
});

Deno.test("parseConnectionString - Unix socket DSN with password", () => {
  const result = parseConnectionString(
    "postgresql://disc:secret@/mydb?host=/tmp"
  );
  assertEquals(result.hostname, "/tmp");
  assertEquals(result.user, "disc");
  assertEquals(result.password, "secret");
  assertEquals(result.database, "mydb");
  assertEquals(result.host_type, "socket");
});

Deno.test("replaceDsnDatabase - TCP DSN", () => {
  const result = replaceDsnDatabase(
    "postgresql://user:pass@localhost:5432/mydb",
    "other"
  );
  assertEquals(result, "postgresql://user:pass@localhost:5432/other");
});

Deno.test("replaceDsnDatabase - Unix socket DSN", () => {
  const result = replaceDsnDatabase(
    "postgresql://disc@/disc-project?host=/tmp/socket",
    "postgres"
  );
  assertEquals(result, "postgresql://disc@/postgres?host=/tmp/socket");
});
