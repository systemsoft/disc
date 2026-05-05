/**
 * Tests for SDL Parser
 */

import { assertEquals, assertThrows } from "@std/assert";
import { SDLParser } from "./parser.ts";
import { SchemaValidator } from "./validator.ts";
import { SyntaxError } from "../lib/errors.ts";

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
    "Unknown token in a property body must produce a syntax error",
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
    "Unknown token in an access policy body must produce a syntax error",
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
    const policy = typeDecl.members.find((m) => m.kind === "AccessPolicy");
    assertEquals(policy?.kind, "AccessPolicy");
    if (policy?.kind === "AccessPolicy") {
      assertEquals(policy.name.value, "owner_writes_only");
      assertEquals(policy.condition !== undefined, true);
      assertEquals(
        policy.withCheck !== undefined,
        true,
        "with check expression must be parsed onto policy.withCheck",
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
    const policy = typeDecl.members.find((m) => m.kind === "AccessPolicy");
    if (policy?.kind === "AccessPolicy") {
      assertEquals(policy.withCheck, undefined);
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
    "Type 'NonExistentType' is not defined",
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
    "Expected ':' after property name",
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
    `expected at least 2 declarations, got ${document.declarations.length}`,
  );
  assertEquals(
    errors.length >= 1,
    true,
    `expected at least 1 error, got ${errors.length}`,
  );
  // Good1 + Good2 must both be present in the recovered document.
  const names = document.declarations.flatMap((d) =>
    d.kind === "TypeDeclaration" ? [d.name.value] : []
  );
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

  const names = document.declarations.flatMap((d) =>
    d.kind === "TypeDeclaration" ? [d.name.value] : []
  );
  for (const expected of ["Ok1", "Ok2", "Ok3"]) {
    assertEquals(
      names.includes(expected),
      true,
      `Expected '${expected}' in recovered names, got ${JSON.stringify(names)}`,
    );
  }
  assertEquals(
    errors.length >= 2,
    true,
    `expected at least 2 errors, got ${errors.length}`,
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
    "module foo {",
  ];
  for (const src of sources) {
    const { errors } = new SDLParser(src).parseWithRecovery();
    assertEquals(
      errors.length > 0,
      true,
      `expected ${JSON.stringify(src)} to produce errors`,
    );
  }
});

Deno.test("SDL Parser - parse() still throws on first error (backward compat)", () => {
  const source = `type Bad { @@@ }`;
  assertThrows(() => new SDLParser(source).parse(), SyntaxError);
});
