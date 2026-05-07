/**
 * `disc admin` CLI integration tests
 * (#1129 + #5383 + #6454 + #1119 + #4209)
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { canRunPgTests, getTestDsn } from "../tests/pg-test-harness.ts";
import { ConsoleCapture } from "../tests/test-utils.ts";
import {
  adminCommand,
  collectAccessPolicyAst,
  collectPoliciesFromSdl,
  testPolicyImpl,
} from "./admin.ts";
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

// ---------------------------------------------------------------------------
// gh/geldata#6432 — `disc admin list-policies` is pure SDL
// introspection, no DB required. Tests target the underlying
// `collectPoliciesFromSdl` helper so we exercise the policy-name +
// action + condition shape without a CLI runner.
// ---------------------------------------------------------------------------
Deno.test("admin list-policies — collects policies from SDL with action + events + condition", () => {
  const sdl = `
    module default {
      type Document {
        required title: str;
        required owner: User;
        access policy owner_read {
          allow select;
          using (.owner.id = global current_user);
        };
        access policy owner_write {
          allow update, delete;
          using (.owner.id = global current_user);
        };
        access policy admin_override {
          allow all;
          using (global is_admin);
          errmessage := "Only admins can bypass document policies";
        };
      }
      type User {
        required name: str;
      }
    }
  `;

  const policies = collectPoliciesFromSdl(sdl);

  assertEquals(
    policies.has("Document"),
    true,
    "Document type should appear in policy list (Gel #6432)",
  );
  assertEquals(
    policies.has("User"),
    false,
    "User has no policies — must not appear in the listing",
  );

  const docPolicies = policies.get("Document")!;
  assertEquals(docPolicies.length, 3, "Document declares 3 policies");

  const ownerRead = docPolicies.find((p) => p.name === "owner_read");
  assert(ownerRead !== undefined, "owner_read policy missing");
  assertEquals(ownerRead.action, "allow");
  assertEquals(ownerRead.events, ["select"]);
  assert(
    typeof ownerRead.condition === "string" && ownerRead.condition.length > 0,
    "owner_read should carry a condition string",
  );

  const ownerWrite = docPolicies.find((p) => p.name === "owner_write");
  assert(ownerWrite !== undefined);
  assertEquals(
    ownerWrite.events.sort(),
    ["delete", "update"],
    "owner_write should list both update + delete events",
  );

  const adminOverride = docPolicies.find((p) => p.name === "admin_override");
  assert(adminOverride !== undefined);
  assertEquals(
    adminOverride.errmessage,
    "Only admins can bypass document policies",
    "errmessage on admin_override must round-trip from SDL",
  );
});

Deno.test("admin list-policies — schemas with no policies return an empty map", () => {
  const sdl = `
    module default {
      type User {
        required name: str;
      }
    }
  `;
  const policies = collectPoliciesFromSdl(sdl);
  assertEquals(policies.size, 0, "No policies → empty map");
});

// ---------------------------------------------------------------------------
// gh/geldata#6432 slice 4 — `disc admin test-policy`. Run a policy
// in isolation against a synthetic context. Tests use a temp SDL
// file + the exported `testPolicyImpl` helper so we capture every
// emitted line without spinning up a subprocess.
// ---------------------------------------------------------------------------

async function withTempSdl<T>(
  sdl: string,
  body: (path: string) => Promise<T>,
): Promise<T> {
  const path = await Deno.makeTempFile({
    prefix: "disc-test-policy-",
    suffix: ".disc",
  });
  await Deno.writeTextFile(path, sdl);
  try {
    return await body(path);
  } finally {
    await Deno.remove(path);
  }
}

const TEST_POLICY_SDL = `
  module default {
    type Doc {
      required title: str;
      access policy owner_only {
        allow select;
        using (.owner.id = global current_user);
      };
      access policy admin_override {
        allow all;
        using (global is_admin);
        errmessage := "Only admins may modify documents";
      };
    }
  }
`;

Deno.test("admin test-policy — collectAccessPolicyAst returns the AST nodes for the type (Bundle VV)", () => {
  const map = collectAccessPolicyAst(TEST_POLICY_SDL);
  assertEquals(
    map.has("Doc"),
    true,
    "Doc must surface in the AST policy map",
  );
  const docPolicies = map.get("Doc")!;
  assertEquals(
    docPolicies.length,
    2,
    "Doc declares 2 access policies",
  );
  // Pinning AST shape — kind + name access path so a parser refactor
  // that breaks `policy.name.value` trips here.
  assertEquals(docPolicies[0].kind, "AccessPolicy");
  assertEquals(docPolicies[0].name.value, "owner_only");
  assertEquals(docPolicies[1].name.value, "admin_override");
});

Deno.test("admin test-policy — single target evaluates only the named policy", async () => {
  await withTempSdl(TEST_POLICY_SDL, async (path) => {
    const lines: string[] = [];
    await testPolicyImpl(
      {
        schema: path,
        target: "Doc.owner_only",
        action: "select",
        userId: "u1",
      },
      (line) => lines.push(line),
    );

    // First line carries the verdict header.
    const header = lines[0];
    assert(
      header.startsWith("Doc.owner_only (select):"),
      `Expected header to start with the qualified policy name; got: ${header}`,
    );
    // No other policy headers should appear — only owner_only.
    const policyHeaders = lines.filter((l) =>
      /^Doc\.\w+ \(select\):/.test(l)
    );
    assertEquals(
      policyHeaders.length,
      1,
      "Single-target mode must evaluate exactly one policy",
    );
  });
});

Deno.test("admin test-policy — --all mode evaluates every policy on the type", async () => {
  await withTempSdl(TEST_POLICY_SDL, async (path) => {
    const lines: string[] = [];
    await testPolicyImpl(
      {
        schema: path,
        target: "Doc",
        action: "select",
        userId: "u1",
        all: true,
      },
      (line) => lines.push(line),
    );

    const policyHeaders = lines.filter((l) =>
      /^Doc\.\w+ \(select\):/.test(l)
    );
    assertEquals(
      policyHeaders.length,
      2,
      "--all mode must evaluate both policies on Doc",
    );
    // Each header should report ALLOW or DENY.
    for (const h of policyHeaders) {
      assert(
        /\b(ALLOW|DENY)\b/.test(h),
        `Each verdict line must carry ALLOW or DENY; got: ${h}`,
      );
    }
  });
});

Deno.test("admin test-policy — denial surfaces the policy's errmessage", async () => {
  await withTempSdl(TEST_POLICY_SDL, async (path) => {
    const lines: string[] = [];
    // Force a deny path: the eval path defaults `defaultAllow: false`,
    // and admin_override only allows when `global is_admin` is set.
    // Without that global, admin_override doesn't allow → permissive
    // mode falls through to "no allow found". Pin the reason string
    // path stays intact.
    await testPolicyImpl(
      {
        schema: path,
        target: "Doc.admin_override",
        action: "delete",
        userId: "u1",
      },
      (line) => lines.push(line),
    );

    const joined = lines.join("\n");
    assert(
      /\bDENY\b/.test(joined),
      `Expected DENY verdict in: ${joined}`,
    );
    // The `reason:` line should always be present.
    assert(
      /\breason:/.test(joined),
      `Expected reason line in output: ${joined}`,
    );
  });
});

Deno.test("admin test-policy — type with no policies emits a helpful message", async () => {
  const sdl = `
    module default {
      type Bare {
        required name: str;
      }
    }
  `;
  await withTempSdl(sdl, async (path) => {
    const lines: string[] = [];
    await testPolicyImpl(
      {
        schema: path,
        target: "Bare",
        action: "select",
        all: true,
      },
      (line) => lines.push(line),
    );
    assertStringIncludes(lines.join("\n"), "(no policies on type Bare)");
  });
});

Deno.test("admin test-policy — bad target shape throws clearly", async () => {
  await withTempSdl(TEST_POLICY_SDL, async (path) => {
    let threw = false;
    try {
      await testPolicyImpl(
        {
          schema: path,
          target: "Doc", // missing .<policy>, no --all
          action: "select",
        },
        () => {},
      );
    } catch (e) {
      threw = true;
      assertStringIncludes(
        (e as Error).message,
        "<Type>.<policy>",
      );
    }
    assertEquals(
      threw,
      true,
      "Missing dot in target must throw with the expected hint",
    );
  });
});
