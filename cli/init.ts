/**
 * CLI Init Command Implementation - Project initialization functionality
 */

export interface InitOptions {
  name: string;
  template?: "basic" | "minimal" | "full";
  database_url?: string;
  force?: boolean;
  directory?: string;
}

export class InitCommand {
  /**
   * Initialize a new Disc project
   */
  async execute(options: InitOptions): Promise<void> {
    console.log("🚀 Initializing new Disc project...");
    console.log(`📁 Creating project: ${options.name}`);

    const projectDir = options.directory 
      ? `${options.directory}/${options.name}`
      : `./${options.name}`;

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
      console.error("💡 Project name must be lowercase letters, numbers, and hyphens only");
      throw new Error(`Invalid project name: ${options.name}`);
    }

    try {
      // Create project directory
      await Deno.mkdir(projectDir, { recursive: true });

      // Create files based on template
      await this.createProjectFiles(projectDir, options);

      console.log("✅ Project initialized successfully!");
      console.log(`💡 Next steps:`);
      console.log(`   cd ${options.name}`);
      console.log(`   disc migrate`);
      console.log(`   disc serve`);
    } catch (error) {
      console.error(`❌ Failed to initialize project: ${error.message}`);
      throw error;
    }
  }

  private isValidProjectName(name: string): boolean {
    return /^[a-z0-9-]+$/.test(name) && !name.startsWith('-') && !name.endsWith('-');
  }

  private async createProjectFiles(projectDir: string, options: InitOptions): Promise<void> {
    const template = options.template || "basic";
    const databaseUrl = options.database_url || "postgresql://localhost:5432/disc_dev";

    // Create schema.esdl
    await this.createSchemaFile(projectDir, template);

    // Create deno.json
    await this.createDenoConfig(projectDir, options.name);

    // Create .env
    await this.createEnvFile(projectDir, databaseUrl);

    // Create .gitignore
    await this.createGitignore(projectDir);

    // Create README.md
    await this.createReadme(projectDir, options.name);

    // Create mod.ts
    await this.createModuleFile(projectDir, options.name);

    // Create migrations directory
    await Deno.mkdir(`${projectDir}/migrations`, { recursive: true });
    await Deno.writeTextFile(`${projectDir}/migrations/.gitkeep`, "");
  }

  private async createSchemaFile(projectDir: string, template: string): Promise<void> {
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
    created_at: datetime {
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
    created_at: datetime {
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
    created_at: datetime {
      default := datetime_current();
    };
    updated_at: datetime {
      default := datetime_current();
    };
  };
};`;
        break;
    }

    await Deno.writeTextFile(`${projectDir}/schema.esdl`, schemaContent);
  }

  private async createDenoConfig(projectDir: string, projectName: string): Promise<void> {
    const denoConfig = {
      name: projectName,
      version: "0.1.0",
      exports: {
        ".": "./mod.ts"
      },
      imports: {
        "@disc/db": "jsr:@disc/db@*"
      },
      tasks: {
        "serve": "disc serve",
        "migrate": "disc migrate",
        "codegen": "disc codegen",
        "dev": "disc watch",
        "shell": "disc shell"
      }
    };

    await Deno.writeTextFile(
      `${projectDir}/deno.json`, 
      JSON.stringify(denoConfig, null, 2)
    );
  }

  private async createEnvFile(projectDir: string, databaseUrl: string): Promise<void> {
    const envContent = `# Disc Database Configuration
DATABASE_URL=${databaseUrl}
DISC_PORT=5656
DISC_HOST=localhost

# Development settings
NODE_ENV=development
`;

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

  private async createReadme(projectDir: string, projectName: string): Promise<void> {
    const dbName = projectName.replace(/-/g, '_') + '_dev';
    
    const readmeContent = `# ${projectName}

A Disc database project.

## Getting Started

1. **Setup database**:
   \`\`\`bash
   createdb ${dbName}
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
  }

  private async createModuleFile(projectDir: string, projectName: string): Promise<void> {
    const modContent = `// Main module for ${projectName}
export * from "@disc/db";
`;

    await Deno.writeTextFile(`${projectDir}/mod.ts`, modContent);
  }
}

export const initCommand = new InitCommand();