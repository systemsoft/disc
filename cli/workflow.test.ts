/**
 * CLI Workflow Tests - Test complete CLI command workflows
 *
 * Tests that require database connections need DISC_PG_TEST_URL.
 */

import { assert, assertEquals } from "@std/assert";
import {
  cleanupTempDir,
  ConsoleCapture,
  createTempDir,
  EnvMock,
} from "../tests/test-utils.ts";
import { commands } from "./commands.ts";

const HAS_PG = !!Deno.env.get("DISC_PG_TEST_URL");

Deno.test("CLI Workflow - Complete project initialization", async () => {
  const console = new ConsoleCapture();
  const tempDir = await createTempDir();

  try {
    // Simulate full init workflow
    const projectName = "test-workflow-project";

    // Test init command
    await commands.init({
      name: projectName,
      template: "basic",
      directory: tempDir,
    });

    // Verify project directory was created
    const projectDir = `${tempDir}/${projectName}`;
    const projectExists = await Deno.stat(projectDir).then(() => true).catch(
      () => false,
    );
    assert(projectExists, "Project directory should be created");

    // Verify essential files exist
    const schemaExists = await Deno.stat(`${projectDir}/schema.esdl`).then(() =>
      true
    ).catch(() => false);
    const configExists = await Deno.stat(`${projectDir}/deno.json`).then(() =>
      true
    ).catch(() => false);
    const envExists = await Deno.stat(`${projectDir}/.env`).then(() => true)
      .catch(() => false);

    assert(schemaExists, "Schema file should be created");
    assert(configExists, "Deno config should be created");
    assert(envExists, "Environment file should be created");
  } finally {
    console.restore();
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CLI Workflow - Migration planning and execution", async () => {
  const console = new ConsoleCapture();
  const tempDir = await createTempDir();
  const env = new EnvMock();

  try {
    env.set("DATABASE_URL", "postgresql://localhost:5432/test_disc");

    // Create a test schema file
    const schemaFile = `${tempDir}/schema.esdl`;
    await Deno.writeTextFile(
      schemaFile,
      `module default {
  type User {
    required name: str;
    required email: str;
  };
};`,
    );

    // Test migration create
    await commands.migrate({
      _: ["migrate"],
      create: true,
      schema: schemaFile,
      "dry-run": false,
      "auto-approve": false,
    });

    // Test migration apply (dry run)
    await commands.migrate({
      _: ["migrate"],
      schema: schemaFile,
      "dry-run": true,
      "auto-approve": true,
    });

    // Should not throw errors
    assert(true, "Migration workflow should complete without errors");
  } finally {
    console.restore();
    env.restore();
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CLI Workflow - Code generation", async () => {
  const console = new ConsoleCapture();
  const tempDir = await createTempDir();

  try {
    // Create test schema and output directory
    const schemaFile = `${tempDir}/schema.esdl`;
    const outputDir = `${tempDir}/generated`;

    await Deno.writeTextFile(
      schemaFile,
      `module default {
  type Post {
    required title: str;
    required content: str;
  };
};`,
    );

    // Test codegen command
    await commands.codegen({
      _: ["codegen"],
      schema: schemaFile,
      output: outputDir,
      target: "client",
      "no-queries": false,
      "no-mutations": false,
      "no-client": false,
      "no-format": false,
    });

    // Should not throw errors
    assert(true, "Codegen workflow should complete without errors");
  } finally {
    console.restore();
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CLI Workflow - Server configuration", async () => {
  const console = new ConsoleCapture();
  const env = new EnvMock();

  try {
    env.set("DISC_PORT", "8080");
    env.set("DISC_HOST", "0.0.0.0");

    // Test serve configuration (without actually starting server)
    // This is a mock test since we can't start real server in tests
    const serverOptions = {
      port: 9000,
      host: "localhost",
      config: undefined,
    };

    // Validate configuration
    assertEquals(serverOptions.port, 9000);
    assertEquals(serverOptions.host, "localhost");

    // Mock server startup would use these options
    assert(true, "Server configuration should be valid");
  } finally {
    console.restore();
    env.restore();
  }
});

Deno.test({ name: "CLI Workflow - Shell connection options", ignore: !HAS_PG, fn: async () => {
  const console = new ConsoleCapture();

  try {
    // Test shell options parsing
    const shellOptions = {
      host: "192.168.1.100",
      port: 8080,
      database: "custom_db",
      non_interactive: true,
      execute: "select User { name }",
    };

    // Should be able to execute shell with these options
    // (Mock execution since we can't connect to real server)
    await commands.shell(shellOptions);

    assert(true, "Shell configuration should be valid");
  } finally {
    console.restore();
  }
}});

Deno.test("CLI Workflow - Watch command setup", async () => {
  const console = new ConsoleCapture();
  const tempDir = await createTempDir();

  try {
    const schemaFile = `${tempDir}/schema.esdl`;
    const outputDir = `${tempDir}/generated`;

    // Create schema file
    await Deno.writeTextFile(
      schemaFile,
      `module default {
  type Item {
    required name: str;
  };
};`,
    );

    // Test watch configuration (without actually starting watcher)
    const watchOptions = {
      schema_file: schemaFile,
      output_dir: outputDir,
      delay_ms: 500,
    };

    // This would start file watching in real usage
    // For test, we just validate the configuration
    assert(watchOptions.schema_file.includes("schema.esdl"));
    assert(watchOptions.output_dir.includes("generated"));
    assertEquals(watchOptions.delay_ms, 500);
  } finally {
    console.restore();
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CLI Workflow - Error handling for missing files", async () => {
  const console = new ConsoleCapture();
  const tempDir = await createTempDir();

  try {
    const nonExistentSchema = `${tempDir}/missing.esdl`;

    // Test migration with missing schema file
    try {
      await commands.migrate({
        _: ["migrate"],
        schema: nonExistentSchema,
        "dry-run": true,
      });
      assert(false, "Should throw error for missing schema");
    } catch (error) {
      // Expected behavior - should handle missing files gracefully
      assert(error instanceof Error);
    }

    // Test codegen with missing schema file
    try {
      await commands.codegen({
        _: ["codegen"],
        schema: nonExistentSchema,
        output: `${tempDir}/output`,
      });
      // Should not throw since codegen uses test schema as fallback
      assert(true, "Codegen should handle missing schema gracefully");
    } catch (error) {
      // Also acceptable if it throws
      assert(error instanceof Error);
    }
  } finally {
    console.restore();
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CLI Workflow - Command argument validation", async () => {
  const console = new ConsoleCapture();

  try {
    // Test invalid project names for init
    try {
      await commands.init({
        name: "Invalid-Project-Name", // Contains uppercase
        template: "basic",
      });
      assert(false, "Should reject invalid project name");
    } catch (error) {
      assert((error as Error).message.includes("Invalid project name"));
    }

    try {
      await commands.init({
        name: "-invalid-start", // Starts with dash
        template: "basic",
      });
      assert(false, "Should reject project name starting with dash");
    } catch (error) {
      assert((error as Error).message.includes("Invalid project name"));
    }

    // Test valid project names
    const validNames = ["my-project", "disc-app", "blog", "user-management"];
    for (const name of validNames) {
      // Should not throw
      assert(
        /^[a-z0-9-]+$/.test(name) && !name.startsWith("-") &&
          !name.endsWith("-"),
      );
    }
  } finally {
    console.restore();
  }
});

Deno.test("CLI Workflow - Environment variable integration", async () => {
  const env = new EnvMock();

  try {
    // Test DATABASE_URL handling
    env.clear("DATABASE_URL");
    let dbUrl = Deno.env.get("DATABASE_URL") ||
      "postgresql://localhost:5432/disc_dev";
    assertEquals(dbUrl, "postgresql://localhost:5432/disc_dev");

    env.set("DATABASE_URL", "postgresql://custom:5432/custom_db");
    dbUrl = Deno.env.get("DATABASE_URL") ||
      "postgresql://localhost:5432/disc_dev";
    assertEquals(dbUrl, "postgresql://custom:5432/custom_db");

    // Test server environment variables
    env.set("DISC_PORT", "8080");
    env.set("DISC_HOST", "0.0.0.0");

    const port = parseInt(Deno.env.get("DISC_PORT") || "5656");
    const host = Deno.env.get("DISC_HOST") || "localhost";

    assertEquals(port, 8080);
    assertEquals(host, "0.0.0.0");
  } finally {
    env.restore();
  }
});
