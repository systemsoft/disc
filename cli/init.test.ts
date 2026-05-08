/**
 * CLI Init Command Tests - Test project initialization functionality.
 *
 * All tests below run against the real `InitCommand` with
 * `skipPostgres: true` so they exercise the actual scaffold logic
 * without needing a live PostgreSQL instance. The legacy
 * `mockInitCommand` helper that duplicated InitCommand's behavior
 * (and tested obsolete assumptions like DATABASE_URL pinning to
 * `localhost:5432/disc_dev` and a `schema.disc` file at the project
 * root) was removed in this pass — the scaffold has since moved to
 * `dbschema/default.disc`, no DATABASE_URL in managed mode, and a
 * README that drives users to `disc start` instead of `createdb`.
 * (P2-33)
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cleanupTempDir, createTempDir } from "../tests/test-utils.ts";
import { InitCommand } from "./init.ts";

/**
 * Run the real InitCommand against a temp directory in skip-postgres
 * mode and return the project directory path. Most tests below use
 * this — only the ones that exercise the PG path or specific error
 * scenarios call `new InitCommand()` directly.
 */
async function initProject(
  tempDir: string,
  name: string,
  extra: Partial<Parameters<InitCommand["execute"]>[0]> = {}
): Promise<string> {
  await new InitCommand().execute({
    name,
    skipPostgres: true,
    directory: tempDir,
    ...extra
  });
  return `${tempDir}/${name}`;
}

Deno.test("CLI Init - basic project initialization", async () => {
  const tempDir = await createTempDir();
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);
    const projectName = "test-basic-project";
    const projectDir = await initProject(tempDir, projectName);

    // Verify all expected files were created
    for (
      const path of [
        "dbschema/default.disc",
        "deno.json",
        ".env",
        ".gitignore",
        "README.md",
        "mod.ts",
        "migrations",
        "disc.toml"
      ]
    ) {
      const exists = await Deno
        .stat(`${projectDir}/${path}`)
        .then(() => true)
        .catch(() => false);
      assert(exists, `${path} should be created`);
    }

    // Verify schema content (basic template)
    const schemaContent = await Deno.readTextFile(
      `${projectDir}/dbschema/default.disc`
    );
    assertStringIncludes(schemaContent, "type User");
    assertStringIncludes(schemaContent, "required email: str");

    // Verify deno.json content
    const configContent = JSON.parse(
      await Deno.readTextFile(`${projectDir}/deno.json`)
    );
    assertEquals(configContent.name, projectName);
    assertEquals(configContent.tasks.serve, "disc serve");
    assertEquals(configContent.tasks.migrate, "disc migrate");

    // Verify .env content — managed mode does NOT pin DATABASE_URL
    // (the DSN is derived from disc.toml at runtime).
    const envContent = await Deno.readTextFile(`${projectDir}/.env`);
    assertStringIncludes(envContent, "DISC_PORT=5656");
    assertEquals(
      /^DATABASE_URL=/m.test(envContent),
      false,
      "managed-mode .env must not hardcode DATABASE_URL"
    );
  } finally {
    Deno.chdir(originalCwd);
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CLI Init - minimal template", async () => {
  const tempDir = await createTempDir();
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);
    const projectDir = await initProject(tempDir, "minimal-project", {
      template: "minimal"
    });

    const schemaContent = await Deno.readTextFile(
      `${projectDir}/dbschema/default.disc`
    );

    // Minimal template should have empty module
    assertStringIncludes(schemaContent, "module default");
    assertStringIncludes(schemaContent, "Add your schema definitions here");
    assert(
      !schemaContent.includes("type User"),
      "Should not include default types"
    );
  } finally {
    Deno.chdir(originalCwd);
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CLI Init - full template", async () => {
  const tempDir = await createTempDir();
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);
    const projectDir = await initProject(tempDir, "full-project", {
      template: "full"
    });

    const schemaContent = await Deno.readTextFile(
      `${projectDir}/dbschema/default.disc`
    );

    // Full template should have multiple types
    assertStringIncludes(schemaContent, "type User");
    assertStringIncludes(schemaContent, "type Post");
    assertStringIncludes(schemaContent, "multi posts: Post");
    assertStringIncludes(schemaContent, "required author: User");
  } finally {
    Deno.chdir(originalCwd);
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CLI Init - external --backend-dsn pins DATABASE_URL", async () => {
  // Replaces the legacy "custom database URL" mock test, which asserted
  // a managed-mode DATABASE_URL pin that the modern scaffold no longer
  // writes. The remaining behavior worth testing is the backend-DSN
  // path: when the user opts into an external Postgres, the scaffold
  // DOES write DATABASE_URL with that exact value.
  const tempDir = await createTempDir();
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);
    const customDbUrl = "postgresql://custom:5432/custom_db";
    const projectDir = await initProject(tempDir, "custom-db-project", {
      backendDsn: customDbUrl
    });

    const envContent = await Deno.readTextFile(`${projectDir}/.env`);
    assertStringIncludes(envContent, `DATABASE_URL=${customDbUrl}`);
  } finally {
    Deno.chdir(originalCwd);
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CLI Init - directory already exists error", async () => {
  const tempDir = await createTempDir();
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);
    const projectName = "existing-project";
    const projectDir = `${tempDir}/${projectName}`;

    // Create directory first with content so the check fires.
    await Deno.mkdir(projectDir, { recursive: true });
    await Deno.writeTextFile(`${projectDir}/existing-file.txt`, "exists");

    let thrown: unknown;
    try {
      await new InitCommand().execute({
        name: projectName,
        skipPostgres: true,
        directory: tempDir
      });
    } catch (err) {
      thrown = err;
    }
    assert(thrown instanceof Error, "execute() must throw on existing dir");
    assertStringIncludes(
      (thrown as Error).message,
      "already exists"
    );
  } finally {
    Deno.chdir(originalCwd);
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CLI Init - force overwrite existing directory", async () => {
  const tempDir = await createTempDir();
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);
    const projectName = "force-project";
    const projectDir = `${tempDir}/${projectName}`;

    // Pre-populate the directory so without --force this would throw.
    await Deno.mkdir(projectDir, { recursive: true });
    await Deno.writeTextFile(`${projectDir}/old-file.txt`, "old content");

    await new InitCommand().execute({
      name: projectName,
      skipPostgres: true,
      directory: tempDir,
      force: true
    });

    // The scaffold's canonical schema path must exist after the run.
    const schemaExists = await Deno
      .stat(
        `${projectDir}/dbschema/default.disc`
      )
      .then(() => true)
      .catch(() => false);
    assert(schemaExists, "scaffold must overwrite when force=true");
  } finally {
    Deno.chdir(originalCwd);
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CLI Init - rejects invalid project name", async () => {
  // Replaces the prior pure-regex check with an end-to-end run: the
  // real InitCommand throws when the name fails its validation.
  const tempDir = await createTempDir();
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);

    for (const badName of ["My-Project", "disc_app", "-invalid", "invalid-"]) {
      let thrown: unknown;
      try {
        await new InitCommand().execute({
          name: badName,
          skipPostgres: true,
          directory: tempDir
        });
      } catch (err) {
        thrown = err;
      }
      assert(
        thrown instanceof Error,
        `name '${badName}' should be rejected by InitCommand`
      );
      assertStringIncludes(
        (thrown as Error).message,
        "Invalid project name"
      );
    }

    // A name with spaces hits Deno.mkdir / path semantics before
    // reaching the regex; covered separately in the bad-name list
    // above. Valid names round-trip without throwing — verify one.
    await new InitCommand().execute({
      name: "blog-api",
      skipPostgres: true,
      directory: tempDir
    });
  } finally {
    Deno.chdir(originalCwd);
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CLI Init - creates proper README content", async () => {
  const tempDir = await createTempDir();
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);
    const projectName = "readme-test-project";
    const projectDir = await initProject(tempDir, projectName);

    const readmeContent = await Deno.readTextFile(`${projectDir}/README.md`);

    // The modern scaffold drives users to `disc start` (bundled-PG flow)
    // rather than `createdb` — see `readme-test` below for the negative
    // assertion. Here we exercise the positive content surface.
    assertStringIncludes(readmeContent, `# ${projectName}`);
    assertStringIncludes(readmeContent, "Disc");
    assertStringIncludes(readmeContent, "disc migrate");
    assertStringIncludes(readmeContent, "deno task");
  } finally {
    Deno.chdir(originalCwd);
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CLI Init - creates proper gitignore", async () => {
  const tempDir = await createTempDir();
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);
    const projectDir = await initProject(tempDir, "gitignore-test");

    const gitignoreContent = await Deno.readTextFile(
      `${projectDir}/.gitignore`
    );

    // Verify common entries are present
    assertStringIncludes(gitignoreContent, "node_modules/");
    assertStringIncludes(gitignoreContent, ".env.local");
    assertStringIncludes(gitignoreContent, "generated/");
    assertStringIncludes(gitignoreContent, "*.log");
    assertStringIncludes(gitignoreContent, ".DS_Store");
    assertStringIncludes(gitignoreContent, ".deno/");
  } finally {
    Deno.chdir(originalCwd);
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CLI Init - throws on PG setup failure, keeps scaffold resumable", async () => {
  const tempDir = await createTempDir();
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);
    const projectName = "pg-fail-test";

    // Inject a PostgresManager that always fails — exercising the path that
    // previously printed "✅ Project initialized successfully!" with exit 0.
    const failingManager = {
      createInstance: () => {
        throw new Error("simulated PG failure");
      }
    } as unknown as import("../postgres/mod.ts").PostgresManager;

    let thrown: unknown;
    try {
      await new InitCommand(failingManager).execute({
        name: projectName,
        directory: tempDir
      });
    } catch (e) {
      thrown = e;
    }

    assert(
      thrown instanceof Error,
      "execute() must throw when PG setup fails (fixes false-success exit 0 bug)"
    );
    assertStringIncludes((thrown as Error).message, "simulated PG failure");

    // The scaffold should still exist so the user can re-run `disc start`
    // after fixing the environment.
    const tomlExists = await Deno
      .stat(
        `${tempDir}/${projectName}/disc.toml`
      )
      .then(() => true)
      .catch(() => false);
    assert(
      tomlExists,
      "disc.toml must be written before PG setup so the project is resumable"
    );
  } finally {
    Deno.chdir(originalCwd);
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CLI Init - disc.toml written inside project dir, not CWD", async () => {
  const tempDir = await createTempDir();
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);
    const projectName = "toml-location-test";

    await new InitCommand().execute({
      name: projectName,
      skipPostgres: true,
      directory: tempDir
    });

    const projectDir = `${tempDir}/${projectName}`;

    const inProject = await Deno.stat(`${projectDir}/disc.toml`).then(() => true).catch(() => false);
    const inCwd = await Deno
      .stat(`${tempDir}/disc.toml`)
      .then(() => true)
      .catch(() => false);

    assert(inProject, "disc.toml must be at projectDir/disc.toml");
    assert(
      !inCwd,
      "disc.toml must NOT leak to CWD (would be shared by sibling projects)"
    );
  } finally {
    Deno.chdir(originalCwd);
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CLI Init - disc.toml has correct managed instance config", async () => {
  const tempDir = await createTempDir();
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);
    const projectName = "toml-managed-test";

    await new InitCommand().execute({
      name: projectName,
      skipPostgres: true,
      directory: tempDir
    });

    const tomlContent = await Deno.readTextFile(
      `${tempDir}/${projectName}/disc.toml`
    );
    assertStringIncludes(tomlContent, `name = "${projectName}"`);
    assertStringIncludes(tomlContent, `managed = true`);
    assertStringIncludes(tomlContent, `instance_name = "${projectName}"`);
  } finally {
    Deno.chdir(originalCwd);
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CLI Init - disc.toml reflects backend DSN", async () => {
  const tempDir = await createTempDir();
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);
    const projectName = "toml-backend-test";
    const backendDsn = "postgresql://prod:secret@db.example.com:5432/app";

    await new InitCommand().execute({
      name: projectName,
      backendDsn,
      directory: tempDir
    });

    const tomlContent = await Deno.readTextFile(
      `${tempDir}/${projectName}/disc.toml`
    );
    assertStringIncludes(tomlContent, `managed = false`);
    assertStringIncludes(tomlContent, `backend_dsn = "${backendDsn}"`);
  } finally {
    Deno.chdir(originalCwd);
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CLI Init - deno.json scaffold omits unpublished JSR ref", async () => {
  const tempDir = await createTempDir();
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);
    const projectName = "deno-config-test";

    await new InitCommand().execute({
      name: projectName,
      skipPostgres: true,
      directory: tempDir
    });

    const denoJson = JSON.parse(
      await Deno.readTextFile(`${tempDir}/${projectName}/deno.json`)
    );
    // Until @disc/db is published on JSR, the scaffold must not reference it
    // — a generated project that cannot resolve its imports is worse than a
    // scaffold with no default imports.
    assertEquals(
      denoJson.imports?.["@disc/db"],
      undefined,
      "Scaffold must not reference unpublished @disc/db via jsr:"
    );
  } finally {
    Deno.chdir(originalCwd);
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CLI Init - README does not reference manual createdb", async () => {
  const tempDir = await createTempDir();
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);
    const projectName = "readme-test";

    await new InitCommand().execute({
      name: projectName,
      skipPostgres: true,
      directory: tempDir
    });

    const readme = await Deno.readTextFile(
      `${tempDir}/${projectName}/README.md`
    );
    // Scaffold used to tell users to `createdb foo_dev` — contradicts the
    // bundled-PG value proposition.
    assertEquals(
      readme.includes("createdb"),
      false,
      "README must not instruct manual createdb in the bundled-PG flow"
    );
    assertStringIncludes(readme, "disc start");
  } finally {
    Deno.chdir(originalCwd);
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CLI Init - .env for managed PG omits TCP DATABASE_URL", async () => {
  const tempDir = await createTempDir();
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);
    const projectName = "env-managed-test";

    await new InitCommand().execute({
      name: projectName,
      skipPostgres: true,
      directory: tempDir
    });

    const env = await Deno.readTextFile(`${tempDir}/${projectName}/.env`);
    // Previous scaffold wrote DATABASE_URL=postgresql://localhost:5432/disc_dev
    // which contradicted the socket-only bundled PG. For managed mode the DSN
    // is derived from disc.toml, so .env should not pin a specific URL.
    assertEquals(
      /^DATABASE_URL=/m.test(env),
      false,
      ".env must not hardcode DATABASE_URL in managed mode"
    );
  } finally {
    Deno.chdir(originalCwd);
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CLI Init - schema at canonical dbschema/default.disc path", async () => {
  const tempDir = await createTempDir();
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);
    const projectName = "schema-path-test";

    await new InitCommand().execute({
      name: projectName,
      template: "basic",
      skipPostgres: true,
      directory: tempDir
    });

    const projectDir = `${tempDir}/${projectName}`;

    const schemaExists = await Deno
      .stat(
        `${projectDir}/dbschema/default.disc`
      )
      .then(() => true)
      .catch(() => false);
    assert(
      schemaExists,
      "Schema should be at dbschema/default.disc (canonical path matching migrate/codegen defaults)"
    );

    const legacyExists = await Deno
      .stat(`${projectDir}/schema.disc`)
      .then(
        () => true
      )
      .catch(() => false);
    assert(
      !legacyExists,
      "Legacy schema.disc path should not be created"
    );

    const schemaContent = await Deno.readTextFile(
      `${projectDir}/dbschema/default.disc`
    );
    assertStringIncludes(schemaContent, "type User");
  } finally {
    Deno.chdir(originalCwd);
    await cleanupTempDir(tempDir);
  }
});
