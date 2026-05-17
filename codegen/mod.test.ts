/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Codegen module tests
 */

/*** NATIVE ------------------------------------------- ***/

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";

/*** UTILITY ------------------------------------------ ***/

import * as Codegen from "./mod.ts";
import * as Context from "../compiler/context.ts";
import * as Types from "./types.ts";

import { cleanupTempDir, createTempDir } from "../tests/test-utils.ts";

/*** RUNTIME ------------------------------------------ ***/

Deno.test("Codegen - generateTypeScript with default config", () => {
  const schema = Context.createTestSchema();
  const result = Codegen.generateTypeScript(schema);

  assertExists(result);
  assertEquals(result.errors.length, 0);
  assertEquals(result.files.length > 0, true);

  /*** Should have at least types file ***/
  const hasTypesFile = result.files.some(f => f.type === "types");
  assertEquals(hasTypesFile, true);
});

Deno.test("Codegen - generateTypeScript with custom config", () => {
  const schema = Context.createTestSchema();

  const config: Partial<Types.CodegenConfig> = {
    includeClient: false,
    includeQueryBuilders: false,
    outputDir: "./custom-output",
    target: "server",
    typePrefix: "Db"
  };

  const result = Codegen.generateTypeScript(schema, config);
  assertExists(result);
  assertEquals(result.errors.length, 0);

  /*** Should not have client files when includeClient is false ***/
  const hasClientFile = result.files.some(f => f.type === "client");
  assertEquals(hasClientFile, false);

  /*** Should not have query files when includeQueryBuilders is false ***/
  const hasQueryFile = result.files.some(f => f.type === "queries");
  assertEquals(hasQueryFile, false);
});

Deno.test("Codegen - generateTypeScript client target", () => {
  const schema = Context.createTestSchema();

  const config: Partial<Types.CodegenConfig> = {
    includeClient: true,
    includeQueryBuilders: true,
    target: "client"
  };

  const result = Codegen.generateTypeScript(schema, config);
  assertExists(result);
  assertEquals(result.errors.length, 0);

  /*** Should have client files ***/
  const hasClientFile = result.files.some(f => f.type === "client");
  assertEquals(hasClientFile, true);

  /*** Should have query builders ***/
  const hasQueryFile = result.files.some(f => f.type === "queries");
  assertEquals(hasQueryFile, true);
});

Deno.test("Codegen - generateTypeScript server target", () => {
  const schema = Context.createTestSchema();

  const config: Partial<Types.CodegenConfig> = {
    includeClient: false,
    includeQueryBuilders: false,
    target: "server"
  };

  const result = Codegen.generateTypeScript(schema, config);
  assertExists(result);
  assertEquals(result.errors.length, 0);

  /*** Should have types but not client ***/
  const hasTypesFile = result.files.some(f => f.type === "types");
  assertEquals(hasTypesFile, true);

  const hasClientFile = result.files.some(f => f.type === "client");
  assertEquals(hasClientFile, false);
});

Deno.test("Codegen - generateTypeScript both target", () => {
  const schema = Context.createTestSchema();

  const config: Partial<Types.CodegenConfig> = {
    includeClient: true,
    includeMutations: true,
    includeQueryBuilders: true,
    target: "both"
  };

  const result = Codegen.generateTypeScript(schema, config);
  assertExists(result);
  assertEquals(result.errors.length, 0);

  /*** Should have all file types ***/
  const hasTypesFile = result.files.some(f => f.type === "types");
  const hasClientFile = result.files.some(f => f.type === "client");
  const hasQueryFile = result.files.some(f => f.type === "queries");
  const hasIndexFile = result.files.some(f => f.type === "index");

  assertEquals(hasTypesFile, true);
  assertEquals(hasClientFile, true);
  assertEquals(hasQueryFile, true);
  assertEquals(hasIndexFile, true);
});

Deno.test("Codegen - writeGeneratedFiles creates files", async () => {
  const tempDir = await createTempDir();

  try {
    const schema = Context.createTestSchema();
    const result = Codegen.generateTypeScript(schema, { outputDir: "generated" });
    await Codegen.writeGeneratedFiles(result, tempDir, { runFmt: false });

    /*** Check that files were created ***/
    for (const file of result.files) {
      const fullPath = join(tempDir, file.path);
      const stat = await Deno.stat(fullPath);
      assertEquals(stat.isFile, true);

      const content = await Deno.readTextFile(fullPath);
      assertEquals(content, file.content);
    }
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("Codegen - writeGeneratedFiles creates output directory", async () => {
  const tempDir = await createTempDir();

  try {
    const schema = Context.createTestSchema();
    const result = Codegen.generateTypeScript(schema, { outputDir: "custom-dir" });
    await Codegen.writeGeneratedFiles(result, tempDir, { runFmt: false });

    /*** Check that output directory was created ***/
    const outputDir = join(tempDir, "custom-dir");
    const stat = await Deno.stat(outputDir);
    assertEquals(stat.isDirectory, true);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("Codegen - DEFAULT_CONFIGS presets", () => {
  const clientConfig = Codegen.DEFAULT_CONFIGS.client();
  assertEquals(clientConfig.target, "client");
  assertEquals(clientConfig.includeQueryBuilders, true);
  assertEquals(clientConfig.includeClient, true);
  assertEquals(clientConfig.includeMutations, true);

  const serverConfig = Codegen.DEFAULT_CONFIGS.server();
  assertEquals(serverConfig.target, "server");
  assertEquals(serverConfig.includeQueryBuilders, false);
  assertEquals(serverConfig.includeClient, false);
  assertEquals(serverConfig.includeMutations, false);

  const bothConfig = Codegen.DEFAULT_CONFIGS.both();
  assertEquals(bothConfig.target, "both");
  assertEquals(bothConfig.includeQueryBuilders, true);
  assertEquals(bothConfig.includeClient, true);
  assertEquals(bothConfig.includeMutations, true);
});

Deno.test("Codegen - generated TypeScript content validation", () => {
  const schema = Context.createTestSchema();
  const result = Codegen.generateTypeScript(schema);
  /*** Find the types file ***/
  const typesFile = result.files.find(f => f.type === "types");
  assertExists(typesFile);

  /*** Should contain interface definitions ***/
  assertStringIncludes(typesFile.content, "interface");
  assertStringIncludes(typesFile.content, "export");

  /*** Should contain some of the test schema types ***/
  const schemaTypeNames = Array.from(schema.types.keys());

  if (schemaTypeNames.length > 0)
    assertStringIncludes(typesFile.content, schemaTypeNames[0]);
});

Deno.test("Codegen - generated client content validation", () => {
  const schema = Context.createTestSchema();

  const config: Partial<Types.CodegenConfig> = {
    includeClient: true,
    target: "client"
  };

  const result = Codegen.generateTypeScript(schema, config);
  /*** Find the client file ***/
  const clientFile = result.files.find(f => f.type === "client");
  assertExists(clientFile);

  /*** Should contain client class ***/
  assertStringIncludes(clientFile.content, "class");
  assertStringIncludes(clientFile.content, "DiscClient");
  assertStringIncludes(clientFile.content, "constructor");
});

Deno.test("Codegen - generated index file validation", () => {
  const schema = Context.createTestSchema();
  const result = Codegen.generateTypeScript(schema);
  /*** Find the index file ***/
  const indexFile = result.files.find(f => f.type === "index");
  assertExists(indexFile);

  /*** Should contain exports ***/
  assertStringIncludes(indexFile.content, "export");

  /*** Should export types ***/
  if (result.files.some(f => f.type === "types"))
    assertStringIncludes(indexFile.content, "./types");

  /*** Should export client if included ***/
  if (result.files.some(f => f.type === "client"))
    assertStringIncludes(indexFile.content, "./client");
});

Deno.test("Codegen - error handling for empty schema", () => {
  /*** Create empty schema ***/
  const emptySchema: Context.Schema = {
    functions: new Map(),
    types: new Map()
  };

  const result = Codegen.generateTypeScript(emptySchema);

  assertExists(result);
  /*** Should still generate files even with empty schema ***/
  assertEquals(result.files.length > 0, true);

  /*** Should have index file at minimum ***/
  const hasIndexFile = result.files.some(f => f.type === "index");
  assertEquals(hasIndexFile, true);
});

Deno.test("Codegen - config merging with defaults", () => {
  const schema = Context.createTestSchema();

  const partialConfig: Partial<Types.CodegenConfig> = {
    includeMutations: false,
    outputDir: "./test-output"
  };

  const result = Codegen.generateTypeScript(schema, partialConfig);
  /*** Config should be merged with defaults ***/
  assertExists(result);

  /*** Mutations should be disabled ***/
  const hasMutationsFile = result.files.some(f => f.type === "mutations");
  assertEquals(hasMutationsFile, false);
});

Deno.test("Codegen - file path generation", () => {
  const schema = Context.createTestSchema();
  const config: Partial<Types.CodegenConfig> = { outputDir: "custom/nested/path" };
  const result = Codegen.generateTypeScript(schema, config);

  /*** All files should use the custom output directory ***/
  for (const file of result.files) {
    assertStringIncludes(file.path, "custom/nested/path");
  }
});

/*** --- Stage 15.5 integration tests --- ***/

Deno.test("Codegen - full pipeline with enriched test schema", () => {
  const schema = Context.createTestSchema();

  const result = Codegen.generateTypeScript(schema, {
    includeClient: false,
    includeQueryBuilders: true
  });

  assertEquals(result.errors.length, 0);

  const typesFile = result.files.find(f => f.type === "types");
  assertExists(typesFile);
  const typesContent = typesFile.content;

  /*** Correct TypeScript types on interfaces ***/
  assertStringIncludes(typesContent, "name: string");
  assertStringIncludes(typesContent, "email: string");
  assertStringIncludes(typesContent, "createdAt: Date");
  assertStringIncludes(typesContent, "active?: boolean");
  assertStringIncludes(typesContent, "age?: number");

  /*** Computed property postCount should appear on the interface ***/
  assertStringIncludes(typesContent, "postCount?: number");

  /*** Enum union type generated ***/
  assertStringIncludes(typesContent, `export type Status = "active" | "inactive" | "pending";`);

  /*** Smart Insert type: excludes id, excludes computed (postCount), excludes
       readonly+hasDefault (createdAt) ***/
  const insertStart = typesContent.indexOf("export interface UserInsert");
  assertEquals(insertStart !== -1, true);
  const insertEnd = typesContent.indexOf("}", insertStart);
  const insertBlock = typesContent.substring(insertStart, insertEnd + 1);

  assertEquals(insertBlock.includes("id:"), false);
  assertEquals(insertBlock.includes("id?:"), false);
  assertEquals(insertBlock.includes("postCount"), false);
  assertEquals(insertBlock.includes("createdAt"), false);
  assertStringIncludes(insertBlock, "name: string;");
  assertStringIncludes(insertBlock, "email: string;");

  /*** Smart Update type: excludes id, readonly (createdAt), computed (postCount) ***/
  const updateStart = typesContent.indexOf("export interface UserUpdate");
  assertEquals(updateStart !== -1, true);
  const updateEnd = typesContent.indexOf("}", updateStart);
  const updateBlock = typesContent.substring(updateStart, updateEnd + 1);

  assertEquals(updateBlock.includes("id:"), false);
  assertEquals(updateBlock.includes("id?:"), false);
  assertEquals(updateBlock.includes("postCount"), false);
  assertEquals(updateBlock.includes("createdAt"), false);
  assertStringIncludes(updateBlock, "name?: string;");
  assertStringIncludes(updateBlock, "email?: string;");

  /*** FilterVars with correct types ***/
  const filterStart = typesContent.indexOf("export interface UserFilterVars");
  assertEquals(filterStart !== -1, true);
  const filterEnd = typesContent.indexOf("}", filterStart);
  const filterBlock = typesContent.substring(filterStart, filterEnd + 1);

  assertStringIncludes(filterBlock, "id?: string;");
  assertStringIncludes(filterBlock, "email?: string;");
  assertStringIncludes(filterBlock, "age?: number;");
  assertStringIncludes(filterBlock, "createdAt?: Date;");

  /*** JSDoc with constraints ***/
  assertStringIncludes(typesContent, "@constraint exclusive");
  assertStringIncludes(typesContent, "@constraint max_length(255)");

  /*** Query builders should have correct _typeCasts ***/
  const queryFile = result.files.find(f => f.type === "queries");
  assertExists(queryFile);
  const queryContent = queryFile.content;

  assertStringIncludes(queryContent, "_typeCasts");
  assertStringIncludes(queryContent, `name: "<str>"`);
  assertStringIncludes(queryContent, `email: "<str>"`);
  assertStringIncludes(queryContent, `age: "<int32>"`);
  assertStringIncludes(queryContent, `active: "<bool>"`);
  assertStringIncludes(queryContent, `createdAt: "<datetime>"`);
});

Deno.test("Codegen - backward compatibility with minimal PropertyDef", () => {
  /*** Create a minimal schema with NO new fields (no edgeqlType, readonly, hasDefault, computed,
       constraints) to verify backward compat ***/
  const minimalSchema: Context.Schema = {
    functions: new Map(),
    types: new Map([
      ["Item", {
        kind: "object",
        links: new Map(),
        name: "Item",
        properties: new Map([
          ["id", {
            columnName: "id",
            multi: false,
            name: "id",
            required: true,
            type: "uuid"
          }],
          ["title", {
            columnName: "title",
            multi: false,
            name: "title",
            required: true,
            type: "str"
          }],
          ["count", {
            columnName: "count",
            multi: false,
            name: "count",
            required: false,
            type: "int32"
          }]
        ]),
        tableName: "items"
      }]
    ])
  };

  const result = Codegen.generateTypeScript(minimalSchema, {
    includeClient: false,
    includeQueryBuilders: true
  });

  /*** Should generate without errors ***/
  assertEquals(result.errors.length, 0);

  const typesFile = result.files.find(f => f.type === "types");
  assertExists(typesFile);

  /*** Interface should still generate correct types via type field fallback ***/
  assertStringIncludes(typesFile.content, "title: string");
  assertStringIncludes(typesFile.content, "count?: number");

  /*** Insert/Update types should still be generated ***/
  assertStringIncludes(typesFile.content, "export interface ItemInsert");
  assertStringIncludes(typesFile.content, "export interface ItemUpdate");

  /*** Query builders should still work with type field fallback ***/
  const queryFile = result.files.find(f => f.type === "queries");
  assertExists(queryFile);
  assertStringIncludes(queryFile.content, `title: "<str>"`);
  assertStringIncludes(queryFile.content, `count: "<int32>"`);
});

Deno.test("Codegen - mixed schema with enum and object types", () => {
  const schema = Context.createTestSchema();

  const result = Codegen.generateTypeScript(schema, {
    includeClient: false,
    includeQueryBuilders: true
  });

  assertEquals(result.errors.length, 0);

  const typesFile = result.files.find(f => f.type === "types");
  assertExists(typesFile);
  const content = typesFile.content;

  /*** Enum type generates a union type ***/
  assertStringIncludes(content, `export type Status = "active" | "inactive" | "pending";`);

  /*** Object types generate interfaces ***/
  assertStringIncludes(content, "export interface User");
  assertStringIncludes(content, "export interface Post");

  /*** Enum does NOT generate interface, Insert, Update, or FilterVars ***/
  assertEquals(content.includes("export interface Status"), false);
  assertEquals(content.includes("StatusInsert"), false);
  assertEquals(content.includes("StatusUpdate"), false);
  assertEquals(content.includes("StatusFilterVars"), false);

  /*** Object types DO generate Insert/Update/FilterVars ***/
  assertStringIncludes(content, "export interface UserInsert");
  assertStringIncludes(content, "export interface UserUpdate");
  assertStringIncludes(content, "export interface UserFilterVars");
  assertStringIncludes(content, "export interface PostInsert");
  assertStringIncludes(content, "export interface PostUpdate");
  assertStringIncludes(content, "export interface PostFilterVars");

  /*** Query builders should only exist for object types, not enums ***/
  const queryFile = result.files.find(f => f.type === "queries");
  assertExists(queryFile);
  assertStringIncludes(queryFile.content, "UserQueryBuilder");
  assertStringIncludes(queryFile.content, "PostQueryBuilder");
  assertEquals(queryFile.content.includes("StatusQueryBuilder"), false);
});

/*** --- Multi-module codegen integration tests --- ***/

Deno.test("Codegen - multi-module schema generates namespaces", () => {
  const schema = Context.createMultiModuleTestSchema();

  const result = Codegen.generateTypeScript(schema, {
    includeClient: false,
    includeQueryBuilders: true
  });

  assertEquals(result.errors.length, 0);

  /*** Types file should be named interfaces.ts in multi-module mode ***/
  const typesFile = result.files.find(f => f.type === "interfaces");
  assertExists(typesFile);
  assertStringIncludes(typesFile.path, "interfaces.ts");

  const content = typesFile.content;
  /*** Should have namespace declarations ***/
  assertStringIncludes(content, "export namespace $default {");
  assertStringIncludes(content, "export namespace api {");
  assertStringIncludes(content, "export namespace payment {");
});

Deno.test("Codegen - multi-module cross-module link references", () => {
  const schema = Context.createMultiModuleTestSchema();

  const result = Codegen.generateTypeScript(schema, {
    includeClient: false,
    includeQueryBuilders: false
  });

  assertEquals(result.errors.length, 0);

  const typesFile = result.files.find(f => f.type === "interfaces");
  assertExists(typesFile);
  const content = typesFile.content;

  /*** Merchant (default module) links to api::ApiKey — should use api.ApiKey ***/
  assertStringIncludes(content, "api.ApiKey[]");
  /*** Merchant links to payment::Payment — should use payment.Payment ***/
  assertStringIncludes(content, "payment.Payment[]");
  /*** ApiKey (api module) links to Merchant (default) — should use $default.Merchant ***/
  assertStringIncludes(content, "$default.Merchant");
  /*** Payment (payment module) links to Merchant (default) — should use $default.Merchant (content
       already checked above via $default.Merchant) ***/
});

Deno.test("Codegen - multi-module enums inside namespaces", () => {
  const schema = Context.createMultiModuleTestSchema();

  const result = Codegen.generateTypeScript(schema, {
    includeClient: false,
    includeQueryBuilders: false
  });

  assertEquals(result.errors.length, 0);

  const typesFile = result.files.find(f => f.type === "interfaces");
  assertExists(typesFile);
  const content = typesFile.content;

  /*** MerchantStatus enum in $default namespace ***/
  assertStringIncludes(content, `export type MerchantStatus = "active" | "suspended" | "pending"`);
  /*** PaymentStatus enum in payment namespace ***/
  assertStringIncludes(content, `export type PaymentStatus = "pending" | "completed" | "failed" | "refunded"`);
});

Deno.test("Codegen - multi-module Insert/Update/FilterVars in namespaces", () => {
  const schema = Context.createMultiModuleTestSchema();

  const result = Codegen.generateTypeScript(schema, {
    includeClient: false,
    includeQueryBuilders: false
  });

  assertEquals(result.errors.length, 0);

  const typesFile = result.files.find(f => f.type === "interfaces");
  assertExists(typesFile);
  const content = typesFile.content;

  /*** Insert/Update/FilterVars should be inside namespaces (indented) ***/
  assertStringIncludes(content, "  export interface MerchantInsert");
  assertStringIncludes(content, "  export interface PaymentInsert");
  assertStringIncludes(content, "  export interface ApiKeyInsert");
  assertStringIncludes(content, "  export interface MerchantUpdate");
  assertStringIncludes(content, "  export interface PaymentUpdate");
  assertStringIncludes(content, "  export interface MerchantFilterVars");
  assertStringIncludes(content, "  export interface PaymentFilterVars");
});

Deno.test("Codegen - multi-module query builders use qualified EdgeQL names", () => {
  const schema = Context.createMultiModuleTestSchema();

  const result = Codegen.generateTypeScript(schema, {
    includeClient: false,
    includeQueryBuilders: true
  });

  assertEquals(result.errors.length, 0);

  const queryFile = result.files.find(f => f.type === "queries");
  assertExists(queryFile);
  const content = queryFile.content;

  /*** Builders for non-default modules use qualified EdgeQL names ***/
  assertStringIncludes(content, "select payment::Payment");
  assertStringIncludes(content, "select api::ApiKey");
  /*** Default module uses unqualified names ***/
  assertStringIncludes(content, "select Merchant {");

  /*** Types are referenced with namespace prefix ***/
  assertStringIncludes(content, "Types.$default.Merchant");
  assertStringIncludes(content, "Types.payment.Payment");
  assertStringIncludes(content, "Types.api.ApiKey");

  /*** Import from interfaces.ts ***/
  assertStringIncludes(content, `from "./interfaces.ts"`);
});

Deno.test("Codegen - multi-module index exports from interfaces.ts", () => {
  const schema = Context.createMultiModuleTestSchema();

  const result = Codegen.generateTypeScript(schema, {
    includeClient: true,
    includeQueryBuilders: true
  });

  assertEquals(result.errors.length, 0);

  const indexFile = result.files.find(f => f.type === "index");
  assertExists(indexFile);
  assertStringIncludes(indexFile.content, "./interfaces.ts");
});

Deno.test("Codegen - backward compat: schema without module field generates flat types", () => {
  /*** createTestSchema() has NO module field on any type ***/
  const schema = Context.createTestSchema();

  const result = Codegen.generateTypeScript(schema, {
    includeClient: false,
    includeQueryBuilders: true
  });

  assertEquals(result.errors.length, 0);

  /*** Should use types.ts (not interfaces.ts) ***/
  const typesFile = result.files.find(f => f.type === "types");
  assertExists(typesFile);
  assertStringIncludes(typesFile.path, "types.ts");

  /*** Should NOT have namespace declarations ***/
  const content = typesFile.content;
  assertEquals(content.includes("export namespace"), false);

  /*** Should have flat exports ***/
  assertStringIncludes(content, "export interface User {");
  assertStringIncludes(content, "export interface Post {");
});

/*** --- discoverSchemaFiles tests --- ***/

Deno.test("Codegen - discoverSchemaFiles finds .disc files first", async () => {
  const tempDir = await createTempDir();

  try {
    /*** Create .disc and .gel files ***/
    await Deno.writeTextFile(`${tempDir}/default.disc`, "module default {}");
    await Deno.writeTextFile(`${tempDir}/default.gel`, "module default {}");

    const files = await Codegen.discoverSchemaFiles(tempDir);
    assertEquals(files.length, 1);
    assertStringIncludes(files[0], ".disc");
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("Codegen - discoverSchemaFiles falls back to .gel", async () => {
  const tempDir = await createTempDir();

  try {
    await Deno.writeTextFile(`${tempDir}/default.gel`, "module default {}");
    await Deno.writeTextFile(`${tempDir}/api.gel`, "module api {}");

    const files = await Codegen.discoverSchemaFiles(tempDir);
    assertEquals(files.length, 2);
    /*** Should be sorted alphabetically ***/
    assertStringIncludes(files[0], "api.gel");
    assertStringIncludes(files[1], "default.gel");
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("Codegen - discoverSchemaFiles falls back to .disc", async () => {
  const tempDir = await createTempDir();

  try {
    await Deno.writeTextFile(`${tempDir}/schema.disc`, "module default {}");

    const files = await Codegen.discoverSchemaFiles(tempDir);
    assertEquals(files.length, 1);
    assertStringIncludes(files[0], ".disc");
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("Codegen - discoverSchemaFiles returns empty for empty dir", async () => {
  const tempDir = await createTempDir();

  try {
    const files = await Codegen.discoverSchemaFiles(tempDir);
    assertEquals(files.length, 0);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("Codegen - discoverSchemaFiles returns empty for nonexistent dir", async () => {
  const files = await Codegen.discoverSchemaFiles("/nonexistent/dir/that/does/not/exist");
  assertEquals(files.length, 0);
});

Deno.test("Codegen - all features combined in single generated file", () => {
  const schema = Context.createTestSchema();

  const result = Codegen.generateTypeScript(schema, {
    includeClient: false,
    includeQueryBuilders: true
  });

  assertEquals(result.errors.length, 0);

  const typesFile = result.files.find(f => f.type === "types");
  assertExists(typesFile);
  const content = typesFile.content;

  /*** File header ***/
  assertStringIncludes(content, "Generated by Disc TypeScript Codegen");

  /*** Enum union type section ***/
  assertStringIncludes(content, "export type Status");

  /*** Interface section ***/
  assertStringIncludes(content, "export interface User");
  assertStringIncludes(content, "export interface Post");

  /*** Utility types section ***/
  assertStringIncludes(content, "export interface QueryResult");
  assertStringIncludes(content, "export interface QueryError");

  /*** Insert/Update/FilterVars for User ***/
  assertStringIncludes(content, "export interface UserInsert");
  assertStringIncludes(content, "export interface UserUpdate");
  assertStringIncludes(content, "export interface UserFilterVars");

  /*** Insert/Update/FilterVars for Post ***/
  assertStringIncludes(content, "export interface PostInsert");
  assertStringIncludes(content, "export interface PostUpdate");
  assertStringIncludes(content, "export interface PostFilterVars");

  /*** JSDoc with constraints present ***/
  assertStringIncludes(content, "@constraint exclusive");
  assertStringIncludes(content, "@constraint max_length(255)");

  /*** JSDoc with readonly and default metadata ***/
  assertStringIncludes(content, "@readonly");
  assertStringIncludes(content, "@default");

  /*** Query builders file ***/
  const queryFile = result.files.find(f => f.type === "queries");
  assertExists(queryFile);
  const queryContent = queryFile.content;

  /*** Type casts map ***/
  assertStringIncludes(queryContent, "_typeCasts");

  /*** Builder classes ***/
  assertStringIncludes(queryContent, "UserQueryBuilder");
  assertStringIncludes(queryContent, "PostQueryBuilder");

  /*** Typed method signatures ***/
  assertStringIncludes(queryContent, "Types.UserInsert");
  assertStringIncludes(queryContent, "Types.UserUpdate");
  assertStringIncludes(queryContent, "Types.UserFilterVars");
  assertStringIncludes(queryContent, "Types.PostInsert");
  assertStringIncludes(queryContent, "Types.PostUpdate");
  assertStringIncludes(queryContent, "Types.PostFilterVars");
});
