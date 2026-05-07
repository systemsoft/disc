/**
 * Tests for Access Policy Parser
 */

import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { SDLLexer } from "../schema/lexer.ts";
import { AccessPolicyParser } from "./parser.ts";
import { SyntaxError } from "../lib/errors.ts";

Deno.test("AccessPolicyParser - parse simple allow policy", () => {
  const source = `
    access policy public_read for User {
      allow select;
    }
  `;

  const lexer = new SDLLexer(source);
  const tokens = lexer.tokenize();
  const parser = new AccessPolicyParser(tokens, source);
  const policy = parser.parseAccessPolicy();

  assertEquals(policy.kind, "AccessPolicy");
  assertEquals(policy.name, "public_read");
  assertEquals(policy.objectType, "User");
  assertEquals(policy.rules.length, 1);
  assertEquals(policy.rules[0].action, "allow");
  assertEquals(policy.rules[0].operations.length, 1);
  assertEquals(policy.rules[0].operations[0].operation, "select");
});

Deno.test("AccessPolicyParser - parse policy with multiple operations", () => {
  const source = `
    access policy user_crud for Post {
      allow select, insert, update, delete;
    }
  `;

  const lexer = new SDLLexer(source);
  const tokens = lexer.tokenize();
  const parser = new AccessPolicyParser(tokens, source);
  const policy = parser.parseAccessPolicy();

  assertEquals(policy.rules[0].operations.length, 4);
  assertEquals(policy.rules[0].operations[0].operation, "select");
  assertEquals(policy.rules[0].operations[1].operation, "insert");
  assertEquals(policy.rules[0].operations[2].operation, "update");
  assertEquals(policy.rules[0].operations[3].operation, "delete");
});

Deno.test("AccessPolicyParser - parse policy with condition", () => {
  const source = `
    access policy owner_access for Post {
      allow all when .author = current_user;
    }
  `;

  const lexer = new SDLLexer(source);
  const tokens = lexer.tokenize();
  const parser = new AccessPolicyParser(tokens, source);
  const policy = parser.parseAccessPolicy();

  assertEquals(policy.rules[0].operations[0].operation, "all");
  assertEquals(policy.rules[0].condition?.kind, "AccessComparison");
});

Deno.test("AccessPolicyParser - parse policy with using clause", () => {
  const source = `
    access policy tenant_isolation for Document {
      allow select;
      using (.tenant_id = current_session.tenant_id);
    }
  `;

  const lexer = new SDLLexer(source);
  const tokens = lexer.tokenize();
  const parser = new AccessPolicyParser(tokens, source);
  const policy = parser.parseAccessPolicy();

  assertEquals(policy.using?.kind, "AccessComparison");
});

Deno.test("AccessPolicyParser - parse policy with with check clause", () => {
  const source = `
    access policy valid_status for Order {
      allow insert;
      with check (.status in ["pending", "approved"]);
    }
  `;

  const lexer = new SDLLexer(source);
  const tokens = lexer.tokenize();
  const parser = new AccessPolicyParser(tokens, source);
  const policy = parser.parseAccessPolicy();

  assertEquals(policy.withCheck?.kind, "AccessComparison");
});

Deno.test("AccessPolicyParser - parse policy with deny rule", () => {
  const source = `
    access policy no_delete for AuditLog {
      deny delete;
      allow select;
    }
  `;

  const lexer = new SDLLexer(source);
  const tokens = lexer.tokenize();
  const parser = new AccessPolicyParser(tokens, source);
  const policy = parser.parseAccessPolicy();

  assertEquals(policy.rules.length, 2);
  assertEquals(policy.rules[0].action, "deny");
  assertEquals(policy.rules[0].operations[0].operation, "delete");
  assertEquals(policy.rules[1].action, "allow");
  assertEquals(policy.rules[1].operations[0].operation, "select");
});

Deno.test("AccessPolicyParser - parse policy with column restrictions", () => {
  const source = `
    access policy partial_update for User {
      allow update(name, bio);
      deny update(email, role);
    }
  `;

  const lexer = new SDLLexer(source);
  const tokens = lexer.tokenize();
  const parser = new AccessPolicyParser(tokens, source);
  const policy = parser.parseAccessPolicy();

  assertEquals(policy.rules[0].operations[0].columns, ["name", "bio"]);
  assertEquals(policy.rules[1].operations[0].columns, ["email", "role"]);
});

Deno.test("AccessPolicyParser - parse complex condition", () => {
  const source = `
    access policy complex_rule for Document {
      allow select when 
        .public = true or 
        (.author = current_user and .status != "draft") or
        has_role("admin");
    }
  `;

  const lexer = new SDLLexer(source);
  const tokens = lexer.tokenize();
  const parser = new AccessPolicyParser(tokens, source);
  const policy = parser.parseAccessPolicy();

  assertEquals(policy.rules[0].condition?.kind, "AccessLogical");
});

Deno.test("AccessPolicyParser - parse global policy", () => {
  const source = `
    access policy require_auth {
      deny all when current_user = null;
    }
  `;

  const lexer = new SDLLexer(source);
  const tokens = lexer.tokenize();
  const parser = new AccessPolicyParser(tokens, source);
  const policy = parser.parseAccessPolicy();

  assertEquals(policy.name, "require_auth");
  assertEquals(policy.objectType, undefined);
  assertEquals(policy.rules[0].action, "deny");
});

Deno.test("AccessPolicyParser - error on invalid operation", () => {
  const source = `
    access policy bad_op for User {
      allow invalid_operation;
    }
  `;

  const lexer = new SDLLexer(source);
  const tokens = lexer.tokenize();
  const parser = new AccessPolicyParser(tokens, source);

  assertThrows(
    () => parser.parseAccessPolicy(),
    SyntaxError,
    "Invalid access operation",
  );
});

Deno.test("AccessPolicyParser - parse policy with errmessage (Gel #4095)", () => {
  const source = `
    access policy admin_only for User {
      allow update when current_role = "admin";
      errmessage := "Only admins can modify this record";
    }
  `;

  const lexer = new SDLLexer(source);
  const tokens = lexer.tokenize();
  const parser = new AccessPolicyParser(tokens, source);
  const policy = parser.parseAccessPolicy();

  assertEquals(policy.errmessage, "Only admins can modify this record");
  assertEquals(policy.rules.length, 1);
  assertEquals(policy.rules[0].action, "allow");
});

Deno.test("AccessPolicyParser - errmessage is undefined when not specified", () => {
  const source = `
    access policy plain_policy for User {
      allow select;
    }
  `;

  const lexer = new SDLLexer(source);
  const tokens = lexer.tokenize();
  const parser = new AccessPolicyParser(tokens, source);
  const policy = parser.parseAccessPolicy();

  assertEquals(policy.errmessage, undefined);
});

Deno.test("AccessPolicyParser - parse function calls in conditions", () => {
  const source = `
    access policy admin_only for SystemConfig {
      allow all when has_role("admin");
      deny all when is_banned(current_user);
    }
  `;

  const lexer = new SDLLexer(source);
  const tokens = lexer.tokenize();
  const parser = new AccessPolicyParser(tokens, source);
  const policy = parser.parseAccessPolicy();

  const firstCondition = policy.rules[0].condition as any;
  assertEquals(firstCondition.kind, "AccessFunction");
  assertEquals(firstCondition.name, "has_role");

  const secondCondition = policy.rules[1].condition as any;
  assertEquals(secondCondition.kind, "AccessFunction");
  assertEquals(secondCondition.name, "is_banned");
});
