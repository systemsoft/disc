/**
 * Tests for Rewrite Rules (Stage 32 Phase 5)
 *
 * Verifies that SDL rewrite declarations are correctly parsed, validated,
 * diffed, and compiled to PostgreSQL trigger DDL for automatic column
 * value setting on INSERT/UPDATE.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { SDLParser } from "../schema/parser.ts";
import { SchemaValidator } from "../schema/validator.ts";
import { DDLGenerator } from "./ddl.ts";
import { SchemaDiffer } from "./differ.ts";
import { SchemaManager } from "./schema-manager.ts";
import { Module } from "../schema/converter.ts";
import * as Types from "./types.ts";

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
  newSource: string,
): Types.MigrationOperation[] {
  const differ = new SchemaDiffer();
  return differ.diff(parseToModules(oldSource), parseToModules(newSource));
}

/** Generate DDL from migration operations */
function generateDDL(operations: Types.MigrationOperation[]): string[] {
  const generator = new DDLGenerator();
  return generator.generateDDL(operations);
}

/** Generate rollback DDL from migration operations */
function generateRollbackDDL(
  operations: Types.MigrationOperation[],
): string[] {
  const generator = new DDLGenerator();
  return generator.generateRollbackDDL(operations);
}

// ============================================================
// Parser Tests
// ============================================================

Deno.test("Parser - rewrite with single event (insert)", () => {
  const doc = parseSDL(`
    module default {
      type Post {
        required created_at: datetime {
          rewrite insert using (datetime_of_statement());
        };
      }
    }
  `);

  const mod = doc.declarations[0];
  assertEquals(mod.kind, "ModuleDeclaration");
  if (mod.kind !== "ModuleDeclaration") return;

  const postType = mod.declarations[0];
  assertEquals(postType.kind, "TypeDeclaration");
  if (postType.kind !== "TypeDeclaration") return;

  const prop = postType.members.find((m) => m.kind === "PropertyDeclaration");
  assertEquals(prop !== undefined, true);
  if (!prop || prop.kind !== "PropertyDeclaration") return;

  assertEquals(prop.rewrites !== undefined, true);
  assertEquals(prop.rewrites!.length, 1);
  assertEquals(prop.rewrites![0].kind, "RewriteDeclaration");
  assertEquals(prop.rewrites![0].events, ["insert"]);
  assertStringIncludes(prop.rewrites![0].using, "datetime_of_statement()");
});

Deno.test("Parser - rewrite with multiple events (insert, update)", () => {
  const doc = parseSDL(`
    module default {
      type Post {
        required updated_at: datetime {
          rewrite insert, update using (datetime_of_statement());
        };
      }
    }
  `);

  const mod = doc.declarations[0];
  if (mod.kind !== "ModuleDeclaration") return;
  const postType = mod.declarations[0];
  if (postType.kind !== "TypeDeclaration") return;

  const prop = postType.members.find((m) => m.kind === "PropertyDeclaration");
  if (!prop || prop.kind !== "PropertyDeclaration") return;

  assertEquals(prop.rewrites!.length, 1);
  assertEquals(prop.rewrites![0].events, ["insert", "update"]);
});

Deno.test("Parser - rewrite with __old__ reference expression", () => {
  const doc = parseSDL(`
    module default {
      type Counter {
        required value: int64 {
          rewrite update using (__old__.value + 1);
        };
      }
    }
  `);

  const mod = doc.declarations[0];
  if (mod.kind !== "ModuleDeclaration") return;
  const counterType = mod.declarations[0];
  if (counterType.kind !== "TypeDeclaration") return;

  const prop = counterType.members.find(
    (m) => m.kind === "PropertyDeclaration",
  );
  if (!prop || prop.kind !== "PropertyDeclaration") return;

  assertEquals(prop.rewrites!.length, 1);
  assertEquals(prop.rewrites![0].events, ["update"]);
  assertStringIncludes(prop.rewrites![0].using, "__old__");
});

Deno.test("Parser - property with both constraint and rewrite", () => {
  const doc = parseSDL(`
    module default {
      type Post {
        required title: str {
          constraint max_len_value(255);
          rewrite insert using (datetime_of_statement());
        };
      }
    }
  `);

  const mod = doc.declarations[0];
  if (mod.kind !== "ModuleDeclaration") return;
  const postType = mod.declarations[0];
  if (postType.kind !== "TypeDeclaration") return;

  const prop = postType.members.find((m) => m.kind === "PropertyDeclaration");
  if (!prop || prop.kind !== "PropertyDeclaration") return;

  assertEquals(prop.constraints !== undefined, true);
  assertEquals(prop.constraints!.length, 1);
  assertEquals(prop.rewrites !== undefined, true);
  assertEquals(prop.rewrites!.length, 1);
});

Deno.test("Parser - type with multiple properties having rewrites", () => {
  const doc = parseSDL(`
    module default {
      type Post {
        required created_at: datetime {
          rewrite insert using (datetime_of_statement());
        };
        required updated_at: datetime {
          rewrite insert, update using (datetime_of_statement());
        };
        required title: str;
      }
    }
  `);

  const mod = doc.declarations[0];
  if (mod.kind !== "ModuleDeclaration") return;
  const postType = mod.declarations[0];
  if (postType.kind !== "TypeDeclaration") return;

  const propsWithRewrites = postType.members.filter(
    (m) => m.kind === "PropertyDeclaration" && m.rewrites && m.rewrites.length > 0,
  );
  assertEquals(propsWithRewrites.length, 2);

  const propsWithoutRewrites = postType.members.filter(
    (m) =>
      m.kind === "PropertyDeclaration" &&
      (!m.rewrites || m.rewrites.length === 0),
  );
  assertEquals(propsWithoutRewrites.length, 1);
});

// ============================================================
// Validator Tests
// ============================================================

Deno.test("Validator - valid rewrite passes validation", () => {
  const doc = parseSDL(`
    module default {
      type Post {
        required created_at: datetime {
          rewrite insert using (datetime_of_statement());
        };
      }
    }
  `);

  const validator = new SchemaValidator();
  const result = validator.validate(doc);

  const rewriteErrors = (result.errors || []).filter(
    (e) => e.message.includes("rewrite") || e.message.includes("Rewrite"),
  );
  assertEquals(rewriteErrors.length, 0);
});

Deno.test("Validator - duplicate event across multiple rewrites on same property produces error", () => {
  // Manually construct a document with duplicate rewrite events since the
  // parser would need two separate rewrite declarations on the same property
  const doc = parseSDL(`
    module default {
      type Post {
        required updated_at: datetime {
          rewrite insert using (datetime_of_statement());
          rewrite insert using (datetime_current());
        };
      }
    }
  `);

  const validator = new SchemaValidator();
  const result = validator.validate(doc);

  const dupeErrors = (result.errors || []).filter(
    (e) =>
      e.message.includes("Duplicate rewrite event") ||
      e.message.includes("duplicate") && e.message.includes("rewrite"),
  );
  assertEquals(dupeErrors.length >= 1, true);
});

Deno.test("Validator - rewrite with empty using expression produces error", () => {
  // We need to manually construct this since the parser would normally fail,
  // but we can test the validator directly with a constructed AST
  const validator = new SchemaValidator();

  // Create a document with an empty using expression by constructing AST directly
  // Note: ModuleDeclaration.name is QualifiedName (with .parts), not Identifier
  const doc = {
    kind: "SDLDocument" as const,
    declarations: [{
      kind: "ModuleDeclaration" as const,
      name: { kind: "QualifiedName" as const, parts: ["default"] },
      declarations: [{
        kind: "TypeDeclaration" as const,
        name: { kind: "Identifier" as const, value: "Post" },
        members: [{
          kind: "PropertyDeclaration" as const,
          name: { kind: "Identifier" as const, value: "updated_at" },
          type: {
            kind: "TypeRef" as const,
            name: { kind: "QualifiedName" as const, parts: ["datetime"] },
          },
          required: true,
          multi: false,
          rewrites: [{
            kind: "RewriteDeclaration" as const,
            events: ["insert" as const],
            using: "",
          }],
        }],
      }],
    }],
  };

  const result = validator.validate(doc as any);

  const emptyErrors = (result.errors || []).filter(
    (e) => e.message.includes("using") && e.message.includes("expression"),
  );
  assertEquals(emptyErrors.length >= 1, true);
});

// ============================================================
// Differ Tests
// ============================================================

Deno.test("Differ - new type with rewrite generates CreateType with rewrite in property", () => {
  const operations = diffFromEmpty(`
    module default {
      type Post {
        required created_at: datetime {
          rewrite insert using (datetime_of_statement());
        };
        required title: str;
      }
    }
  `);

  assertEquals(operations.length, 1);
  assertEquals(operations[0].kind, "CreateType");

  const createOp = operations[0] as Types.CreateTypeOperation;
  assertEquals(createOp.typeName, "Post");

  const createdAtProp = createOp.properties.find(
    (p) => p.name === "created_at",
  );
  assertEquals(createdAtProp !== undefined, true);
  assertEquals(createdAtProp!.rewrites !== undefined, true);
  assertEquals(createdAtProp!.rewrites!.length, 1);
  assertEquals(createdAtProp!.rewrites![0].events, ["insert"]);
  assertStringIncludes(
    createdAtProp!.rewrites![0].body,
    "datetime_of_statement()",
  );
});

Deno.test("Differ - add rewrite to existing property produces AddRewrite", () => {
  const operations = diffSchemas(
    `
    module default {
      type Post {
        required created_at: datetime;
        required title: str;
      }
    }
    `,
    `
    module default {
      type Post {
        required created_at: datetime {
          rewrite insert using (datetime_of_statement());
        };
        required title: str;
      }
    }
    `,
  );

  // Find the AlterType that contains AddRewrite
  const alterOps = operations.filter((op) => op.kind === "AlterType");
  assertEquals(alterOps.length >= 1, true);

  const alterOp = alterOps[0] as Types.AlterTypeOperation;
  const addRewriteOps = alterOp.operations.filter(
    (op) => op.kind === "AddRewrite",
  );
  assertEquals(addRewriteOps.length, 1);

  const addRewrite = addRewriteOps[0] as Types.AddRewriteOperation;
  assertEquals(addRewrite.propertyName, "created_at");
  assertEquals(addRewrite.rewrite.events, ["insert"]);
});

Deno.test("Differ - remove rewrite from existing property produces DropRewrite", () => {
  const operations = diffSchemas(
    `
    module default {
      type Post {
        required created_at: datetime {
          rewrite insert using (datetime_of_statement());
        };
        required title: str;
      }
    }
    `,
    `
    module default {
      type Post {
        required created_at: datetime;
        required title: str;
      }
    }
    `,
  );

  const alterOps = operations.filter((op) => op.kind === "AlterType");
  assertEquals(alterOps.length >= 1, true);

  const alterOp = alterOps[0] as Types.AlterTypeOperation;
  const dropRewriteOps = alterOp.operations.filter(
    (op) => op.kind === "DropRewrite",
  );
  assertEquals(dropRewriteOps.length, 1);

  const dropRewrite = dropRewriteOps[0] as Types.DropRewriteOperation;
  assertEquals(dropRewrite.propertyName, "created_at");
  assertEquals(dropRewrite.events, ["insert"]);
});

Deno.test("Differ - modify rewrite body generates DropRewrite + AddRewrite", () => {
  const operations = diffSchemas(
    `
    module default {
      type Post {
        required created_at: datetime {
          rewrite insert using (datetime_of_statement());
        };
        required title: str;
      }
    }
    `,
    `
    module default {
      type Post {
        required created_at: datetime {
          rewrite insert using (datetime_current());
        };
        required title: str;
      }
    }
    `,
  );

  const alterOps = operations.filter((op) => op.kind === "AlterType");
  assertEquals(alterOps.length >= 1, true);

  const alterOp = alterOps[0] as Types.AlterTypeOperation;

  const dropRewriteOps = alterOp.operations.filter(
    (op) => op.kind === "DropRewrite",
  );
  const addRewriteOps = alterOp.operations.filter(
    (op) => op.kind === "AddRewrite",
  );

  // Must have DropRewrite + AddRewrite (rewrites can't be altered in place)
  assertEquals(dropRewriteOps.length, 1);
  assertEquals(addRewriteOps.length, 1);

  const addRewrite = addRewriteOps[0] as Types.AddRewriteOperation;
  assertStringIncludes(addRewrite.rewrite.body, "datetime_current()");
});

Deno.test("Differ - multiple rewrites on different properties", () => {
  const operations = diffFromEmpty(`
    module default {
      type Post {
        required created_at: datetime {
          rewrite insert using (datetime_of_statement());
        };
        required updated_at: datetime {
          rewrite insert, update using (datetime_of_statement());
        };
        required title: str;
      }
    }
  `);

  assertEquals(operations.length, 1);
  assertEquals(operations[0].kind, "CreateType");

  const createOp = operations[0] as Types.CreateTypeOperation;

  const createdAtProp = createOp.properties.find(
    (p) => p.name === "created_at",
  );
  const updatedAtProp = createOp.properties.find(
    (p) => p.name === "updated_at",
  );

  assertEquals(createdAtProp!.rewrites!.length, 1);
  assertEquals(createdAtProp!.rewrites![0].events, ["insert"]);

  assertEquals(updatedAtProp!.rewrites!.length, 1);
  assertEquals(updatedAtProp!.rewrites![0].events, ["insert", "update"]);
});

// ============================================================
// DDL Tests
// ============================================================

Deno.test("DDL - generateCreateRewrite output for INSERT only event", () => {
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "Post",
    properties: [
      {
        name: "created_at",
        type: "datetime",
        required: true,
        multi: false,
        constraints: [],
        annotations: {},
        rewrites: [
          {
            events: ["insert"],
            body: "datetime_of_statement()",
          },
        ],
      },
      {
        name: "title",
        type: "str",
        required: true,
        multi: false,
        constraints: [],
        annotations: {},
      },
    ],
    links: [],
  };

  const statements = generateDDL([operation]);

  const fnStatements = statements.filter((s) => s.includes("CREATE OR REPLACE FUNCTION") && s.includes("rewrite_fn"));
  const trigStatements = statements.filter(
    (s) => s.includes("CREATE TRIGGER") && s.includes("rewrite"),
  );

  assertEquals(fnStatements.length, 1);
  assertEquals(trigStatements.length, 1);

  assertStringIncludes(fnStatements[0], "post__created_at__rewrite_fn");
  assertStringIncludes(fnStatements[0], "RETURNS TRIGGER");
  assertStringIncludes(trigStatements[0], "post__created_at__rewrite");
  assertStringIncludes(trigStatements[0], "BEFORE INSERT");
  assertStringIncludes(trigStatements[0], "FOR EACH ROW");
});

Deno.test("DDL - generateCreateRewrite output for UPDATE only event", () => {
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "Post",
    properties: [
      {
        name: "updated_at",
        type: "datetime",
        required: true,
        multi: false,
        constraints: [],
        annotations: {},
        rewrites: [
          {
            events: ["update"],
            body: "datetime_of_statement()",
          },
        ],
      },
    ],
    links: [],
  };

  const statements = generateDDL([operation]);

  const trigStatements = statements.filter(
    (s) => s.includes("CREATE TRIGGER") && s.includes("rewrite"),
  );

  assertEquals(trigStatements.length, 1);
  assertStringIncludes(trigStatements[0], "BEFORE UPDATE");
  // Should NOT include INSERT
  assertEquals(trigStatements[0].includes("INSERT"), false);
});

Deno.test("DDL - generateCreateRewrite output for INSERT, UPDATE combined", () => {
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "Post",
    properties: [
      {
        name: "updated_at",
        type: "datetime",
        required: true,
        multi: false,
        constraints: [],
        annotations: {},
        rewrites: [
          {
            events: ["insert", "update"],
            body: "datetime_of_statement()",
          },
        ],
      },
    ],
    links: [],
  };

  const statements = generateDDL([operation]);

  const trigStatements = statements.filter(
    (s) => s.includes("CREATE TRIGGER") && s.includes("rewrite"),
  );

  assertEquals(trigStatements.length, 1);
  assertStringIncludes(trigStatements[0], "BEFORE INSERT OR UPDATE");
});

Deno.test("DDL - variable substitution: datetime_of_statement() -> statement_timestamp()", () => {
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "Post",
    properties: [
      {
        name: "created_at",
        type: "datetime",
        required: true,
        multi: false,
        constraints: [],
        annotations: {},
        rewrites: [
          {
            events: ["insert"],
            body: "datetime_of_statement()",
          },
        ],
      },
    ],
    links: [],
  };

  const statements = generateDDL([operation]);

  const fnStatement = statements.find(
    (s) => s.includes("CREATE OR REPLACE FUNCTION") && s.includes("rewrite_fn"),
  );

  assertEquals(fnStatement !== undefined, true);
  assertStringIncludes(fnStatement!, "statement_timestamp()");
  assertEquals(fnStatement!.includes("datetime_of_statement"), false);
});

Deno.test("DDL - variable substitution: __old__ -> OLD", () => {
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "Counter",
    properties: [
      {
        name: "value",
        type: "int64",
        required: true,
        multi: false,
        constraints: [],
        annotations: {},
        rewrites: [
          {
            events: ["update"],
            body: "__old__.value + 1",
          },
        ],
      },
    ],
    links: [],
  };

  const statements = generateDDL([operation]);

  const fnStatement = statements.find(
    (s) => s.includes("CREATE OR REPLACE FUNCTION") && s.includes("rewrite_fn"),
  );

  assertEquals(fnStatement !== undefined, true);
  assertStringIncludes(fnStatement!, "OLD.value + 1");
  assertEquals(fnStatement!.includes("__old__"), false);
});

Deno.test("DDL - generateDropRewrite output", () => {
  const operation: Types.AlterTypeOperation = {
    kind: "AlterType",
    typeName: "Post",
    operations: [
      {
        kind: "DropRewrite",
        propertyName: "created_at",
        events: ["insert"],
      } as Types.DropRewriteOperation,
    ],
  };

  const statements = generateDDL([operation]);

  const dropTrigStatements = statements.filter((s) => s.includes("DROP TRIGGER"));
  const dropFnStatements = statements.filter((s) => s.includes("DROP FUNCTION"));

  assertEquals(dropTrigStatements.length, 1);
  assertEquals(dropFnStatements.length, 1);

  assertStringIncludes(dropTrigStatements[0], "post__created_at__rewrite");
  assertStringIncludes(dropFnStatements[0], "post__created_at__rewrite_fn");
});

Deno.test("DDL - generateCreateType includes rewrites in output", () => {
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "Post",
    properties: [
      {
        name: "title",
        type: "str",
        required: true,
        multi: false,
        constraints: [],
        annotations: {},
      },
      {
        name: "created_at",
        type: "datetime",
        required: true,
        multi: false,
        constraints: [],
        annotations: {},
        rewrites: [
          {
            events: ["insert"],
            body: "datetime_of_statement()",
          },
        ],
      },
      {
        name: "updated_at",
        type: "datetime",
        required: true,
        multi: false,
        constraints: [],
        annotations: {},
        rewrites: [
          {
            events: ["insert", "update"],
            body: "datetime_of_statement()",
          },
        ],
      },
    ],
    links: [],
  };

  const statements = generateDDL([operation]);

  // Should have CREATE TABLE
  const createTable = statements.find((s) => s.startsWith("CREATE TABLE"));
  assertEquals(createTable !== undefined, true);

  // Should have 2 CREATE FUNCTION for rewrite (one for created_at, one for updated_at)
  const createFns = statements.filter(
    (s) => s.includes("CREATE OR REPLACE FUNCTION") && s.includes("rewrite_fn"),
  );
  assertEquals(createFns.length, 2);

  // Should have 2 CREATE TRIGGER for rewrite
  const createTrigs = statements.filter(
    (s) => s.includes("CREATE TRIGGER") && s.includes("rewrite"),
  );
  assertEquals(createTrigs.length, 2);
});

// ============================================================
// Rollback DDL Tests
// ============================================================

Deno.test("DDL - rollback for AddRewrite generates DROP TRIGGER + DROP FUNCTION", () => {
  const operation: Types.AlterTypeOperation = {
    kind: "AlterType",
    typeName: "Post",
    operations: [
      {
        kind: "AddRewrite",
        propertyName: "created_at",
        rewrite: {
          events: ["insert"],
          body: "datetime_of_statement()",
        },
      } as Types.AddRewriteOperation,
    ],
  };

  const statements = generateRollbackDDL([operation]);

  const dropTrigStatements = statements.filter((s) => s.includes("DROP TRIGGER"));
  const dropFnStatements = statements.filter((s) => s.includes("DROP FUNCTION"));

  assertEquals(dropTrigStatements.length, 1);
  assertEquals(dropFnStatements.length, 1);
  assertStringIncludes(dropTrigStatements[0], "post__created_at__rewrite");
  assertStringIncludes(dropFnStatements[0], "post__created_at__rewrite_fn");
});

Deno.test("DDL - rollback for DropRewrite produces manual rollback comment", () => {
  const operation: Types.AlterTypeOperation = {
    kind: "AlterType",
    typeName: "Post",
    operations: [
      {
        kind: "DropRewrite",
        propertyName: "created_at",
        events: ["insert"],
      } as Types.DropRewriteOperation,
    ],
  };

  const statements = generateRollbackDDL([operation]);

  const manualStatements = statements.filter((s) => s.includes("MANUAL ROLLBACK REQUIRED"));
  assertEquals(manualStatements.length >= 1, true);
  assertStringIncludes(manualStatements[0], "created_at");
});

// ============================================================
// End-to-end: SDL (parsed) -> Differ -> DDL
// ============================================================

Deno.test("End-to-end - SDL with insert rewrite produces correct DDL", () => {
  const modules = parseToModules(`
    module default {
      type Post {
        required title: str;
        required created_at: datetime {
          rewrite insert using (datetime_of_statement());
        };
      }
    }
  `);

  const differ = new SchemaDiffer();
  const operations = differ.diff([], modules);
  const ddl = generateDDL(operations);

  // Should have CREATE TABLE
  const createTable = ddl.find((s) => s.startsWith("CREATE TABLE"));
  assertEquals(createTable !== undefined, true);

  // Should have CREATE FUNCTION for rewrite
  const createFn = ddl.find(
    (s) =>
      s.includes("CREATE OR REPLACE FUNCTION") &&
      s.includes("post__created_at__rewrite_fn"),
  );
  assertEquals(createFn !== undefined, true);
  assertStringIncludes(createFn!, "statement_timestamp()");

  // Should have CREATE TRIGGER for rewrite
  const createTrig = ddl.find(
    (s) =>
      s.includes("CREATE TRIGGER") &&
      s.includes("post__created_at__rewrite"),
  );
  assertEquals(createTrig !== undefined, true);
  assertStringIncludes(createTrig!, "BEFORE INSERT");
  assertStringIncludes(createTrig!, "FOR EACH ROW");
});

Deno.test("End-to-end - SDL with insert+update rewrite produces correct DDL", () => {
  const modules = parseToModules(`
    module default {
      type Post {
        required title: str;
        required updated_at: datetime {
          rewrite insert, update using (datetime_of_statement());
        };
      }
    }
  `);

  const differ = new SchemaDiffer();
  const operations = differ.diff([], modules);
  const ddl = generateDDL(operations);

  const createTrig = ddl.find(
    (s) =>
      s.includes("CREATE TRIGGER") &&
      s.includes("post__updated_at__rewrite"),
  );
  assertEquals(createTrig !== undefined, true);
  assertStringIncludes(createTrig!, "BEFORE INSERT OR UPDATE");
});

Deno.test("End-to-end - schema with rewrite extracts to compiler context (RewriteDef on PropertyDef)", () => {
  const modules = parseToModules(`
    module default {
      type Post {
        required title: str;
        required created_at: datetime {
          rewrite insert using (datetime_of_statement());
        };
        required updated_at: datetime {
          rewrite insert, update using (datetime_of_statement());
        };
      }
    }
  `);

  const schemaManager = new SchemaManager({
    dryRun: true,
  });
  const schema = schemaManager.modulesToSchema(modules);

  // SchemaManager stores types by bare name (e.g., "Post"), not "default::Post"
  const postType = schema.types.get("Post");
  assertEquals(postType !== undefined, true);

  const createdAtProp = postType!.properties.get("created_at");
  assertEquals(createdAtProp !== undefined, true);
  assertEquals(createdAtProp!.rewrites !== undefined, true);
  assertEquals(createdAtProp!.rewrites!.length, 1);
  assertEquals(createdAtProp!.rewrites![0].events, ["insert"]);
  assertStringIncludes(
    createdAtProp!.rewrites![0].body,
    "datetime_of_statement()",
  );

  const updatedAtProp = postType!.properties.get("updated_at");
  assertEquals(updatedAtProp !== undefined, true);
  assertEquals(updatedAtProp!.rewrites !== undefined, true);
  assertEquals(updatedAtProp!.rewrites!.length, 1);
  assertEquals(updatedAtProp!.rewrites![0].events, ["insert", "update"]);
});

Deno.test("End-to-end - full pipeline: SDL -> parse -> diff -> DDL -> verify content", () => {
  // Test the complete pipeline from raw SDL text to DDL output
  const sdl = `
    module default {
      type Article {
        required title: str;
        required body: str;
        required created_at: datetime {
          rewrite insert using (datetime_of_statement());
        };
        required updated_at: datetime {
          rewrite insert, update using (datetime_of_statement());
        };
      }
    }
  `;

  const operations = diffFromEmpty(sdl);
  assertEquals(operations.length, 1);
  assertEquals(operations[0].kind, "CreateType");

  const ddl = generateDDL(operations);

  // Should have CREATE TABLE
  const createTable = ddl.find((s) => s.startsWith("CREATE TABLE"));
  assertEquals(createTable !== undefined, true);
  assertStringIncludes(createTable!, "article");

  // Should have 2 rewrite functions
  const rewriteFns = ddl.filter(
    (s) => s.includes("CREATE OR REPLACE FUNCTION") && s.includes("rewrite_fn"),
  );
  assertEquals(rewriteFns.length, 2);

  // Should have 2 rewrite triggers
  const rewriteTrigs = ddl.filter(
    (s) => s.includes("CREATE TRIGGER") && s.includes("rewrite"),
  );
  assertEquals(rewriteTrigs.length, 2);

  // Verify the created_at trigger is INSERT-only
  const createdAtTrig = rewriteTrigs.find((s) => s.includes("created_at__rewrite"));
  assertEquals(createdAtTrig !== undefined, true);
  assertStringIncludes(createdAtTrig!, "BEFORE INSERT ON");

  // Verify the updated_at trigger is INSERT OR UPDATE
  const updatedAtTrig = rewriteTrigs.find((s) => s.includes("updated_at__rewrite"));
  assertEquals(updatedAtTrig !== undefined, true);
  assertStringIncludes(updatedAtTrig!, "BEFORE INSERT OR UPDATE ON");

  // Verify both functions use statement_timestamp() (not datetime_of_statement)
  for (const fn of rewriteFns) {
    assertStringIncludes(fn, "statement_timestamp()");
    assertEquals(fn.includes("datetime_of_statement"), false);
  }
});
