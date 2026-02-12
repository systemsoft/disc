/**
 * Tests for Access Policy Evaluator
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { AccessEvaluator } from "./evaluator.ts";
import { 
  AccessPolicy, 
  AccessConfig, 
  AccessContext,
} from "./types.ts";

function createTestConfig(overrides?: Partial<AccessConfig>): AccessConfig {
  return {
    mode: "permissive",
    defaultAllow: false,
    enableRLS: true,
    enableAudit: false,
    ...overrides,
  };
}

Deno.test("AccessEvaluator - allow with no policies uses default", () => {
  const evaluator = new AccessEvaluator(createTestConfig({ defaultAllow: true }));
  const context: AccessContext = { userId: "user1" };
  
  const decision = evaluator.evaluate("User", "select", context);
  
  assertEquals(decision.allowed, true);
  assertEquals(decision.reason, "No policies defined, default allow");
});

Deno.test("AccessEvaluator - deny with no policies uses default", () => {
  const evaluator = new AccessEvaluator(createTestConfig({ defaultAllow: false }));
  const context: AccessContext = { userId: "user1" };
  
  const decision = evaluator.evaluate("User", "select", context);
  
  assertEquals(decision.allowed, false);
  assertEquals(decision.reason, "No policies defined, default deny");
});

Deno.test("AccessEvaluator - simple allow policy", () => {
  const evaluator = new AccessEvaluator(createTestConfig());
  const policy: AccessPolicy = {
    name: "allow_select",
    objectType: "User",
    actions: [{ allow: true, operations: ["select"] }],
  };
  
  evaluator.registerPolicy(policy);
  
  const context: AccessContext = { userId: "user1" };
  const decision = evaluator.evaluate("User", "select", context);
  
  assertEquals(decision.allowed, true);
  assertEquals(decision.appliedPolicies, ["allow_select"]);
});

Deno.test("AccessEvaluator - simple deny policy", () => {
  const evaluator = new AccessEvaluator(createTestConfig());
  const policy: AccessPolicy = {
    name: "deny_delete",
    objectType: "User",
    actions: [{ allow: false, operations: ["delete"] }],
  };
  
  evaluator.registerPolicy(policy);
  
  const context: AccessContext = { userId: "user1" };
  const decision = evaluator.evaluate("User", "delete", context);
  
  assertEquals(decision.allowed, false);
});

Deno.test("AccessEvaluator - all operation matches any", () => {
  const evaluator = new AccessEvaluator(createTestConfig());
  const policy: AccessPolicy = {
    name: "allow_all",
    objectType: "Post",
    actions: [{ allow: true, operations: ["all"] }],
  };
  
  evaluator.registerPolicy(policy);
  
  const context: AccessContext = { userId: "user1" };
  
  assertEquals(evaluator.evaluate("Post", "select", context).allowed, true);
  assertEquals(evaluator.evaluate("Post", "insert", context).allowed, true);
  assertEquals(evaluator.evaluate("Post", "update", context).allowed, true);
  assertEquals(evaluator.evaluate("Post", "delete", context).allowed, true);
});

Deno.test("AccessEvaluator - multiple policies combine in permissive mode", () => {
  const evaluator = new AccessEvaluator(createTestConfig({ mode: "permissive" }));
  
  evaluator.registerPolicy({
    name: "allow_read",
    objectType: "Document",
    actions: [{ allow: true, operations: ["select"] }],
  });
  
  evaluator.registerPolicy({
    name: "allow_write",
    objectType: "Document",
    actions: [{ allow: true, operations: ["insert", "update"] }],
  });
  
  const context: AccessContext = { userId: "user1" };
  
  assertEquals(evaluator.evaluate("Document", "select", context).allowed, true);
  assertEquals(evaluator.evaluate("Document", "update", context).allowed, true);
  assertEquals(evaluator.evaluate("Document", "delete", context).allowed, false);
});

Deno.test("AccessEvaluator - deny overrides allow in permissive mode", () => {
  const evaluator = new AccessEvaluator(createTestConfig({ mode: "permissive" }));
  
  evaluator.registerPolicy({
    name: "allow_all",
    objectType: "Secret",
    actions: [{ allow: true, operations: ["all"] }],
  });
  
  evaluator.registerPolicy({
    name: "deny_delete",
    objectType: "Secret",
    actions: [{ allow: false, operations: ["delete"] }],
  });
  
  const context: AccessContext = { userId: "user1" };
  
  assertEquals(evaluator.evaluate("Secret", "select", context).allowed, true);
  assertEquals(evaluator.evaluate("Secret", "delete", context).allowed, false);
});

Deno.test("AccessEvaluator - restrictive mode requires explicit allow", () => {
  const evaluator = new AccessEvaluator(createTestConfig({ mode: "restrictive" }));
  
  evaluator.registerPolicy({
    name: "allow_select",
    objectType: "Private",
    actions: [{ allow: true, operations: ["select"] }],
  });
  
  const context: AccessContext = { userId: "user1" };
  
  assertEquals(evaluator.evaluate("Private", "select", context).allowed, true);
  assertEquals(evaluator.evaluate("Private", "update", context).allowed, false);
});

Deno.test("AccessEvaluator - restrictive mode with early deny", () => {
  const evaluator = new AccessEvaluator(createTestConfig({ mode: "restrictive" }));
  
  evaluator.registerPolicy({
    name: "deny_all",
    objectType: "Forbidden",
    actions: [{ allow: false, operations: ["all"] }],
  });
  
  evaluator.registerPolicy({
    name: "allow_select",
    objectType: "Forbidden",
    actions: [{ allow: true, operations: ["select"] }],
  });
  
  const context: AccessContext = { userId: "user1" };
  const decision = evaluator.evaluate("Forbidden", "select", context);
  
  assertEquals(decision.allowed, false);
  assertEquals(decision.reason, "Denied by policy: deny_all");
});

Deno.test("AccessEvaluator - global policy applies to all types", () => {
  const evaluator = new AccessEvaluator(createTestConfig());
  
  const globalPolicy: AccessPolicy = {
    name: "require_auth",
    objectType: "", // Global policy
    actions: [{ allow: false, operations: ["all"] }],
    condition: {
      kind: "AccessComparison",
      operator: "=",
      left: { kind: "AccessGlobal", name: "current_user" },
      right: { kind: "AccessLiteral", value: null, type: "null" },
    } as any,
  };
  
  evaluator.registerPolicy(globalPolicy);
  
  // With no user, should be denied
  const noAuthContext: AccessContext = {};
  assertEquals(evaluator.evaluate("AnyType", "select", noAuthContext).allowed, false);
  
  // With user, condition not met, so policy doesn't apply
  const authContext: AccessContext = { userId: "user1" };
  // Since no other policies and defaultAllow is false, should still be denied
  assertEquals(evaluator.evaluate("AnyType", "select", authContext).allowed, false);
});

Deno.test("AccessEvaluator - getPolicies returns registered policies", () => {
  const evaluator = new AccessEvaluator(createTestConfig());
  
  evaluator.registerPolicy({
    name: "policy1",
    objectType: "Type1",
    actions: [{ allow: true, operations: ["select"] }],
  });
  
  evaluator.registerPolicy({
    name: "policy2",
    objectType: "Type1",
    actions: [{ allow: true, operations: ["insert"] }],
  });
  
  evaluator.registerPolicy({
    name: "policy3",
    objectType: "Type2",
    actions: [{ allow: true, operations: ["select"] }],
  });
  
  const type1Policies = evaluator.getPolicies("Type1");
  assertEquals(type1Policies.length, 2);
  
  const type2Policies = evaluator.getPolicies("Type2");
  assertEquals(type2Policies.length, 1);
  
  const allPolicies = evaluator.getPolicies();
  assertEquals(allPolicies.length, 3);
});

Deno.test("AccessEvaluator - clearPolicies removes all policies", () => {
  const evaluator = new AccessEvaluator(createTestConfig());
  
  evaluator.registerPolicy({
    name: "policy1",
    objectType: "Type1",
    actions: [{ allow: true, operations: ["select"] }],
  });
  
  assertEquals(evaluator.getPolicies().length, 1);
  
  evaluator.clearPolicies();
  
  assertEquals(evaluator.getPolicies().length, 0);
});