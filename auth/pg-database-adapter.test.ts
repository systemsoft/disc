/**
 * Tests for PgDatabaseAdapter
 */

import { assertEquals, assertStrictEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { DatabaseInterface, QueryResult } from "./database-interface.ts";
import { convertPlaceholders, PgDatabaseAdapter } from "./pg-database-adapter.ts";

// --- convertPlaceholders tests ---

Deno.test("convertPlaceholders - single placeholder", () => {
  assertEquals(
    convertPlaceholders("SELECT * FROM users WHERE id = ?"),
    "SELECT * FROM users WHERE id = $1"
  );
});

Deno.test("convertPlaceholders - multiple placeholders", () => {
  assertEquals(
    convertPlaceholders("INSERT INTO users (id, email, name) VALUES (?, ?, ?)"),
    "INSERT INTO users (id, email, name) VALUES ($1, $2, $3)"
  );
});

Deno.test("convertPlaceholders - no placeholders", () => {
  const sql = "SELECT * FROM users";
  assertEquals(convertPlaceholders(sql), sql);
});

Deno.test("convertPlaceholders - skips ? inside single-quoted strings", () => {
  assertEquals(
    convertPlaceholders("SELECT * FROM users WHERE name = '?' AND id = ?"),
    "SELECT * FROM users WHERE name = '?' AND id = $1"
  );
});

Deno.test("convertPlaceholders - handles escaped single quotes", () => {
  assertEquals(
    convertPlaceholders("SELECT * FROM users WHERE name = 'it''s?' AND id = ?"),
    "SELECT * FROM users WHERE name = 'it''s?' AND id = $1"
  );
});

Deno.test("convertPlaceholders - mixed string and param placeholders", () => {
  assertEquals(
    convertPlaceholders(
      "UPDATE users SET name = ? WHERE email = '?' AND id = ?"
    ),
    "UPDATE users SET name = $1 WHERE email = '?' AND id = $2"
  );
});

Deno.test("convertPlaceholders - complex INSERT with many params", () => {
  assertEquals(
    convertPlaceholders(
      "INSERT INTO users (id, email, username, passwordHash, emailVerified, metadata, verification_token) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ),
    "INSERT INTO users (id, email, username, passwordHash, emailVerified, metadata, verification_token) VALUES ($1, $2, $3, $4, $5, $6, $7)"
  );
});

// --- PgDatabaseAdapter delegation tests ---

/** Fake DatabaseConnection for testing delegation */
class FakeDatabaseConnection {
  calls: { method: string; args: any[]; }[] = [];
  private _connected = false;
  queryResult: QueryResult = { rows: [], rowCount: 0 };

  connect(): Promise<void> {
    this.calls.push({ method: "connect", args: [] });
    this._connected = true;
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.calls.push({ method: "close", args: [] });
    this._connected = false;
    return Promise.resolve();
  }

  isConnected(): boolean {
    return this._connected;
  }

  execute(sql: string, params?: any[]): Promise<void> {
    this.calls.push({ method: "execute", args: [sql, params] });
    return Promise.resolve();
  }

  query(sql: string, params?: any[]): Promise<QueryResult> {
    this.calls.push({ method: "query", args: [sql, params] });
    return Promise.resolve(this.queryResult);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.calls.push({ method: "transaction", args: [] });
    await this.execute("BEGIN");
    try {
      const result = await fn();
      await this.execute("COMMIT");
      return result;
    } catch (error) {
      await this.execute("ROLLBACK");
      throw error;
    }
  }
}

Deno.test("PgDatabaseAdapter - delegates connect", async () => {
  const fake = new FakeDatabaseConnection();
  const adapter = new PgDatabaseAdapter(fake as any);

  await adapter.connect();

  assertEquals(fake.calls.length, 1);
  assertEquals(fake.calls[0].method, "connect");
});

Deno.test("PgDatabaseAdapter - delegates close", async () => {
  const fake = new FakeDatabaseConnection();
  const adapter = new PgDatabaseAdapter(fake as any);

  await adapter.close();

  assertEquals(fake.calls.length, 1);
  assertEquals(fake.calls[0].method, "close");
});

Deno.test("PgDatabaseAdapter - delegates isConnected", async () => {
  const fake = new FakeDatabaseConnection();
  const adapter = new PgDatabaseAdapter(fake as any);

  assertEquals(adapter.isConnected(), false);
  await adapter.connect();
  assertEquals(adapter.isConnected(), true);
});

Deno.test("PgDatabaseAdapter - execute converts placeholders", async () => {
  const fake = new FakeDatabaseConnection();
  const adapter = new PgDatabaseAdapter(fake as any);

  await adapter.execute("UPDATE users SET name = ? WHERE id = ?", [
    "Ada",
    "123"
  ]);

  const executeCall = fake.calls.find(c => c.method === "execute");
  assertEquals(
    executeCall?.args[0],
    "UPDATE users SET name = $1 WHERE id = $2"
  );
  assertEquals(executeCall?.args[1], ["Ada", "123"]);
});

Deno.test("PgDatabaseAdapter - query converts placeholders", async () => {
  const fake = new FakeDatabaseConnection();
  fake.queryResult = { rows: [{ id: "1" }], rowCount: 1 };
  const adapter = new PgDatabaseAdapter(fake as any);

  const result = await adapter.query("SELECT * FROM users WHERE email = ?", [
    "test@test.com"
  ]);

  const queryCall = fake.calls.find(c => c.method === "query");
  assertEquals(queryCall?.args[0], "SELECT * FROM users WHERE email = $1");
  assertEquals(queryCall?.args[1], ["test@test.com"]);
  assertEquals(result.rows.length, 1);
  assertEquals(result.rowCount, 1);
});

Deno.test("PgDatabaseAdapter - transaction passes adapter to callback", async () => {
  const fake = new FakeDatabaseConnection();
  const adapter = new PgDatabaseAdapter(fake as any);

  let receivedDb: DatabaseInterface | null = null;

  await adapter.transaction(db => {
    receivedDb = db;
    return Promise.resolve();
  });

  // The callback should receive the adapter itself (for correct placeholder conversion)
  assertStrictEquals(receivedDb, adapter);
});
