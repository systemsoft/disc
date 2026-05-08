/**
 * Tests for Deletion Policies: `on target delete set empty` and
 * `on source delete allow|delete target` (Stage 35 Phase 2)
 *
 * Verifies that SDL deletion policy declarations are correctly parsed,
 * diffed, and compiled to PostgreSQL DDL.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { DDLGenerator } from "../migration/ddl.ts";
import { SchemaDiffer } from "../migration/differ.ts";
import * as Types from "../migration/types.ts";
import { Module } from "../schema/converter.ts";
import { SDLParser } from "../schema/parser.ts";
import { SchemaValidator } from "../schema/validator.ts";

// ============================================================
// Helpers
// ============================================================

/** Parse an SDL string and return the document AST */
function parseSDL(source: string) {
  const parser = new SDLParser(source);
  return parser.parse();
}

/** Parse SDL and convert to Module[] for the differ */
function parseToModules(source: string): Module[] {
  const doc = parseSDL(source);
  const validator = new SchemaValidator();
  return validator.convertToModules(doc);
}

/** Diff empty schema against the given SDL and return migration operations */
function diffFromEmpty(source: string): Types.MigrationOperation[] {
  const differ = new SchemaDiffer();
  return differ.diff([], parseToModules(source));
}

/** Diff two SDL strings and return migration operations */
function diffSchemas(
  oldSource: string,
  newSource: string
): Types.MigrationOperation[] {
  const differ = new SchemaDiffer();
  return differ.diff(parseToModules(oldSource), parseToModules(newSource));
}

/** Generate DDL from migration operations */
function generateDDL(operations: Types.MigrationOperation[]): string[] {
  const generator = new DDLGenerator();
  return generator.generateDDL(operations);
}

// ============================================================
// Parser Tests
// ============================================================

Deno.test("Parser: on target delete set empty parses correctly", () => {
  const sdl = `
    type Comment {
      required link post -> Post {
        on target delete set empty;
      };
    }
    type Post {
      required title: str;
    }
  `;

  const doc = parseSDL(sdl);
  const commentType = doc.declarations.find(
    d => d.kind === "TypeDeclaration" && d.name.value === "Comment"
  );
  assertEquals(commentType !== undefined, true);

  if (commentType && commentType.kind === "TypeDeclaration") {
    const linkMember = commentType.members.find(
      m => m.kind === "LinkDeclaration"
    );
    assertEquals(linkMember !== undefined, true);

    if (linkMember && linkMember.kind === "LinkDeclaration") {
      assertEquals(linkMember.onTargetDelete, "set empty");
    }
  }
});

Deno.test("Parser: on target delete delete source parses correctly", () => {
  const sdl = `
    type Session {
      required link subject -> User {
        on target delete delete source;
      };
    }
    type User {
      required name: str;
    }
  `;

  const doc = parseSDL(sdl);
  const sessionType = doc.declarations.find(
    d => d.kind === "TypeDeclaration" && d.name.value === "Session"
  );
  assertEquals(sessionType !== undefined, true);

  if (sessionType && sessionType.kind === "TypeDeclaration") {
    const linkMember = sessionType.members.find(
      m => m.kind === "LinkDeclaration"
    );
    assertEquals(linkMember !== undefined, true);

    if (linkMember && linkMember.kind === "LinkDeclaration") {
      assertEquals(linkMember.onTargetDelete, "delete source");
    }
  }
});

Deno.test("Differ: mapOnTargetDelete delete source returns CASCADE", () => {
  const sdl = `
    type Session {
      required link subject -> User {
        on target delete delete source;
      };
    }
    type User {
      required name: str;
    }
  `;

  const ops = diffFromEmpty(sdl);
  const createSession = ops.find(
    op =>
      op.kind === "CreateType" &&
      (op as Types.CreateTypeOperation).typeName === "Session"
  ) as Types.CreateTypeOperation;

  assertEquals(createSession !== undefined, true);
  const subjectLink = createSession.links.find(l => l.name === "subject");
  assertEquals(subjectLink !== undefined, true);
  assertEquals(subjectLink!.onTargetDelete, "CASCADE");
});

Deno.test("Parser: invalid delete policy emits hint listing valid options", () => {
  const sdl = `
    type A {
      required b -> B {
        on target delete frobnicate;
      };
    }
    type B { required name: str; }
  `;
  const parser = new SDLParser(sdl);
  const { errors } = parser.parseWithRecovery();
  assertEquals(errors.length > 0, true);
  const policyErr = errors.find(e =>
    e.message.includes("Invalid delete policy")
  );
  assertEquals(policyErr !== undefined, true);
  assertEquals(
    policyErr!.context?.hint?.includes("delete source"),
    true,
    "hint should list delete source as a valid option"
  );
});

Deno.test("Parser: on source delete allow parses correctly", () => {
  const sdl = `
    type Order {
      required link customer -> Customer {
        on source delete allow;
      };
    }
    type Customer {
      required name: str;
    }
  `;

  const doc = parseSDL(sdl);
  const orderType = doc.declarations.find(
    d => d.kind === "TypeDeclaration" && d.name.value === "Order"
  );
  assertEquals(orderType !== undefined, true);

  if (orderType && orderType.kind === "TypeDeclaration") {
    const linkMember = orderType.members.find(
      m => m.kind === "LinkDeclaration"
    );
    assertEquals(linkMember !== undefined, true);

    if (linkMember && linkMember.kind === "LinkDeclaration") {
      assertEquals(linkMember.onSourceDelete, "allow");
    }
  }
});

Deno.test("Parser: on source delete delete target parses correctly", () => {
  const sdl = `
    type Parent {
      required link child -> Child {
        on source delete delete target;
      };
    }
    type Child {
      required name: str;
    }
  `;

  const doc = parseSDL(sdl);
  const parentType = doc.declarations.find(
    d => d.kind === "TypeDeclaration" && d.name.value === "Parent"
  );
  assertEquals(parentType !== undefined, true);

  if (parentType && parentType.kind === "TypeDeclaration") {
    const linkMember = parentType.members.find(
      m => m.kind === "LinkDeclaration"
    );
    assertEquals(linkMember !== undefined, true);

    if (linkMember && linkMember.kind === "LinkDeclaration") {
      assertEquals(linkMember.onSourceDelete, "delete target");
    }
  }
});

// ============================================================
// Differ Tests
// ============================================================

Deno.test("Differ: mapOnTargetDelete set empty returns SET NULL", () => {
  const sdl = `
    type Comment {
      link post -> Post {
        on target delete set empty;
      };
    }
    type Post {
      required title: str;
    }
  `;

  const ops = diffFromEmpty(sdl);
  const createComment = ops.find(
    op =>
      op.kind === "CreateType" &&
      (op as Types.CreateTypeOperation).typeName === "Comment"
  ) as Types.CreateTypeOperation;

  assertEquals(createComment !== undefined, true);
  const postLink = createComment.links.find(l => l.name === "post");
  assertEquals(postLink !== undefined, true);
  assertEquals(postLink!.onTargetDelete, "SET NULL");
});

Deno.test("Differ: link with onSourceDelete extracted correctly", () => {
  const sdl = `
    type Parent {
      required link child -> Child {
        on source delete delete target;
      };
    }
    type Child {
      required name: str;
    }
  `;

  const ops = diffFromEmpty(sdl);
  const createParent = ops.find(
    op =>
      op.kind === "CreateType" &&
      (op as Types.CreateTypeOperation).typeName === "Parent"
  ) as Types.CreateTypeOperation;

  assertEquals(createParent !== undefined, true);
  const childLink = createParent.links.find(l => l.name === "child");
  assertEquals(childLink !== undefined, true);
  assertEquals(childLink!.onSourceDelete, "DELETE TARGET");
});

Deno.test("Differ: onSourceDelete change detected in diff", () => {
  const oldSdl = `
    type Parent {
      required link child -> Child;
    }
    type Child {
      required name: str;
    }
  `;

  const newSdl = `
    type Parent {
      required link child -> Child {
        on source delete delete target;
      };
    }
    type Child {
      required name: str;
    }
  `;

  const ops = diffSchemas(oldSdl, newSdl);
  const alterParent = ops.find(
    op =>
      op.kind === "AlterType" &&
      (op as Types.AlterTypeOperation).typeName === "Parent"
  ) as Types.AlterTypeOperation;

  assertEquals(alterParent !== undefined, true);

  const alterLink = alterParent.operations.find(
    op => op.kind === "AlterLink"
  ) as Types.AlterLinkOperation;

  assertEquals(alterLink !== undefined, true);
  assertEquals(alterLink.linkName, "child");

  const sourceDeleteChange = alterLink.changes.find(
    c => c.kind === "ChangeOnSourceDelete"
  );
  assertEquals(sourceDeleteChange !== undefined, true);
  assertEquals(sourceDeleteChange!.oldValue, undefined);
  assertEquals(sourceDeleteChange!.newValue, "DELETE TARGET");
});

// ============================================================
// DDL Generation Tests
// ============================================================

Deno.test("DDL: SET NULL FK constraint generated for set empty", () => {
  const sdl = `
    type Comment {
      link post -> Post {
        on target delete set empty;
      };
    }
    type Post {
      required title: str;
    }
  `;

  const ops = diffFromEmpty(sdl);
  const ddl = generateDDL(ops);
  const allDdl = ddl.join("\n");

  // Should have ON DELETE SET NULL in the FK constraint
  assertStringIncludes(allDdl, "ON DELETE SET NULL");
});

Deno.test("DDL: source delete trigger generated for delete target", () => {
  const sdl = `
    type Parent {
      required link child -> Child {
        on source delete delete target;
      };
    }
    type Child {
      required name: str;
    }
  `;

  const ops = diffFromEmpty(sdl);
  const ddl = generateDDL(ops);
  const allDdl = ddl.join("\n");

  // Should have a trigger function that deletes from child table
  assertStringIncludes(allDdl, "disc_source_delete_parent_child");
  assertStringIncludes(allDdl, "BEFORE DELETE ON");
  assertStringIncludes(allDdl, "DELETE FROM");
  assertStringIncludes(allDdl, "LANGUAGE plpgsql");
});

Deno.test("DDL: combined target + source policies on same link", () => {
  const sdl = `
    type Parent {
      link child -> Child {
        on target delete set empty;
        on source delete delete target;
      };
    }
    type Child {
      required name: str;
    }
  `;

  const doc = parseSDL(sdl);
  const parentType = doc.declarations.find(
    d => d.kind === "TypeDeclaration" && d.name.value === "Parent"
  );

  if (parentType && parentType.kind === "TypeDeclaration") {
    const linkMember = parentType.members.find(
      m => m.kind === "LinkDeclaration"
    );
    assertEquals(linkMember !== undefined, true);

    if (linkMember && linkMember.kind === "LinkDeclaration") {
      assertEquals(linkMember.onTargetDelete, "set empty");
      assertEquals(linkMember.onSourceDelete, "delete target");
    }
  }

  const ops = diffFromEmpty(sdl);
  const ddl = generateDDL(ops);
  const allDdl = ddl.join("\n");

  // Both policies should be in the DDL
  assertStringIncludes(allDdl, "ON DELETE SET NULL");
  assertStringIncludes(allDdl, "disc_source_delete_parent_child");
});

Deno.test("DDL: on source delete allow does not generate trigger", () => {
  const sdl = `
    type Order {
      required link customer -> Customer {
        on source delete allow;
      };
    }
    type Customer {
      required name: str;
    }
  `;

  const ops = diffFromEmpty(sdl);
  const ddl = generateDDL(ops);
  const allDdl = ddl.join("\n");

  // "allow" means no special action needed, no trigger should be generated
  assertEquals(allDdl.includes("disc_source_delete"), false);
  assertEquals(allDdl.includes("trg_source_delete"), false);
});

Deno.test("DDL: existing on target delete policies still work", () => {
  const sdl = `
    type Comment {
      required link post -> Post {
        on target delete restrict;
      };
    }
    type Post {
      required title: str;
    }
  `;

  const ops = diffFromEmpty(sdl);
  const ddl = generateDDL(ops);
  const allDdl = ddl.join("\n");

  assertStringIncludes(allDdl, "ON DELETE RESTRICT");
});

Deno.test("Differ: onSourceDelete allow extracted correctly", () => {
  const sdl = `
    type Order {
      required link customer -> Customer {
        on source delete allow;
      };
    }
    type Customer {
      required name: str;
    }
  `;

  const ops = diffFromEmpty(sdl);
  const createOrder = ops.find(
    op =>
      op.kind === "CreateType" &&
      (op as Types.CreateTypeOperation).typeName === "Order"
  ) as Types.CreateTypeOperation;

  assertEquals(createOrder !== undefined, true);
  const customerLink = createOrder.links.find(l => l.name === "customer");
  assertEquals(customerLink !== undefined, true);
  assertEquals(customerLink!.onSourceDelete, "ALLOW");
});
