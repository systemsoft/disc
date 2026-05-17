/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for multiple inheritance support (Stage 29)
 *
 * Validates that types can extend multiple parents, properties merge correctly
 * from all parents, diamond inheritance deduplicates, and that downstream
 * systems (codegen, DDL, differ, introspection) handle multi-parent types.
 */

import { assertEquals, assertExists } from "@std/assert";
import { TypeScriptGenerator } from "../codegen/typescript-generator.ts";
import { DDLGenerator } from "../migration/ddl.ts";
import { SchemaDiffer } from "../migration/differ.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import type { TypeDeclaration, TypeRef } from "../schema/ast.ts";
import { getBuiltinFunctions } from "./builtin-functions.ts";
import { getAllSubtypes, getTypeHierarchy } from "./context.ts";
import type { Schema, TypeDef } from "./context.ts";
import { describeType } from "./introspection.ts";

// ---------------------------------------------------------------------------
// Helper: build a minimal TypeDef (mirrors type-hierarchy.test.ts pattern)
// ---------------------------------------------------------------------------

function makeTypeDef(
  overrides: Partial<TypeDef> & Pick<TypeDef, "name" | "tableName">
): TypeDef {
  return {
    kind: "object",
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid",
        hasDefault: true
      }]
    ]),
    links: new Map(),
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Helper: parse SDL through SchemaManager and return the Schema
// ---------------------------------------------------------------------------

function parseAndBuild(sdl: string): Schema {
  const manager = new SchemaManager({});
  const parseResult = manager.parseSDL(sdl);
  assertEquals(parseResult.ok, true, "parseSDL should succeed");
  if (!parseResult.ok) {
    throw parseResult.error;
  }
  return manager.modulesToSchema(parseResult.value);
}

// ---------------------------------------------------------------------------
// Helper: build a TypeDeclaration AST node for differ tests
// ---------------------------------------------------------------------------

function makeTypeRef(name: string): TypeRef {
  return {
    kind: "TypeRef",
    name: { kind: "QualifiedName", parts: [name] }
  };
}

function makeTypeDeclaration(
  name: string,
  options: {
    abstract?: boolean;
    extending?: string[];
    members?: TypeDeclaration["members"];
  } = {}
): TypeDeclaration {
  return {
    kind: "TypeDeclaration",
    name: { kind: "Identifier", value: name },
    abstract: options.abstract,
    extending: options.extending?.map(makeTypeRef),
    members: options.members ?? []
  };
}

// ===========================================================================
// 1. Schema manager: multiple parents merge properties
// ===========================================================================

Deno.test("multiple inheritance - schema manager merges properties from multiple parents", () => {
  const sdl = `
    abstract type Timestamped {
      property created_at: datetime;
    }
    abstract type Authored {
      required property author_name: str;
    }
    type BlogPost extending Timestamped, Authored {
      required property title: str;
      required property body: str;
    }
  `;

  const schema = parseAndBuild(sdl);

  // Verify BlogPost exists
  const blogPost = schema.types.get("BlogPost");
  assertExists(blogPost, "BlogPost type should exist in schema");

  // Verify parentTypes array
  assertEquals(
    blogPost.parentTypes,
    ["Timestamped", "Authored"],
    "BlogPost should have both parent types"
  );

  // Verify all 4 properties are present (plus implicit id = 5 total)
  assertEquals(
    blogPost.properties.has("created_at"),
    true,
    "BlogPost should inherit created_at from Timestamped"
  );
  assertEquals(
    blogPost.properties.has("author_name"),
    true,
    "BlogPost should inherit author_name from Authored"
  );
  assertEquals(
    blogPost.properties.has("title"),
    true,
    "BlogPost should have its own title property"
  );
  assertEquals(
    blogPost.properties.has("body"),
    true,
    "BlogPost should have its own body property"
  );

  // Verify both parents know BlogPost is a subtype
  const timestamped = schema.types.get("Timestamped");
  assertExists(timestamped, "Timestamped type should exist");
  assertEquals(
    timestamped.subtypes?.includes("BlogPost"),
    true,
    "Timestamped should list BlogPost as a subtype"
  );

  const authored = schema.types.get("Authored");
  assertExists(authored, "Authored type should exist");
  assertEquals(
    authored.subtypes?.includes("BlogPost"),
    true,
    "Authored should list BlogPost as a subtype"
  );
});

// ===========================================================================
// 2. Schema manager: diamond problem — first-seen wins
// ===========================================================================

Deno.test("multiple inheritance - diamond problem: inherited property appears once (first-seen wins)", () => {
  const sdl = `
    abstract type Base {
      property name: str;
    }
    abstract type Left extending Base {
      property left_val: int64;
    }
    abstract type Right extending Base {
      property right_val: int64;
    }
    type Diamond extending Left, Right {
      property own_val: str;
    }
  `;

  const schema = parseAndBuild(sdl);
  const diamond = schema.types.get("Diamond");
  assertExists(diamond, "Diamond type should exist");

  // Diamond should have: id, name, left_val, right_val, own_val
  assertEquals(
    diamond.properties.has("name"),
    true,
    "Diamond should inherit 'name' from Base (via Left or Right)"
  );
  assertEquals(
    diamond.properties.has("left_val"),
    true,
    "Diamond should inherit 'left_val' from Left"
  );
  assertEquals(
    diamond.properties.has("right_val"),
    true,
    "Diamond should inherit 'right_val' from Right"
  );
  assertEquals(
    diamond.properties.has("own_val"),
    true,
    "Diamond should have its own 'own_val'"
  );

  // Count properties: id + name + left_val + right_val + own_val = 5
  // The 'name' property must NOT be duplicated
  assertEquals(
    diamond.properties.size,
    5,
    "Diamond should have exactly 5 properties (id + 4 inherited/own, no duplicates)"
  );

  // Verify parentTypes
  assertEquals(
    diamond.parentTypes,
    ["Left", "Right"],
    "Diamond should extend Left and Right"
  );
});

// ===========================================================================
// 3. getTypeHierarchy: multiple parents BFS
// ===========================================================================

Deno.test("multiple inheritance - getTypeHierarchy returns BFS ancestry with no duplicates", () => {
  const base = makeTypeDef({
    name: "Base",
    tableName: "bases",
    abstract: true,
    subtypes: ["Left", "Right"],
    discriminatorColumn: "__type__"
  });

  const left = makeTypeDef({
    name: "Left",
    tableName: "lefts",
    parentTypes: ["Base"],
    subtypes: ["Diamond"]
  });

  const right = makeTypeDef({
    name: "Right",
    tableName: "rights",
    parentTypes: ["Base"],
    subtypes: ["Diamond"]
  });

  const diamond = makeTypeDef({
    name: "Diamond",
    tableName: "diamonds",
    parentTypes: ["Left", "Right"]
  });

  const schema: Schema = {
    types: new Map([
      ["Base", base],
      ["Left", left],
      ["Right", right],
      ["Diamond", diamond]
    ]),
    functions: getBuiltinFunctions()
  };

  const hierarchy = getTypeHierarchy(schema, "Diamond");

  // BFS from Diamond: first Diamond itself, then its parents [Left, Right],
  // then Left's parent [Base] — Right's parent [Base] already visited
  assertEquals(
    hierarchy,
    ["Diamond", "Left", "Right", "Base"],
    "getTypeHierarchy should return BFS order with no duplicates"
  );
});

// ===========================================================================
// 4. getAllSubtypes: type with multiple children from different parents
// ===========================================================================

Deno.test("multiple inheritance - getAllSubtypes includes children from multiple parents", () => {
  const timestamped = makeTypeDef({
    name: "Timestamped",
    tableName: "timestampeds",
    abstract: true,
    subtypes: ["BlogPost", "Comment"],
    discriminatorColumn: "__type__"
  });

  const authored = makeTypeDef({
    name: "Authored",
    tableName: "authoreds",
    abstract: true,
    subtypes: ["BlogPost", "Comment"],
    discriminatorColumn: "__type__"
  });

  const blogPost = makeTypeDef({
    name: "BlogPost",
    tableName: "blog_posts",
    parentTypes: ["Timestamped", "Authored"]
  });

  const comment = makeTypeDef({
    name: "Comment",
    tableName: "comments",
    parentTypes: ["Timestamped", "Authored"]
  });

  const schema: Schema = {
    types: new Map([
      ["Timestamped", timestamped],
      ["Authored", authored],
      ["BlogPost", blogPost],
      ["Comment", comment]
    ]),
    functions: getBuiltinFunctions()
  };

  // Timestamped should see both BlogPost and Comment
  const timestampedSubs = getAllSubtypes(schema, "Timestamped");
  assertEquals(
    timestampedSubs.includes("BlogPost"),
    true,
    "Timestamped subtypes should include BlogPost"
  );
  assertEquals(
    timestampedSubs.includes("Comment"),
    true,
    "Timestamped subtypes should include Comment"
  );
  assertEquals(timestampedSubs.length, 2);

  // Authored should see both BlogPost and Comment
  const authoredSubs = getAllSubtypes(schema, "Authored");
  assertEquals(
    authoredSubs.includes("BlogPost"),
    true,
    "Authored subtypes should include BlogPost"
  );
  assertEquals(
    authoredSubs.includes("Comment"),
    true,
    "Authored subtypes should include Comment"
  );
  assertEquals(authoredSubs.length, 2);
});

// ===========================================================================
// 5. Codegen: multiple inheritance generates extends clause
// ===========================================================================

Deno.test("multiple inheritance - codegen generates interface with multiple extends", () => {
  const timestamped: TypeDef = makeTypeDef({
    name: "Timestamped",
    tableName: "timestampeds",
    abstract: true,
    subtypes: ["BlogPost"],
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid",
        hasDefault: true
      }],
      ["created_at", {
        name: "created_at",
        type: "timestamptz",
        required: false,
        multi: false,
        columnName: "created_at",
        edgeqlType: "datetime"
      }]
    ])
  });

  const authored: TypeDef = makeTypeDef({
    name: "Authored",
    tableName: "authoreds",
    abstract: true,
    subtypes: ["BlogPost"],
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid",
        hasDefault: true
      }],
      ["author_name", {
        name: "author_name",
        type: "text",
        required: true,
        multi: false,
        columnName: "author_name",
        edgeqlType: "str"
      }]
    ])
  });

  const blogPost: TypeDef = makeTypeDef({
    name: "BlogPost",
    tableName: "blog_posts",
    parentTypes: ["Timestamped", "Authored"],
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid",
        hasDefault: true
      }],
      ["title", {
        name: "title",
        type: "text",
        required: true,
        multi: false,
        columnName: "title",
        edgeqlType: "str"
      }]
    ])
  });

  const schema: Schema = {
    types: new Map([
      ["Timestamped", timestamped],
      ["Authored", authored],
      ["BlogPost", blogPost]
    ]),
    functions: getBuiltinFunctions()
  };

  const generator = new TypeScriptGenerator(schema, {
    outputDir: "/tmp/test",
    schemaSource: "",
    target: "both",
    includeQueryBuilders: false,
    includeMutations: false,
    includeClient: false,
    formatOutput: true
  });

  const result = generator.generate();
  assertEquals(result.errors.length, 0, "Codegen should produce no errors");

  // Find the types file
  const typesFile = result.files.find(f => f.type === "types");
  assertExists(typesFile, "Types file should be generated");

  // Verify the extends clause
  const content = typesFile.content;
  assertEquals(
    content.includes(
      "export interface BlogPost extends Timestamped, Authored {"
    ),
    true,
    "BlogPost interface should extend both Timestamped and Authored"
  );
});

// ===========================================================================
// 6. DDL: discriminator column on types in hierarchy
// ===========================================================================

Deno.test("multiple inheritance - DDL generates __type__ discriminator for child type with parentTypes", () => {
  const sdl = `
    abstract type Timestamped {
      property created_at: datetime;
    }
    abstract type Authored {
      required property author_name: str;
    }
    type BlogPost extending Timestamped, Authored {
      required property title: str;
    }
  `;

  const manager = new SchemaManager({});
  const parseResult = manager.parseSDL(sdl);
  assertEquals(parseResult.ok, true);
  if (!parseResult.ok) {
    return;
  }

  const modules = parseResult.value;

  // Use the differ to create operations from the new schema
  const differ = new SchemaDiffer();
  const operations = differ.diff([], modules);

  // Generate DDL from the operations
  const ddlGenerator = new DDLGenerator();
  const statements = ddlGenerator.generateDDL(operations);

  // Find the BlogPost CREATE TABLE statement
  const blogPostDDL = statements.find(s => s.includes("blog_post") && s.includes("CREATE TABLE"));
  assertExists(blogPostDDL, "DDL should include CREATE TABLE for blog_post");

  // BlogPost should have __type__ discriminator because it has parentTypes
  assertEquals(
    blogPostDDL.includes("__type__"),
    true,
    "BlogPost table should include __type__ discriminator column"
  );

  // Verify the __type__ default value is the type name
  assertEquals(
    blogPostDDL.includes("'BlogPost'"),
    true,
    "BlogPost __type__ column should default to 'BlogPost'"
  );

  // Verify parent tables are also created
  const timestampedDDL = statements.find(s => s.includes("timestamped") && s.includes("CREATE TABLE"));
  assertExists(
    timestampedDDL,
    "DDL should include CREATE TABLE for timestamped"
  );

  const authoredDDL = statements.find(s => s.includes("authored") && s.includes("CREATE TABLE"));
  assertExists(authoredDDL, "DDL should include CREATE TABLE for authored");
});

// ===========================================================================
// 7. Differ: multiple parents stored in operation
// ===========================================================================

Deno.test("multiple inheritance - differ stores multiple parent types in CreateTypeOperation", () => {
  const typeDecl = makeTypeDeclaration("BlogPost", {
    extending: ["Timestamped", "Authored"],
    members: []
  });

  const differ = new SchemaDiffer();
  const op = differ.createTypeOperation(typeDecl);

  assertEquals(op.kind, "CreateType");
  assertEquals(op.typeName, "BlogPost");
  assertEquals(
    op.parentTypes,
    ["Timestamped", "Authored"],
    "Operation should store both parent type names"
  );
});

// ===========================================================================
// 8. Introspection: parentTypes reported as array
// ===========================================================================

Deno.test("multiple inheritance - introspection reports parentTypes as array", () => {
  const blogPost = makeTypeDef({
    name: "BlogPost",
    tableName: "blog_posts",
    parentTypes: ["Timestamped", "Authored"],
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid",
        hasDefault: true
      }],
      ["title", {
        name: "title",
        type: "text",
        required: true,
        multi: false,
        columnName: "title",
        edgeqlType: "str"
      }]
    ])
  });

  const timestamped = makeTypeDef({
    name: "Timestamped",
    tableName: "timestampeds",
    abstract: true
  });

  const authored = makeTypeDef({
    name: "Authored",
    tableName: "authoreds",
    abstract: true
  });

  const schema: Schema = {
    types: new Map([
      ["Timestamped", timestamped],
      ["Authored", authored],
      ["BlogPost", blogPost]
    ]),
    functions: getBuiltinFunctions()
  };

  const description = describeType(schema, "BlogPost");

  assertEquals(
    description.parentTypes,
    ["Timestamped", "Authored"],
    "describeType should report parentTypes as an array with both parents"
  );
  assertEquals(description.name, "BlogPost");
  assertEquals(description.abstract, false);
});
