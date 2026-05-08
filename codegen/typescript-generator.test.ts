/**
 * TypeScript Generator tests for Stages 15.1 and 15.2:
 * Correct type casts, edgeqlType on PropertyDef, SQL type backward compat,
 * schema-aware insert/update types, and enum support
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import * as Context from "../compiler/context.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import * as Types from "./types.ts";
import { TypeScriptGenerator } from "./typescript-generator.ts";

/**
 * Helper: create a schema with properties that have edgeqlType set,
 * simulating what modulesToSchema() produces after Stage 15.1.
 */
function createSchemaWithEdgeQLTypes(): Context.Schema {
  const userType: Context.TypeDef = {
    name: "User",
    kind: "object",
    tableName: "users",
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid"
      }],
      ["name", {
        name: "name",
        type: "text",
        required: true,
        multi: false,
        columnName: "name",
        edgeqlType: "str"
      }],
      ["email", {
        name: "email",
        type: "text",
        required: true,
        multi: false,
        columnName: "email",
        edgeqlType: "str"
      }],
      ["age", {
        name: "age",
        type: "integer",
        required: false,
        multi: false,
        columnName: "age",
        edgeqlType: "int32"
      }],
      ["active", {
        name: "active",
        type: "boolean",
        required: false,
        multi: false,
        columnName: "active",
        edgeqlType: "bool"
      }],
      ["createdAt", {
        name: "createdAt",
        type: "timestamptz",
        required: true,
        multi: false,
        columnName: "created_at",
        edgeqlType: "datetime"
      }],
      ["score", {
        name: "score",
        type: "double precision",
        required: false,
        multi: false,
        columnName: "score",
        edgeqlType: "float64"
      }]
    ]),
    links: new Map()
  };

  return {
    types: new Map([["User", userType]]),
    functions: new Map()
  };
}

/**
 * Helper: create a schema WITHOUT edgeqlType set (backward compat scenario),
 * where type field contains EdgeQL type names directly.
 */
function createSchemaWithoutEdgeQLType(): Context.Schema {
  const itemType: Context.TypeDef = {
    name: "Item",
    kind: "object",
    tableName: "items",
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id"
      }],
      ["title", {
        name: "title",
        type: "str",
        required: true,
        multi: false,
        columnName: "title"
      }],
      ["count", {
        name: "count",
        type: "int32",
        required: false,
        multi: false,
        columnName: "count"
      }]
    ]),
    links: new Map()
  };

  return {
    types: new Map([["Item", itemType]]),
    functions: new Map()
  };
}

function createDefaultConfig(): Types.CodegenConfig {
  return {
    outputDir: "./generated",
    schemaSource: "./schema.disc",
    target: "client",
    typePrefix: "",
    interfaceSuffix: "",
    includeQueryBuilders: true,
    includeMutations: true,
    includeClient: false,
    formatOutput: true
  };
}

// --- mapEdgeQLTypeToEdgeQLCast tests ---

Deno.test("TypeScriptGenerator - mapEdgeQLTypeToEdgeQLCast returns correct cast for int32", () => {
  assertEquals(Types.mapEdgeQLTypeToEdgeQLCast("int32"), "<int32>");
});

Deno.test("TypeScriptGenerator - mapEdgeQLTypeToEdgeQLCast returns correct cast for bool", () => {
  assertEquals(Types.mapEdgeQLTypeToEdgeQLCast("bool"), "<bool>");
});

Deno.test("TypeScriptGenerator - mapEdgeQLTypeToEdgeQLCast returns correct cast for datetime", () => {
  assertEquals(Types.mapEdgeQLTypeToEdgeQLCast("datetime"), "<datetime>");
});

Deno.test("TypeScriptGenerator - mapEdgeQLTypeToEdgeQLCast falls back for unknown type", () => {
  assertEquals(Types.mapEdgeQLTypeToEdgeQLCast("custom_type"), "<custom_type>");
});

// --- mapEdgeQLTypeToTypeScript with edgeqlType ---

Deno.test("TypeScriptGenerator - mapEdgeQLTypeToTypeScript works with edgeqlType value", () => {
  // When edgeqlType is "str", it should resolve to "string"
  assertEquals(Types.mapEdgeQLTypeToTypeScript("str", true, false), "string");
  // When edgeqlType is "int32", it should resolve to "number"
  assertEquals(Types.mapEdgeQLTypeToTypeScript("int32", true, false), "number");
  // When edgeqlType is "bool", it should resolve to "boolean"
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("bool", true, false),
    "boolean"
  );
  // When edgeqlType is "datetime", it should resolve to "Date"
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("datetime", true, false),
    "Date"
  );
});

// --- Backward compatibility: SQL type names ---

Deno.test("TypeScriptGenerator - mapEdgeQLTypeToTypeScript backward compat with SQL type names", () => {
  // When type field contains SQL types instead of EdgeQL types
  assertEquals(Types.mapEdgeQLTypeToTypeScript("text", true, false), "string");
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("integer", true, false),
    "number"
  );
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("boolean", true, false),
    "boolean"
  );
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("timestamptz", true, false),
    "Date"
  );
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("timestamp", true, false),
    "Date"
  );
  // "bigint" SQL type maps to "int64" EdgeQL which maps to "bigint" (P1-20:
  // `number` would silently lose precision above 2^53-1).
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("bigint", true, false),
    "bigint"
  );
});

// --- Generated query builder _typeCasts map ---

Deno.test("TypeScriptGenerator - generated query builder has correct _typeCasts map", () => {
  const schema = createSchemaWithEdgeQLTypes();
  const config = createDefaultConfig();
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const queryFile = result.files.find(f => f.type === "queries");
  assertEquals(queryFile !== undefined, true);

  const content = queryFile!.content;

  // Should have _typeCasts with correct casts
  assertStringIncludes(content, "_typeCasts");
  assertStringIncludes(content, "name: \"<str>\"");
  assertStringIncludes(content, "email: \"<str>\"");
  assertStringIncludes(content, "age: \"<int32>\"");
  assertStringIncludes(content, "active: \"<bool>\"");
  assertStringIncludes(content, "createdAt: \"<datetime>\"");
  assertStringIncludes(content, "score: \"<float64>\"");
});

// --- Insert method uses correct casts ---

Deno.test("TypeScriptGenerator - insert method uses _typeCasts lookup", () => {
  const schema = createSchemaWithEdgeQLTypes();
  const config = createDefaultConfig();
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const queryFile = result.files.find(f => f.type === "queries");
  assertEquals(queryFile !== undefined, true);

  const content = queryFile!.content;

  // Insert method should reference _typeCasts instead of hardcoded <str>
  assertStringIncludes(content, "UserQueryBuilder._typeCasts[key]");

  // Should NOT contain hardcoded <str> in insert assignments
  // (The fallback `|| "<str>"` is acceptable but the primary path uses _typeCasts)
  const insertSection = content.substring(
    content.indexOf("async insert("),
    content.indexOf("async update(")
  );
  // Should not have the old pattern `\${key} := <str>$\${key}`
  assertEquals(insertSection.includes(":= <str>$"), false);
});

// --- Update method uses correct casts ---

Deno.test("TypeScriptGenerator - update method uses _typeCasts lookup", () => {
  const schema = createSchemaWithEdgeQLTypes();
  const config = createDefaultConfig();
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const queryFile = result.files.find(f => f.type === "queries");
  assertEquals(queryFile !== undefined, true);

  const content = queryFile!.content;

  // Update method should reference _typeCasts
  const updateSection = content.substring(
    content.indexOf("async update("),
    content.indexOf("async delete(")
  );
  assertStringIncludes(updateSection, "_typeCasts[key]");
  // Should not have the old hardcoded pattern
  assertEquals(updateSection.includes(":= <str>$"), false);
});

// --- Backward compat: missing edgeqlType falls back to type ---

Deno.test("TypeScriptGenerator - missing edgeqlType falls back to type field for casts", () => {
  const schema = createSchemaWithoutEdgeQLType();
  const config = createDefaultConfig();
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const queryFile = result.files.find(f => f.type === "queries");
  assertEquals(queryFile !== undefined, true);

  const content = queryFile!.content;

  // When edgeqlType is undefined, type field ("str", "int32") should be used
  assertStringIncludes(content, "title: \"<str>\"");
  assertStringIncludes(content, "count: \"<int32>\"");
});

// --- Interface generation uses edgeqlType for type mapping ---

Deno.test("TypeScriptGenerator - interface uses edgeqlType for TypeScript type mapping", () => {
  const schema = createSchemaWithEdgeQLTypes();
  const config = createDefaultConfig();
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const typesFile = result.files.find(f => f.type === "types");
  assertEquals(typesFile !== undefined, true);

  const content = typesFile!.content;

  // Properties should map correctly via edgeqlType even though type is SQL
  assertStringIncludes(content, "name: string");
  assertStringIncludes(content, "email: string");
  assertStringIncludes(content, "age?: number");
  assertStringIncludes(content, "active?: boolean");
  assertStringIncludes(content, "createdAt: Date");
  assertStringIncludes(content, "score?: number");
});

// --- Stage 15.2 tests: schema-aware insert/update types and enum support ---

/**
 * Helper: create a schema with property metadata for insert/update type tests.
 */
function createSchemaWithMetadata(): Context.Schema {
  const userType: Context.TypeDef = {
    name: "User",
    kind: "object",
    tableName: "users",
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid"
      }],
      ["email", {
        name: "email",
        type: "text",
        required: true,
        multi: false,
        columnName: "email",
        edgeqlType: "str"
      }],
      ["name", {
        name: "name",
        type: "text",
        required: true,
        multi: false,
        columnName: "name",
        edgeqlType: "str"
      }],
      ["age", {
        name: "age",
        type: "integer",
        required: false,
        multi: false,
        columnName: "age",
        edgeqlType: "int32"
      }],
      ["createdAt", {
        name: "createdAt",
        type: "timestamptz",
        required: true,
        multi: false,
        columnName: "created_at",
        edgeqlType: "datetime",
        readonly: true,
        hasDefault: true
      }],
      ["updatedAt", {
        name: "updatedAt",
        type: "timestamptz",
        required: true,
        multi: false,
        columnName: "updated_at",
        edgeqlType: "datetime",
        hasDefault: true
      }],
      ["displayName", {
        name: "displayName",
        type: "text",
        required: false,
        multi: false,
        columnName: "display_name",
        edgeqlType: "str",
        computed: true
      }],
      ["loginCount", {
        name: "loginCount",
        type: "integer",
        required: true,
        multi: false,
        columnName: "login_count",
        edgeqlType: "int32",
        readonly: true
      }]
    ]),
    links: new Map()
  };

  return {
    types: new Map([["User", userType]]),
    functions: new Map()
  };
}

/**
 * Helper: create a schema with an enum type for enum generation tests.
 */
function createSchemaWithEnum(): Context.Schema {
  const statusType: Context.TypeDef = {
    name: "Status",
    kind: "enum",
    tableName: "status",
    properties: new Map(),
    links: new Map(),
    enumValues: ["active", "inactive", "pending"]
  };

  const userType: Context.TypeDef = {
    name: "User",
    kind: "object",
    tableName: "users",
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid"
      }],
      ["name", {
        name: "name",
        type: "text",
        required: true,
        multi: false,
        columnName: "name",
        edgeqlType: "str"
      }]
    ]),
    links: new Map()
  };

  return {
    types: new Map([
      ["Status", statusType],
      ["User", userType]
    ]),
    functions: new Map()
  };
}

// --- Insert type tests ---

Deno.test("TypeScriptGenerator - UserInsert requires email and name (no ?)", () => {
  const schema = createSchemaWithMetadata();
  const config = createDefaultConfig();
  config.includeQueryBuilders = false;
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const typesFile = result.files.find(f => f.type === "types");
  assertEquals(typesFile !== undefined, true);

  const content = typesFile!.content;

  // Extract the UserInsert interface content
  const insertStart = content.indexOf("export interface UserInsert");
  const insertEnd = content.indexOf("}", insertStart);
  const insertBlock = content.substring(insertStart, insertEnd + 1);

  // email and name should be required (no ?)
  assertStringIncludes(insertBlock, "email: string;");
  assertStringIncludes(insertBlock, "name: string;");
  // Verify they are NOT optional
  assertEquals(insertBlock.includes("email?: string"), false);
  assertEquals(insertBlock.includes("name?: string"), false);
});

Deno.test("TypeScriptGenerator - UserInsert makes createdAt optional when it has default", () => {
  const schema = createSchemaWithMetadata();
  const config = createDefaultConfig();
  config.includeQueryBuilders = false;
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const typesFile = result.files.find(f => f.type === "types");
  assertEquals(typesFile !== undefined, true);

  const content = typesFile!.content;

  // createdAt is readonly && hasDefault, so it should be excluded from Insert
  const insertStart = content.indexOf("export interface UserInsert");
  const insertEnd = content.indexOf("}", insertStart);
  const insertBlock = content.substring(insertStart, insertEnd + 1);
  assertEquals(insertBlock.includes("createdAt"), false);

  // updatedAt has default but is NOT readonly, so it should be optional in insert
  assertStringIncludes(insertBlock, "updatedAt?: Date;");
});

Deno.test("TypeScriptGenerator - UserInsert excludes id", () => {
  const schema = createSchemaWithMetadata();
  const config = createDefaultConfig();
  config.includeQueryBuilders = false;
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const typesFile = result.files.find(f => f.type === "types");
  assertEquals(typesFile !== undefined, true);

  const content = typesFile!.content;

  // Extract the UserInsert block
  const insertStart = content.indexOf("export interface UserInsert");
  const insertEnd = content.indexOf("}", insertStart);
  const insertBlock = content.substring(insertStart, insertEnd + 1);

  // id should not appear in Insert type
  assertEquals(insertBlock.includes("id:"), false);
  assertEquals(insertBlock.includes("id?:"), false);
});

// --- Update type tests ---

Deno.test("TypeScriptGenerator - UserUpdate excludes readonly properties", () => {
  const schema = createSchemaWithMetadata();
  const config = createDefaultConfig();
  config.includeQueryBuilders = false;
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const typesFile = result.files.find(f => f.type === "types");
  assertEquals(typesFile !== undefined, true);

  const content = typesFile!.content;

  // Extract the UserUpdate block
  const updateStart = content.indexOf("export interface UserUpdate");
  const updateEnd = content.indexOf("}", updateStart);
  const updateBlock = content.substring(updateStart, updateEnd + 1);

  // readonly properties should be excluded
  assertEquals(updateBlock.includes("createdAt"), false);
  assertEquals(updateBlock.includes("loginCount"), false);

  // computed properties should be excluded
  assertEquals(updateBlock.includes("displayName"), false);

  // id should be excluded
  assertEquals(updateBlock.includes("id:"), false);
});

Deno.test("TypeScriptGenerator - UserUpdate makes all fields optional", () => {
  const schema = createSchemaWithMetadata();
  const config = createDefaultConfig();
  config.includeQueryBuilders = false;
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const typesFile = result.files.find(f => f.type === "types");
  assertEquals(typesFile !== undefined, true);

  const content = typesFile!.content;

  // Extract the UserUpdate block
  const updateStart = content.indexOf("export interface UserUpdate");
  const updateEnd = content.indexOf("}", updateStart);
  const updateBlock = content.substring(updateStart, updateEnd + 1);

  // All remaining fields should be optional
  assertStringIncludes(updateBlock, "email?: string;");
  assertStringIncludes(updateBlock, "name?: string;");
  assertStringIncludes(updateBlock, "age?: number;");
  assertStringIncludes(updateBlock, "updatedAt?: Date;");
});

// --- Enum type tests ---

Deno.test("TypeScriptGenerator - enum type generates union type string", () => {
  const schema = createSchemaWithEnum();
  const config = createDefaultConfig();
  config.includeQueryBuilders = false;
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const typesFile = result.files.find(f => f.type === "types");
  assertEquals(typesFile !== undefined, true);

  const content = typesFile!.content;

  // Should generate a union type for the enum
  assertStringIncludes(
    content,
    "export type Status = \"active\" | \"inactive\" | \"pending\";"
  );

  // Should NOT generate an interface for the enum type
  assertEquals(content.includes("export interface Status"), false);

  // Should NOT generate Insert/Update types for enum
  assertEquals(content.includes("StatusInsert"), false);
  assertEquals(content.includes("StatusUpdate"), false);
});

// --- Query builder signature tests ---

Deno.test("TypeScriptGenerator - query builder insert method uses ${Type}Insert parameter type", () => {
  const schema = createSchemaWithMetadata();
  const config = createDefaultConfig();
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const queryFile = result.files.find(f => f.type === "queries");
  assertEquals(queryFile !== undefined, true);

  const content = queryFile!.content;

  // Insert method should use UserInsert type
  assertStringIncludes(content, "async insert(data: Types.UserInsert)");
  // Should NOT use old generic Partial<Omit<...>> pattern
  assertEquals(content.includes("Partial<Omit<"), false);
});

Deno.test("TypeScriptGenerator - query builder update method uses ${Type}Update parameter type", () => {
  const schema = createSchemaWithMetadata();
  const config = createDefaultConfig();
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const queryFile = result.files.find(f => f.type === "queries");
  assertEquals(queryFile !== undefined, true);

  const content = queryFile!.content;

  // Update method should use UserUpdate type
  assertStringIncludes(content, "data: Types.UserUpdate)");
  // Should NOT use old generic Partial<Omit<...>> pattern
  assertEquals(content.includes("Partial<Omit<"), false);
});

// --- Stage 15.3 tests: FilterVars type generation and typed filter/count signatures ---

Deno.test("TypeScriptGenerator - UserFilterVars is generated with correct optional properties", () => {
  const schema = createSchemaWithEdgeQLTypes();
  const config = createDefaultConfig();
  config.includeQueryBuilders = false;
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const typesFile = result.files.find(f => f.type === "types");
  assertEquals(typesFile !== undefined, true);

  const content = typesFile!.content;

  // Extract the UserFilterVars interface
  const filterStart = content.indexOf("export interface UserFilterVars");
  assertEquals(filterStart !== -1, true);
  const filterEnd = content.indexOf("}", filterStart);
  const filterBlock = content.substring(filterStart, filterEnd + 1);

  // All properties should be optional
  assertStringIncludes(filterBlock, "id?: string;");
  assertStringIncludes(filterBlock, "email?: string;");
  assertStringIncludes(filterBlock, "name?: string;");
  assertStringIncludes(filterBlock, "age?: number;");
  assertStringIncludes(filterBlock, "active?: boolean;");
  assertStringIncludes(filterBlock, "createdAt?: Date;");
  assertStringIncludes(filterBlock, "score?: number;");
});

Deno.test("TypeScriptGenerator - FilterVars includes index signature for flexibility", () => {
  const schema = createSchemaWithEdgeQLTypes();
  const config = createDefaultConfig();
  config.includeQueryBuilders = false;
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const typesFile = result.files.find(f => f.type === "types");
  assertEquals(typesFile !== undefined, true);

  const content = typesFile!.content;

  // Extract the UserFilterVars interface
  const filterStart = content.indexOf("export interface UserFilterVars");
  assertEquals(filterStart !== -1, true);
  const filterEnd = content.indexOf("}", filterStart);
  const filterBlock = content.substring(filterStart, filterEnd + 1);

  // Should include index signature
  assertStringIncludes(filterBlock, "[key: string]: unknown;");
});

// (Old test asserted the string-based `filter(condition, variables, shape)`
// signature with `Types.UserFilterVars`. Stage C replaces that with the
// object-shaped `filter(FilterArg<XFilter>)` API; new assertions below.)

Deno.test("TypeScriptGenerator - count method uses Types.${Type}FilterVars parameter type", () => {
  const schema = createSchemaWithEdgeQLTypes();
  const config = createDefaultConfig();
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const queryFile = result.files.find(f => f.type === "queries");
  assertEquals(queryFile !== undefined, true);

  const content = queryFile!.content;

  // Count method should use UserFilterVars type
  const countSection = content.substring(
    content.indexOf("async count("),
    content.indexOf("}\n", content.indexOf("async count("))
  );
  assertStringIncludes(countSection, "variables?: Types.UserFilterVars");
  // Should NOT use old generic Record<string, any> pattern in count
  assertEquals(countSection.includes("Record<string, any>"), false);
});

Deno.test("TypeScriptGenerator - enum types do not generate FilterVars", () => {
  const schema = createSchemaWithEnum();
  const config = createDefaultConfig();
  config.includeQueryBuilders = false;
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const typesFile = result.files.find(f => f.type === "types");
  assertEquals(typesFile !== undefined, true);

  const content = typesFile!.content;

  // Enum types should NOT generate FilterVars
  assertEquals(content.includes("StatusFilterVars"), false);

  // Object types should still generate FilterVars
  assertStringIncludes(content, "export interface UserFilterVars");
});

// --- Stage 15.4 tests: Constraint-aware codegen with JSDoc output ---

/**
 * Helper: create a schema with property constraints for JSDoc generation tests.
 */
function createSchemaWithConstraints(): Context.Schema {
  const userType: Context.TypeDef = {
    name: "User",
    kind: "object",
    tableName: "users",
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid"
      }],
      ["email", {
        name: "email",
        type: "text",
        required: true,
        multi: false,
        columnName: "email",
        edgeqlType: "str",
        constraints: [{ name: "exclusive" }]
      }],
      ["name", {
        name: "name",
        type: "text",
        required: true,
        multi: false,
        columnName: "name",
        edgeqlType: "str",
        constraints: [
          { name: "max_length", args: ["100"] },
          { name: "min_length", args: ["1"] }
        ]
      }],
      ["bio", {
        name: "bio",
        type: "text",
        required: false,
        multi: false,
        columnName: "bio",
        edgeqlType: "str"
      }],
      ["createdAt", {
        name: "createdAt",
        type: "timestamptz",
        required: true,
        multi: false,
        columnName: "created_at",
        edgeqlType: "datetime",
        readonly: true,
        hasDefault: true
      }]
    ]),
    links: new Map()
  };

  return {
    types: new Map([["User", userType]]),
    functions: new Map()
  };
}

Deno.test("TypeScriptGenerator - exclusive constraint appears in JSDoc as @constraint exclusive", () => {
  const schema = createSchemaWithConstraints();
  const config = createDefaultConfig();
  config.includeQueryBuilders = false;
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const typesFile = result.files.find(f => f.type === "types");
  assertEquals(typesFile !== undefined, true);

  const content = typesFile!.content;

  // email should have @constraint exclusive in its JSDoc
  assertStringIncludes(content, "@constraint exclusive");
});

Deno.test("TypeScriptGenerator - constraint with args formats as @constraint name(args)", () => {
  const schema = createSchemaWithConstraints();
  const config = createDefaultConfig();
  config.includeQueryBuilders = false;
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const typesFile = result.files.find(f => f.type === "types");
  assertEquals(typesFile !== undefined, true);

  const content = typesFile!.content;

  // name should have @constraint max_length(100) and @constraint min_length(1)
  assertStringIncludes(content, "@constraint max_length(100)");
  assertStringIncludes(content, "@constraint min_length(1)");
});

Deno.test("TypeScriptGenerator - properties without constraints have clean single-line JSDoc", () => {
  const schema = createSchemaWithConstraints();
  const config = createDefaultConfig();
  config.includeQueryBuilders = false;
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const typesFile = result.files.find(f => f.type === "types");
  assertEquals(typesFile !== undefined, true);

  const content = typesFile!.content;

  // bio has no constraints, readonly, or hasDefault — should use single-line JSDoc
  // Find the JSDoc for bio: should be `/** str */` on a single line
  const bioJsdocIndex = content.indexOf("/** str */");
  assertEquals(bioJsdocIndex !== -1, true);

  // The line after bio's JSDoc should be the property declaration
  const bioLine = content.indexOf("bio?:", bioJsdocIndex);
  assertEquals(bioLine !== -1, true);

  // bio should NOT have a multi-line JSDoc block
  // Check there's no `@constraint` near bio
  const bioSection = content.substring(bioJsdocIndex, bioLine);
  assertEquals(bioSection.includes("@constraint"), false);
});

Deno.test("TypeScriptGenerator - readonly and hasDefault metadata appears in JSDoc", () => {
  const schema = createSchemaWithConstraints();
  const config = createDefaultConfig();
  config.includeQueryBuilders = false;
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const typesFile = result.files.find(f => f.type === "types");
  assertEquals(typesFile !== undefined, true);

  const content = typesFile!.content;

  // createdAt has readonly: true and hasDefault: true
  // Find the JSDoc block for createdAt
  const createdAtJsdocStart = content.indexOf("* datetime (required)");
  assertEquals(createdAtJsdocStart !== -1, true);

  // Should contain @readonly and @default tags
  const createdAtSection = content.substring(
    createdAtJsdocStart,
    content.indexOf("createdAt:", createdAtJsdocStart)
  );
  assertStringIncludes(createdAtSection, "@readonly");
  assertStringIncludes(createdAtSection, "@default");
});

// --- Stage A: Filter / Select / operator-helper type generation ---
//
// New object-shaped filter API: scalar fields take a bare value (equality)
// or an operator object; links recurse to the target type's Filter; reserved
// keys (`select`, `order_by`, `limit`, `offset`) shape the query.

/**
 * Helper: schema with one type that has a link, for testing link recursion
 * in the generated Filter interface.
 */
function createSchemaWithLink(): Context.Schema {
  const merchantType: Context.TypeDef = {
    name: "Merchant",
    kind: "object",
    tableName: "merchants",
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid"
      }],
      ["email", {
        name: "email",
        type: "text",
        required: true,
        multi: false,
        columnName: "email",
        edgeqlType: "str"
      }]
    ]),
    links: new Map()
  };

  const paymentType: Context.TypeDef = {
    name: "Payment",
    kind: "object",
    tableName: "payments",
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid"
      }],
      ["amount", {
        name: "amount",
        type: "double precision",
        required: true,
        multi: false,
        columnName: "amount",
        edgeqlType: "float64"
      }]
    ]),
    links: new Map([
      ["merchant", {
        name: "merchant",
        target: "Merchant",
        required: true,
        multi: false,
        columnName: "merchant_id"
      }]
    ])
  };

  return {
    types: new Map([
      ["Merchant", merchantType],
      ["Payment", paymentType]
    ]),
    functions: new Map()
  };
}

Deno.test("Stage A — operator helper types Op<T>, OrdOp<T>, StrOp emitted once", () => {
  const schema = createSchemaWithEdgeQLTypes();
  const config = createDefaultConfig();
  config.includeQueryBuilders = false;
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const typesFile = result.files.find(f => f.type === "types");
  const content = typesFile!.content;

  // Equality + set ops, available on every scalar type
  assertStringIncludes(content, "export interface Op<T>");
  assertStringIncludes(content, "eq?: T");
  assertStringIncludes(content, "ne?: T");
  assertStringIncludes(content, "in?: T[]");
  assertStringIncludes(content, "not_in?: T[]");

  // Ordered ops, for numbers and dates
  assertStringIncludes(content, "export interface OrdOp<T>");
  assertStringIncludes(content, "gt?: T");
  assertStringIncludes(content, "gte?: T");
  assertStringIncludes(content, "lt?: T");
  assertStringIncludes(content, "lte?: T");

  // String-only ops
  assertStringIncludes(content, "export interface StrOp");
  assertStringIncludes(content, "like?: string");
  assertStringIncludes(content, "ilike?: string");

  // Each helper emitted exactly once
  assertEquals(content.match(/export interface Op</g)?.length, 1);
  assertEquals(content.match(/export interface OrdOp</g)?.length, 1);
  assertEquals(content.match(/export interface StrOp/g)?.length, 1);
});

Deno.test("Stage A — UserFilter has scalar+operator union per field", () => {
  const schema = createSchemaWithEdgeQLTypes();
  const config = createDefaultConfig();
  config.includeQueryBuilders = false;
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const typesFile = result.files.find(f => f.type === "types");
  const content = typesFile!.content;

  const filterStart = content.indexOf("export interface UserFilter ");
  assertEquals(filterStart !== -1, true);
  const filterEnd = content.indexOf("\n}", filterStart);
  const filterBlock = content.substring(filterStart, filterEnd + 2);

  // str → string | StrOp
  assertStringIncludes(filterBlock, "email?: string | StrOp");
  assertStringIncludes(filterBlock, "name?: string | StrOp");
  // int32 / float64 → number | OrdOp<number>
  assertStringIncludes(filterBlock, "age?: number | OrdOp<number>");
  assertStringIncludes(filterBlock, "score?: number | OrdOp<number>");
  // bool → boolean | Op<boolean>
  assertStringIncludes(filterBlock, "active?: boolean | Op<boolean>");
  // datetime → Date | OrdOp<Date>
  assertStringIncludes(filterBlock, "createdAt?: Date | OrdOp<Date>");
});

Deno.test("Stage A — UserFilter has reserved keys select/order_by/limit/offset", () => {
  const schema = createSchemaWithEdgeQLTypes();
  const config = createDefaultConfig();
  config.includeQueryBuilders = false;
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const typesFile = result.files.find(f => f.type === "types");
  const content = typesFile!.content;

  const filterStart = content.indexOf("export interface UserFilter ");
  const filterEnd = content.indexOf("\n}", filterStart);
  const filterBlock = content.substring(filterStart, filterEnd + 2);

  assertStringIncludes(filterBlock, "select?: UserSelect");
  assertStringIncludes(filterBlock, "order_by?: string | string[]");
  assertStringIncludes(filterBlock, "limit?: number");
  assertStringIncludes(filterBlock, "offset?: number");
});

Deno.test("Stage A — UserSelect has boolean per scalar field", () => {
  const schema = createSchemaWithEdgeQLTypes();
  const config = createDefaultConfig();
  config.includeQueryBuilders = false;
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const typesFile = result.files.find(f => f.type === "types");
  const content = typesFile!.content;

  const selectStart = content.indexOf("export interface UserSelect ");
  assertEquals(selectStart !== -1, true);
  const selectEnd = content.indexOf("\n}", selectStart);
  const selectBlock = content.substring(selectStart, selectEnd + 2);

  assertStringIncludes(selectBlock, "id?: boolean");
  assertStringIncludes(selectBlock, "email?: boolean");
  assertStringIncludes(selectBlock, "name?: boolean");
  assertStringIncludes(selectBlock, "age?: boolean");
});

Deno.test("Stage A — Filter recurses into linked types", () => {
  const schema = createSchemaWithLink();
  const config = createDefaultConfig();
  config.includeQueryBuilders = false;
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const typesFile = result.files.find(f => f.type === "types");
  const content = typesFile!.content;

  const filterStart = content.indexOf("export interface PaymentFilter ");
  assertEquals(filterStart !== -1, true);
  const filterEnd = content.indexOf("\n}", filterStart);
  const filterBlock = content.substring(filterStart, filterEnd + 2);

  // Link field uses the target's Filter type (no `_id` shorthand)
  assertStringIncludes(filterBlock, "merchant?: MerchantFilter");
  // Scalar still works
  assertStringIncludes(filterBlock, "amount?: number | OrdOp<number>");
});

Deno.test("Stage A — Select recurses into linked types as boolean | TargetSelect", () => {
  const schema = createSchemaWithLink();
  const config = createDefaultConfig();
  config.includeQueryBuilders = false;
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const typesFile = result.files.find(f => f.type === "types");
  const content = typesFile!.content;

  const selectStart = content.indexOf("export interface PaymentSelect ");
  assertEquals(selectStart !== -1, true);
  const selectEnd = content.indexOf("\n}", selectStart);
  const selectBlock = content.substring(selectStart, selectEnd + 2);

  // Link in Select: true to pull all fields, or a nested Select to narrow
  assertStringIncludes(selectBlock, "merchant?: boolean | MerchantSelect");
});

// --- Stage B: client.ts re-exports the SDK combinators ---

Deno.test("Stage B — generated client.ts re-exports and/or/not from the SDK", () => {
  const schema = createSchemaWithEdgeQLTypes();
  const config = createDefaultConfig();
  config.includeClient = true;
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const clientFile = result.files.find(f => f.type === "client");
  assertEquals(clientFile !== undefined, true);
  const content = clientFile!.content;

  // Combinators alongside AuthManager / SubscriptionClient on the SDK re-export line
  assertStringIncludes(content, "export { and, AuthManager, not, or, SubscriptionClient }");
});

Deno.test("Stage B — generated index.ts re-exports combinators via client.ts", () => {
  const schema = createSchemaWithEdgeQLTypes();
  const config = createDefaultConfig();
  config.includeClient = true;
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const indexFile = result.files.find(f => f.type === "index");
  assertEquals(indexFile !== undefined, true);
  const content = indexFile!.content;

  assertStringIncludes(content, "export { and, AuthManager, not, or, SubscriptionClient } from \"./client.ts\"");
});

// --- Stage C: filter() method uses compileFilter at runtime ---

Deno.test("Stage C — generated queries.ts imports compileFilter + FilterArg + TypeInfo from the SDK", () => {
  const schema = createSchemaWithEdgeQLTypes();
  const config = createDefaultConfig();
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const queryFile = result.files.find(f => f.type === "queries");
  const content = queryFile!.content;

  assertStringIncludes(
    content,
    "import { compileFilter, type FilterArg, type TypeInfo }"
  );
});

Deno.test("Stage C — each builder declares a static _typeInfo with casts + link thunks", () => {
  const schema = createSchemaWithLink();
  const config = createDefaultConfig();
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const queryFile = result.files.find(f => f.type === "queries");
  const content = queryFile!.content;

  // PaymentQueryBuilder._typeInfo must include casts (incl. id) and a thunk for `merchant`
  const start = content.indexOf("class PaymentQueryBuilder");
  const end = content.indexOf("constructor(", start);
  const classHead = content.substring(start, end);

  assertStringIncludes(classHead, "static readonly _typeInfo: TypeInfo");
  assertStringIncludes(classHead, "casts: {");
  assertStringIncludes(classHead, "id: \"<uuid>\"");
  assertStringIncludes(classHead, "amount: \"<float64>\"");
  assertStringIncludes(classHead, "links: {");
  assertStringIncludes(
    classHead,
    "merchant: () => MerchantQueryBuilder._typeInfo"
  );
});

Deno.test("typeInfo link thunks strip module-qualified target prefix", () => {
  // Regression: link.target arriving as "default::Merchant" used to be emitted
  // verbatim, producing `() => default::MerchantQueryBuilder._typeInfo` —
  // invalid TS that breaks the generated queries.ts at parse time.
  const merchantType: Context.TypeDef = {
    name: "Merchant",
    kind: "object",
    tableName: "merchants",
    properties: new Map([
      ["id", { name: "id", type: "uuid", required: true, multi: false, columnName: "id", edgeqlType: "uuid" }]
    ]),
    links: new Map()
  };
  const paymentType: Context.TypeDef = {
    name: "Payment",
    kind: "object",
    tableName: "payments",
    properties: new Map([
      ["id", { name: "id", type: "uuid", required: true, multi: false, columnName: "id", edgeqlType: "uuid" }]
    ]),
    links: new Map([
      ["merchant", {
        name: "merchant",
        target: "default::Merchant",
        required: true,
        multi: false,
        columnName: "merchant_id"
      }]
    ])
  };
  const schema: Context.Schema = {
    types: new Map([["Merchant", merchantType], ["Payment", paymentType]]),
    functions: new Map()
  };

  const generator = new TypeScriptGenerator(schema, createDefaultConfig());
  const result = generator.generate();
  const content = result.files.find(f => f.type === "queries")!.content;

  assertStringIncludes(content, "merchant: () => MerchantQueryBuilder._typeInfo");
  assertEquals(content.includes("default::MerchantQueryBuilder"), false);
  assertEquals(content.includes("::"), false);
});

Deno.test("client.ts constructor uses bare type names for multi-module schemas", () => {
  // Regression: the constructor used to iterate this.schema.types and use the
  // map key (e.g. "api::ApiKey") as both property and builder identifier,
  // producing `this.api::apikey = new Queries.api::ApiKeyQueryBuilder(this)`.
  // Both halves are invalid TS — broke client.ts at parse time.
  const merchantType: Context.TypeDef = {
    name: "Merchant",
    kind: "object",
    tableName: "merchants",
    module: "default",
    properties: new Map([
      ["id", { name: "id", type: "uuid", required: true, multi: false, columnName: "id", edgeqlType: "uuid" }]
    ]),
    links: new Map()
  };
  const apiKeyType: Context.TypeDef = {
    name: "ApiKey",
    kind: "object",
    tableName: "api_keys",
    module: "api",
    properties: new Map([
      ["id", { name: "id", type: "uuid", required: true, multi: false, columnName: "id", edgeqlType: "uuid" }]
    ]),
    links: new Map()
  };
  const schema: Context.Schema = {
    types: new Map([
      ["Merchant", merchantType],
      ["api::ApiKey", apiKeyType]
    ]),
    functions: new Map()
  };

  const config = createDefaultConfig();
  config.includeClient = true;
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();
  const clientFile = result.files.find(f => f.type === "client");
  const content = clientFile!.content;

  // Bare property assignment + bare builder reference
  assertStringIncludes(content, "this.merchant = new Queries.MerchantQueryBuilder(this)");
  assertStringIncludes(content, "this.apikey = new Queries.ApiKeyQueryBuilder(this)");
  // No "::" should leak anywhere in the emitted client
  assertEquals(content.includes("::"), false);
});

Deno.test("Stage C — filter() takes FilterArg<XFilter> and delegates to compileFilter", () => {
  const schema = createSchemaWithLink();
  const config = createDefaultConfig();
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const queryFile = result.files.find(f => f.type === "queries");
  const content = queryFile!.content;

  const filterStart = content.indexOf(
    "async filter(",
    content.indexOf("class PaymentQueryBuilder")
  );
  const filterEnd = content.indexOf("async insert(", filterStart);
  const filterBody = content.substring(filterStart, filterEnd);

  // New signature
  assertStringIncludes(filterBody, "filter: FilterArg<Types.PaymentFilter>");
  // Delegates to the SDK compiler with the right type name + _typeInfo
  assertStringIncludes(
    filterBody,
    "compileFilter(\"Payment\", filter, PaymentQueryBuilder._typeInfo)"
  );
  // No vestiges of the old string-based signature
  assertEquals(filterBody.includes("condition: string"), false);
  assertEquals(filterBody.includes("FilterVars"), false);
});

// --- Stage D: assembly of select/order_by/limit/offset in generated filter() ---

Deno.test("Stage D — generated filter() assembles selectShape / orderBy / limit / offset clauses", () => {
  const schema = createSchemaWithLink();
  const config = createDefaultConfig();
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const queryFile = result.files.find(f => f.type === "queries");
  const content = queryFile!.content;

  const filterStart = content.indexOf(
    "async filter(",
    content.indexOf("class PaymentQueryBuilder")
  );
  const filterEnd = content.indexOf("async insert(", filterStart);
  const body = content.substring(filterStart, filterEnd);

  // Falls back to `{ * }` when no select narrowing
  assertStringIncludes(body, "compiled.selectShape ?? \"{ * }\"");
  // Conditionally appends each piece in canonical EdgeQL order
  assertStringIncludes(body, "if (compiled.clause) parts.push(`filter ${compiled.clause}`)");
  assertStringIncludes(body, "if (compiled.orderBy) parts.push(compiled.orderBy)");
  assertStringIncludes(body, "if (compiled.limit !== null) parts.push(`limit ${compiled.limit}`)");
  assertStringIncludes(body, "if (compiled.offset !== null) parts.push(`offset ${compiled.offset}`)");
});

// --- Regression tests: codegen output must be valid TS ---

Deno.test("interface declares `id` exactly once", () => {
  // Regression: schema-manager seeds every type with an implicit `id`
  // PropertyDef AND the generator hardcoded an `id: string;` line, so every
  // generated interface had two `id: string;` declarations — TS rejects with
  // TS2300 (duplicate identifier) the moment the consumer turns on strict.
  const schema = createSchemaWithEdgeQLTypes();
  const generator = new TypeScriptGenerator(schema, createDefaultConfig());
  const result = generator.generate();
  const types = result.files.find(f => f.type === "types")!;

  const userInterfaceStart = types.content.indexOf("export interface User {");
  const userInterfaceEnd = types.content.indexOf("}", userInterfaceStart);
  const userBody = types.content.substring(userInterfaceStart, userInterfaceEnd);

  const idMatches = userBody.match(/\bid:\s*string;/g) ?? [];
  assertEquals(idMatches.length, 1, "User interface should declare id exactly once");
});

Deno.test("computed properties surface as `unknown`, not the parser's `auto` placeholder", () => {
  // Regression: `name := expr` parses with type `auto` (parser.ts:511 — the
  // placeholder for "infer later"). That keyword used to flow through the
  // type-mapping fallback and land in the emitted TS as an invalid literal:
  //   fullName?: auto | null;       // not a TS type
  //   fullName?: auto | Op<auto>;   // invalid generic argument
  // and into the runtime cast map:
  //   fullName: "<auto>"            // not valid EdgeQL
  const computedType: Context.TypeDef = {
    name: "User",
    kind: "object",
    tableName: "users",
    properties: new Map([
      ["id", { name: "id", type: "uuid", required: true, multi: false, columnName: "id", edgeqlType: "uuid" }],
      ["name", { name: "name", type: "text", required: true, multi: false, columnName: "name", edgeqlType: "str" }],
      ["fullName", { name: "fullName", type: "text", required: false, multi: false, columnName: "full_name", edgeqlType: "auto", computed: true }]
    ]),
    links: new Map()
  };
  const schema: Context.Schema = {
    types: new Map([["User", computedType]]),
    functions: new Map()
  };

  const generator = new TypeScriptGenerator(schema, createDefaultConfig());
  const result = generator.generate();
  const typesContent = result.files.find(f => f.type === "types")!.content;
  const queriesContent = result.files.find(f => f.type === "queries")!.content;

  // Computed surfaces as unknown in the interface…
  assertStringIncludes(typesContent, "fullName?: unknown");
  // …and in FilterVars/Filter…
  assertEquals(typesContent.includes("auto"), false, "no `auto` literal anywhere in the types file");
  // …and is omitted from the runtime cast maps (no `<auto>` in queries.ts).
  assertEquals(queriesContent.includes("fullName: \"<auto>\""), false);
  assertEquals(queriesContent.includes("<auto>"), false);
});

Deno.test("colon-form property targeting an object type is reclassified as a link", () => {
  // Regression: `user: default::User` parses as a PropertyDeclaration but is
  // semantically a link. Without reclassification the generator emitted
  // `user: default::User` verbatim into TS — `::` is a parse error — and the
  // runtime cast map carried `<default::User>` which would have failed at
  // query time too. Mirrors the arrow-shorthand reclassification but in the
  // inverse direction (object target instead of scalar target).
  const sm = new SchemaManager({});
  const sdl = `
    module default {
      type User { required name: str; }
    }
    module api {
      type ApiKey {
        required token: str;
        required user: default::User;
      }
    }
  `;
  const parsed = sm.parseSDL(sdl);
  if (!parsed.ok) throw parsed.error;
  const schema = sm.modulesToSchema(parsed.value);

  const apiKey = schema.types.get("api::ApiKey")!;
  // `user` should land in the links map, NOT the properties map.
  assertEquals(apiKey.properties.has("user"), false, "user should not be a property");
  assertEquals(apiKey.links.has("user"), true, "user should be a link");
  assertEquals(apiKey.links.get("user")!.target, "default::User");

  // And the resulting codegen must be `::`-free in the output identifiers.
  const config = createDefaultConfig();
  config.includeClient = true;
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();
  const interfaces = result.files.find(f => f.type === "interfaces")!.content;

  // Cross-module link surfaces via the namespace alias, not the raw qualifier.
  assertStringIncludes(interfaces, "user: $default.User");
  // No `::` in TS code (strip JSDoc comments, where the qualified name is
  // intentionally retained for human readability).
  const codeOnly = interfaces.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assertEquals(/[A-Za-z_]+::[A-Za-z_]+/.test(codeOnly), false, "no module-qualified identifiers leak into TS code");
});
