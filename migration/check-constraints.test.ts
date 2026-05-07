/**
 * Tests for CHECK Constraint DDL Generation
 *
 * Verifies that EdgeQL constraints on properties are correctly mapped
 * to PostgreSQL CHECK constraints in the generated DDL.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { DDLGenerator } from "./ddl.ts";
import { SchemaDiffer } from "./differ.ts";
import { Module } from "../schema/converter.ts";
import * as Types from "./types.ts";

// ============================================================
// DDL Generator: CHECK constraint generation from operations
// ============================================================

Deno.test("DDL Generator - max_len_value generates CHECK with length <=", () => {
  const generator = new DDLGenerator();
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "User",
    properties: [
      {
        name: "name",
        type: "str",
        required: true,
        multi: false,
        constraints: ["max_len_value(255)"],
        annotations: {},
      },
    ],
    links: [],
  };

  const statements = generator.generateDDL([operation]);
  const checkStatements = statements.filter((s) => s.includes("CHECK"));

  assertEquals(checkStatements.length, 1);
  assertStringIncludes(checkStatements[0], "CHECK (length(name) <= 255)");
  assertStringIncludes(checkStatements[0], "chk_user_name_max_len_value_255_");
});

Deno.test("DDL Generator - min_len_value generates CHECK with length >=", () => {
  const generator = new DDLGenerator();
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "User",
    properties: [
      {
        name: "username",
        type: "str",
        required: true,
        multi: false,
        constraints: ["min_len_value(3)"],
        annotations: {},
      },
    ],
    links: [],
  };

  const statements = generator.generateDDL([operation]);
  const checkStatements = statements.filter((s) => s.includes("CHECK"));

  assertEquals(checkStatements.length, 1);
  assertStringIncludes(checkStatements[0], "CHECK (length(username) >= 3)");
});

Deno.test("DDL Generator - max_value generates CHECK with <=", () => {
  const generator = new DDLGenerator();
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "Product",
    properties: [
      {
        name: "price",
        type: "float64",
        required: true,
        multi: false,
        constraints: ["max_value(9999)"],
        annotations: {},
      },
    ],
    links: [],
  };

  const statements = generator.generateDDL([operation]);
  const checkStatements = statements.filter((s) => s.includes("CHECK"));

  assertEquals(checkStatements.length, 1);
  assertStringIncludes(checkStatements[0], "CHECK (price <= 9999)");
});

Deno.test("DDL Generator - min_value generates CHECK with >=", () => {
  const generator = new DDLGenerator();
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "Product",
    properties: [
      {
        name: "quantity",
        type: "int32",
        required: true,
        multi: false,
        constraints: ["min_value(0)"],
        annotations: {},
      },
    ],
    links: [],
  };

  const statements = generator.generateDDL([operation]);
  const checkStatements = statements.filter((s) => s.includes("CHECK"));

  assertEquals(checkStatements.length, 1);
  assertStringIncludes(checkStatements[0], "CHECK (quantity >= 0)");
});

Deno.test("DDL Generator - regexp generates CHECK with ~ operator", () => {
  const generator = new DDLGenerator();
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "User",
    properties: [
      {
        name: "email",
        type: "str",
        required: true,
        multi: false,
        constraints: [
          "regexp(^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$)",
        ],
        annotations: {},
      },
    ],
    links: [],
  };

  const statements = generator.generateDDL([operation]);
  const checkStatements = statements.filter((s) => s.includes("CHECK"));

  assertEquals(checkStatements.length, 1);
  assertStringIncludes(checkStatements[0], "CHECK (email ~ '");
  assertStringIncludes(checkStatements[0], "@[a-zA-Z0-9.-]+");
});

Deno.test("DDL Generator - exclusive constraint does NOT generate CHECK", () => {
  const generator = new DDLGenerator();
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "User",
    properties: [
      {
        name: "email",
        type: "str",
        required: true,
        multi: false,
        constraints: ["exclusive"],
        annotations: {},
      },
    ],
    links: [],
  };

  const statements = generator.generateDDL([operation]);
  const checkStatements = statements.filter((s) => s.includes("CHECK"));

  assertEquals(checkStatements.length, 0);
  // Exclusive is handled as UNIQUE index instead
  const uniqueStatements = statements.filter((s) => s.includes("UNIQUE"));
  assertEquals(uniqueStatements.length >= 1, true);
});

Deno.test("DDL Generator - multiple constraints on one property generate multiple CHECKs", () => {
  const generator = new DDLGenerator();
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "User",
    properties: [
      {
        name: "username",
        type: "str",
        required: true,
        multi: false,
        constraints: ["min_len_value(3)", "max_len_value(50)"],
        annotations: {},
      },
    ],
    links: [],
  };

  const statements = generator.generateDDL([operation]);
  const checkStatements = statements.filter((s) => s.includes("CHECK"));

  assertEquals(checkStatements.length, 2);
  assertStringIncludes(checkStatements[0], "CHECK (length(username) >= 3)");
  assertStringIncludes(checkStatements[1], "CHECK (length(username) <= 50)");
});

Deno.test("DDL Generator - multiple properties each with constraints", () => {
  const generator = new DDLGenerator();
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "Product",
    properties: [
      {
        name: "name",
        type: "str",
        required: true,
        multi: false,
        constraints: ["max_len_value(200)"],
        annotations: {},
      },
      {
        name: "price",
        type: "float64",
        required: true,
        multi: false,
        constraints: ["min_value(0)", "max_value(99999)"],
        annotations: {},
      },
    ],
    links: [],
  };

  const statements = generator.generateDDL([operation]);
  const checkStatements = statements.filter((s) => s.includes("CHECK"));

  assertEquals(checkStatements.length, 3);
  assertStringIncludes(checkStatements[0], "length(name) <= 200");
  assertStringIncludes(checkStatements[1], "price >= 0");
  assertStringIncludes(checkStatements[2], "price <= 99999");
});

Deno.test("DDL Generator - constraint with no args generates no CHECK", () => {
  const generator = new DDLGenerator();
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "Item",
    properties: [
      {
        name: "code",
        type: "str",
        required: true,
        multi: false,
        constraints: ["max_len_value"],
        annotations: {},
      },
    ],
    links: [],
  };

  const statements = generator.generateDDL([operation]);
  const checkStatements = statements.filter((s) => s.includes("CHECK"));

  // max_len_value without a numeric argument should not produce a CHECK
  assertEquals(checkStatements.length, 0);
});

Deno.test("DDL Generator - CHECK constraints also generated on AddProperty", () => {
  const generator = new DDLGenerator();
  const operation: Types.AlterTypeOperation = {
    kind: "AlterType",
    typeName: "User",
    operations: [
      {
        kind: "AddProperty",
        property: {
          name: "bio",
          type: "str",
          required: false,
          multi: false,
          constraints: ["max_len_value(1000)"],
          annotations: {},
        },
      } as Types.AddPropertyOperation,
    ],
  };

  const statements = generator.generateDDL([operation]);
  const checkStatements = statements.filter((s) => s.includes("CHECK"));

  assertEquals(checkStatements.length, 1);
  assertStringIncludes(checkStatements[0], "CHECK (length(bio) <= 1000)");
});

// ============================================================
// Schema Differ: constraint extraction with arguments
// ============================================================

Deno.test("Schema Differ - extractConstraints includes arguments in constraint string", () => {
  const differ = new SchemaDiffer();

  const schema: Module[] = [
    {
      name: "default",
      items: [
        {
          kind: "TypeDeclaration",
          name: { kind: "Identifier", value: "User" },
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
              constraints: [
                {
                  kind: "Constraint",
                  name: { kind: "Identifier", value: "max_len_value" },
                  args: [
                    { kind: "Literal", type: "integer", value: 255 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ];

  // Diff against empty schema to get a CreateType operation
  const operations = differ.diff([], schema);

  assertEquals(operations.length, 1);
  assertEquals(operations[0].kind, "CreateType");

  const createOp = operations[0] as Types.CreateTypeOperation;
  assertEquals(createOp.properties.length, 1);
  assertEquals(createOp.properties[0].constraints, ["max_len_value(255)"]);
});

Deno.test("Schema Differ - constraint without args remains just the name", () => {
  const differ = new SchemaDiffer();

  const schema: Module[] = [
    {
      name: "default",
      items: [
        {
          kind: "TypeDeclaration",
          name: { kind: "Identifier", value: "User" },
          members: [
            {
              kind: "PropertyDeclaration",
              name: { kind: "Identifier", value: "email" },
              type: {
                kind: "TypeRef",
                name: { kind: "QualifiedName", parts: ["str"] },
              },
              required: true,
              multi: false,
              constraints: [
                {
                  kind: "Constraint",
                  name: { kind: "Identifier", value: "exclusive" },
                },
              ],
            },
          ],
        },
      ],
    },
  ];

  const operations = differ.diff([], schema);
  const createOp = operations[0] as Types.CreateTypeOperation;

  assertEquals(createOp.properties[0].constraints, ["exclusive"]);
});

Deno.test("Schema Differ - multiple constraint args separated by commas", () => {
  const differ = new SchemaDiffer();

  const schema: Module[] = [
    {
      name: "default",
      items: [
        {
          kind: "TypeDeclaration",
          name: { kind: "Identifier", value: "Config" },
          members: [
            {
              kind: "PropertyDeclaration",
              name: { kind: "Identifier", value: "value" },
              type: {
                kind: "TypeRef",
                name: { kind: "QualifiedName", parts: ["str"] },
              },
              required: true,
              multi: false,
              constraints: [
                {
                  kind: "Constraint",
                  name: { kind: "Identifier", value: "regexp" },
                  args: [
                    { kind: "Literal", type: "string", value: "^[a-z]+$" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ];

  const operations = differ.diff([], schema);
  const createOp = operations[0] as Types.CreateTypeOperation;

  assertEquals(createOp.properties[0].constraints, ["regexp(^[a-z]+$)"]);
});

// ============================================================
// End-to-end: Schema with constraints -> DDL with CHECK
// ============================================================

Deno.test("End-to-end - Schema with constraints produces correct DDL", () => {
  const differ = new SchemaDiffer();
  const generator = new DDLGenerator();

  const schema: Module[] = [
    {
      name: "default",
      items: [
        {
          kind: "TypeDeclaration",
          name: { kind: "Identifier", value: "User" },
          members: [
            {
              kind: "PropertyDeclaration",
              name: { kind: "Identifier", value: "username" },
              type: {
                kind: "TypeRef",
                name: { kind: "QualifiedName", parts: ["str"] },
              },
              required: true,
              multi: false,
              constraints: [
                {
                  kind: "Constraint",
                  name: { kind: "Identifier", value: "min_len_value" },
                  args: [
                    { kind: "Literal", type: "integer", value: 3 },
                  ],
                },
                {
                  kind: "Constraint",
                  name: { kind: "Identifier", value: "max_len_value" },
                  args: [
                    { kind: "Literal", type: "integer", value: 50 },
                  ],
                },
                {
                  kind: "Constraint",
                  name: { kind: "Identifier", value: "exclusive" },
                },
              ],
            },
            {
              kind: "PropertyDeclaration",
              name: { kind: "Identifier", value: "age" },
              type: {
                kind: "TypeRef",
                name: { kind: "QualifiedName", parts: ["int32"] },
              },
              required: false,
              multi: false,
              constraints: [
                {
                  kind: "Constraint",
                  name: { kind: "Identifier", value: "min_value" },
                  args: [
                    { kind: "Literal", type: "integer", value: 0 },
                  ],
                },
                {
                  kind: "Constraint",
                  name: { kind: "Identifier", value: "max_value" },
                  args: [
                    { kind: "Literal", type: "integer", value: 150 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ];

  const operations = differ.diff([], schema);
  const ddl = generator.generateDDL(operations);

  // Should have CREATE TABLE, UNIQUE INDEX for exclusive, and CHECK constraints
  const createTable = ddl.find((s) => s.startsWith("CREATE TABLE"));
  assertEquals(createTable !== undefined, true);

  const uniqueIndex = ddl.find((s) => s.includes("UNIQUE INDEX") && s.includes("username"));
  assertEquals(uniqueIndex !== undefined, true);

  const checkStatements = ddl.filter((s) => s.includes("CHECK"));
  assertEquals(checkStatements.length, 4);

  // Verify min_len_value CHECK for username
  const minLenCheck = checkStatements.find((s) => s.includes("length(username) >= 3"));
  assertEquals(minLenCheck !== undefined, true);

  // Verify max_len_value CHECK for username
  const maxLenCheck = checkStatements.find((s) => s.includes("length(username) <= 50"));
  assertEquals(maxLenCheck !== undefined, true);

  // Verify min_value CHECK for age
  const minValCheck = checkStatements.find((s) => s.includes("age >= 0"));
  assertEquals(minValCheck !== undefined, true);

  // Verify max_value CHECK for age
  const maxValCheck = checkStatements.find((s) => s.includes("age <= 150"));
  assertEquals(maxValCheck !== undefined, true);
});

Deno.test("DDL Generator - regexp constraint escapes single quotes in pattern", () => {
  const generator = new DDLGenerator();
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "Item",
    properties: [
      {
        name: "label",
        type: "str",
        required: true,
        multi: false,
        constraints: ["regexp(^[a-z']+$)"],
        annotations: {},
      },
    ],
    links: [],
  };

  const statements = generator.generateDDL([operation]);
  const checkStatements = statements.filter((s) => s.includes("CHECK"));

  assertEquals(checkStatements.length, 1);
  // Single quote in pattern should be escaped to double single quote
  assertStringIncludes(checkStatements[0], "label ~ '^[a-z'']+$'");
});

// ============================================================
// Stage 25: New constraint types
// ============================================================

Deno.test("DDL Generator - max_ex_value generates CHECK with strict less-than", () => {
  const generator = new DDLGenerator();
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "Bid",
    properties: [
      {
        name: "amount",
        type: "float64",
        required: true,
        multi: false,
        constraints: ["max_ex_value(1000000)"],
        annotations: {},
      },
    ],
    links: [],
  };

  const statements = generator.generateDDL([operation]);
  const checkStatements = statements.filter((s) => s.includes("CHECK"));

  assertEquals(checkStatements.length, 1);
  assertStringIncludes(checkStatements[0], "CHECK (amount < 1000000)");
});

Deno.test("DDL Generator - min_ex_value generates CHECK with strict greater-than", () => {
  const generator = new DDLGenerator();
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "Temperature",
    properties: [
      {
        name: "kelvin",
        type: "float64",
        required: true,
        multi: false,
        constraints: ["min_ex_value(0)"],
        annotations: {},
      },
    ],
    links: [],
  };

  const statements = generator.generateDDL([operation]);
  const checkStatements = statements.filter((s) => s.includes("CHECK"));

  assertEquals(checkStatements.length, 1);
  assertStringIncludes(checkStatements[0], "CHECK (kelvin > 0)");
});

Deno.test("DDL Generator - one_of generates CHECK with IN clause for string values", () => {
  const generator = new DDLGenerator();
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "Task",
    properties: [
      {
        name: "status",
        type: "str",
        required: true,
        multi: false,
        constraints: ["one_of(active,inactive,archived)"],
        annotations: {},
      },
    ],
    links: [],
  };

  const statements = generator.generateDDL([operation]);
  const checkStatements = statements.filter((s) => s.includes("CHECK"));

  assertEquals(checkStatements.length, 1);
  assertStringIncludes(
    checkStatements[0],
    "CHECK (status IN ('active', 'inactive', 'archived'))",
  );
});

Deno.test("DDL Generator - one_of generates CHECK with IN clause for numeric values", () => {
  const generator = new DDLGenerator();
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "Config",
    properties: [
      {
        name: "level",
        type: "int32",
        required: true,
        multi: false,
        constraints: ["one_of(1,2,3,4,5)"],
        annotations: {},
      },
    ],
    links: [],
  };

  const statements = generator.generateDDL([operation]);
  const checkStatements = statements.filter((s) => s.includes("CHECK"));

  assertEquals(checkStatements.length, 1);
  assertStringIncludes(
    checkStatements[0],
    "CHECK (level IN (1, 2, 3, 4, 5))",
  );
});

Deno.test("DDL Generator - expression_on generates CHECK with __subject__ replaced by column name", () => {
  const generator = new DDLGenerator();
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "Discount",
    properties: [
      {
        name: "percentage",
        type: "float64",
        required: true,
        multi: false,
        constraints: [
          "expression_on(__subject__ >= 0 AND __subject__ <= 100)",
        ],
        annotations: {},
      },
    ],
    links: [],
  };

  const statements = generator.generateDDL([operation]);
  const checkStatements = statements.filter((s) => s.includes("CHECK"));

  assertEquals(checkStatements.length, 1);
  assertStringIncludes(
    checkStatements[0],
    "CHECK (percentage >= 0 AND percentage <= 100)",
  );
});

Deno.test("DDL Generator - combined exclusive and value constraints on same property", () => {
  const generator = new DDLGenerator();
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "Product",
    properties: [
      {
        name: "sku",
        type: "str",
        required: true,
        multi: false,
        constraints: ["exclusive", "min_len_value(3)", "max_len_value(20)"],
        annotations: {},
      },
    ],
    links: [],
  };

  const statements = generator.generateDDL([operation]);
  const checkStatements = statements.filter((s) => s.includes("CHECK"));
  const uniqueStatements = statements.filter((s) => s.includes("UNIQUE"));

  // exclusive -> UNIQUE, min_len_value/max_len_value -> CHECK
  assertEquals(checkStatements.length, 2);
  assertEquals(uniqueStatements.length >= 1, true);
  assertStringIncludes(checkStatements[0], "length(sku) >= 3");
  assertStringIncludes(checkStatements[1], "length(sku) <= 20");
});

// ============================================================
// Constraint differ: add/drop detection
// ============================================================

Deno.test("Schema Differ - detects added constraint on existing property", () => {
  const differ = new SchemaDiffer();

  const makeSchema = (constraints: any[]): Module[] => [{
    name: "default",
    items: [{
      kind: "TypeDeclaration",
      name: { kind: "Identifier", value: "User" },
      members: [{
        kind: "PropertyDeclaration",
        name: { kind: "Identifier", value: "name" },
        type: {
          kind: "TypeRef",
          name: { kind: "QualifiedName", parts: ["str"] },
        },
        required: true,
        multi: false,
        constraints,
      }],
    }],
  }];

  const oldSchema = makeSchema([]);
  const newSchema = makeSchema([{
    kind: "Constraint",
    name: { kind: "Identifier", value: "max_len_value" },
    args: [{ kind: "Literal", type: "integer", value: 255 }],
  }]);

  const operations = differ.diff(oldSchema, newSchema);

  // Should be AlterType with AlterProperty containing AddConstraint
  assertEquals(operations.length, 1);
  assertEquals(operations[0].kind, "AlterType");
  const alterType = operations[0] as Types.AlterTypeOperation;
  assertEquals(alterType.operations.length, 1);
  assertEquals(alterType.operations[0].kind, "AlterProperty");
  const alterProp = alterType.operations[0] as Types.AlterPropertyOperation;
  assertEquals(alterProp.changes.length, 1);
  assertEquals(alterProp.changes[0].kind, "AddConstraint");
  assertEquals(alterProp.changes[0].newValue, "max_len_value(255)");
});

Deno.test("Schema Differ - detects dropped constraint on existing property", () => {
  const differ = new SchemaDiffer();

  const makeSchema = (constraints: any[]): Module[] => [{
    name: "default",
    items: [{
      kind: "TypeDeclaration",
      name: { kind: "Identifier", value: "User" },
      members: [{
        kind: "PropertyDeclaration",
        name: { kind: "Identifier", value: "name" },
        type: {
          kind: "TypeRef",
          name: { kind: "QualifiedName", parts: ["str"] },
        },
        required: true,
        multi: false,
        constraints,
      }],
    }],
  }];

  const oldSchema = makeSchema([{
    kind: "Constraint",
    name: { kind: "Identifier", value: "max_len_value" },
    args: [{ kind: "Literal", type: "integer", value: 255 }],
  }]);
  const newSchema = makeSchema([]);

  const operations = differ.diff(oldSchema, newSchema);

  assertEquals(operations.length, 1);
  assertEquals(operations[0].kind, "AlterType");
  const alterType = operations[0] as Types.AlterTypeOperation;
  assertEquals(alterType.operations.length, 1);
  assertEquals(alterType.operations[0].kind, "AlterProperty");
  const alterProp = alterType.operations[0] as Types.AlterPropertyOperation;
  assertEquals(alterProp.changes.length, 1);
  assertEquals(alterProp.changes[0].kind, "DropConstraint");
  assertEquals(alterProp.changes[0].oldValue, "max_len_value(255)");
});

Deno.test("Schema Differ - detects constraint modification (value change)", () => {
  const differ = new SchemaDiffer();

  const makeSchema = (maxLen: number): Module[] => [{
    name: "default",
    items: [{
      kind: "TypeDeclaration",
      name: { kind: "Identifier", value: "User" },
      members: [{
        kind: "PropertyDeclaration",
        name: { kind: "Identifier", value: "name" },
        type: {
          kind: "TypeRef",
          name: { kind: "QualifiedName", parts: ["str"] },
        },
        required: true,
        multi: false,
        constraints: [{
          kind: "Constraint",
          name: { kind: "Identifier", value: "max_len_value" },
          args: [{ kind: "Literal", type: "integer", value: maxLen }],
        }],
      }],
    }],
  }];

  const oldSchema = makeSchema(255);
  const newSchema = makeSchema(100);

  const operations = differ.diff(oldSchema, newSchema);

  assertEquals(operations.length, 1);
  assertEquals(operations[0].kind, "AlterType");
  const alterType = operations[0] as Types.AlterTypeOperation;
  const alterProp = alterType.operations[0] as Types.AlterPropertyOperation;
  // Constraint value change = drop old + add new
  const addConstraint = alterProp.changes.find(
    (c: Types.PropertyChange) => c.kind === "AddConstraint",
  );
  const dropConstraint = alterProp.changes.find(
    (c: Types.PropertyChange) => c.kind === "DropConstraint",
  );
  assertEquals(addConstraint?.newValue, "max_len_value(100)");
  assertEquals(dropConstraint?.oldValue, "max_len_value(255)");
});

// ============================================================
// Schema Differ: expression on constraint serialization
// ============================================================

Deno.test("Schema Differ - expression on constraint serialized as expression_on(...)", () => {
  const differ = new SchemaDiffer();

  const schema: Module[] = [{
    name: "default",
    items: [{
      kind: "TypeDeclaration",
      name: { kind: "Identifier", value: "Discount" },
      members: [{
        kind: "PropertyDeclaration",
        name: { kind: "Identifier", value: "percentage" },
        type: {
          kind: "TypeRef",
          name: { kind: "QualifiedName", parts: ["float64"] },
        },
        required: true,
        multi: false,
        constraints: [{
          kind: "Constraint",
          name: { kind: "Identifier", value: "expression" },
          on: {
            kind: "BinaryOp",
            op: "AND",
            left: {
              kind: "BinaryOp",
              op: ">=",
              left: {
                kind: "PathExpression",
                path: ["__subject__"],
              },
              right: { kind: "Literal", type: "integer", value: 0 },
            },
            right: {
              kind: "BinaryOp",
              op: "<=",
              left: {
                kind: "PathExpression",
                path: ["__subject__"],
              },
              right: { kind: "Literal", type: "integer", value: 100 },
            },
          },
        }],
      }],
    }],
  }];

  const operations = differ.diff([], schema);
  const createOp = operations[0] as Types.CreateTypeOperation;
  const constraint = createOp.properties[0].constraints[0];

  // Should be serialized as expression_on(...)
  assertEquals(constraint.startsWith("expression_on("), true);
  assertStringIncludes(constraint, "__subject__");
});

// ============================================================
// DDL: AddConstraint/DropConstraint on AlterProperty
// ============================================================

Deno.test("DDL Generator - AddConstraint generates ALTER TABLE ADD CONSTRAINT", () => {
  const generator = new DDLGenerator();
  const operation: Types.AlterTypeOperation = {
    kind: "AlterType",
    typeName: "User",
    operations: [
      {
        kind: "AlterProperty",
        propertyName: "age",
        changes: [{
          kind: "AddConstraint",
          newValue: "min_value(0)",
        }],
      } as Types.AlterPropertyOperation,
    ],
  };

  const statements = generator.generateDDL([operation]);
  const checkStatements = statements.filter((s) => s.includes("CHECK"));

  assertEquals(checkStatements.length, 1);
  assertStringIncludes(checkStatements[0], "ADD CONSTRAINT");
  assertStringIncludes(checkStatements[0], "CHECK (age >= 0)");
});

Deno.test("DDL Generator - DropConstraint generates ALTER TABLE DROP CONSTRAINT", () => {
  const generator = new DDLGenerator();
  const operation: Types.AlterTypeOperation = {
    kind: "AlterType",
    typeName: "User",
    operations: [
      {
        kind: "AlterProperty",
        propertyName: "age",
        changes: [{
          kind: "DropConstraint",
          oldValue: "min_value(0)",
        }],
      } as Types.AlterPropertyOperation,
    ],
  };

  const statements = generator.generateDDL([operation]);
  const dropStatements = statements.filter((s) => s.includes("DROP CONSTRAINT"));

  assertEquals(dropStatements.length, 1);
  assertStringIncludes(dropStatements[0], "DROP CONSTRAINT IF EXISTS");
  assertStringIncludes(dropStatements[0], "chk_user_age_min_value_0_");
});
