/**
 * TypeScript Generator tests for Stages 15.1 and 15.2:
 * Correct type casts, edgeqlType on PropertyDef, SQL type backward compat,
 * schema-aware insert/update types, and enum support
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import * as Context from "../compiler/context.ts";
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
        edgeqlType: "uuid",
      }],
      ["name", {
        name: "name",
        type: "text",
        required: true,
        multi: false,
        columnName: "name",
        edgeqlType: "str",
      }],
      ["email", {
        name: "email",
        type: "text",
        required: true,
        multi: false,
        columnName: "email",
        edgeqlType: "str",
      }],
      ["age", {
        name: "age",
        type: "integer",
        required: false,
        multi: false,
        columnName: "age",
        edgeqlType: "int32",
      }],
      ["active", {
        name: "active",
        type: "boolean",
        required: false,
        multi: false,
        columnName: "active",
        edgeqlType: "bool",
      }],
      ["createdAt", {
        name: "createdAt",
        type: "timestamptz",
        required: true,
        multi: false,
        columnName: "created_at",
        edgeqlType: "datetime",
      }],
      ["score", {
        name: "score",
        type: "double precision",
        required: false,
        multi: false,
        columnName: "score",
        edgeqlType: "float64",
      }],
    ]),
    links: new Map(),
  };

  return {
    types: new Map([["User", userType]]),
    functions: new Map(),
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
        columnName: "id",
      }],
      ["title", {
        name: "title",
        type: "str",
        required: true,
        multi: false,
        columnName: "title",
      }],
      ["count", {
        name: "count",
        type: "int32",
        required: false,
        multi: false,
        columnName: "count",
      }],
    ]),
    links: new Map(),
  };

  return {
    types: new Map([["Item", itemType]]),
    functions: new Map(),
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
    formatOutput: true,
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
    "boolean",
  );
  // When edgeqlType is "datetime", it should resolve to "Date"
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("datetime", true, false),
    "Date",
  );
});

// --- Backward compatibility: SQL type names ---

Deno.test("TypeScriptGenerator - mapEdgeQLTypeToTypeScript backward compat with SQL type names", () => {
  // When type field contains SQL types instead of EdgeQL types
  assertEquals(Types.mapEdgeQLTypeToTypeScript("text", true, false), "string");
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("integer", true, false),
    "number",
  );
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("boolean", true, false),
    "boolean",
  );
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("timestamptz", true, false),
    "Date",
  );
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("timestamp", true, false),
    "Date",
  );
  // "bigint" SQL type maps to "int64" EdgeQL which maps to "number"
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("bigint", true, false),
    "number",
  );
});

// --- Generated query builder _typeCasts map ---

Deno.test("TypeScriptGenerator - generated query builder has correct _typeCasts map", () => {
  const schema = createSchemaWithEdgeQLTypes();
  const config = createDefaultConfig();
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const queryFile = result.files.find((f) => f.type === "queries");
  assertEquals(queryFile !== undefined, true);

  const content = queryFile!.content;

  // Should have _typeCasts with correct casts
  assertStringIncludes(content, "_typeCasts");
  assertStringIncludes(content, 'name: "<str>"');
  assertStringIncludes(content, 'email: "<str>"');
  assertStringIncludes(content, 'age: "<int32>"');
  assertStringIncludes(content, 'active: "<bool>"');
  assertStringIncludes(content, 'createdAt: "<datetime>"');
  assertStringIncludes(content, 'score: "<float64>"');
});

// --- Insert method uses correct casts ---

Deno.test("TypeScriptGenerator - insert method uses _typeCasts lookup", () => {
  const schema = createSchemaWithEdgeQLTypes();
  const config = createDefaultConfig();
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const queryFile = result.files.find((f) => f.type === "queries");
  assertEquals(queryFile !== undefined, true);

  const content = queryFile!.content;

  // Insert method should reference _typeCasts instead of hardcoded <str>
  assertStringIncludes(content, "UserQueryBuilder._typeCasts[key]");

  // Should NOT contain hardcoded <str> in insert assignments
  // (The fallback `|| "<str>"` is acceptable but the primary path uses _typeCasts)
  const insertSection = content.substring(
    content.indexOf("async insert("),
    content.indexOf("async update("),
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

  const queryFile = result.files.find((f) => f.type === "queries");
  assertEquals(queryFile !== undefined, true);

  const content = queryFile!.content;

  // Update method should reference _typeCasts
  const updateSection = content.substring(
    content.indexOf("async update("),
    content.indexOf("async delete("),
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

  const queryFile = result.files.find((f) => f.type === "queries");
  assertEquals(queryFile !== undefined, true);

  const content = queryFile!.content;

  // When edgeqlType is undefined, type field ("str", "int32") should be used
  assertStringIncludes(content, 'title: "<str>"');
  assertStringIncludes(content, 'count: "<int32>"');
});

// --- Interface generation uses edgeqlType for type mapping ---

Deno.test("TypeScriptGenerator - interface uses edgeqlType for TypeScript type mapping", () => {
  const schema = createSchemaWithEdgeQLTypes();
  const config = createDefaultConfig();
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const typesFile = result.files.find((f) => f.type === "types");
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
        edgeqlType: "uuid",
      }],
      ["email", {
        name: "email",
        type: "text",
        required: true,
        multi: false,
        columnName: "email",
        edgeqlType: "str",
      }],
      ["name", {
        name: "name",
        type: "text",
        required: true,
        multi: false,
        columnName: "name",
        edgeqlType: "str",
      }],
      ["age", {
        name: "age",
        type: "integer",
        required: false,
        multi: false,
        columnName: "age",
        edgeqlType: "int32",
      }],
      ["createdAt", {
        name: "createdAt",
        type: "timestamptz",
        required: true,
        multi: false,
        columnName: "created_at",
        edgeqlType: "datetime",
        readonly: true,
        hasDefault: true,
      }],
      ["updatedAt", {
        name: "updatedAt",
        type: "timestamptz",
        required: true,
        multi: false,
        columnName: "updated_at",
        edgeqlType: "datetime",
        hasDefault: true,
      }],
      ["displayName", {
        name: "displayName",
        type: "text",
        required: false,
        multi: false,
        columnName: "display_name",
        edgeqlType: "str",
        computed: true,
      }],
      ["loginCount", {
        name: "loginCount",
        type: "integer",
        required: true,
        multi: false,
        columnName: "login_count",
        edgeqlType: "int32",
        readonly: true,
      }],
    ]),
    links: new Map(),
  };

  return {
    types: new Map([["User", userType]]),
    functions: new Map(),
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
    enumValues: ["active", "inactive", "pending"],
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
        edgeqlType: "uuid",
      }],
      ["name", {
        name: "name",
        type: "text",
        required: true,
        multi: false,
        columnName: "name",
        edgeqlType: "str",
      }],
    ]),
    links: new Map(),
  };

  return {
    types: new Map([
      ["Status", statusType],
      ["User", userType],
    ]),
    functions: new Map(),
  };
}

// --- Insert type tests ---

Deno.test("TypeScriptGenerator - UserInsert requires email and name (no ?)", () => {
  const schema = createSchemaWithMetadata();
  const config = createDefaultConfig();
  config.includeQueryBuilders = false;
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const typesFile = result.files.find((f) => f.type === "types");
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

  const typesFile = result.files.find((f) => f.type === "types");
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

  const typesFile = result.files.find((f) => f.type === "types");
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

  const typesFile = result.files.find((f) => f.type === "types");
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

  const typesFile = result.files.find((f) => f.type === "types");
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

  const typesFile = result.files.find((f) => f.type === "types");
  assertEquals(typesFile !== undefined, true);

  const content = typesFile!.content;

  // Should generate a union type for the enum
  assertStringIncludes(
    content,
    'export type Status = "active" | "inactive" | "pending";',
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

  const queryFile = result.files.find((f) => f.type === "queries");
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

  const queryFile = result.files.find((f) => f.type === "queries");
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

  const typesFile = result.files.find((f) => f.type === "types");
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

  const typesFile = result.files.find((f) => f.type === "types");
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

Deno.test("TypeScriptGenerator - filter method uses Types.${Type}FilterVars parameter type", () => {
  const schema = createSchemaWithEdgeQLTypes();
  const config = createDefaultConfig();
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const queryFile = result.files.find((f) => f.type === "queries");
  assertEquals(queryFile !== undefined, true);

  const content = queryFile!.content;

  // Filter method should use UserFilterVars type
  assertStringIncludes(content, "variables?: Types.UserFilterVars");
  // Should NOT use old generic Record<string, any> pattern in filter
  const filterSection = content.substring(
    content.indexOf("async filter("),
    content.indexOf("async insert("),
  );
  assertEquals(filterSection.includes("Record<string, any>"), false);
});

Deno.test("TypeScriptGenerator - count method uses Types.${Type}FilterVars parameter type", () => {
  const schema = createSchemaWithEdgeQLTypes();
  const config = createDefaultConfig();
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const queryFile = result.files.find((f) => f.type === "queries");
  assertEquals(queryFile !== undefined, true);

  const content = queryFile!.content;

  // Count method should use UserFilterVars type
  const countSection = content.substring(
    content.indexOf("async count("),
    content.indexOf("}\n", content.indexOf("async count(")),
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

  const typesFile = result.files.find((f) => f.type === "types");
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
        edgeqlType: "uuid",
      }],
      ["email", {
        name: "email",
        type: "text",
        required: true,
        multi: false,
        columnName: "email",
        edgeqlType: "str",
        constraints: [{ name: "exclusive" }],
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
          { name: "min_length", args: ["1"] },
        ],
      }],
      ["bio", {
        name: "bio",
        type: "text",
        required: false,
        multi: false,
        columnName: "bio",
        edgeqlType: "str",
      }],
      ["createdAt", {
        name: "createdAt",
        type: "timestamptz",
        required: true,
        multi: false,
        columnName: "created_at",
        edgeqlType: "datetime",
        readonly: true,
        hasDefault: true,
      }],
    ]),
    links: new Map(),
  };

  return {
    types: new Map([["User", userType]]),
    functions: new Map(),
  };
}

Deno.test("TypeScriptGenerator - exclusive constraint appears in JSDoc as @constraint exclusive", () => {
  const schema = createSchemaWithConstraints();
  const config = createDefaultConfig();
  config.includeQueryBuilders = false;
  const generator = new TypeScriptGenerator(schema, config);
  const result = generator.generate();

  const typesFile = result.files.find((f) => f.type === "types");
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

  const typesFile = result.files.find((f) => f.type === "types");
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

  const typesFile = result.files.find((f) => f.type === "types");
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

  const typesFile = result.files.find((f) => f.type === "types");
  assertEquals(typesFile !== undefined, true);

  const content = typesFile!.content;

  // createdAt has readonly: true and hasDefault: true
  // Find the JSDoc block for createdAt
  const createdAtJsdocStart = content.indexOf("* datetime (required)");
  assertEquals(createdAtJsdocStart !== -1, true);

  // Should contain @readonly and @default tags
  const createdAtSection = content.substring(
    createdAtJsdocStart,
    content.indexOf("createdAt:", createdAtJsdocStart),
  );
  assertStringIncludes(createdAtSection, "@readonly");
  assertStringIncludes(createdAtSection, "@default");
});
