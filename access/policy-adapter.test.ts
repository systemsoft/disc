/**
 * Tests for Policy Adapter
 */

import { assertEquals } from "@std/assert";
import { createIdentifier } from "../schema/ast.ts";
import type { AccessPolicy as SDLAccessPolicy } from "../schema/ast.ts";
import { adaptAccessPolicies } from "./policy-adapter.ts";

// ---------------------------------------------------------------------------
// Test 1: Empty input returns empty array
// ---------------------------------------------------------------------------

Deno.test("policy-adapter: empty input returns empty array", () => {
  const result = adaptAccessPolicies("User", []);

  assertEquals(result, []);
});

// ---------------------------------------------------------------------------
// Test 2: Single allow policy with one operation
// ---------------------------------------------------------------------------

Deno.test("policy-adapter: single allow policy with one operation", () => {
  const sdlPolicy: SDLAccessPolicy = {
    kind: "AccessPolicy",
    name: createIdentifier("public_read"),
    actions: [
      {
        kind: "AccessAction",
        allow: true,
        operations: ["select"],
      },
    ],
  };

  const result = adaptAccessPolicies("Post", [sdlPolicy]);

  assertEquals(result.length, 1);
  assertEquals(result[0].name, "public_read");
  assertEquals(result[0].objectType, "Post");
  assertEquals(result[0].actions.length, 1);
  assertEquals(result[0].actions[0].allow, true);
  assertEquals(result[0].actions[0].operations, ["select"]);
  assertEquals(result[0].condition, undefined);
  assertEquals(result[0].using, undefined);
});

// ---------------------------------------------------------------------------
// Test 3: Deny + allow policies on same type
// ---------------------------------------------------------------------------

Deno.test("policy-adapter: deny and allow policies on same type", () => {
  const sdlPolicies: SDLAccessPolicy[] = [
    {
      kind: "AccessPolicy",
      name: createIdentifier("no_delete"),
      actions: [
        {
          kind: "AccessAction",
          allow: false,
          operations: ["delete"],
        },
      ],
    },
    {
      kind: "AccessPolicy",
      name: createIdentifier("allow_read"),
      actions: [
        {
          kind: "AccessAction",
          allow: true,
          operations: ["select"],
        },
      ],
    },
  ];

  const result = adaptAccessPolicies("AuditLog", sdlPolicies);

  assertEquals(result.length, 2);

  assertEquals(result[0].name, "no_delete");
  assertEquals(result[0].objectType, "AuditLog");
  assertEquals(result[0].actions[0].allow, false);
  assertEquals(result[0].actions[0].operations, ["delete"]);

  assertEquals(result[1].name, "allow_read");
  assertEquals(result[1].objectType, "AuditLog");
  assertEquals(result[1].actions[0].allow, true);
  assertEquals(result[1].actions[0].operations, ["select"]);
});

// ---------------------------------------------------------------------------
// Test 4: Column-referencing condition separates condition from using
// ---------------------------------------------------------------------------

Deno.test("policy-adapter: column-referencing condition separates condition from using", () => {
  // .author = global current_user — has column ref (.author) + global
  const conditionExpr = {
    kind: "BinaryOp" as const,
    op: "=",
    left: {
      kind: "PathExpression" as const,
      path: [".", "author"],
    },
    right: {
      kind: "PathExpression" as const,
      path: ["global", "current_user"],
    },
  };

  const sdlPolicy: SDLAccessPolicy = {
    kind: "AccessPolicy",
    name: createIdentifier("owner_only"),
    actions: [
      {
        kind: "AccessAction",
        allow: true,
        operations: ["select"],
      },
    ],
    condition: conditionExpr,
  };

  const result = adaptAccessPolicies("Document", [sdlPolicy]);

  assertEquals(result.length, 1);
  assertEquals(result[0].name, "owner_only");

  // using gets the full expression (for SQL WHERE generation)
  assertEquals(result[0].using!.kind, "AccessComparison");
  assertEquals((result[0].using as any).operator, "=");
  assertEquals((result[0].using as any).left.kind, "AccessPath");
  assertEquals((result[0].using as any).left.path, ["author"]);
  assertEquals((result[0].using as any).right.kind, "AccessGlobal");
  assertEquals((result[0].using as any).right.name, "current_user");

  // condition is a minimal global guard (not the full expression)
  assertEquals(result[0].condition!.kind, "AccessGlobal");
  assertEquals((result[0].condition as any).name, "current_user");

  // condition and using are NOT the same reference
  assertEquals(result[0].condition !== result[0].using, true);
});

// ---------------------------------------------------------------------------
// Test 4b: Pure context condition sets both condition and using
// ---------------------------------------------------------------------------

Deno.test("policy-adapter: pure context condition sets both condition and using", () => {
  // global current_role = "admin" — no column references
  const conditionExpr = {
    kind: "BinaryOp" as const,
    op: "=",
    left: {
      kind: "PathExpression" as const,
      path: ["global", "current_role"],
    },
    right: {
      kind: "Literal" as const,
      type: "string" as const,
      value: "admin",
    },
  };

  const sdlPolicy: SDLAccessPolicy = {
    kind: "AccessPolicy",
    name: createIdentifier("admin_only"),
    actions: [
      {
        kind: "AccessAction",
        allow: true,
        operations: ["all"],
      },
    ],
    condition: conditionExpr,
  };

  const result = adaptAccessPolicies("AdminPanel", [sdlPolicy]);

  assertEquals(result.length, 1);
  assertEquals(result[0].name, "admin_only");

  // Both condition and using are the full expression (no column refs)
  assertEquals(result[0].condition!.kind, "AccessComparison");
  assertEquals(result[0].using!.kind, "AccessComparison");
  assertEquals(result[0].condition, result[0].using);
});

// ---------------------------------------------------------------------------
// Test 4c: Pure column expression sets using only, condition undefined
// ---------------------------------------------------------------------------

Deno.test("policy-adapter: pure column expression sets using only", () => {
  // .status = "active" — column ref, no globals
  const conditionExpr = {
    kind: "BinaryOp" as const,
    op: "=",
    left: {
      kind: "PathExpression" as const,
      path: [".", "status"],
    },
    right: {
      kind: "Literal" as const,
      type: "string" as const,
      value: "active",
    },
  };

  const sdlPolicy: SDLAccessPolicy = {
    kind: "AccessPolicy",
    name: createIdentifier("active_only"),
    actions: [
      {
        kind: "AccessAction",
        allow: true,
        operations: ["select"],
      },
    ],
    condition: conditionExpr,
  };

  const result = adaptAccessPolicies("Item", [sdlPolicy]);

  assertEquals(result.length, 1);
  assertEquals(result[0].name, "active_only");

  // using gets the full expression
  assertEquals(result[0].using!.kind, "AccessComparison");
  assertEquals((result[0].using as any).left.kind, "AccessPath");
  assertEquals((result[0].using as any).left.path, ["status"]);

  // condition is undefined — no globals to guard on, always fires
  assertEquals(result[0].condition, undefined);
});

// ---------------------------------------------------------------------------
// Test 5: Policy with "all" operations
// ---------------------------------------------------------------------------

Deno.test("policy-adapter: policy with all operations", () => {
  const sdlPolicy: SDLAccessPolicy = {
    kind: "AccessPolicy",
    name: createIdentifier("admin_all"),
    actions: [
      {
        kind: "AccessAction",
        allow: true,
        operations: ["all"],
      },
    ],
  };

  const result = adaptAccessPolicies("SystemConfig", [sdlPolicy]);

  assertEquals(result.length, 1);
  assertEquals(result[0].name, "admin_all");
  assertEquals(result[0].actions[0].operations, ["all"]);
});

// ---------------------------------------------------------------------------
// Test 6: Multiple policies on same type
// ---------------------------------------------------------------------------

Deno.test("policy-adapter: multiple policies on same type", () => {
  const sdlPolicies: SDLAccessPolicy[] = [
    {
      kind: "AccessPolicy",
      name: createIdentifier("allow_read"),
      actions: [
        {
          kind: "AccessAction",
          allow: true,
          operations: ["select"],
        },
      ],
    },
    {
      kind: "AccessPolicy",
      name: createIdentifier("allow_write"),
      actions: [
        {
          kind: "AccessAction",
          allow: true,
          operations: ["insert", "update"],
        },
      ],
    },
    {
      kind: "AccessPolicy",
      name: createIdentifier("no_delete"),
      actions: [
        {
          kind: "AccessAction",
          allow: false,
          operations: ["delete"],
        },
      ],
    },
  ];

  const result = adaptAccessPolicies("Article", sdlPolicies);

  assertEquals(result.length, 3);
  assertEquals(result[0].name, "allow_read");
  assertEquals(result[1].name, "allow_write");
  assertEquals(result[1].actions[0].operations, ["insert", "update"]);
  assertEquals(result[2].name, "no_delete");
  assertEquals(result[2].actions[0].allow, false);

  // All policies share the same objectType
  for (const policy of result) {
    assertEquals(policy.objectType, "Article");
  }
});

// ---------------------------------------------------------------------------
// Test 7: Policy with multiple actions (allow select, deny delete)
// ---------------------------------------------------------------------------

Deno.test("policy-adapter: policy with multiple actions", () => {
  const sdlPolicy: SDLAccessPolicy = {
    kind: "AccessPolicy",
    name: createIdentifier("read_only_guard"),
    actions: [
      {
        kind: "AccessAction",
        allow: true,
        operations: ["select"],
      },
      {
        kind: "AccessAction",
        allow: false,
        operations: ["delete"],
      },
    ],
  };

  const result = adaptAccessPolicies("Report", [sdlPolicy]);

  assertEquals(result.length, 1);
  assertEquals(result[0].name, "read_only_guard");
  assertEquals(result[0].objectType, "Report");
  assertEquals(result[0].actions.length, 2);

  assertEquals(result[0].actions[0].allow, true);
  assertEquals(result[0].actions[0].operations, ["select"]);

  assertEquals(result[0].actions[1].allow, false);
  assertEquals(result[0].actions[1].operations, ["delete"]);
});

// ---------------------------------------------------------------------------
// Test 8: with check expression is forwarded to runtime.withCheck (P1-37)
// ---------------------------------------------------------------------------

Deno.test("policy-adapter: with check expression is forwarded to runtime.withCheck (P1-37)", () => {
  // .status = "draft"
  const checkExpr = {
    kind: "BinaryOp" as const,
    op: "=",
    left: {
      kind: "PathExpression" as const,
      path: [".", "status"],
    },
    right: {
      kind: "Literal" as const,
      value: "draft",
      type: "string" as const,
    },
  };

  const sdlPolicy: SDLAccessPolicy = {
    kind: "AccessPolicy",
    name: createIdentifier("draft_writes_only"),
    actions: [
      {
        kind: "AccessAction",
        allow: true,
        operations: ["insert", "update"],
      },
    ],
    withCheck: checkExpr,
  };

  const result = adaptAccessPolicies("Post", [sdlPolicy]);

  assertEquals(result.length, 1);
  assertEquals(result[0].withCheck !== undefined, true);
  assertEquals(result[0].withCheck!.kind, "AccessComparison");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assertEquals((result[0].withCheck as any).left.kind, "AccessPath");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assertEquals((result[0].withCheck as any).left.path, ["status"]);
});

Deno.test("policy-adapter: omitted with check leaves runtime.withCheck undefined", () => {
  const sdlPolicy: SDLAccessPolicy = {
    kind: "AccessPolicy",
    name: createIdentifier("plain"),
    actions: [
      { kind: "AccessAction", allow: true, operations: ["select"] },
    ],
  };
  const result = adaptAccessPolicies("Post", [sdlPolicy]);
  assertEquals(result[0].withCheck, undefined);
});

// ---------------------------------------------------------------------------
// errmessage forwarding (Gel #4095)
// ---------------------------------------------------------------------------

Deno.test("policy-adapter: errmessage is forwarded to runtime policy (Gel #4095)", () => {
  const sdlPolicy: SDLAccessPolicy = {
    kind: "AccessPolicy",
    name: createIdentifier("admin_only"),
    actions: [
      { kind: "AccessAction", allow: false, operations: ["update"] },
    ],
    errmessage: "Only admins can modify this record",
  };

  const result = adaptAccessPolicies("Doc", [sdlPolicy]);

  assertEquals(result[0].errmessage, "Only admins can modify this record");
});

Deno.test("policy-adapter: omitted errmessage leaves runtime.errmessage undefined", () => {
  const sdlPolicy: SDLAccessPolicy = {
    kind: "AccessPolicy",
    name: createIdentifier("plain"),
    actions: [
      { kind: "AccessAction", allow: true, operations: ["select"] },
    ],
  };

  const result = adaptAccessPolicies("Post", [sdlPolicy]);

  assertEquals(result[0].errmessage, undefined);
});
