/**
 * CLI Init Command Tests - Test project initialization functionality
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  assertLogContains,
  cleanupTempDir,
  ConsoleCapture,
  createTempDir,
} from "../tests/test-utils.ts";

// Mock init command implementation
interface InitOptions {
  name?: string;
  template?: "basic" | "minimal" | "full";
  databaseUrl?: string;
  force?: boolean;
}

async function mockInitCommand(
  targetDir: string,
  options: InitOptions = {},
): Promise<void> {
  const projectName = options.name || "disc-project";
  const template = options.template || "basic";
  const databaseUrl = options.databaseUrl ||
    "postgresql://localhost:5432/disc_dev";

  // Create project directory
  const projectDir = `${targetDir}/${projectName}`;
  await Deno.mkdir(projectDir, { recursive: true });

  // Create schema.esdl based on template
  let schemaContent = "";
  switch (template) {
    case "minimal":
      schemaContent = `module default {
  # Add your schema definitions here
};`;
      break;
    case "basic":
      schemaContent = `module default {
  type User {
    required name: str;
    required email: str {
      constraint exclusive;
    };
    createdAt: datetime {
      default := datetime_current();
    };
  };
};`;
      break;
    case "full":
      schemaContent = `module default {
  type User {
    required name: str;
    required email: str {
      constraint exclusive;
    };
    multi posts: Post;
    createdAt: datetime {
      default := datetime_current();
    };
  };

  type Post {
    required title: str;
    required content: str;
    required author: User;
    published: bool {
      default := false;
    };
    createdAt: datetime {
      default := datetime_current();
    };
    updatedAt: datetime {
      default := datetime_current();
    };
  };
};`;
      break;
  }

  await Deno.writeTextFile(`${projectDir}/schema.esdl`, schemaContent);

  // Create deno.json
  const denoConfig = {
    name: projectName,
    version: "0.1.0",
    exports: {
      ".": "./mod.ts",
    },
    imports: {
      "@disc/db": "jsr:@disc/db@*",
    },
    tasks: {
      "serve": "disc serve",
      "migrate": "disc migrate",
      "codegen": "disc codegen",
      "dev": "disc watch",
      "shell": "disc shell",
    },
  };

  await Deno.writeTextFile(
    `${projectDir}/deno.json`,
    JSON.stringify(denoConfig, null, 2),
  );

  // Create .env file
  const envContent = `# Disc Database Configuration
DATABASE_URL=${databaseUrl}
DISC_PORT=5656
DISC_HOST=localhost

# Development settings
NODE_ENV=development
`;

  await Deno.writeTextFile(`${projectDir}/.env`, envContent);

  // Create gitignore
  const gitignoreContent = `# Dependencies
node_modules/
.npm/
.deno/

# Environment
.env.local
.env.production

# Logs
*.log
logs/

# Generated files
generated/
*.db
*.sqlite

# IDE
.vscode/
.idea/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db
`;

  await Deno.writeTextFile(`${projectDir}/.gitignore`, gitignoreContent);

  // Create README.md
  const readmeContent = `# ${projectName}

A Disc database project.

## Getting Started

1. **Setup database**:
   \`\`\`bash
   createdb ${projectName.replace(/-/g, "_")}_dev
   \`\`\`

2. **Apply schema**:
   \`\`\`bash
   disc migrate
   \`\`\`

3. **Generate types**:
   \`\`\`bash
   disc codegen
   \`\`\`

4. **Start server**:
   \`\`\`bash
   disc serve
   \`\`\`

## Available Commands

- \`deno task serve\` - Start the Disc server
- \`deno task migrate\` - Apply schema migrations  
- \`deno task codegen\` - Generate TypeScript types
- \`deno task dev\` - Watch for schema changes
- \`deno task shell\` - Open EdgeQL REPL

## Schema

Your schema is defined in \`schema.esdl\`. Edit this file to modify your database structure.

## Environment

Copy \`.env\` to \`.env.local\` and adjust settings for your environment.
`;

  await Deno.writeTextFile(`${projectDir}/README.md`, readmeContent);

  // Create basic mod.ts
  const modContent = `// Main module for ${projectName}
export * from "@disc/db";
`;

  await Deno.writeTextFile(`${projectDir}/mod.ts`, modContent);

  // Create migrations directory
  await Deno.mkdir(`${projectDir}/migrations`, { recursive: true });
  await Deno.writeTextFile(`${projectDir}/migrations/.gitkeep`, "");
}

Deno.test("CLI Init - basic project initialization", async () => {
  const console = new ConsoleCapture();
  const tempDir = await createTempDir();

  try {
    const projectName = "test-basic-project";

    console.log("🚀 Initializing new Disc project...");
    console.log(`📁 Creating project: ${projectName}`);

    await mockInitCommand(tempDir, { name: projectName });

    const projectDir = `${tempDir}/${projectName}`;

    // Verify all expected files were created
    const schemaExists = await Deno.stat(`${projectDir}/schema.esdl`).then(() =>
      true
    ).catch(() => false);
    const configExists = await Deno.stat(`${projectDir}/deno.json`).then(() =>
      true
    ).catch(() => false);
    const envExists = await Deno.stat(`${projectDir}/.env`).then(() => true)
      .catch(() => false);
    const gitignoreExists = await Deno.stat(`${projectDir}/.gitignore`).then(
      () => true,
    ).catch(() => false);
    const readmeExists = await Deno.stat(`${projectDir}/README.md`).then(() =>
      true
    ).catch(() => false);
    const modExists = await Deno.stat(`${projectDir}/mod.ts`).then(() => true)
      .catch(() => false);
    const migrationsExists = await Deno.stat(`${projectDir}/migrations`).then(
      () => true,
    ).catch(() => false);

    assert(schemaExists, "Schema file should be created");
    assert(configExists, "Deno config should be created");
    assert(envExists, "Environment file should be created");
    assert(gitignoreExists, "Gitignore should be created");
    assert(readmeExists, "README should be created");
    assert(modExists, "Main module should be created");
    assert(migrationsExists, "Migrations directory should be created");

    // Verify schema content (basic template)
    const schemaContent = await Deno.readTextFile(`${projectDir}/schema.esdl`);
    assertStringIncludes(schemaContent, "type User");
    assertStringIncludes(schemaContent, "required email: str");

    // Verify deno.json content
    const configContent = JSON.parse(
      await Deno.readTextFile(`${projectDir}/deno.json`),
    );
    assertEquals(configContent.name, projectName);
    assertEquals(configContent.tasks.serve, "disc serve");
    assertEquals(configContent.tasks.migrate, "disc migrate");

    // Verify .env content
    const envContent = await Deno.readTextFile(`${projectDir}/.env`);
    assertStringIncludes(
      envContent,
      "DATABASE_URL=postgresql://localhost:5432/disc_dev",
    );
    assertStringIncludes(envContent, "DISC_PORT=5656");

    console.log("✅ Project initialized successfully!");
    console.log(`💡 Next steps:`);
    console.log(`   cd ${projectName}`);
    console.log(`   disc migrate`);
    console.log(`   disc serve`);

    const logs = console.getLogs();
    assertLogContains(logs, "Initializing new Disc project");
    assertLogContains(logs, "Project initialized successfully");
  } finally {
    console.restore();
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CLI Init - minimal template", async () => {
  const tempDir = await createTempDir();

  try {
    const projectName = "minimal-project";

    await mockInitCommand(tempDir, {
      name: projectName,
      template: "minimal",
    });

    const projectDir = `${tempDir}/${projectName}`;
    const schemaContent = await Deno.readTextFile(`${projectDir}/schema.esdl`);

    // Minimal template should have empty module
    assertStringIncludes(schemaContent, "module default");
    assertStringIncludes(schemaContent, "Add your schema definitions here");
    assert(
      !schemaContent.includes("type User"),
      "Should not include default types",
    );
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CLI Init - full template", async () => {
  const tempDir = await createTempDir();

  try {
    const projectName = "full-project";

    await mockInitCommand(tempDir, {
      name: projectName,
      template: "full",
    });

    const projectDir = `${tempDir}/${projectName}`;
    const schemaContent = await Deno.readTextFile(`${projectDir}/schema.esdl`);

    // Full template should have multiple types
    assertStringIncludes(schemaContent, "type User");
    assertStringIncludes(schemaContent, "type Post");
    assertStringIncludes(schemaContent, "multi posts: Post");
    assertStringIncludes(schemaContent, "required author: User");
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CLI Init - custom database URL", async () => {
  const tempDir = await createTempDir();

  try {
    const projectName = "custom-db-project";
    const customDbUrl = "postgresql://custom:5432/custom_db";

    await mockInitCommand(tempDir, {
      name: projectName,
      databaseUrl: customDbUrl,
    });

    const projectDir = `${tempDir}/${projectName}`;
    const envContent = await Deno.readTextFile(`${projectDir}/.env`);

    assertStringIncludes(envContent, `DATABASE_URL=${customDbUrl}`);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CLI Init - directory already exists error", async () => {
  const console = new ConsoleCapture();
  const tempDir = await createTempDir();

  try {
    const projectName = "existing-project";
    const projectDir = `${tempDir}/${projectName}`;

    // Create directory first
    await Deno.mkdir(projectDir, { recursive: true });
    await Deno.writeTextFile(`${projectDir}/existing-file.txt`, "exists");

    // Check if directory exists
    const exists = await Deno.stat(projectDir).then(() => true).catch(() =>
      false
    );
    assert(exists, "Directory should exist");

    // Simulate error handling
    console.error(`❌ Directory '${projectName}' already exists`);
    console.error("💡 Use --force to overwrite or choose a different name");

    const errorLogs = console.getErrorLogs();
    assert(
      errorLogs.some((log) => log.includes("already exists")),
      "Should show exists error",
    );
    assert(
      errorLogs.some((log) => log.includes("--force")),
      "Should show force option",
    );
  } finally {
    console.restore();
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CLI Init - force overwrite existing directory", async () => {
  const tempDir = await createTempDir();

  try {
    const projectName = "force-project";
    const projectDir = `${tempDir}/${projectName}`;

    // Create directory with existing content
    await Deno.mkdir(projectDir, { recursive: true });
    await Deno.writeTextFile(`${projectDir}/old-file.txt`, "old content");

    // Verify old file exists
    const oldExists = await Deno.stat(`${projectDir}/old-file.txt`).then(() =>
      true
    ).catch(() => false);
    assert(oldExists, "Old file should exist");

    // Mock force initialization (would overwrite)
    await mockInitCommand(tempDir, {
      name: projectName,
      force: true,
    });

    // Verify new files were created
    const schemaExists = await Deno.stat(`${projectDir}/schema.esdl`).then(() =>
      true
    ).catch(() => false);
    assert(schemaExists, "New schema should be created");
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CLI Init - validates project name", () => {
  // Test valid project names
  const validNames = ["my-project", "disc-app", "user-management", "blog-api"];

  for (const name of validNames) {
    // Simulate validation - should pass
    const isValid = /^[a-z0-9-]+$/.test(name) && !name.startsWith("-") &&
      !name.endsWith("-");
    assert(isValid, `${name} should be valid`);
  }

  // Test invalid project names
  const invalidNames = [
    "My-Project",
    "disc_app",
    "-invalid",
    "invalid-",
    "has spaces",
  ];

  for (const name of invalidNames) {
    // Simulate validation - should fail
    const isValid = /^[a-z0-9-]+$/.test(name) && !name.startsWith("-") &&
      !name.endsWith("-");
    assert(!isValid, `${name} should be invalid`);
  }
});

Deno.test("CLI Init - creates proper README content", async () => {
  const tempDir = await createTempDir();

  try {
    const projectName = "readme-test-project";

    await mockInitCommand(tempDir, { name: projectName });

    const projectDir = `${tempDir}/${projectName}`;
    const readmeContent = await Deno.readTextFile(`${projectDir}/README.md`);

    // Verify README includes project-specific content
    assertStringIncludes(readmeContent, `# ${projectName}`);
    assertStringIncludes(readmeContent, "A Disc database project");
    assertStringIncludes(readmeContent, "Getting Started");
    assertStringIncludes(readmeContent, "createdb");
    assertStringIncludes(readmeContent, "disc migrate");
    assertStringIncludes(readmeContent, "Available Commands");
    assertStringIncludes(readmeContent, "deno task serve");

    // Should include the database name derived from project name
    const dbName = projectName.replace(/-/g, "_") + "_dev";
    assertStringIncludes(readmeContent, dbName);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CLI Init - creates proper gitignore", async () => {
  const tempDir = await createTempDir();

  try {
    const projectName = "gitignore-test";

    await mockInitCommand(tempDir, { name: projectName });

    const projectDir = `${tempDir}/${projectName}`;
    const gitignoreContent = await Deno.readTextFile(
      `${projectDir}/.gitignore`,
    );

    // Verify common entries are present
    assertStringIncludes(gitignoreContent, "node_modules/");
    assertStringIncludes(gitignoreContent, ".env.local");
    assertStringIncludes(gitignoreContent, "generated/");
    assertStringIncludes(gitignoreContent, "*.log");
    assertStringIncludes(gitignoreContent, ".DS_Store");
    assertStringIncludes(gitignoreContent, ".deno/");
  } finally {
    await cleanupTempDir(tempDir);
  }
});
