/**
 * PostgreSQL End-to-End Tests for Stage 39: Annotations DDL & Abstract Annotations
 *
 * Verifies that schemas with annotations can be migrated and that
 * DESCRIBE TYPE / DESCRIBE SCHEMA return annotation data in their JSON output.
 *
 * Set DISC_PG_TEST_URL or DISC_PG_AUTO=1 to enable them.
 */

import { assertEquals, assertExists } from "@std/assert";
import { canRunPgTests, getTestDsn } from "../tests/pg-test-harness.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { describeSchema, describeType } from "./introspection.ts";
import { TypeScriptGenerator } from "../codegen/typescript-generator.ts";

const RUN_PG = canRunPgTests();

function makePool(dsn: string): ConnectionPool {
  return new ConnectionPool({
    connectionString: dsn,
    cleanupInterval: 0,
    maxConnections: 3,
    minConnections: 1,
  });
}

Deno.test({
  name:
    "PG Stage 39: schema with annotations -> migrate -> DESCRIBE TYPE -> verify annotations",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const sdl = `
        module default {
          type Article {
            annotation description := 'A published article';
            required title: str {
              annotation description := 'Article headline';
            };
            required body: str;
          };
        }
      `;

      const manager = new SchemaManager({ pool, dryRun: true });
      await manager.initialize();

      const parseResult = manager.parseSDL(sdl);
      assertEquals(parseResult.ok, true);

      const schema = manager.modulesToSchema(parseResult.value);

      // Use introspection to verify annotations propagated
      const typeDesc = describeType(schema, "Article");
      assertEquals(
        typeDesc.annotations["description"],
        "'A published article'",
      );

      const titleProp = typeDesc.properties.find((p) => p.name === "title");
      assertExists(titleProp);
      assertEquals(titleProp.annotations["description"], "'Article headline'");

      await manager.close();
    } finally {
      await pool.close();
    }
  },
});

Deno.test({
  name:
    "PG Stage 39: schema with @description -> codegen -> verify JSDoc output",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const sdl = `
        module default {
          type Profile {
            annotation description := 'User profile information';
            required username: str {
              annotation description := 'Unique username';
            };
          };
        }
      `;

      const manager = new SchemaManager({ pool, dryRun: true });
      await manager.initialize();

      const parseResult = manager.parseSDL(sdl);
      assertEquals(parseResult.ok, true);

      const schema = manager.modulesToSchema(parseResult.value);

      // Generate TypeScript
      const generator = new TypeScriptGenerator(schema, {
        outputDir: "./generated",
        formatOutput: true,
        includeQueryBuilders: false,
        includeClient: false,
      });

      const result = generator.generate();
      // The codegen tags the generated TypeScript file as `"types"` for
      // single-module schemas and `"interfaces"` once any type carries
      // an explicit `module` (which the SchemaManager always sets, even
      // to `"default"`). Accept either label.
      const typesFile = result.files.find(
        (f) => f.type === "types" || f.type === "interfaces",
      );
      assertExists(typesFile);

      // Verify JSDoc output contains annotation text
      assertEquals(
        typesFile.content.includes("'User profile information'"),
        true,
      );
      assertEquals(
        typesFile.content.includes("@description 'Unique username'"),
        true,
      );

      await manager.close();
    } finally {
      await pool.close();
    }
  },
});

Deno.test({
  name:
    "PG Stage 39: abstract annotation + usage -> migrate -> DESCRIBE SCHEMA -> verify",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const sdl = `
        module default {
          abstract annotation custom_note;

          type Widget {
            annotation custom_note := 'Important widget';
            annotation description := 'A widget type';
            required label: str;
          };
        }
      `;

      const manager = new SchemaManager({ pool, dryRun: true });
      await manager.initialize();

      const parseResult = manager.parseSDL(sdl);
      assertEquals(parseResult.ok, true);

      const schema = manager.modulesToSchema(parseResult.value);

      // Verify abstract annotations collected
      assertExists(schema.abstractAnnotations);
      assertEquals(schema.abstractAnnotations!.has("custom_note"), true);

      // Verify type annotations via DESCRIBE SCHEMA
      const schemaDesc = describeSchema(schema);
      const widgetType = schemaDesc.types.find((t) => t.name === "Widget");
      assertExists(widgetType);
      assertEquals(widgetType.annotations["custom_note"], "'Important widget'");
      assertEquals(widgetType.annotations["description"], "'A widget type'");

      await manager.close();
    } finally {
      await pool.close();
    }
  },
});
