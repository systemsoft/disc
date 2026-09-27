/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for Access Policy Evaluator
 */

/*** NATIVE ------------------------------------------- ***/

import { assertEquals } from "@std/assert";

/*** UTILITY ------------------------------------------ ***/

import { AccessEvaluator } from "./evaluator.ts";
import type { AccessExpressionNode } from "./ast.ts";
import { type AccessConfig, type AccessContext, type AccessPolicy } from "./types.ts";

/*** RUNTIME ------------------------------------------ ***/

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
    actions: [{ allow: true, operations: ["select"] }],
    name: "allow_select",
    objectType: "User"
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
    actions: [{ allow: false, operations: ["delete"] }],
    name: "deny_delete",
    objectType: "User"
  };

  evaluator.registerPolicy(policy);

  const context: AccessContext = { userId: "user1" };
  const decision = evaluator.evaluate("User", "delete", context);

  assertEquals(decision.allowed, false);
});

Deno.test("AccessEvaluator - all operation matches any", () => {
  const evaluator = new AccessEvaluator(createTestConfig());

  const policy: AccessPolicy = {
    actions: [{ allow: true, operations: ["all"] }],
    name: "allow_all",
    objectType: "Post"
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
    actions: [{ allow: true, operations: ["select"] }],
    name: "allow_read",
    objectType: "Document"
  });

  evaluator.registerPolicy({
    actions: [{ allow: true, operations: ["insert", "update"] }],
    name: "allow_write",
    objectType: "Document"
  });

  const context: AccessContext = { userId: "user1" };

  assertEquals(evaluator.evaluate("Document", "select", context).allowed, true);
  assertEquals(evaluator.evaluate("Document", "update", context).allowed, true);
  assertEquals(evaluator.evaluate("Document", "delete", context).allowed, false);
});

Deno.test("AccessEvaluator - deny overrides allow in permissive mode", () => {
  const evaluator = new AccessEvaluator(createTestConfig({ mode: "permissive" }));

  evaluator.registerPolicy({
    actions: [{ allow: true, operations: ["all"] }],
    name: "allow_all",
    objectType: "Secret"
  });

  evaluator.registerPolicy({
    actions: [{ allow: false, operations: ["delete"] }],
    name: "deny_delete",
    objectType: "Secret"
  });

  const context: AccessContext = { userId: "user1" };

  assertEquals(evaluator.evaluate("Secret", "select", context).allowed, true);
  assertEquals(evaluator.evaluate("Secret", "delete", context).allowed, false);
});

Deno.test("AccessEvaluator - restrictive mode requires explicit allow", () => {
  const evaluator = new AccessEvaluator(createTestConfig({ mode: "restrictive" }));

  evaluator.registerPolicy({
    actions: [{ allow: true, operations: ["select"] }],
    name: "allow_select",
    objectType: "Private"
  });

  const context: AccessContext = { userId: "user1" };

  assertEquals(evaluator.evaluate("Private", "select", context).allowed, true);
  assertEquals(evaluator.evaluate("Private", "update", context).allowed, false);
});

Deno.test("AccessEvaluator - restrictive mode with early deny", () => {
  const evaluator = new AccessEvaluator(createTestConfig({ mode: "restrictive" }));

  evaluator.registerPolicy({
    actions: [{ allow: false, operations: ["all"] }],
    name: "deny_all",
    objectType: "Forbidden"
  });

  evaluator.registerPolicy({
    actions: [{ allow: true, operations: ["select"] }],
    name: "allow_select",
    objectType: "Forbidden"
  });

  const context: AccessContext = { userId: "user1" };
  const decision = evaluator.evaluate("Forbidden", "select", context);

  assertEquals(decision.allowed, false);
  assertEquals(decision.reason, "Denied by policy: deny_all");
});

Deno.test("AccessEvaluator - global policy applies to all types", () => {
  const evaluator = new AccessEvaluator(createTestConfig());

  const globalPolicy: AccessPolicy = {
    actions: [{ allow: false, operations: ["all"] }],
    condition: {
      kind: "AccessComparison",
      left: { kind: "AccessGlobal", name: "current_user" },
      operator: "=",
      right: { kind: "AccessLiteral", value: null, type: "null" }
    } as any,
    name: "require_auth",
    objectType: "" /*** Global policy ***/
  };

  evaluator.registerPolicy(globalPolicy);

  /*** With no user, should be denied ***/
  const noAuthContext: AccessContext = {};
  assertEquals(evaluator.evaluate("AnyType", "select", noAuthContext).allowed, false);

  /*** With user, condition not met, so policy doesn’t apply ***/
  const authContext: AccessContext = { userId: "user1" };
  /*** Since no other policies and defaultAllow is false, should still be denied ***/
  assertEquals(evaluator.evaluate("AnyType", "select", authContext).allowed, false);
});

Deno.test("AccessEvaluator - deny in restrictive mode surfaces policy errmessage (Gel #4095)", () => {
  const evaluator = new AccessEvaluator(createTestConfig({ mode: "restrictive" }));

  evaluator.registerPolicy({
    actions: [{ allow: false, operations: ["update"] }],
    errmessage: "Only admins can modify this record",
    name: "admin_only",
    objectType: "Secret"
  });

  const decision = evaluator.evaluate("Secret", "update", { userId: "u1" });

  assertEquals(decision.allowed, false);
  assertEquals(decision.denialMessage, "Only admins can modify this record");
});

Deno.test("AccessEvaluator - deny in permissive mode surfaces policy errmessage (Gel #4095)", () => {
  const evaluator = new AccessEvaluator(createTestConfig({ mode: "permissive" }));

  evaluator.registerPolicy({
    actions: [{ allow: true, operations: ["all"] }],
    name: "allow_all",
    objectType: "Doc"
  });

  evaluator.registerPolicy({
    actions: [{ allow: false, operations: ["delete"] }],
    errmessage: "Documents are append-only and cannot be deleted",
    name: "no_delete",
    objectType: "Doc"
  });

  const decision = evaluator.evaluate("Doc", "delete", { userId: "u1" });

  assertEquals(decision.allowed, false);
  assertEquals(decision.denialMessage, "Documents are append-only and cannot be deleted");
});

Deno.test("AccessEvaluator - allow verdict has no denialMessage", () => {
  const evaluator = new AccessEvaluator(createTestConfig());

  evaluator.registerPolicy({
    actions: [{ allow: true, operations: ["select"] }],
    errmessage: "should not be surfaced",
    name: "allow_select",
    objectType: "User"
  });

  const decision = evaluator.evaluate("User", "select", { userId: "u1" });

  assertEquals(decision.allowed, true);
  assertEquals(decision.denialMessage, undefined);
});

Deno.test("AccessEvaluator - deny without errmessage leaves denialMessage undefined", () => {
  const evaluator = new AccessEvaluator(createTestConfig({ mode: "restrictive" }));

  evaluator.registerPolicy({
    actions: [{ allow: false, operations: ["select"] }],
    name: "deny_select",
    objectType: "User"
  });

  const decision = evaluator.evaluate("User", "select", { userId: "u1" });

  assertEquals(decision.allowed, false);
  assertEquals(decision.denialMessage, undefined);
});

Deno.test("AccessEvaluator - getPolicies returns registered policies", () => {
  const evaluator = new AccessEvaluator(createTestConfig());

  evaluator.registerPolicy({
    actions: [{ allow: true, operations: ["select"] }],
    name: "policy1",
    objectType: "Type1"
  });

  evaluator.registerPolicy({
    actions: [{ allow: true, operations: ["insert"] }],
    name: "policy2",
    objectType: "Type1"
  });

  evaluator.registerPolicy({
    actions: [{ allow: true, operations: ["select"] }],
    name: "policy3",
    objectType: "Type2"
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
    actions: [{ allow: true, operations: ["select"] }],
    name: "policy1",
    objectType: "Type1"
  });

  assertEquals(evaluator.getPolicies().length, 1);
  evaluator.clearPolicies();
  assertEquals(evaluator.getPolicies().length, 0);
});

// --- Custom globals integration tests ---

Deno.test("AccessEvaluator - evaluateGlobal returns custom global value from context.globals", () => {
  const evaluator = new AccessEvaluator(createTestConfig());

  const globals = new Map<string, unknown>();
  globals.set("tenant_id", "acme-corp");
  globals.set("is_admin", true);

  const policy: AccessPolicy = {
    actions: [{ allow: true, operations: ["select"] }],
    condition: {
      kind: "AccessGlobal",
      name: "is_admin"
    } as any,
    name: "check_custom_global",
    objectType: "Tenant"
  };

  evaluator.registerPolicy(policy);

  const context: AccessContext = { userId: "user1", globals };
  const decision = evaluator.evaluate("Tenant", "select", context);

  assertEquals(decision.allowed, true);
  assertEquals(decision.appliedPolicies, ["check_custom_global"]);
});

Deno.test("AccessEvaluator - expressionToSQL reads a custom global from the setting set global writes", () => {
  const evaluator = new AccessEvaluator(createTestConfig());
  const context: AccessContext = { userId: "user1" };

  assertEquals(
    evaluator.expressionToSQL({ kind: "AccessGlobal", name: "tenant_id" }, context),
    "NULLIF(current_setting('disc.global_default__tenant_id', true), '')"
  );
  assertEquals(
    evaluator.expressionToSQL({ kind: "AccessGlobal", name: "billing::tenant_id" }, context),
    "NULLIF(current_setting('disc.global_billing__tenant_id', true), '')"
  );
});

Deno.test("AccessEvaluator - expressionToSQL takes a custom global's SQL from the resolver, in the policy's type", () => {
  const evaluator = new AccessEvaluator(createTestConfig());
  const seen: [string, string | undefined][] = [];
  evaluator.setGlobalResolver((name, objectType) => {
    seen.push([name, objectType]);
    return name === "tenant_id" ? "resolved_tenant" : undefined;
  });

  assertEquals(evaluator.expressionToSQL({ kind: "AccessGlobal", name: "tenant_id" }, {}, "Doc"), "resolved_tenant");
  assertEquals(
    evaluator.expressionToSQL({ kind: "AccessGlobal", name: "other" }, {}, "Doc"),
    "NULLIF(current_setting('disc.global_default__other', true), '')"
  );
  assertEquals(seen, [["tenant_id", "Doc"], ["other", "Doc"]]);
});

Deno.test("AccessEvaluator - expressionToSQL inlines a custom global the context supplies", () => {
  const evaluator = new AccessEvaluator(createTestConfig());
  const context: AccessContext = { globals: new Map<string, unknown>([["is_admin", false], ["tenant_id", "acme"]]) };

  assertEquals(evaluator.expressionToSQL({ kind: "AccessGlobal", name: "is_admin" }, context), "FALSE");
  assertEquals(evaluator.expressionToSQL({ kind: "AccessGlobal", name: "tenant_id" }, context), "E'acme'");
});

Deno.test("AccessEvaluator - a condition over a custom global the context lacks is left to the policy's SQL", () => {
  const evaluator = new AccessEvaluator(createTestConfig());
  const isAdmin = { kind: "AccessGlobal" as const, name: "is_admin" };
  evaluator.registerPolicy({
    actions: [{ allow: true, operations: ["select"] }],
    condition: isAdmin,
    name: "admins",
    objectType: "Tenant",
    using: isAdmin
  });

  const decision = evaluator.evaluate("Tenant", "select", { userId: "user1" });
  assertEquals(decision.allowed, true);
  assertEquals(decision.sqlConditions, ["NULLIF(current_setting('disc.global_default__is_admin', true), '')"]);

  // Supplied by the context, it is inlined in the SQL, which still decides.
  assertEquals(evaluator.evaluate("Tenant", "select", { globals: new Map([["is_admin", false]]) }).sqlConditions, ["FALSE"]);
});

Deno.test("AccessEvaluator - built-in globals still work with backward compatibility", () => {
  const evaluator = new AccessEvaluator(createTestConfig());

  const context: AccessContext = {
    sessionData: { foo: "bar" },
    userId: "user-123",
    userRole: "admin"
  };

  /*** current_user SQL generation (E'…' escape-literal form, safe
       against standard_conforming_strings=off) ***/
  const userExpr = { kind: "AccessGlobal" as const, name: "current_user" };
  assertEquals(evaluator.expressionToSQL(userExpr, context), "E'user-123'");

  /*** current_role SQL generation ***/
  const roleExpr = { kind: "AccessGlobal" as const, name: "current_role" };
  assertEquals(evaluator.expressionToSQL(roleExpr, context), "E'admin'");

  /*** current_session SQL generation ***/
  const sessionExpr = {
    kind: "AccessGlobal" as const,
    name: "current_session"
  };

  assertEquals(evaluator.expressionToSQL(sessionExpr, context), "'true'");

  /*** Built-in evaluateGlobal still works via policy condition ***/
  const policy: AccessPolicy = {
    actions: [{ allow: true, operations: ["select"] }],
    condition: {
      kind: "AccessGlobal",
      name: "current_user"
    } as any,
    name: "require_user",
    objectType: "Resource"
  };

  evaluator.registerPolicy(policy);

  // With userId set, condition should pass
  const withUser: AccessContext = { userId: "user-123" };
  assertEquals(evaluator.evaluate("Resource", "select", withUser).allowed, true);

  // Without userId, condition should fail
  const noUser: AccessContext = {};
  assertEquals(evaluator.evaluate("Resource", "select", noUser).allowed, false);
});

/*** P0-01 / P0-02: SQL injection via context.userId / context.userRole / globals ***/

Deno.test("AccessEvaluator - expressionToSQL escapes single quotes in userId", () => {
  const evaluator = new AccessEvaluator(createTestConfig());

  const sql = evaluator.expressionToSQL(
    { kind: "AccessGlobal", name: "current_user" },
    { userId: "admin'; DROP TABLE users; --" }
  );

  /*** The unescaped attack substring must not leak through. ***/
  assertEquals(
    sql.includes("DROP TABLE users"),
    true,
    "input literally contains the phrase, but it must be INSIDE a quoted E'…' literal"
  );

  /*** The first character of the injection — the single quote — must be doubled, so the SQL stays
       inside a single string literal. ***/
  assertEquals(sql.includes("admin''; DROP TABLE users; --"), true);
  /*** And the result must use the E'…' escape-literal form. ***/
  assertEquals(sql.startsWith("E'"), true);
});

Deno.test("AccessEvaluator - expressionToSQL escapes backslashes in userId", () => {
  const evaluator = new AccessEvaluator(createTestConfig());

  const sql = evaluator.expressionToSQL(
    { kind: "AccessGlobal", name: "current_user" },
    { userId: "evil\\'; DROP TABLE x; --" }
  );

  /*** Backslash must be doubled — defends against standard_conforming_strings=off ***/
  assertEquals(sql.includes("evil\\\\"), true, `Expected doubled backslash in ${sql}`);
});

Deno.test("AccessEvaluator - expressionToSQL escapes userRole the same way", () => {
  const evaluator = new AccessEvaluator(createTestConfig());

  const sql = evaluator.expressionToSQL(
    { kind: "AccessGlobal", name: "current_role" },
    { userRole: "admin'--" }
  );

  assertEquals(sql.startsWith("E'"), true);
  assertEquals(sql.includes("admin''--"), true);
});

Deno.test("AccessEvaluator - custom global with unsafe name is rejected", () => {
  const evaluator = new AccessEvaluator(createTestConfig());
  let threw = false;

  try {
    evaluator.expressionToSQL(
      { kind: "AccessGlobal", name: "evil'); DROP TABLE x; --" },
      {}
    );
  } catch (_) {
    threw = true;
  }

  assertEquals(threw, true, "Unsafe global identifier must throw");
});

/*** gh/geldata#6432 slice 3 — per-policy disable for testing. `AccessContext.disabledPolicies`
     carries qualified policy names (`<TypeName>.<policy_name>`). The evaluator filters them out
     before evaluation, so a disabled deny-policy stops denying and a disabled allow-policy stops
     allowing — same shape as if the policy weren’t declared at all. ***/
Deno.test("AccessEvaluator - disabledPolicies skips matching policies (Bundle UU — gh/geldata#6432)", () => {
  const evaluator = new AccessEvaluator(createTestConfig({ defaultAllow: true }));

  /*** A deny policy that would normally fire on delete. ***/
  const denyPolicy: AccessPolicy = {
    actions: [{ allow: false, operations: ["delete"] }],
    name: "no_delete",
    objectType: "Doc"
  };

  evaluator.registerPolicy(denyPolicy);

  /*** Without the disable, delete is denied. ***/
  const baseline = evaluator.evaluate("Doc", "delete", { userId: "u1" });
  assertEquals(baseline.allowed, false, "Baseline: delete is denied by no_delete");

  /*** With `Doc.no_delete` disabled, the policy is filtered out and the type behaves as if the
       policy weren’t declared. Combined with `defaultAllow: true`, that means the operation
       is allowed. ***/
  const withDisable = evaluator.evaluate("Doc", "delete", {
    disabledPolicies: new Set(["Doc.no_delete"]),
    userId: "u1"
  });

  assertEquals(
    withDisable.allowed,
    true,
    "disabledPolicies must skip the deny policy and fall back to default"
  );

  assertEquals(
    withDisable.reason,
    "No policies defined, default allow",
    "Disabling every policy on a type should match the no-policies-defined path"
  );
});

Deno.test("AccessEvaluator - disabledPolicies only matches the named policy (Bundle UU)", () => {
  const evaluator = new AccessEvaluator(createTestConfig());

  evaluator.registerPolicy({
    actions: [{ allow: true, operations: ["select"] }],
    name: "owner_select",
    objectType: "Doc"
  });

  evaluator.registerPolicy({
    actions: [{ allow: true, operations: ["select"] }],
    name: "admin_select",
    objectType: "Doc"
  });

  /*** Disable only owner_select. The other allow-policy still applies, so the request
       remains allowed. ***/
  const decision = evaluator.evaluate("Doc", "select", {
    disabledPolicies: new Set(["Doc.owner_select"]),
    userId: "u1"
  });

  assertEquals(decision.allowed, true, "Request still allowed via admin_select");

  /*** appliedPolicies should not list the disabled one. ***/
  assertEquals(decision.appliedPolicies.includes("owner_select"), false, "Disabled policy must not appear in appliedPolicies");
  assertEquals(decision.appliedPolicies.includes("admin_select"), true, "Non-disabled policy must still appear in appliedPolicies");
});

Deno.test("AccessEvaluator - disabledPolicies on a different type is a no-op (Bundle UU)", () => {
  const evaluator = new AccessEvaluator(createTestConfig());

  evaluator.registerPolicy({
    actions: [{ allow: true, operations: ["select"] }],
    name: "owner_select",
    objectType: "Doc"
  });

  /*** Disabling `User.owner_select` should not affect `Doc.owner_select` — qualified names mean the
       type binding matters. ***/
  const decision = evaluator.evaluate("Doc", "select", {
    disabledPolicies: new Set(["User.owner_select"]),
    userId: "u1"
  });

  assertEquals(decision.allowed, true);
  assertEquals(decision.appliedPolicies, ["owner_select"]);
});

Deno.test("AccessEvaluator - update is update read and update write", () => {
  const evaluator = new AccessEvaluator(createTestConfig());

  evaluator.registerPolicy({ actions: [{ allow: true, operations: ["update"] }], name: "edit", objectType: "Doc" });
  evaluator.registerPolicy({ actions: [{ allow: true, operations: ["update read"] }], name: "reach", objectType: "Note" });

  assertEquals(evaluator.evaluate("Doc", "update read", { userId: "u1" }).allowed, true);
  assertEquals(evaluator.evaluate("Doc", "update write", { userId: "u1" }).allowed, true);
  assertEquals(evaluator.evaluate("Note", "update read", { userId: "u1" }).allowed, true);
  assertEquals(evaluator.evaluate("Note", "update write", { userId: "u1" }).allowed, false);
});

Deno.test("AccessEvaluator - an in-memory condition compares globals by value, not as booleans", () => {
  const evaluator = new AccessEvaluator(createTestConfig());
  const role = (operator: "=" | "!=", value: string): AccessExpressionNode => ({
    kind: "AccessComparison",
    left: { kind: "AccessGlobal", name: "current_role" },
    operator,
    right: { kind: "AccessLiteral", type: "string", value }
  });

  evaluator.registerPolicy({ actions: [{ allow: true, operations: ["select"] }], condition: role("=", "admin"), name: "admins", objectType: "Doc" });
  evaluator.registerPolicy({ actions: [{ allow: true, operations: ["select"] }], condition: role("!=", "guest"), name: "members", objectType: "Note" });

  assertEquals(evaluator.evaluate("Doc", "select", { userRole: "admin" }).allowed, true);
  assertEquals(evaluator.evaluate("Doc", "select", { userRole: "member" }).allowed, false);
  assertEquals(evaluator.evaluate("Doc", "select", {}).allowed, false);
  assertEquals(evaluator.evaluate("Note", "select", { userRole: "admin" }).allowed, true);
  assertEquals(evaluator.evaluate("Note", "select", { userRole: "guest" }).allowed, false);
});

Deno.test("AccessEvaluator - a condition with SQL is left to the SQL, never decided in memory", () => {
  const evaluator = new AccessEvaluator(createTestConfig());
  evaluator.setPolicyCompiler(edgeql => `<sql of ${edgeql}>`);
  // As the adapter builds it for `using (.public ?= true or .owner ?= global current_user)`:
  // an in-memory guard requiring current_user, which is wrong for an anonymous caller.
  evaluator.registerPolicy({
    actions: [{ allow: true, operations: ["select"] }],
    condition: { kind: "AccessGlobal", name: "current_user" },
    name: "visible",
    objectType: "Doc",
    usingSource: ".public ?= true or .owner ?= global current_user"
  });

  const decision = evaluator.evaluate("Doc", "select", {});
  assertEquals(decision.allowed, true);
  assertEquals(decision.sqlConditions, ["<sql of .public ?= true or .owner ?= global current_user>"]);
});

Deno.test("AccessEvaluator - an allowing policy without a condition leaves the objects unfiltered", () => {
  const evaluator = new AccessEvaluator(createTestConfig());
  evaluator.setPolicyCompiler(edgeql => `<sql of ${edgeql}>`);
  evaluator.registerPolicy({ actions: [{ allow: true, operations: ["select"] }], name: "own", objectType: "Doc", usingSource: ".mine" });
  evaluator.registerPolicy({ actions: [{ allow: true, operations: ["select"] }], name: "everyone", objectType: "Doc" });

  const decision = evaluator.evaluate("Doc", "select", {});
  assertEquals(decision.allowed, true);
  assertEquals(decision.sqlConditions, undefined);
});

Deno.test("AccessEvaluator - writePolicies gives each policy's condition on written objects", () => {
  const evaluator = new AccessEvaluator(createTestConfig());
  const owner: AccessExpressionNode = {
    kind: "AccessComparison",
    left: { kind: "AccessPath", path: ["owner"] },
    operator: "=",
    right: { kind: "AccessGlobal", name: "current_user" }
  };

  evaluator.registerPolicy({ actions: [{ allow: true, operations: ["all"] }], errmessage: "yours only", name: "own", objectType: "Doc", using: owner });
  evaluator.registerPolicy({
    actions: [{ allow: false, operations: ["insert"] }],
    name: "no_draft",
    objectType: "Doc",
    using: { kind: "AccessPath", path: ["draft"] },
    withCheck: { kind: "AccessLiteral", type: "boolean", value: true }
  });

  assertEquals(evaluator.writePolicies("Doc", "insert", { userId: "u1" }), {
    allow: [{ condition: "((owner = E'u1'))", errmessage: "yours only" }],
    deny: [{ condition: "(draft) AND (true)", errmessage: undefined }]
  });
  assertEquals(evaluator.writePolicies("Doc", "update write", { userId: "u1" })?.deny, []);
  assertEquals(evaluator.writePolicies("Other", "insert", { userId: "u1" }), undefined);
  // A deny over the object's values is left to the write check: the insert itself is allowed.
  assertEquals(evaluator.evaluate("Doc", "insert", { userId: "u1" }).allowed, true);
  assertEquals(evaluator.evaluate("Doc", "delete", { userId: "u1" }).allowed, true);
});

/*** HELPER ------------------------------------------- ***/

function createTestConfig(overrides?: Partial<AccessConfig>): AccessConfig {
  return {
    defaultAllow: false,
    enableRLS: true,
    enableAudit: false,
    mode: "permissive",
    ...overrides
  };
}
