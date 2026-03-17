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
// Test 4: Policy with condition expression sets both condition and using
// ---------------------------------------------------------------------------

Deno.test("policy-adapter: policy with condition sets condition and using", () => {
  const conditionExpr = {
    kind: "BinaryOp" as const,
    op: "=",
    left: {
      kind: "PathExpression" as const,
      path: ["author"],
    },
    right: {
      kind: "PathExpression" as const,
      path: ["current_user"],
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
  assertEquals(result[0].condition, conditionExpr);
  assertEquals(result[0].using, conditionExpr);
  // condition and using should be the exact same reference
  assertEquals(result[0].condition === result[0].using, true);
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
