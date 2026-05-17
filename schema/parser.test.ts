/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for SDL Parser
 */

import { assertEquals, assertThrows } from "@std/assert";
import { SyntaxError } from "../lib/errors.ts";
import { SDLParser } from "./parser.ts";
import { SchemaValidator } from "./validator.ts";

Deno.test("SDL Parser - Basic Type Declaration", () => {
  const source = `
    type User {
      required name: str;
      email: str;
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "SDLDocument");
  assertEquals(ast.declarations.length, 1);

  const typeDecl = ast.declarations[0];
  assertEquals(typeDecl.kind, "TypeDeclaration");
  if (typeDecl.kind === "TypeDeclaration") {
    assertEquals(typeDecl.name.value, "User");
    assertEquals(typeDecl.members.length, 2);

    const nameProp = typeDecl.members[0];
    if (nameProp.kind === "PropertyDeclaration") {
      assertEquals(nameProp.name.value, "name");
      assertEquals(nameProp.required, true);
      assertEquals(nameProp.type.name.parts[0], "str");
    }
  }
});

Deno.test("SDL Parser - Type with Constraints", () => {
  const source = `
    type User {
      required email: str {
        constraint exclusive;
        constraint regexp(r'^[^@]+@[^@]+\\.[^@]+$');
      };
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();

  const typeDecl = ast.declarations[0];
  if (typeDecl.kind === "TypeDeclaration") {
    const emailProp = typeDecl.members[0];
    if (emailProp.kind === "PropertyDeclaration") {
      assertEquals(emailProp.constraints?.length, 2);
      assertEquals(emailProp.constraints?.[0].name?.value, "exclusive");
      assertEquals(emailProp.constraints?.[1].name?.value, "regexp");
    }
  }
});

Deno.test("SDL Parser - Links", () => {
  const source = `
    type Post {
      required title: str;
      required author: User;
      multi tags: Tag;
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();

  const typeDecl = ast.declarations[0];
  if (typeDecl.kind === "TypeDeclaration") {
    const authorLink = typeDecl.members[1];
    if (authorLink.kind === "LinkDeclaration") {
      assertEquals(authorLink.name.value, "author");
      assertEquals(authorLink.required, true);
      assertEquals(authorLink.target.name.parts[0], "User");
    }

    const tagsLink = typeDecl.members[2];
    if (tagsLink.kind === "LinkDeclaration") {
      assertEquals(tagsLink.multi, true);
    }
  }
});

Deno.test("SDL Parser - Computed Properties", () => {
  const source = `
    type Person {
      required first_name: str;
      required last_name: str;
      full_name := .first_name ++ ' ' ++ .last_name;
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();

  const typeDecl = ast.declarations[0];
  if (typeDecl.kind === "TypeDeclaration") {
    const fullNameProp = typeDecl.members[2];
    if (fullNameProp.kind === "PropertyDeclaration") {
      assertEquals(fullNameProp.name.value, "full_name");
      assertEquals(fullNameProp.computed?.kind, "BinaryOp");
    }
  }
});

Deno.test("SDL Parser - Module Declaration", () => {
  const source = `
    module default {
      type User {
        required name: str;
      };

      type Post {
        required title: str;
        required author: User;
      };
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();

  assertEquals(ast.declarations.length, 1);
  const moduleDecl = ast.declarations[0];

  if (moduleDecl.kind === "ModuleDeclaration") {
    assertEquals(moduleDecl.name.parts[0], "default");
    assertEquals(moduleDecl.declarations.length, 2);
  }
});

Deno.test("SDL Parser - Module with trailing semicolon (README syntax)", () => {
  // This is the exact form shown in README.md and CLAUDE.md
  const source = `module default {
  type User {
    required name: str;
    required email: str {
      constraint exclusive;
    };
  };
};`;

  const parser = new SDLParser(source);
  const ast = parser.parse();

  assertEquals(ast.declarations.length, 1);
  const moduleDecl = ast.declarations[0];
  assertEquals(moduleDecl.kind, "ModuleDeclaration");
  if (moduleDecl.kind === "ModuleDeclaration") {
    assertEquals(moduleDecl.declarations.length, 1);
  }
});

Deno.test("SDL Parser - Top-level type with trailing semicolon", () => {
  // A standalone type followed by a trailing semi at file end
  const source = `type Person {
    required name: str;
  };`;

  const parser = new SDLParser(source);
  const ast = parser.parse();

  assertEquals(ast.declarations.length, 1);
  assertEquals(ast.declarations[0].kind, "TypeDeclaration");
});

Deno.test("SDL Parser - rejects typo in property body (no silent skip) (P1-04)", () => {
  const source = `
    module default {
      type User {
        required name: str {
          typo_here;
        };
      }
    }
  `;
  let threw = false;
  try {
    new SDLParser(source).parse();
  } catch (_) {
    threw = true;
  }
  assertEquals(
    threw,
    true,
    "Unknown token in a property body must produce a syntax error"
  );
});

Deno.test("SDL Parser - rejects typo in access policy body (no silent skip) (P1-04)", () => {
  const source = `
    module default {
      type User {
        required name: str;
        access policy admin_all {
          allow all;
          typo_here;
        }
      }
    }
  `;
  let threw = false;
  try {
    new SDLParser(source).parse();
  } catch (_) {
    threw = true;
  }
  assertEquals(
    threw,
    true,
    "Unknown token in an access policy body must produce a syntax error"
  );
});

Deno.test("SDL Parser - Multiple trailing semicolons at end of file", () => {
  const source = `module default {
    type A { required x: str; };
  };;;`;

  const parser = new SDLParser(source);
  const ast = parser.parse();
  assertEquals(ast.declarations.length, 1);
});

Deno.test("SDL Parser - Type Extension", () => {
  const source = `
    abstract type Person {
      required name: str;
    }
    
    type User extending Person {
      required email: str;
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();

  assertEquals(ast.declarations.length, 2);

  const personType = ast.declarations[0];
  if (personType.kind === "TypeDeclaration") {
    assertEquals(personType.abstract, true);
  }

  const userType = ast.declarations[1];
  if (userType.kind === "TypeDeclaration") {
    assertEquals(userType.extending?.[0].name.parts[0], "Person");
  }
});

Deno.test("SDL Parser - Scalar Type", () => {
  const source = `
    scalar type Email extending str {
      constraint regexp(r'^[^@]+@[^@]+\\.[^@]+$');
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();

  const scalarDecl = ast.declarations[0];
  if (scalarDecl.kind === "ScalarTypeDeclaration") {
    assertEquals(scalarDecl.name.value, "Email");
    assertEquals(scalarDecl.extending?.[0].name.parts[0], "str");
    assertEquals(scalarDecl.constraints?.length, 1);
  }
});

Deno.test("SDL Parser - Alias", () => {
  const source = `
    alias CurrentUser := (
      select User filter .id = global current_user_id
    );
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();

  const aliasDecl = ast.declarations[0];
  if (aliasDecl.kind === "AliasDeclaration") {
    assertEquals(aliasDecl.name.value, "CurrentUser");
    assertEquals(aliasDecl.using.kind, "PathExpression"); // Simplified for this test
  }
});

Deno.test("SDL Parser - Default Values", () => {
  const source = `
    type Post {
      required title: str;
      createdAt: datetime {
        default := datetime_current();
        readonly := true;
      };
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();

  const typeDecl = ast.declarations[0];
  if (typeDecl.kind === "TypeDeclaration") {
    const createdAtProp = typeDecl.members[1];
    if (createdAtProp.kind === "PropertyDeclaration") {
      assertEquals(createdAtProp.default?.kind, "FunctionCall");
      assertEquals(createdAtProp.readonly, true);
    }
  }
});

Deno.test("SDL Parser - Index Declaration", () => {
  const source = `
    type User {
      required email: str;
      index on (.email);
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();

  const typeDecl = ast.declarations[0];
  if (typeDecl.kind === "TypeDeclaration") {
    const indexDecl = typeDecl.members[1];
    if (indexDecl.kind === "Index") {
      assertEquals(indexDecl.on.kind, "PathExpression");
    }
  }
});

Deno.test("SDL Parser - Access Policy", () => {
  const source = `
    type Document {
      required title: str;
      required owner: User;
      
      access policy owner_only {
        allow select, update, delete;
        using (global current_user ?= .owner);
      };
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();

  const typeDecl = ast.declarations[0];
  if (typeDecl.kind === "TypeDeclaration") {
    const policy = typeDecl.members[2];
    if (policy.kind === "AccessPolicy") {
      assertEquals(policy.name.value, "owner_only");
      assertEquals(policy.actions[0].allow, true);
      assertEquals(policy.actions[0].operations.length, 3);
      assertEquals(policy.condition?.kind, "BinaryOp");
    }
  }
});

Deno.test("SDL Parser - Access Policy with `with check` clause (P1-37)", () => {
  const source = `
    type Document {
      required title: str;
      required status: str;
      required owner: User;

      access policy owner_writes_only {
        allow select, insert, update;
        using (global current_user ?= .owner);
        with check (.status = "draft");
      };
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();

  const typeDecl = ast.declarations[0];
  assertEquals(typeDecl.kind, "TypeDeclaration");
  if (typeDecl.kind === "TypeDeclaration") {
    const policy = typeDecl.members.find(m => m.kind === "AccessPolicy");
    assertEquals(policy?.kind, "AccessPolicy");
    if (policy?.kind === "AccessPolicy") {
      assertEquals(policy.name.value, "owner_writes_only");
      assertEquals(policy.condition !== undefined, true);
      assertEquals(
        policy.withCheck !== undefined,
        true,
        "with check expression must be parsed onto policy.withCheck"
      );
    }
  }
});

Deno.test("SDL Parser - Access Policy without `with check` leaves withCheck undefined", () => {
  const source = `
    type Document {
      required title: str;
      access policy admin_all {
        allow all;
      };
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();
  const typeDecl = ast.declarations[0];
  if (typeDecl.kind === "TypeDeclaration") {
    const policy = typeDecl.members.find(m => m.kind === "AccessPolicy");
    if (policy?.kind === "AccessPolicy") {
      assertEquals(policy.withCheck, undefined);
    }
  }
});

Deno.test("SDL Parser - Access Policy with errmessage (Gel #4095)", () => {
  const source = `
    type Document {
      required title: str;
      access policy admin_only {
        allow update;
        errmessage := "Only admins can modify this record";
      };
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();
  const typeDecl = ast.declarations[0];
  assertEquals(typeDecl.kind, "TypeDeclaration");
  if (typeDecl.kind === "TypeDeclaration") {
    const policy = typeDecl.members.find(m => m.kind === "AccessPolicy");
    assertEquals(policy?.kind, "AccessPolicy");
    if (policy?.kind === "AccessPolicy") {
      assertEquals(policy.errmessage, "Only admins can modify this record");
    }
  }
});

Deno.test("SDL Parser - Access Policy without errmessage leaves it undefined", () => {
  const source = `
    type Document {
      required title: str;
      access policy admin_all {
        allow all;
      };
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();
  const typeDecl = ast.declarations[0];
  if (typeDecl.kind === "TypeDeclaration") {
    const policy = typeDecl.members.find(m => m.kind === "AccessPolicy");
    if (policy?.kind === "AccessPolicy") {
      assertEquals(policy.errmessage, undefined);
    }
  }
});

Deno.test("SDL Parser - `with` without `check` raises a clear error", () => {
  const source = `
    type Document {
      access policy bad {
        allow all;
        with (.x = 1);
      };
    }
  `;
  let threw = false;
  try {
    new SDLParser(source).parse();
  } catch (_) {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("SDL Parser - Function Declaration", () => {
  const source = `
    function get_user_by_email(email: str) -> User
      using (
        select User filter .email = email
      );
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();

  const funcDecl = ast.declarations[0];
  if (funcDecl.kind === "FunctionDeclaration") {
    assertEquals(funcDecl.name.value, "get_user_by_email");
    assertEquals(funcDecl.parameters.length, 1);
    assertEquals(funcDecl.parameters[0].name.value, "email");
    assertEquals(funcDecl.returnType.name.parts[0], "User");
  }
});

Deno.test("SDL Parser - Global Declaration", () => {
  const source = `
    global current_user_id: uuid;
    global app_settings: json {
      default := '{}';
    };
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();

  assertEquals(ast.declarations.length, 2);

  const globalDecl = ast.declarations[1];
  if (globalDecl.kind === "GlobalDeclaration") {
    assertEquals(globalDecl.name.value, "app_settings");
    assertEquals(globalDecl.type.name.parts[0], "json");
    assertEquals(globalDecl.default?.kind, "Literal");
  }
});

Deno.test("SDL Parser - Backtick Identifiers", () => {
  const source = `
    type \`User-Profile\` {
      required \`first-name\`: str;
      \`last-name\`: str;
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();

  const typeDecl = ast.declarations[0];
  if (typeDecl.kind === "TypeDeclaration") {
    assertEquals(typeDecl.name.value, "User-Profile");
    assertEquals(typeDecl.name.quoted, true);

    const firstNameProp = typeDecl.members[0];
    if (firstNameProp.kind === "PropertyDeclaration") {
      assertEquals(firstNameProp.name.value, "first-name");
      assertEquals(firstNameProp.name.quoted, true);
    }
  }
});

Deno.test("SDL Validator - Duplicate Type Error", () => {
  const source = `
    type User {
      required name: str;
    }
    
    type User {
      required email: str;
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();

  const validator = new SchemaValidator();
  const result = validator.validate(ast);

  assertEquals(result.ok, false);
  assertEquals(result.errors?.length, 1);
  assertEquals(result.errors?.[0].message, "Type 'User' is already defined");
});

Deno.test("SDL Validator - Undefined Type Error", () => {
  const source = `
    type Post {
      required title: str;
      required author: NonExistentType;
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();

  const validator = new SchemaValidator();
  const result = validator.validate(ast);

  assertEquals(result.ok, false);
  assertEquals(result.errors?.length, 1);
  assertEquals(
    result.errors?.[0].message,
    "Type 'NonExistentType' is not defined"
  );
});

Deno.test("SDL Validator - Valid Schema", () => {
  const source = `
    type User {
      required name: str;
      email: str;
    }
    
    type Post {
      required title: str;
      required author: User;
      createdAt: datetime;
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();

  const validator = new SchemaValidator();
  const result = validator.validate(ast);

  assertEquals(result.ok, true);
  assertEquals(result.errors, undefined);
});

Deno.test("SDL Parser - Syntax Error", () => {
  const source = `
    type User {
      required name str;  // Missing colon
    }
  `;

  assertThrows(
    () => {
      const parser = new SDLParser(source);
      parser.parse();
    },
    SyntaxError,
    "Expected ':' after property name"
  );
});

Deno.test("SDL Parser - Complex Expression", () => {
  const source = `
    type User {
      display_name := .first_name ++ ' ' ++ .last_name if .last_name != '' else .first_name;
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();

  const typeDecl = ast.declarations[0];
  if (typeDecl.kind === "TypeDeclaration") {
    const displayNameProp = typeDecl.members[0];
    if (displayNameProp.kind === "PropertyDeclaration") {
      assertEquals(displayNameProp.computed?.kind, "ConditionalExpression");
    }
  }
});

// ---------------------------------------------------------------------------
// Error recovery (P2-06): parseWithRecovery() collects every error and skips
// the malformed declaration instead of bailing on the first one.
// ---------------------------------------------------------------------------

Deno.test("SDL Parser - parseWithRecovery: clean source has zero errors", () => {
  const source = `
    type A { required name: str; }
    type B { required label: str; }
  `;

  const { document, errors } = new SDLParser(source).parseWithRecovery();
  assertEquals(errors.length, 0);
  assertEquals(document.declarations.length, 2);
});

Deno.test("SDL Parser - parseWithRecovery: collects multiple errors in one pass", () => {
  // Three top-level declarations; the middle one has a garbage token in
  // its body. Recovery should yield the first and third declarations and
  // record one error for the bad one.
  const source = `
    type Good1 { required name: str; }
    type Bad { @@@ }
    type Good2 { required label: str; }
  `;

  const { document, errors } = new SDLParser(source).parseWithRecovery();

  // The garbage token kills the Bad declaration; recovery picks up at
  // `type Good2` and parses it.
  assertEquals(
    document.declarations.length >= 2,
    true,
    `expected at least 2 declarations, got ${document.declarations.length}`
  );
  assertEquals(
    errors.length >= 1,
    true,
    `expected at least 1 error, got ${errors.length}`
  );
  // Good1 + Good2 must both be present in the recovered document.
  const names = document.declarations.flatMap(d => d.kind === "TypeDeclaration" ? [d.name.value] : []);
  assertEquals(names.includes("Good1"), true);
  assertEquals(names.includes("Good2"), true);
});

Deno.test("SDL Parser - parseWithRecovery: recovers across multiple bad blocks", () => {
  // Two malformed declarations interleaved with two clean ones. Use only
  // lexable input — `???` would fail at lex time, before recovery can run.
  const source = `
    type Ok1 { required a: str; }
    type Bad1 { @@@ }
    type Ok2 { required b: str; }
    type Bad2 { 123 garbage }
    type Ok3 { required c: str; }
  `;

  const { document, errors } = new SDLParser(source).parseWithRecovery();

  const names = document.declarations.flatMap(d => d.kind === "TypeDeclaration" ? [d.name.value] : []);
  for (const expected of ["Ok1", "Ok2", "Ok3"]) {
    assertEquals(
      names.includes(expected),
      true,
      `Expected '${expected}' in recovered names, got ${JSON.stringify(names)}`
    );
  }
  assertEquals(
    errors.length >= 2,
    true,
    `expected at least 2 errors, got ${errors.length}`
  );
});

Deno.test("SDL Parser - parseWithRecovery: never throws on malformed input", () => {
  // The original `parse()` contract throws — verify recovery's contract
  // is always to return a result object, never bubble.
  const sources = [
    "@@@",
    "type",
    "type X {",
    "scalar type",
    "module foo {"
  ];
  for (const src of sources) {
    const { errors } = new SDLParser(src).parseWithRecovery();
    assertEquals(
      errors.length > 0,
      true,
      `expected ${JSON.stringify(src)} to produce errors`
    );
  }
});

Deno.test("SDL Parser - parse() still throws on first error (backward compat)", () => {
  const source = `type Bad { @@@ }`;
  assertThrows(() => new SDLParser(source).parse(), SyntaxError);
});

// gh/geldata#4406: explicit `optional` keyword on a property is the default
// cardinality but Gel SDL allows it as a no-op qualifier. Disc accepts it
// for round-trip compatibility with schemas where users have spelled out
// the explicit form.
Deno.test("SDL Parser - accepts explicit `optional` keyword (gh/geldata#4406)", () => {
  const source = `
    abstract type Node {
      optional updatedAt: datetime {
        readonly := true;
      };
      optional deletedAt: datetime;
      required createdAt: datetime;
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();
  const typeDecl = ast.declarations[0];
  assertEquals(typeDecl.kind, "TypeDeclaration");
  if (typeDecl.kind === "TypeDeclaration") {
    assertEquals(typeDecl.members.length, 3);
    const updatedAt = typeDecl.members[0];
    const deletedAt = typeDecl.members[1];
    const createdAt = typeDecl.members[2];
    if (updatedAt.kind === "PropertyDeclaration") {
      assertEquals(updatedAt.required ?? false, false);
    }
    if (deletedAt.kind === "PropertyDeclaration") {
      assertEquals(deletedAt.required ?? false, false);
    }
    if (createdAt.kind === "PropertyDeclaration") {
      assertEquals(createdAt.required, true);
    }
  }
});

// `optional multi tags: str` is a common explicit-style declaration. Both
// keywords must coexist (#4406 spec).
Deno.test("SDL Parser - accepts `optional multi` cardinality (gh/geldata#4406)", () => {
  const source = `
    type User {
      optional multi tags: str;
      single name: str;
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();
  const typeDecl = ast.declarations[0];
  if (typeDecl.kind === "TypeDeclaration") {
    const tags = typeDecl.members[0];
    if (tags.kind === "PropertyDeclaration") {
      assertEquals(tags.name.value, "tags");
      assertEquals(tags.required ?? false, false);
      assertEquals(tags.multi, true);
    }
    const name = typeDecl.members[1];
    if (name.kind === "PropertyDeclaration") {
      assertEquals(name.name.value, "name");
      assertEquals(name.required ?? false, false);
      assertEquals(name.multi ?? false, false);
    }
  }
});

// ---------------------------------------------------------------------------
// Bundle J — Schema-derived REST surface (Disc-original feature #2)
//
// `rest::hidden` and `rest::expand` annotations gate exposure and shape of
// the auto-generated REST routes. They parse as ordinary qualified-name
// annotations; the validator allows them without an explicit
// `abstract annotation` declaration. Unknown `rest::*` annotations still
// fail validation cleanly.
// ---------------------------------------------------------------------------

Deno.test("SDL Parser - Property accepts rest::hidden annotation", () => {
  const source = `
    type User {
      required email: str {
        annotation rest::hidden;
      };
      required name: str;
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();
  const typeDecl = ast.declarations[0];
  if (typeDecl.kind !== "TypeDeclaration") {
    throw new Error("expected TypeDeclaration");
  }
  const email = typeDecl.members[0];
  if (email.kind !== "PropertyDeclaration") {
    throw new Error("expected PropertyDeclaration for email");
  }
  assertEquals(email.annotations?.length, 1);
  assertEquals(email.annotations?.[0].name.parts, ["rest", "hidden"]);
});

Deno.test("SDL Parser - Link accepts rest::expand annotation", () => {
  const source = `
    type User {
      multi link posts -> Post {
        annotation rest::expand;
      };
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();
  const typeDecl = ast.declarations[0];
  if (typeDecl.kind !== "TypeDeclaration") {
    throw new Error("expected TypeDeclaration");
  }
  const posts = typeDecl.members[0];
  if (posts.kind !== "LinkDeclaration") {
    throw new Error("expected LinkDeclaration for posts");
  }
  assertEquals(posts.annotations?.length, 1);
  assertEquals(posts.annotations?.[0].name.parts, ["rest", "expand"]);
});

Deno.test("SDL Validator - rest::hidden is allowed without abstract declaration", () => {
  const source = `
    type User {
      required email: str {
        annotation rest::hidden;
      };
      required name: str;
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();
  const result = new SchemaValidator().validate(ast);
  assertEquals(result.ok, true, JSON.stringify(result.errors ?? []));
});

Deno.test("SDL Validator - rest::expand is allowed without abstract declaration", () => {
  const source = `
    type Post {
      required title: str;
    }
    type User {
      multi link posts -> Post {
        annotation rest::expand;
      };
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();
  const result = new SchemaValidator().validate(ast);
  assertEquals(result.ok, true, JSON.stringify(result.errors ?? []));
});

Deno.test("SDL Validator - rejects unknown rest::* annotation", () => {
  const source = `
    type User {
      required email: str {
        annotation rest::madeupknob;
      };
    }
  `;

  const parser = new SDLParser(source);
  const ast = parser.parse();
  const result = new SchemaValidator().validate(ast);
  assertEquals(result.ok, false);
  // Error message references the annotation name so callers can find it.
  const flat = (result.errors ?? []).map(e => e.message).join("\n");
  if (!flat.includes("rest::madeupknob")) {
    throw new Error(
      `expected validation error mentioning 'rest::madeupknob', got: ${flat}`
    );
  }
});

// ---------------------------------------------------------------------------
// Enum scalars accept both bare identifiers and quoted string literals as
// values. Gel SDL allows either form (commit f34c452); the previous parser
// only handled identifiers and crashed on `enum<"X", "Y">`.
// ---------------------------------------------------------------------------

Deno.test("SDL Parser - enum scalar with quoted string values", () => {
  const source = `
    module api {
      scalar type Environment extending enum<"PRODUCTION", "SANDBOX">;
    }
  `;

  const ast = new SDLParser(source).parse();
  const mod = ast.declarations[0];
  if (mod.kind !== "ModuleDeclaration") {
    throw new Error(`expected ModuleDeclaration, got ${mod.kind}`);
  }
  const scalar = mod.declarations[0];
  if (scalar.kind !== "ScalarTypeDeclaration") {
    throw new Error(`expected ScalarTypeDeclaration, got ${scalar.kind}`);
  }

  const ext = scalar.extending?.[0];
  assertEquals(ext?.name.parts[0], "enum");
  // Each quoted value becomes a single-part TypeRef so downstream
  // `differ.scalarEnumValues` reads it the same way as bare identifiers.
  assertEquals(
    ext?.params?.map(p => p.name.parts.join("::")),
    ["PRODUCTION", "SANDBOX"]
  );
});

Deno.test("SDL Parser - enum scalar with bare identifier values still works", () => {
  // Regression: the parameter-parsing change must not break the original
  // bare-identifier form, which the rest of the codebase already relies on
  // (see migration/scalar-cascade.test.ts).
  const source = `
    module default {
      scalar type Status extending enum<draft, published, archived>;
    }
  `;

  const ast = new SDLParser(source).parse();
  const mod = ast.declarations[0];
  if (mod.kind !== "ModuleDeclaration") {
    return;
  }
  const scalar = mod.declarations[0];
  if (scalar.kind !== "ScalarTypeDeclaration") {
    return;
  }

  assertEquals(
    scalar.extending?.[0].params?.map(p => p.name.parts.join("::")),
    ["draft", "published", "archived"]
  );
});

// ---------------------------------------------------------------------------
// Composite indexes use a tuple expression: `index on ((.a, .b))`. The outer
// parens belong to `index on (<expr>)`; the inner ones form the tuple. The
// parser previously rejected these with "Expected ')' after expression".
// ---------------------------------------------------------------------------

Deno.test("SDL Parser - composite index parses tuple expression", () => {
  const source = `
    type ApiKey {
      created: datetime;
      environment: str;
      merchant: str;
      index on ((.created, .environment, .merchant));
    }
  `;

  const ast = new SDLParser(source).parse();
  const typeDecl = ast.declarations[0];
  if (typeDecl.kind !== "TypeDeclaration") {
    throw new Error(`expected TypeDeclaration, got ${typeDecl.kind}`);
  }

  const idx = typeDecl.members.find(m => m.kind === "Index");
  if (idx?.kind !== "Index") {
    throw new Error("expected an Index member");
  }
  if (idx.on.kind !== "TupleExpression") {
    throw new Error(`expected TupleExpression, got ${idx.on.kind}`);
  }
  assertEquals(idx.on.elements.length, 3);
  // Each element is `.<name>` — a PathExpression whose first part is the dot.
  for (const el of idx.on.elements) {
    if (el.kind !== "PathExpression") {
      throw new Error(`expected PathExpression element, got ${el.kind}`);
    }
    assertEquals(el.path[0], ".");
  }
  assertEquals(
    idx.on.elements.map(e => e.kind === "PathExpression" ? e.path.slice(1).join("") : ""),
    ["created", "environment", "merchant"]
  );
});

Deno.test("SDL Parser - path step accepts keyword name (e.g. .type)", () => {
  // Regression: `.type` in a path expression failed because `type` is a
  // keyword token. Properties named after keywords are escaped at declaration
  // with backticks, but path references in indexes don't require quoting.
  const source = `
    type Event {
      required \`type\` -> str;
      index on ((.type));
    }
  `;

  const ast = new SDLParser(source).parse();
  const typeDecl = ast.declarations[0];
  if (typeDecl.kind !== "TypeDeclaration") {
    throw new Error(`expected TypeDeclaration, got ${typeDecl.kind}`);
  }
  const idx = typeDecl.members.find(m => m.kind === "Index");
  if (idx?.kind !== "Index") {
    throw new Error("expected an Index member");
  }
  if (idx.on.kind !== "PathExpression") {
    throw new Error(`expected PathExpression, got ${idx.on.kind}`);
  }
  assertEquals(idx.on.path, [".", "type"]);
});

Deno.test("SDL Parser - single-element parens stay a plain expression", () => {
  // Regression: a parenthesized single expression must still unwrap to that
  // expression — only a comma should turn it into a TupleExpression.
  const source = `
    type T {
      x: str;
      index on ((.x));
    }
  `;

  const ast = new SDLParser(source).parse();
  const typeDecl = ast.declarations[0];
  if (typeDecl.kind !== "TypeDeclaration") {
    return;
  }
  const idx = typeDecl.members.find(m => m.kind === "Index");
  if (idx?.kind !== "Index") {
    return;
  }
  assertEquals(idx.on.kind, "PathExpression");
});

// ---------------------------------------------------------------------------
// Type casts in computed expressions: `<cal::relative_duration>"1 hour"`.
// Previously rejected with "Unexpected token in expression: <" because `<`
// was only handled as a comparison operator (between two expressions).
// ---------------------------------------------------------------------------

Deno.test("SDL Parser - computed property uses qualified type cast", () => {
  const source = `
    type RateLimitBucket {
      created: datetime;
      expires := .created + <cal::relative_duration>"1 hour";
    }
  `;

  const ast = new SDLParser(source).parse();
  const typeDecl = ast.declarations[0];
  if (typeDecl.kind !== "TypeDeclaration") {
    throw new Error(`expected TypeDeclaration, got ${typeDecl.kind}`);
  }

  const expires = typeDecl.members.find(
    m => m.kind === "PropertyDeclaration" && m.name.value === "expires"
  );
  if (expires?.kind !== "PropertyDeclaration" || !expires.computed) {
    throw new Error("expected computed `expires` property");
  }
  if (expires.computed.kind !== "BinaryOp" || expires.computed.op !== "+") {
    throw new Error(`expected binary '+', got ${expires.computed.kind}`);
  }
  const right = expires.computed.right;
  if (right.kind !== "TypeCast") {
    throw new Error(`expected TypeCast on right side, got ${right.kind}`);
  }
  assertEquals(right.type.name.parts, ["cal", "relative_duration"]);
  if (right.expr.kind !== "Literal" || right.expr.type !== "string") {
    throw new Error(
      `expected string literal inside cast, got ${right.expr.kind}`
    );
  }
  assertEquals(right.expr.value, "1 hour");
});

Deno.test("SDL Parser - cast to parameterized type: <array<int64>>$param", () => {
  const source = `
    type T {
      ids := <array<int64>>$ids;
    }
  `;

  const ast = new SDLParser(source).parse();
  const typeDecl = ast.declarations[0];
  if (typeDecl.kind !== "TypeDeclaration") {
    throw new Error(`expected TypeDeclaration, got ${typeDecl.kind}`);
  }
  const prop = typeDecl.members.find(
    m => m.kind === "PropertyDeclaration" && m.name.value === "ids"
  );
  if (prop?.kind !== "PropertyDeclaration" || !prop.computed) {
    throw new Error("expected computed `ids` property");
  }
  if (prop.computed.kind !== "TypeCast") {
    throw new Error(`expected TypeCast, got ${prop.computed.kind}`);
  }
  assertEquals(prop.computed.type.name.parts, ["array"]);
  assertEquals(prop.computed.type.params?.[0]?.name.parts, ["int64"]);
});

// ---------------------------------------------------------------------------
// Backlink with type intersection: `requirements := .<options[is Foo]`.
// Previously rejected with "Expected identifier, got <" because the path
// parser only accepted forward links (`.name`).
// ---------------------------------------------------------------------------

Deno.test("SDL Parser - computed property uses backlink with type intersection", () => {
  const source = `
    type PaymentOption {
      requirements := .<options[is PaymentRequirements];
    }
  `;

  const ast = new SDLParser(source).parse();
  const typeDecl = ast.declarations[0];
  if (typeDecl.kind !== "TypeDeclaration") {
    throw new Error(`expected TypeDeclaration, got ${typeDecl.kind}`);
  }
  const prop = typeDecl.members.find(
    m => m.kind === "PropertyDeclaration" && m.name.value === "requirements"
  );
  if (prop?.kind !== "PropertyDeclaration" || !prop.computed) {
    throw new Error("expected computed `requirements` property");
  }
  if (prop.computed.kind !== "PathExpression") {
    throw new Error(`expected PathExpression, got ${prop.computed.kind}`);
  }
  assertEquals(prop.computed.path, [
    ".",
    "<options",
    "[is PaymentRequirements]"
  ]);
  // Joined path round-trips to the original SDL form (relied on by
  // migration/schema-manager.ts when stringifying expressions).
  assertEquals(
    prop.computed.path.join(""),
    ".<options[is PaymentRequirements]"
  );
});

Deno.test("SDL Parser - forward path with type intersection", () => {
  const source = `
    type T {
      x := .friends[is User];
    }
  `;

  const ast = new SDLParser(source).parse();
  const typeDecl = ast.declarations[0];
  if (typeDecl.kind !== "TypeDeclaration") {
    return;
  }
  const prop = typeDecl.members.find(
    m => m.kind === "PropertyDeclaration" && m.name.value === "x"
  );
  if (prop?.kind !== "PropertyDeclaration" || !prop.computed) {
    throw new Error("expected computed `x` property");
  }
  if (prop.computed.kind !== "PathExpression") {
    throw new Error(`expected PathExpression, got ${prop.computed.kind}`);
  }
  assertEquals(prop.computed.path, [".", "friends", "[is User]"]);
});
