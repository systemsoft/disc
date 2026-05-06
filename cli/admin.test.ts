/**
 * `disc admin` CLI integration tests
 * (#1129 + #5383 + #6454 + #1119 + #4209)
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { canRunPgTests, getTestDsn } from "../tests/pg-test-harness.ts";
import { ConsoleCapture } from "../tests/test-utils.ts";
import { adminCommand } from "./admin.ts";
import { DatabaseConnection } from "../lib/database.ts";

const JWT_SECRET = "test-secret-must-be-at-least-32-bytes-long";

async function freshAuth(dsn: string): Promise<void> {
  // Tables may not exist before the first adminCommand.* call. Truncate
  // each one independently so a missing table doesn't abort the rest.
  const db = new DatabaseConnection(dsn);
  await db.connect();
  try {
    for (
      const stmt of [
        "TRUNCATE TABLE user_roles RESTART IDENTITY CASCADE",
        "TRUNCATE TABLE roles RESTART IDENTITY CASCADE",
        "TRUNCATE TABLE sessions RESTART IDENTITY CASCADE",
        "TRUNCATE TABLE users RESTART IDENTITY CASCADE",
      ]
    ) {
      try {
        await db.execute(stmt);
      } catch (_) {
        // table missing — fine
      }
    }
  } finally {
    await db.close();
  }
}

Deno.test({
  name: "admin create-superuser - creates user, role, and assignment",
  ignore: !canRunPgTests(),
  fn: async () => {
    const dsn = await getTestDsn();
    await freshAuth(dsn);

    const cap = new ConsoleCapture();
    cap.capture();
    try {
      await adminCommand.createSuperuser({
        "database-url": dsn,
        "jwt-secret": JWT_SECRET,
        email: "root@example.com",
        password: "rootRootR00t!!!",
        name: "Root",
      });
    } finally {
      cap.restore();
    }

    // Verify the user exists, the superuser role exists, and the
    // assignment row in user_roles links them.
    const db = new DatabaseConnection(dsn);
    await db.connect();
    try {
      const u = await db.query(
        "SELECT id, email FROM users WHERE email = $1",
        ["root@example.com"],
      );
      assertEquals(u.rows.length, 1);
      const userId = u.rows[0].id as string;

      const r = await db.query(
        "SELECT name FROM roles WHERE name = $1",
        ["superuser"],
      );
      assertEquals(r.rows.length, 1);

      const ur = await db.query(
        `SELECT role_name AS name FROM user_roles WHERE user_id = $1`,
        [userId],
      );
      assertEquals(ur.rows.length, 1);
      assertEquals(ur.rows[0].name, "superuser");
    } finally {
      await db.close();
    }
  },
});

Deno.test({
  name: "admin create-superuser - rejects empty password (#4209)",
  ignore: !canRunPgTests(),
  fn: async () => {
    const dsn = await getTestDsn();
    await freshAuth(dsn);

    const cap = new ConsoleCapture();
    cap.capture();
    try {
      await adminCommand.createSuperuser({
        "database-url": dsn,
        "jwt-secret": JWT_SECRET,
        email: "u@example.com",
        password: "",
      });
    } finally {
      cap.restore();
    }
    const errors = cap.getErrors().join("\n");
    assertStringIncludes(errors.toLowerCase(), "password");
    // Verify no user was created
    const db = new DatabaseConnection(dsn);
    await db.connect();
    try {
      const r = await db.query(
        "SELECT 1 FROM users WHERE email = $1",
        ["u@example.com"],
      );
      assertEquals(r.rows.length, 0);
    } finally {
      await db.close();
    }
  },
});

Deno.test({
  name: "admin set-password - rotates password without old one",
  ignore: !canRunPgTests(),
  fn: async () => {
    const dsn = await getTestDsn();
    await freshAuth(dsn);

    const cap = new ConsoleCapture();
    cap.capture();
    try {
      // Bootstrap a user via create-superuser so we have something to rotate
      await adminCommand.createSuperuser({
        "database-url": dsn,
        "jwt-secret": JWT_SECRET,
        email: "rotate@example.com",
        password: "OriginalP4ss!!!!",
      });

      // Capture the old hash so we can confirm it actually changed
      let oldHash: string;
      {
        const db = new DatabaseConnection(dsn);
        await db.connect();
        try {
          const r = await db.query(
            "SELECT password_hash FROM users WHERE email = $1",
            ["rotate@example.com"],
          );
          oldHash = r.rows[0].password_hash as string;
        } finally {
          await db.close();
        }
      }

      await adminCommand.setPassword({
        "database-url": dsn,
        "jwt-secret": JWT_SECRET,
        user: "rotate@example.com",
        password: "RotatedP4ssw0rd!!",
      });

      const db = new DatabaseConnection(dsn);
      await db.connect();
      try {
        const r = await db.query(
          "SELECT password_hash FROM users WHERE email = $1",
          ["rotate@example.com"],
        );
        const newHash = r.rows[0].password_hash as string;
        assert(
          newHash !== oldHash,
          "password_hash unchanged after admin set-password",
        );
      } finally {
        await db.close();
      }
    } finally {
      cap.restore();
    }
  },
});

Deno.test({
  name: "admin set-password - unknown user is reported as error",
  ignore: !canRunPgTests(),
  fn: async () => {
    const dsn = await getTestDsn();
    await freshAuth(dsn);

    const cap = new ConsoleCapture();
    cap.capture();
    try {
      await adminCommand.setPassword({
        "database-url": dsn,
        "jwt-secret": JWT_SECRET,
        user: "ghost@example.com",
        password: "LegitP4ssw0rd!!",
      });
    } finally {
      cap.restore();
    }
    const errors = cap.getErrors().join("\n").toLowerCase();
    assertStringIncludes(errors, "not found");
  },
});

Deno.test({
  name: "admin assign-role - assigns role to existing user",
  ignore: !canRunPgTests(),
  fn: async () => {
    const dsn = await getTestDsn();
    await freshAuth(dsn);

    const cap = new ConsoleCapture();
    cap.capture();
    try {
      await adminCommand.createSuperuser({
        "database-url": dsn,
        "jwt-secret": JWT_SECRET,
        email: "promote@example.com",
        password: "InitialP4ss!!!!",
      });

      await adminCommand.assignRole({
        "database-url": dsn,
        "jwt-secret": JWT_SECRET,
        user: "promote@example.com",
        role: "auditor",
      });
    } finally {
      cap.restore();
    }

    const db = new DatabaseConnection(dsn);
    await db.connect();
    try {
      const r = await db.query(
        `SELECT ur.role_name AS name FROM user_roles ur
         JOIN users u ON u.id = ur.user_id
         WHERE u.email = $1
         ORDER BY ur.role_name`,
        ["promote@example.com"],
      );
      const names = r.rows.map((row) => row.name as string);
      assert(names.includes("auditor"));
      assert(names.includes("superuser"));
    } finally {
      await db.close();
    }
  },
});

Deno.test("admin commands - missing DSN reports a clear error", async () => {
  const cap = new ConsoleCapture();
  cap.capture();
  const saved = Deno.env.get("DATABASE_URL");
  if (saved !== undefined) Deno.env.delete("DATABASE_URL");
  try {
    await adminCommand.createSuperuser({
      "jwt-secret": JWT_SECRET,
      email: "x@example.com",
      password: "EnoughP4ssw0rd!",
    });
  } finally {
    if (saved !== undefined) Deno.env.set("DATABASE_URL", saved);
    cap.restore();
  }
  assertStringIncludes(cap.getErrors().join("\n"), "--database-url");
});
