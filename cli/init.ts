// deno-lint-ignore-file no-console
/**
 * CLI Init Command Implementation - Project initialization functionality
 */

import { PostgresManager } from "../postgres/mod.ts";

export interface InitOptions {
  name: string;
  template?: "basic" | "minimal" | "full";
  databaseUrl?: string;
  force?: boolean;
  directory?: string;
  backendDsn?: string; // External PostgreSQL DSN
  skipPostgres?: boolean; // Skip PostgreSQL setup
}

export class InitCommand {
  private postgresManager: PostgresManager;

  constructor(postgresManager?: PostgresManager) {
    this.postgresManager = postgresManager ?? new PostgresManager();
  }
  /**
   * Initialize a new Disc project
   */
  async execute(options: InitOptions): Promise<void> {
    // P2-16: accept both bare names (`my-app`) and path-style args
    // (`./apps/my-app`, `/tmp/foo`) — matches `git init`, `npm create`,
    // etc. The directory portion is split off and used as the parent;
    // the basename becomes the project name and is validated normally.
    const normalized = this.normalizeNameOrPath(options);
    console.log("🚀 Initializing new Disc project...");
    console.log(`📁 Creating project: ${normalized.name}`);

    // Override options with the normalized name + directory so the rest
    // of the method uses a clean bare name.
    options = { ...options, name: normalized.name, directory: normalized.directory };

    const projectDir = options.directory ? `${options.directory}/${options.name}` : `./${options.name}`;

    // Check if directory exists
    const exists = await Deno.stat(projectDir).then(() => true).catch(() => false);
    if (exists && !options.force) {
      console.error(`❌ Directory '${options.name}' already exists`);
      console.error("💡 Use --force to overwrite or choose a different name");
      throw new Error(`Directory '${options.name}' already exists`);
    }

    // Validate project name
    if (!this.isValidProjectName(options.name)) {
      console.error(`❌ Invalid project name: ${options.name}`);
      console.error(
        "💡 Project name must be lowercase letters, numbers, and hyphens only",
      );
      throw new Error(`Invalid project name: ${options.name}`);
    }

    try {
      // Create project directory
      await Deno.mkdir(projectDir, { recursive: true });

      // Create files based on template (including disc.toml so the project is
      // always resumable even if PG setup fails on this run)
      await this.createProjectFiles(projectDir, options);

      // Initialize PostgreSQL unless skipped or external DSN provided
      if (!options.skipPostgres && !options.backendDsn) {
        console.log("\n📦 Setting up bundled PostgreSQL...");
        await this.initializePostgres(options.name);
      } else if (options.backendDsn) {
        console.log(`\n🔗 Using external PostgreSQL: ${options.backendDsn}`);
      }

      console.log("\n✅ Project initialized successfully!");
      console.log(`💡 Next steps:`);
      console.log(`   cd ${options.name}`);
      if (!options.skipPostgres && !options.backendDsn) {
        console.log(`   disc start  # Start PostgreSQL`);
      }
      console.log(`   disc migrate`);
      console.log(`   disc serve`);
    } catch (error) {
      console.error(
        `❌ Failed to initialize project: ${(error as Error).message}`,
      );
      console.log(
        `💡 Project files were created at ${projectDir}; re-run 'disc start' from inside the project to finish PostgreSQL setup.`,
      );
      throw error;
    }
  }

  /**
   * Split a user-supplied name/path into `{ name, directory }`. (P2-16)
   * If the input contains a `/`, the last segment is the project name
   * and everything before it is the parent directory (replacing any
   * explicit `options.directory`). Bare names pass through unchanged.
   */
  private normalizeNameOrPath(
    options: InitOptions,
  ): { name: string; directory?: string; } {
    const raw = options.name;
    if (!raw.includes("/")) {
      return { name: raw, directory: options.directory };
    }
    const trimmed = raw.replace(/\/+$/, "");
    const lastSlash = trimmed.lastIndexOf("/");
    const directory = trimmed.substring(0, lastSlash) || "/";
    const name = trimmed.substring(lastSlash + 1);
    return { name, directory };
  }

  private isValidProjectName(name: string): boolean {
    return /^[a-z0-9-]+$/.test(name) && !name.startsWith("-")
      && !name.endsWith("-");
  }

  private async createProjectFiles(
    projectDir: string,
    options: InitOptions,
  ): Promise<void> {
    const template = options.template || "basic";

    // Create dbschema/default.disc
    await this.createSchemaFile(projectDir, template);

    // Create disc.toml (always — so project is resumable even if PG setup fails)
    await this.createDiscToml(projectDir, options);

    // Create deno.json
    await this.createDenoConfig(projectDir, options.name);

    // Create .env (socket DSN for managed, backend DSN when provided)
    await this.createEnvFile(projectDir, options);

    // Create .gitignore
    await this.createGitignore(projectDir);

    // Create README.md
    await this.createReadme(projectDir, options);

    // Create mod.ts
    await this.createModuleFile(projectDir, options.name);

    // Create migrations directory
    await Deno.mkdir(`${projectDir}/migrations`, { recursive: true });
    await Deno.writeTextFile(`${projectDir}/migrations/.gitkeep`, "");
  }

  private async createDiscToml(
    projectDir: string,
    options: InitOptions,
  ): Promise<void> {
    const projectName = options.name;
    const lines: string[] = [
      `# Disc Project Configuration`,
      `name = "${projectName}"`,
      `version = "0.1.0"`,
      ``,
      `[database]`,
    ];

    if (options.backendDsn) {
      lines.push(
        `# External PostgreSQL — disc does not manage the instance lifecycle`,
        `managed = false`,
        `backend_dsn = "${options.backendDsn}"`,
      );
    } else {
      lines.push(
        `# Managed PostgreSQL instance`,
        `managed = true`,
        `instance_name = "${projectName}"`,
      );
    }

    lines.push(``, `[server]`, `port = 5656`, `host = "localhost"`, ``);

    await Deno.writeTextFile(`${projectDir}/disc.toml`, lines.join("\n"));
  }

  private async createSchemaFile(
    projectDir: string,
    template: string,
  ): Promise<void> {
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

    await Deno.mkdir(`${projectDir}/dbschema`, { recursive: true });
    await Deno.writeTextFile(
      `${projectDir}/dbschema/default.disc`,
      schemaContent,
    );
  }

  private async createDenoConfig(
    projectDir: string,
    projectName: string,
  ): Promise<void> {
    // The tasks wrap the `disc` CLI, which must be installed and on $PATH.
    // When there is no generated client yet, mod.ts is a no-op stub; once
    // `disc codegen` runs it populates dbschema/disc-client/ which the app
    // can import directly.
    const denoConfig = {
      name: projectName,
      version: "0.1.0",
      exports: {
        ".": "./mod.ts",
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
  }

  private async createEnvFile(
    projectDir: string,
    options: InitOptions,
  ): Promise<void> {
    // For managed PG, the DSN is derived at runtime from disc.toml (socket
    // path depends on $HOME/$DISC_HOME). We keep .env focused on app config
    // and only write DATABASE_URL when the user explicitly asked for an
    // external DSN. Document the override as a comment in the managed case.
    const header = "# Disc Database Configuration";
    const appConfig = "DISC_PORT=5656\nDISC_HOST=localhost\n\n"
      + "# Development settings\nNODE_ENV=development\n";

    let envContent: string;
    if (options.backendDsn) {
      envContent = `${header}\nDATABASE_URL=${options.backendDsn}\n${appConfig}`;
    } else {
      envContent = `${header}\n# Managed PostgreSQL — the DSN is resolved from disc.toml.\n`
        + `# Set DATABASE_URL here only to override with an external database.\n${appConfig}`;
    }

    await Deno.writeTextFile(`${projectDir}/.env`, envContent);
  }

  private async createGitignore(projectDir: string): Promise<void> {
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
  }

  private async initializePostgres(projectName: string): Promise<void> {
    // disc.toml is written up-front in createProjectFiles; if this step fails,
    // the scaffold is still recoverable by re-running `disc start`.
    console.log("📋 Creating PostgreSQL instance...");

    const instance = await this.postgresManager.createInstance(projectName);

    console.log("✅ PostgreSQL instance created");
    console.log(`📁 Data directory: ${instance.getDataDir()}`);
    console.log(`🔗 Connection: ${instance.dsn()}`);
  }

  private async createReadme(
    projectDir: string,
    options: InitOptions,
  ): Promise<void> {
    const projectName = options.name;

    const startStep = options.backendDsn
      ? `1. **Point at your PostgreSQL** (already configured in \`disc.toml\`):
   Your backend DSN: \`${options.backendDsn}\``
      : `1. **Start the bundled PostgreSQL**:
   \`\`\`bash
   disc start
   \`\`\``;

    const readmeContent = `# ${projectName}

A Disc database project.

## Getting Started

${startStep}

2. **Apply the schema**:
   \`\`\`bash
   disc migrate
   \`\`\`

3. **Generate TypeScript types**:
   \`\`\`bash
   disc codegen
   \`\`\`

4. **Start the Disc server**:
   \`\`\`bash
   disc serve
   \`\`\`

## Available Commands

- \`deno task serve\` — Start the Disc server
- \`deno task migrate\` — Apply schema migrations
- \`deno task codegen\` — Generate TypeScript types
- \`deno task dev\` — Watch for schema changes
- \`deno task shell\` — Open EdgeQL REPL

These tasks require the \`disc\` binary on your \`$PATH\`.

## Schema

Your schema is defined in \`dbschema/default.disc\`. Edit this file to modify
your database structure. Additional \`.disc\` files in \`dbschema/\` are
auto-discovered.

## Configuration

- \`disc.toml\` — project and database configuration (committed)
- \`.env\` — environment overrides (copy to \`.env.local\` for local tweaks)
`;

    await Deno.writeTextFile(`${projectDir}/README.md`, readmeContent);
  }

  private async createModuleFile(
    projectDir: string,
    projectName: string,
  ): Promise<void> {
    // Placeholder entry point. After `disc codegen` runs, the typical pattern
    // is to re-export from the generated client:
    //   export * from "./dbschema/disc-client/mod.ts";
    const modContent = `// Main module for ${projectName}
// Run \`disc codegen\` to generate a TypeScript client at
// ./dbschema/disc-client/, then import from it here.
export {};
`;

    await Deno.writeTextFile(`${projectDir}/mod.ts`, modContent);
  }
}

export const initCommand = new InitCommand();
