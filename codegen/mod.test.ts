/**
 * Codegen module tests
 */

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import * as Codegen from "./mod.ts";
import * as Types from "./types.ts";
import * as Context from "../compiler/context.ts";
import { cleanupTempDir, createTempDir } from "../tests/test-utils.ts";

Deno.test("Codegen - generateTypeScript with default config", () => {
  const schema = Context.createTestSchema();
  const result = Codegen.generateTypeScript(schema);

  assertExists(result);
  assertEquals(result.errors.length, 0);
  assertEquals(result.files.length > 0, true);

  // Should have at least types file
  const hasTypesFile = result.files.some((f) => f.type === "types");
  assertEquals(hasTypesFile, true);
});

Deno.test("Codegen - generateTypeScript with custom config", () => {
  const schema = Context.createTestSchema();
  const config: Partial<Types.CodegenConfig> = {
    outputDir: "./custom-output",
    target: "server",
    includeQueryBuilders: false,
    includeClient: false,
    typePrefix: "Db",
  };

  const result = Codegen.generateTypeScript(schema, config);

  assertExists(result);
  assertEquals(result.errors.length, 0);

  // Should not have client files when includeClient is false
  const hasClientFile = result.files.some((f) => f.type === "client");
  assertEquals(hasClientFile, false);

  // Should not have query files when includeQueryBuilders is false
  const hasQueryFile = result.files.some((f) => f.type === "queries");
  assertEquals(hasQueryFile, false);
});

Deno.test("Codegen - generateTypeScript client target", () => {
  const schema = Context.createTestSchema();
  const config: Partial<Types.CodegenConfig> = {
    target: "client",
    includeQueryBuilders: true,
    includeClient: true,
  };

  const result = Codegen.generateTypeScript(schema, config);

  assertExists(result);
  assertEquals(result.errors.length, 0);

  // Should have client files
  const hasClientFile = result.files.some((f) => f.type === "client");
  assertEquals(hasClientFile, true);

  // Should have query builders
  const hasQueryFile = result.files.some((f) => f.type === "queries");
  assertEquals(hasQueryFile, true);
});

Deno.test("Codegen - generateTypeScript server target", () => {
  const schema = Context.createTestSchema();
  const config: Partial<Types.CodegenConfig> = {
    target: "server",
    includeQueryBuilders: false,
    includeClient: false,
  };

  const result = Codegen.generateTypeScript(schema, config);

  assertExists(result);
  assertEquals(result.errors.length, 0);

  // Should have types but not client
  const hasTypesFile = result.files.some((f) => f.type === "types");
  assertEquals(hasTypesFile, true);

  const hasClientFile = result.files.some((f) => f.type === "client");
  assertEquals(hasClientFile, false);
});

Deno.test("Codegen - generateTypeScript both target", () => {
  const schema = Context.createTestSchema();
  const config: Partial<Types.CodegenConfig> = {
    target: "both",
    includeQueryBuilders: true,
    includeClient: true,
    includeMutations: true,
  };

  const result = Codegen.generateTypeScript(schema, config);

  assertExists(result);
  assertEquals(result.errors.length, 0);

  // Should have all file types
  const hasTypesFile = result.files.some((f) => f.type === "types");
  const hasClientFile = result.files.some((f) => f.type === "client");
  const hasQueryFile = result.files.some((f) => f.type === "queries");
  const hasIndexFile = result.files.some((f) => f.type === "index");

  assertEquals(hasTypesFile, true);
  assertEquals(hasClientFile, true);
  assertEquals(hasQueryFile, true);
  assertEquals(hasIndexFile, true);
});

Deno.test("Codegen - writeGeneratedFiles creates files", async () => {
  const tempDir = await createTempDir();

  try {
    const schema = Context.createTestSchema();
    const result = Codegen.generateTypeScript(schema, {
      outputDir: "generated",
    });

    await Codegen.writeGeneratedFiles(result, tempDir);

    // Check that files were created
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
    const result = Codegen.generateTypeScript(schema, {
      outputDir: "custom-dir",
    });

    await Codegen.writeGeneratedFiles(result, tempDir);

    // Check that output directory was created
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

  // Find the types file
  const typesFile = result.files.find((f) => f.type === "types");
  assertExists(typesFile);

  // Should contain interface definitions
  assertStringIncludes(typesFile.content, "interface");
  assertStringIncludes(typesFile.content, "export");

  // Should contain some of the test schema types
  const schemaTypeNames = Array.from(schema.types.keys());
  if (schemaTypeNames.length > 0) {
    assertStringIncludes(typesFile.content, schemaTypeNames[0]);
  }
});

Deno.test("Codegen - generated client content validation", () => {
  const schema = Context.createTestSchema();
  const config: Partial<Types.CodegenConfig> = {
    target: "client",
    includeClient: true,
  };

  const result = Codegen.generateTypeScript(schema, config);

  // Find the client file
  const clientFile = result.files.find((f) => f.type === "client");
  assertExists(clientFile);

  // Should contain client class
  assertStringIncludes(clientFile.content, "class");
  assertStringIncludes(clientFile.content, "DiscClient");
  assertStringIncludes(clientFile.content, "constructor");
});

Deno.test("Codegen - generated index file validation", () => {
  const schema = Context.createTestSchema();
  const result = Codegen.generateTypeScript(schema);

  // Find the index file
  const indexFile = result.files.find((f) => f.type === "index");
  assertExists(indexFile);

  // Should contain exports
  assertStringIncludes(indexFile.content, "export");

  // Should export types
  if (result.files.some((f) => f.type === "types")) {
    assertStringIncludes(indexFile.content, "./types");
  }

  // Should export client if included
  if (result.files.some((f) => f.type === "client")) {
    assertStringIncludes(indexFile.content, "./client");
  }
});

Deno.test("Codegen - error handling for empty schema", () => {
  // Create empty schema
  const emptySchema: Context.Schema = {
    types: new Map(),
    functions: new Map(),
  };

  const result = Codegen.generateTypeScript(emptySchema);

  assertExists(result);
  // Should still generate files even with empty schema
  assertEquals(result.files.length > 0, true);

  // Should have index file at minimum
  const hasIndexFile = result.files.some((f) => f.type === "index");
  assertEquals(hasIndexFile, true);
});

Deno.test("Codegen - config merging with defaults", () => {
  const schema = Context.createTestSchema();
  const partialConfig: Partial<Types.CodegenConfig> = {
    outputDir: "./test-output",
    includeMutations: false,
  };

  const result = Codegen.generateTypeScript(schema, partialConfig);

  // Config should be merged with defaults
  assertExists(result);

  // Mutations should be disabled
  const hasMutationsFile = result.files.some((f) => f.type === "mutations");
  assertEquals(hasMutationsFile, false);
});

Deno.test("Codegen - file path generation", () => {
  const schema = Context.createTestSchema();
  const config: Partial<Types.CodegenConfig> = {
    outputDir: "custom/nested/path",
  };

  const result = Codegen.generateTypeScript(schema, config);

  // All files should use the custom output directory
  for (const file of result.files) {
    assertStringIncludes(file.path, "custom/nested/path");
  }
});
