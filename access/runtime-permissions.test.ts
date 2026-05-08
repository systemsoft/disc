/**
 * Tests for the Deno-permission-aware access policy primitives (#5).
 *
 * Covers the pure spec-string parser plus integration through the
 * access-policy evaluator and SQL emitter. Uses an injected
 * `PermissionChecker` mock everywhere so tests don't depend on the
 * runner's `--allow-*` flags.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { SDLLexer } from "../schema/lexer.ts";
import type { AccessExpressionNode, AccessFunctionNode } from "./ast.ts";
import { AccessEvaluator } from "./evaluator.ts";
import { AccessPolicyParser } from "./parser.ts";
import { hasPermission, parsePermissionSpec, type PermissionChecker, type PermissionSpec } from "./runtime-permissions.ts";
import type { AccessContext } from "./types.ts";

// --- parsePermissionSpec ---

Deno.test("parsePermissionSpec: bare names map to descriptors with no scope", () => {
  for (const name of ["read", "write", "net", "env", "run", "sys", "ffi"]) {
    const spec = parsePermissionSpec(name);
    assertEquals(spec.name, name);
    assertEquals(Object.keys(spec).length, 1);
  }
});

Deno.test("parsePermissionSpec: scoped read/write/ffi map scope to `path`", () => {
  assertEquals(parsePermissionSpec("read:/etc/secrets"), { name: "read", path: "/etc/secrets" });
  assertEquals(parsePermissionSpec("write:/tmp"), { name: "write", path: "/tmp" });
  assertEquals(parsePermissionSpec("ffi:/usr/lib/libfoo.so"), { name: "ffi", path: "/usr/lib/libfoo.so" });
});

Deno.test("parsePermissionSpec: scoped net maps to `host`, env to `variable`, run to `command`, sys to `kind`", () => {
  assertEquals(parsePermissionSpec("net:api.example.com"), { name: "net", host: "api.example.com" });
  assertEquals(parsePermissionSpec("net:host:8080"), { name: "net", host: "host:8080" });
  assertEquals(parsePermissionSpec("env:DATABASE_URL"), { name: "env", variable: "DATABASE_URL" });
  assertEquals(parsePermissionSpec("run:git"), { name: "run", command: "git" });
  assertEquals(parsePermissionSpec("sys:hostname"), { name: "sys", kind: "hostname" });
});

Deno.test("parsePermissionSpec: rejects unknown names", () => {
  assertThrows(() => parsePermissionSpec("filesystem"), Error, "Unknown permission name");
  assertThrows(() => parsePermissionSpec("admin"), Error, "Unknown permission name");
});

Deno.test("parsePermissionSpec: rejects empty input or empty scope", () => {
  assertThrows(() => parsePermissionSpec(""), Error);
  assertThrows(() => parsePermissionSpec("read:"), Error, "empty scope");
});

// --- hasPermission with injected checker ---

Deno.test("hasPermission: returns true only for granted state", () => {
  const grantAll: PermissionChecker = () => "granted";
  const denyAll: PermissionChecker = () => "denied";
  const promptAll: PermissionChecker = () => "prompt";
  assertEquals(hasPermission("net", grantAll), true);
  assertEquals(hasPermission("net", denyAll), false);
  assertEquals(hasPermission("net", promptAll), false);
});

// --- Parser: runtime::has_permission(...) tokenizes and parses ---

function parseExpr(source: string): AccessExpressionNode {
  // Wrap in a minimal access policy and pull out the using expression.
  const wrapped = `access policy test for X { allow select; using (${source}); }`;
  const lexer = new SDLLexer(wrapped);
  const tokens = lexer.tokenize();
  const parser = new AccessPolicyParser(tokens, wrapped);
  const policy = parser.parseAccessPolicy();
  if (!policy.using)
    throw new Error("test setup: expected `using` clause");
  return policy.using;
}

Deno.test("parser accepts runtime::has_permission(\"net\")", () => {
  const expr = parseExpr(`runtime::has_permission("net")`) as AccessFunctionNode;
  assertEquals(expr.kind, "AccessFunction");
  assertEquals(expr.name, "runtime::has_permission");
  assertEquals(expr.args.length, 1);
});

Deno.test("parser accepts scoped permission strings", () => {
  const expr = parseExpr(`runtime::has_permission("read:/etc/secrets")`) as AccessFunctionNode;
  assertEquals(expr.name, "runtime::has_permission");
  const lit = expr.args[0];
  if (lit.kind !== "AccessLiteral")
    throw new Error("expected literal");
  assertEquals(lit.value, "read:/etc/secrets");
});

Deno.test("parser composes runtime::has_permission with AND", () => {
  const expr = parseExpr(
    `runtime::has_permission("net") and current_user.is_admin`
  );
  // Top-level should be AccessLogical with operator "and"
  if (expr.kind !== "AccessLogical")
    throw new Error("expected logical AND");
  assertEquals(expr.operator, "and");
  assertEquals(expr.operands.length, 2);
  assertEquals(expr.operands[0].kind, "AccessFunction");
});

// --- Evaluator: runtime::has_permission(...) returns granted state ---

function makeCtx(checker: PermissionChecker): AccessContext {
  return {
    userId: "u1",
    userRole: "admin",
    permissionChecker: checker
  };
}

Deno.test("evaluator: runtime::has_permission returns true when checker grants", () => {
  const ev = new AccessEvaluator({ defaultAllow: false, enableRLS: true, enableAudit: false, mode: "permissive" });
  const expr = parseExpr(`runtime::has_permission("net")`);
  const calls: PermissionSpec[] = [];
  const checker: PermissionChecker = s => {
    calls.push(s);
    return "granted";
  };
  // @ts-expect-error testing private path via the public evaluator
  const result = ev.evaluateExpression(expr, makeCtx(checker));
  assertEquals(result, true);
  assertEquals(calls, [{ name: "net" }]);
});

Deno.test("evaluator: runtime::has_permission returns false when denied or prompt", () => {
  const ev = new AccessEvaluator({ defaultAllow: false, enableRLS: true, enableAudit: false, mode: "permissive" });
  const expr = parseExpr(`runtime::has_permission("read:/secrets")`);
  // @ts-expect-error testing private path via the public evaluator
  assertEquals(ev.evaluateExpression(expr, makeCtx(() => "denied")), false);
  // @ts-expect-error testing private path via the public evaluator
  assertEquals(ev.evaluateExpression(expr, makeCtx(() => "prompt")), false);
});

Deno.test("evaluator: rejects non-literal arguments to runtime::has_permission", () => {
  const ev = new AccessEvaluator({ defaultAllow: false, enableRLS: true, enableAudit: false, mode: "permissive" });
  // Construct the function call with a non-literal argument directly.
  const expr: AccessFunctionNode = {
    kind: "AccessFunction",
    name: "runtime::has_permission",
    args: [{ kind: "AccessGlobal", name: "current_user" }]
  };
  // @ts-expect-error testing private path via the public evaluator
  assertThrows(() => ev.evaluateExpression(expr, makeCtx(() => "granted")), Error, "string literal");
});

// --- SQL emission: pre-evaluates and inlines TRUE/FALSE ---

Deno.test("expressionToSQL: runtime::has_permission inlines TRUE when granted", () => {
  const ev = new AccessEvaluator({ defaultAllow: false, enableRLS: true, enableAudit: false, mode: "permissive" });
  const expr = parseExpr(`runtime::has_permission("net")`);
  const sql = ev.expressionToSQL(expr, makeCtx(() => "granted"));
  assertEquals(sql, "TRUE");
});

Deno.test("expressionToSQL: runtime::has_permission inlines FALSE when denied", () => {
  const ev = new AccessEvaluator({ defaultAllow: false, enableRLS: true, enableAudit: false, mode: "permissive" });
  const expr = parseExpr(`runtime::has_permission("ffi")`);
  const sql = ev.expressionToSQL(expr, makeCtx(() => "denied"));
  assertEquals(sql, "FALSE");
});

Deno.test("expressionToSQL: composes with existing globals (admin and granted permission)", () => {
  const ev = new AccessEvaluator({ defaultAllow: false, enableRLS: true, enableAudit: false, mode: "permissive" });
  const expr = parseExpr(
    `current_user = "alice" and runtime::has_permission("net")`
  );
  const sql = ev.expressionToSQL(expr, { ...makeCtx(() => "granted"), userId: "alice" });
  // Both sides resolve to literals; no Deno-side function survives in the SQL.
  assertEquals(sql, "((E'alice' = E'alice') AND TRUE)");
});

Deno.test("expressionToSQL: denied permission short-circuits to FALSE in composed expression", () => {
  const ev = new AccessEvaluator({ defaultAllow: false, enableRLS: true, enableAudit: false, mode: "permissive" });
  const expr = parseExpr(
    `current_user = "alice" and runtime::has_permission("ffi")`
  );
  const sql = ev.expressionToSQL(expr, { ...makeCtx(() => "denied"), userId: "alice" });
  // The AND clause survives, but the runtime check is FALSE, so Postgres will
  // evaluate the row filter as false and return zero rows.
  assertEquals(sql, "((E'alice' = E'alice') AND FALSE)");
});
