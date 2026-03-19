/**
 * Tests for Trigger DDL Generation (Stage 31)
 *
 * Verifies that SDL trigger declarations are correctly parsed, validated,
 * diffed, and compiled to PostgreSQL trigger DDL.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { SDLParser } from "../schema/parser.ts";
import { SchemaValidator } from "../schema/validator.ts";
import { DDLGenerator } from "./ddl.ts";
import { SchemaDiffer } from "./differ.ts";
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
function generateRollbackDDL(operations: Types.MigrationOperation[]): string[] {
  const generator = new DDLGenerator();
  return generator.generateRollbackDDL(operations);
}

/**
 * Build a Module[] directly from AST nodes for differ tests that need
 * trigger bodies the SDL parser cannot handle (e.g. `insert` statements).
 * This avoids parser limitations while still testing the differ/DDL layers.
 */
function makeModuleWithTrigger(
  typeName: string,
  triggers: {
    name: string;
    timing: "before" | "after";
    events: ("insert" | "update" | "delete")[];
    scope: "each" | "all";
    bodyPath: string[];
  }[],
): Module[] {
  return [{
    name: "default",
    items: [{
      kind: "TypeDeclaration",
      name: { kind: "Identifier", value: typeName },
      members: [
        {
          kind: "PropertyDeclaration",
          name: { kind: "Identifier", value: "name" },
          type: {
            kind: "TypeRef",
            name: { kind: "QualifiedName", parts: ["str"] },
          },
          required: true,
          multi: false,
        },
        ...triggers.map((t) => ({
          kind: "TriggerDeclaration" as const,
          name: { kind: "Identifier" as const, value: t.name },
          timing: t.timing,
          events: t.events,
          scope: t.scope,
          body: {
            kind: "PathExpression" as const,
            path: t.bodyPath,
          },
        })),
      ],
    }],
  }];
}

// ============================================================
// Parser Tests
// ============================================================

Deno.test("Parser - trigger with single event (after insert)", () => {
  const doc = parseSDL(`
    module default {
      type User {
        required name: str;
        trigger audit_log after insert for each do (
          log_action(__action__)
        );
      }
    }
  `);

  const mod = doc.declarations[0];
  assertEquals(mod.kind, "ModuleDeclaration");
  if (mod.kind !== "ModuleDeclaration") return;

  const userType = mod.declarations[0];
  assertEquals(userType.kind, "TypeDeclaration");
  if (userType.kind !== "TypeDeclaration") return;

  const trigger = userType.members.find((m) => m.kind === "TriggerDeclaration");
  assertEquals(trigger !== undefined, true);
  if (!trigger || trigger.kind !== "TriggerDeclaration") return;

  assertEquals(trigger.name.value, "audit_log");
  assertEquals(trigger.timing, "after");
  assertEquals(trigger.events, ["insert"]);
  assertEquals(trigger.scope, "each");
});

Deno.test("Parser - trigger with multiple events (after insert, update, delete)", () => {
  const doc = parseSDL(`
    module default {
      type User {
        required name: str;
        trigger track_changes after insert, update, delete for each do (
          log_change(__new__)
        );
      }
    }
  `);

  const mod = doc.declarations[0];
  if (mod.kind !== "ModuleDeclaration") return;
  const userType = mod.declarations[0];
  if (userType.kind !== "TypeDeclaration") return;

  const trigger = userType.members.find((m) => m.kind === "TriggerDeclaration");
  if (!trigger || trigger.kind !== "TriggerDeclaration") return;

  assertEquals(trigger.name.value, "track_changes");
  assertEquals(trigger.events, ["insert", "update", "delete"]);
});

Deno.test("Parser - trigger with before timing", () => {
  const doc = parseSDL(`
    module default {
      type User {
        required name: str;
        trigger validate_name before insert for each do (
          validate_record(__new__)
        );
      }
    }
  `);

  const mod = doc.declarations[0];
  if (mod.kind !== "ModuleDeclaration") return;
  const userType = mod.declarations[0];
  if (userType.kind !== "TypeDeclaration") return;

  const trigger = userType.members.find((m) => m.kind === "TriggerDeclaration");
  if (!trigger || trigger.kind !== "TriggerDeclaration") return;

  assertEquals(trigger.timing, "before");
});

Deno.test("Parser - trigger with for all scope (statement-level)", () => {
  const doc = parseSDL(`
    module default {
      type User {
        required name: str;
        trigger notify_batch after insert for all do (
          notify_admin()
        );
      }
    }
  `);

  const mod = doc.declarations[0];
  if (mod.kind !== "ModuleDeclaration") return;
  const userType = mod.declarations[0];
  if (userType.kind !== "TypeDeclaration") return;

  const trigger = userType.members.find((m) => m.kind === "TriggerDeclaration");
  if (!trigger || trigger.kind !== "TriggerDeclaration") return;

  assertEquals(trigger.scope, "all");
});

Deno.test("Parser - multiple triggers on one type", () => {
  const doc = parseSDL(`
    module default {
      type User {
        required name: str;
        trigger audit_insert after insert for each do (
          log_action(__action__)
        );
        trigger audit_delete after delete for each do (
          log_action(__action__)
        );
      }
    }
  `);

  const mod = doc.declarations[0];
  if (mod.kind !== "ModuleDeclaration") return;
  const userType = mod.declarations[0];
  if (userType.kind !== "TypeDeclaration") return;

  const triggers = userType.members.filter(
    (m) => m.kind === "TriggerDeclaration",
  );
  assertEquals(triggers.length, 2);

  if (triggers[0].kind === "TriggerDeclaration") {
    assertEquals(triggers[0].name.value, "audit_insert");
  }
  if (triggers[1].kind === "TriggerDeclaration") {
    assertEquals(triggers[1].name.value, "audit_delete");
  }
});

Deno.test("Parser - trigger alongside properties, links, and constraints", () => {
  const doc = parseSDL(`
    module default {
      type Post {
        required title: str {
          constraint max_len_value(255);
        };
        required body: str;
        trigger audit_post after insert, update for each do (
          log_action(__action__)
        );
      }
    }
  `);

  const mod = doc.declarations[0];
  if (mod.kind !== "ModuleDeclaration") return;
  const postType = mod.declarations[0];
  if (postType.kind !== "TypeDeclaration") return;

  const properties = postType.members.filter(
    (m) => m.kind === "PropertyDeclaration",
  );
  const triggers = postType.members.filter(
    (m) => m.kind === "TriggerDeclaration",
  );

  assertEquals(properties.length, 2);
  assertEquals(triggers.length, 1);
});

// ============================================================
// Validator Tests
// ============================================================

Deno.test("Validator - valid trigger passes validation", () => {
  const doc = parseSDL(`
    module default {
      type User {
        required name: str;
        trigger audit_log after insert for each do (
          log_action(__action__)
        );
      }
    }
  `);

  const validator = new SchemaValidator();
  const result = validator.validate(doc);

  // Filter for trigger-specific errors only
  const triggerErrors = (result.errors || []).filter(
    (e) => e.message.includes("Trigger") || e.message.includes("trigger"),
  );
  assertEquals(triggerErrors.length, 0);
});

Deno.test("Validator - duplicate trigger name produces error", () => {
  const doc = parseSDL(`
    module default {
      type User {
        required name: str;
        trigger audit_log after insert for each do (
          log_action(__action__)
        );
        trigger audit_log after delete for each do (
          log_action(__action__)
        );
      }
    }
  `);

  const validator = new SchemaValidator();
  const result = validator.validate(doc);

  const triggerErrors = (result.errors || []).filter(
    (e) =>
      e.message.includes("audit_log") && e.message.includes("already defined"),
  );
  assertEquals(triggerErrors.length, 1);
  assertStringIncludes(triggerErrors[0].message, "audit_log");
});

// ============================================================
// Differ Tests (using direct AST Module construction)
// ============================================================

Deno.test("Differ - new type with trigger produces CreateType with trigger", () => {
  const differ = new SchemaDiffer();
  const schema = makeModuleWithTrigger("User", [{
    name: "audit_log",
    timing: "after",
    events: ["insert"],
    scope: "each",
    bodyPath: ["log_action"],
  }]);

  const operations = differ.diff([], schema);

  assertEquals(operations.length, 1);
  assertEquals(operations[0].kind, "CreateType");

  const createOp = operations[0] as Types.CreateTypeOperation;
  assertEquals(createOp.typeName, "User");
  assertEquals(createOp.triggers !== undefined, true);
  assertEquals(createOp.triggers!.length, 1);
  assertEquals(createOp.triggers![0].name, "audit_log");
  assertEquals(createOp.triggers![0].timing, "after");
  assertEquals(createOp.triggers![0].events, ["insert"]);
  assertEquals(createOp.triggers![0].scope, "each");
});

Deno.test("Differ - trigger added to existing type produces AddTrigger", () => {
  const differ = new SchemaDiffer();

  const oldSchema = makeModuleWithTrigger("User", []);
  const newSchema = makeModuleWithTrigger("User", [{
    name: "audit_log",
    timing: "after",
    events: ["insert"],
    scope: "each",
    bodyPath: ["log_action"],
  }]);

  const operations = differ.diff(oldSchema, newSchema);

  assertEquals(operations.length, 1);
  assertEquals(operations[0].kind, "AlterType");

  const alterOp = operations[0] as Types.AlterTypeOperation;
  assertEquals(alterOp.operations.length, 1);
  assertEquals(alterOp.operations[0].kind, "AddTrigger");

  const addTrigger = alterOp.operations[0] as Types.AddTriggerOperation;
  assertEquals(addTrigger.trigger.name, "audit_log");
  assertEquals(addTrigger.trigger.timing, "after");
  assertEquals(addTrigger.trigger.events, ["insert"]);
});

Deno.test("Differ - trigger removed produces DropTrigger", () => {
  const differ = new SchemaDiffer();

  const oldSchema = makeModuleWithTrigger("User", [{
    name: "audit_log",
    timing: "after",
    events: ["insert"],
    scope: "each",
    bodyPath: ["log_action"],
  }]);
  const newSchema = makeModuleWithTrigger("User", []);

  const operations = differ.diff(oldSchema, newSchema);

  assertEquals(operations.length, 1);
  assertEquals(operations[0].kind, "AlterType");

  const alterOp = operations[0] as Types.AlterTypeOperation;
  assertEquals(alterOp.operations.length, 1);
  assertEquals(alterOp.operations[0].kind, "DropTrigger");

  const dropTrigger = alterOp.operations[0] as Types.DropTriggerOperation;
  assertEquals(dropTrigger.triggerName, "audit_log");
});

Deno.test("Differ - trigger modified (timing changed) produces DropTrigger + AddTrigger", () => {
  const differ = new SchemaDiffer();

  const oldSchema = makeModuleWithTrigger("User", [{
    name: "audit_log",
    timing: "after",
    events: ["insert"],
    scope: "each",
    bodyPath: ["log_action"],
  }]);
  const newSchema = makeModuleWithTrigger("User", [{
    name: "audit_log",
    timing: "before",
    events: ["insert"],
    scope: "each",
    bodyPath: ["log_action"],
  }]);

  const operations = differ.diff(oldSchema, newSchema);

  assertEquals(operations.length, 1);
  assertEquals(operations[0].kind, "AlterType");

  const alterOp = operations[0] as Types.AlterTypeOperation;
  // Must have DropTrigger + AddTrigger (triggers can't be altered in place)
  assertEquals(alterOp.operations.length, 2);

  const dropOp = alterOp.operations.find((op) => op.kind === "DropTrigger");
  const addOp = alterOp.operations.find((op) => op.kind === "AddTrigger");

  assertEquals(dropOp !== undefined, true);
  assertEquals(addOp !== undefined, true);

  if (addOp && addOp.kind === "AddTrigger") {
    assertEquals(
      (addOp as Types.AddTriggerOperation).trigger.timing,
      "before",
    );
  }
});

Deno.test("Differ - trigger unchanged produces no operations", () => {
  const differ = new SchemaDiffer();

  const schema = makeModuleWithTrigger("User", [{
    name: "audit_log",
    timing: "after",
    events: ["insert"],
    scope: "each",
    bodyPath: ["log_action"],
  }]);

  const operations = differ.diff(schema, schema);

  assertEquals(operations.length, 0);
});

Deno.test("Differ - multiple triggers with mixed changes", () => {
  const differ = new SchemaDiffer();

  const oldSchema = makeModuleWithTrigger("User", [
    {
      name: "keep_same",
      timing: "after",
      events: ["insert"],
      scope: "each",
      bodyPath: ["log_action"],
    },
    {
      name: "to_remove",
      timing: "after",
      events: ["delete"],
      scope: "each",
      bodyPath: ["log_action"],
    },
    {
      name: "to_modify",
      timing: "after",
      events: ["update"],
      scope: "each",
      bodyPath: ["log_action"],
    },
  ]);

  const newSchema = makeModuleWithTrigger("User", [
    {
      name: "keep_same",
      timing: "after",
      events: ["insert"],
      scope: "each",
      bodyPath: ["log_action"],
    },
    {
      name: "to_modify",
      timing: "before",
      events: ["update"],
      scope: "each",
      bodyPath: ["log_action"],
    },
    {
      name: "newly_added",
      timing: "after",
      events: ["insert", "update"],
      scope: "each",
      bodyPath: ["notify"],
    },
  ]);

  const operations = differ.diff(oldSchema, newSchema);

  assertEquals(operations.length, 1);
  assertEquals(operations[0].kind, "AlterType");

  const alterOp = operations[0] as Types.AlterTypeOperation;

  const addOps = alterOp.operations.filter((op) => op.kind === "AddTrigger");
  const dropOps = alterOp.operations.filter((op) => op.kind === "DropTrigger");

  // AddTrigger: newly_added + to_modify (re-added)
  assertEquals(addOps.length, 2);
  // DropTrigger: to_remove + to_modify (dropped first)
  assertEquals(dropOps.length, 2);

  const addNames = addOps.map(
    (op) => (op as Types.AddTriggerOperation).trigger.name,
  );
  const dropNames = dropOps.map(
    (op) => (op as Types.DropTriggerOperation).triggerName,
  );

  assertEquals(addNames.includes("newly_added"), true);
  assertEquals(addNames.includes("to_modify"), true);
  assertEquals(dropNames.includes("to_remove"), true);
  assertEquals(dropNames.includes("to_modify"), true);
});

// ============================================================
// DDL Tests
// ============================================================

Deno.test("DDL - CreateType with trigger generates CREATE FUNCTION + CREATE TRIGGER", () => {
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "User",
    properties: [
      {
        name: "name",
        type: "str",
        required: true,
        multi: false,
        constraints: [],
        annotations: {},
      },
    ],
    links: [],
    triggers: [
      {
        name: "audit_log",
        timing: "after",
        events: ["insert"],
        scope: "each",
        body: "insert AuditLog { action := __action__ }",
      },
    ],
  };

  const statements = generateDDL([operation]);

  const fnStatements = statements.filter((s) =>
    s.includes("CREATE OR REPLACE FUNCTION")
  );
  const trigStatements = statements.filter((s) => s.includes("CREATE TRIGGER"));

  assertEquals(fnStatements.length, 1);
  assertEquals(trigStatements.length, 1);

  assertStringIncludes(fnStatements[0], "user__audit_log_fn");
  assertStringIncludes(fnStatements[0], "RETURNS TRIGGER");
  assertStringIncludes(trigStatements[0], "user__audit_log");
  assertStringIncludes(trigStatements[0], "AFTER INSERT");
  assertStringIncludes(trigStatements[0], "FOR EACH ROW");
});

Deno.test("DDL - AddTrigger generates correct DDL output", () => {
  const operation: Types.AlterTypeOperation = {
    kind: "AlterType",
    typeName: "User",
    operations: [
      {
        kind: "AddTrigger",
        trigger: {
          name: "track_changes",
          timing: "after",
          events: ["insert", "update"],
          scope: "each",
          body: "insert ChangeLog { entity := __new__ }",
        },
      } as Types.AddTriggerOperation,
    ],
  };

  const statements = generateDDL([operation]);

  const fnStatements = statements.filter((s) =>
    s.includes("CREATE OR REPLACE FUNCTION")
  );
  const trigStatements = statements.filter((s) => s.includes("CREATE TRIGGER"));

  assertEquals(fnStatements.length, 1);
  assertEquals(trigStatements.length, 1);

  assertStringIncludes(fnStatements[0], "user__track_changes_fn");
  assertStringIncludes(trigStatements[0], "user__track_changes");
});

Deno.test("DDL - DropTrigger generates DROP TRIGGER + DROP FUNCTION", () => {
  const operation: Types.AlterTypeOperation = {
    kind: "AlterType",
    typeName: "User",
    operations: [
      {
        kind: "DropTrigger",
        triggerName: "audit_log",
      } as Types.DropTriggerOperation,
    ],
  };

  const statements = generateDDL([operation]);

  const dropTrigStatements = statements.filter((s) =>
    s.includes("DROP TRIGGER")
  );
  const dropFnStatements = statements.filter((s) =>
    s.includes("DROP FUNCTION")
  );

  assertEquals(dropTrigStatements.length, 1);
  assertEquals(dropFnStatements.length, 1);

  assertStringIncludes(dropTrigStatements[0], "user__audit_log");
  assertStringIncludes(dropFnStatements[0], "user__audit_log_fn");
});

Deno.test("DDL - BEFORE timing in trigger DDL", () => {
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "User",
    properties: [
      {
        name: "name",
        type: "str",
        required: true,
        multi: false,
        constraints: [],
        annotations: {},
      },
    ],
    links: [],
    triggers: [
      {
        name: "validate",
        timing: "before",
        events: ["insert"],
        scope: "each",
        body: "select validate(__new__)",
      },
    ],
  };

  const statements = generateDDL([operation]);
  const trigStatement = statements.find((s) => s.includes("CREATE TRIGGER"));

  assertEquals(trigStatement !== undefined, true);
  assertStringIncludes(trigStatement!, "BEFORE INSERT");
});

Deno.test("DDL - multiple events are OR-joined in SQL", () => {
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "User",
    properties: [
      {
        name: "name",
        type: "str",
        required: true,
        multi: false,
        constraints: [],
        annotations: {},
      },
    ],
    links: [],
    triggers: [
      {
        name: "track_all",
        timing: "after",
        events: ["insert", "update", "delete"],
        scope: "each",
        body: "insert ChangeLog { action := __action__ }",
      },
    ],
  };

  const statements = generateDDL([operation]);
  const trigStatement = statements.find((s) => s.includes("CREATE TRIGGER"));

  assertEquals(trigStatement !== undefined, true);
  assertStringIncludes(trigStatement!, "INSERT OR UPDATE OR DELETE");
});

Deno.test("DDL - FOR EACH ROW vs FOR EACH STATEMENT", () => {
  const generator = new DDLGenerator();

  // scope "each" -> FOR EACH ROW
  const rowStatements = generator.generateDDL([{
    kind: "CreateType",
    typeName: "User",
    properties: [{
      name: "name",
      type: "str",
      required: true,
      multi: false,
      constraints: [],
      annotations: {},
    }],
    links: [],
    triggers: [{
      name: "row_trigger",
      timing: "after",
      events: ["insert"],
      scope: "each",
      body: "select 1",
    }],
  } as Types.CreateTypeOperation]);

  const rowTrigger = rowStatements.find((s) => s.includes("CREATE TRIGGER"));
  assertStringIncludes(rowTrigger!, "FOR EACH ROW");

  // scope "all" -> FOR EACH STATEMENT
  const stmtStatements = generator.generateDDL([{
    kind: "CreateType",
    typeName: "Event",
    properties: [{
      name: "name",
      type: "str",
      required: true,
      multi: false,
      constraints: [],
      annotations: {},
    }],
    links: [],
    triggers: [{
      name: "stmt_trigger",
      timing: "after",
      events: ["insert"],
      scope: "all",
      body: "select 1",
    }],
  } as Types.CreateTypeOperation]);

  const stmtTrigger = stmtStatements.find((s) => s.includes("CREATE TRIGGER"));
  assertStringIncludes(stmtTrigger!, "FOR EACH STATEMENT");
});

Deno.test("DDL - __new__ / __old__ / __action__ substitution in body", () => {
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "User",
    properties: [
      {
        name: "name",
        type: "str",
        required: true,
        multi: false,
        constraints: [],
        annotations: {},
      },
    ],
    links: [],
    triggers: [
      {
        name: "log_changes",
        timing: "after",
        events: ["update"],
        scope: "each",
        body:
          "insert ChangeLog { old_val := __old__, new_val := __new__, action := __action__ }",
      },
    ],
  };

  const statements = generateDDL([operation]);
  const fnStatement = statements.find((s) =>
    s.includes("CREATE OR REPLACE FUNCTION")
  );

  assertEquals(fnStatement !== undefined, true);
  // __new__ -> NEW, __old__ -> OLD, __action__ -> TG_OP
  assertStringIncludes(fnStatement!, "NEW");
  assertStringIncludes(fnStatement!, "OLD");
  assertStringIncludes(fnStatement!, "TG_OP");
  // Should NOT contain the original EdgeQL variables
  assertEquals(fnStatement!.includes("__new__"), false);
  assertEquals(fnStatement!.includes("__old__"), false);
  assertEquals(fnStatement!.includes("__action__"), false);
});

Deno.test("DDL - rollback for AddTrigger generates DROP TRIGGER + DROP FUNCTION", () => {
  const operation: Types.AlterTypeOperation = {
    kind: "AlterType",
    typeName: "User",
    operations: [
      {
        kind: "AddTrigger",
        trigger: {
          name: "audit_log",
          timing: "after",
          events: ["insert"],
          scope: "each",
          body: "insert AuditLog { action := __action__ }",
        },
      } as Types.AddTriggerOperation,
    ],
  };

  const statements = generateRollbackDDL([operation]);

  const dropTrigStatements = statements.filter((s) =>
    s.includes("DROP TRIGGER")
  );
  const dropFnStatements = statements.filter((s) =>
    s.includes("DROP FUNCTION")
  );

  assertEquals(dropTrigStatements.length, 1);
  assertEquals(dropFnStatements.length, 1);
  assertStringIncludes(dropTrigStatements[0], "user__audit_log");
  assertStringIncludes(dropFnStatements[0], "user__audit_log_fn");
});

Deno.test("DDL - rollback for DropTrigger produces manual rollback comment", () => {
  const operation: Types.AlterTypeOperation = {
    kind: "AlterType",
    typeName: "User",
    operations: [
      {
        kind: "DropTrigger",
        triggerName: "audit_log",
      } as Types.DropTriggerOperation,
    ],
  };

  const statements = generateRollbackDDL([operation]);

  // DropTrigger rollback should note that it requires manual intervention
  const manualStatements = statements.filter((s) =>
    s.includes("MANUAL ROLLBACK REQUIRED")
  );
  assertEquals(manualStatements.length >= 1, true);
  assertStringIncludes(manualStatements[0], "audit_log");
});

// ============================================================
// End-to-end: SDL (parsed) -> Differ -> DDL
// ============================================================

Deno.test("End-to-end - SDL with trigger produces correct DDL via parser", () => {
  const modules = parseToModules(`
    module default {
      type User {
        required name: str;
        trigger audit_log after insert, update for each do (
          log_action(__action__)
        );
      }
    }
  `);

  const differ = new SchemaDiffer();
  const operations = differ.diff([], modules);
  const ddl = generateDDL(operations);

  // Should have CREATE TABLE, CREATE FUNCTION, and CREATE TRIGGER
  const createTable = ddl.find((s) => s.startsWith("CREATE TABLE"));
  assertEquals(createTable !== undefined, true);

  const createFn = ddl.find((s) => s.includes("CREATE OR REPLACE FUNCTION"));
  assertEquals(createFn !== undefined, true);
  assertStringIncludes(createFn!, "user__audit_log_fn");

  const createTrig = ddl.find((s) => s.includes("CREATE TRIGGER"));
  assertEquals(createTrig !== undefined, true);
  assertStringIncludes(createTrig!, "AFTER INSERT OR UPDATE");
  assertStringIncludes(createTrig!, "FOR EACH ROW");
});

Deno.test("End-to-end - adding trigger to existing type produces ALTER with correct DDL", () => {
  const oldModules = parseToModules(`
    module default {
      type User {
        required name: str;
      }
    }
  `);

  const newModules = parseToModules(`
    module default {
      type User {
        required name: str;
        trigger notify_insert before insert for all do (
          notify_admin()
        );
      }
    }
  `);

  const differ = new SchemaDiffer();
  const operations = differ.diff(oldModules, newModules);
  const ddl = generateDDL(operations);

  const createFn = ddl.find((s) => s.includes("CREATE OR REPLACE FUNCTION"));
  assertEquals(createFn !== undefined, true);
  assertStringIncludes(createFn!, "user__notify_insert_fn");

  const createTrig = ddl.find((s) => s.includes("CREATE TRIGGER"));
  assertEquals(createTrig !== undefined, true);
  assertStringIncludes(createTrig!, "BEFORE INSERT");
  assertStringIncludes(createTrig!, "FOR EACH STATEMENT");
});
