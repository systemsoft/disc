import { assertEquals, assertNotEquals } from "@std/assert";
import {
  isPgRunning,
  type ProjectContext,
  resolveDsn,
  resolveProjectContext,
} from "./project-context.ts";
import { join } from "@std/path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a temporary directory for a single test and return its path.
 * Caller is responsible for removing it via `Deno.remove(dir, { recursive: true })`.
 */
async function makeTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "disc-project-context-test-" });
}

/**
 * Write `disc.toml` into `dir` with the given content string.
 */
async function writeToml(dir: string, content: string): Promise<void> {
  await Deno.writeTextFile(join(dir, "disc.toml"), content);
}

// ---------------------------------------------------------------------------
// resolveProjectContext
// ---------------------------------------------------------------------------

Deno.test("resolveProjectContext - returns null when no disc.toml", async () => {
  const dir = await makeTempDir();
  try {
    const result = resolveProjectContext(dir);
    assertEquals(result, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveProjectContext - finds disc.toml in cwd", async () => {
  const dir = await makeTempDir();
  try {
    await writeToml(dir, `name = "my-project"\n`);

    const result = resolveProjectContext(dir);
    assertNotEquals(result, null);
    assertEquals(result!.projectName, "my-project");
    assertEquals(result!.projectRoot, dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveProjectContext - walks up directories", async () => {
  const parentDir = await makeTempDir();
  const childDir = join(parentDir, "sub", "nested");
  try {
    await Deno.mkdir(childDir, { recursive: true });
    await writeToml(parentDir, `name = "ancestor-project"\n`);

    // Resolve from grandchild directory — should find the parent's disc.toml
    const result = resolveProjectContext(childDir);
    assertNotEquals(result, null);
    assertEquals(result!.projectName, "ancestor-project");
    assertEquals(result!.projectRoot, parentDir);
  } finally {
    await Deno.remove(parentDir, { recursive: true });
  }
});

Deno.test("resolveProjectContext - parses all TOML fields", async () => {
  const dir = await makeTempDir();
  try {
    await writeToml(
      dir,
      `# Disc Project Configuration
name = "full-project"
version = "0.1.0"

[database]
managed = false
instance_name = "custom-instance"
backend_dsn = "postgresql://user:pass@host:5432/mydb"

[server]
port = 8080
host = "0.0.0.0"
`,
    );

    const result = resolveProjectContext(dir);
    assertNotEquals(result, null);
    assertEquals(result!.projectName, "full-project");
    assertEquals(result!.instanceName, "custom-instance");
    assertEquals(result!.managed, false);
    assertEquals(result!.backendDsn, "postgresql://user:pass@host:5432/mydb");
    assertEquals(result!.serverPort, 8080);
    assertEquals(result!.serverHost, "0.0.0.0");
    assertEquals(result!.projectRoot, dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveProjectContext - defaults when sections missing", async () => {
  const dir = await makeTempDir();
  try {
    await writeToml(dir, `name = "minimal-project"\n`);

    const result = resolveProjectContext(dir);
    assertNotEquals(result, null);
    assertEquals(result!.projectName, "minimal-project");
    // instanceName falls back to projectName
    assertEquals(result!.instanceName, "minimal-project");
    // managed defaults to true
    assertEquals(result!.managed, true);
    // serverPort defaults to 5656
    assertEquals(result!.serverPort, 5656);
    // serverHost defaults to "localhost"
    assertEquals(result!.serverHost, "localhost");
    // backendDsn is absent
    assertEquals(result!.backendDsn, undefined);
    // serverOverrides absent when no `[server]` knobs present
    assertEquals(result!.serverOverrides, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// resolveProjectContext - serverOverrides (#1325)
// ---------------------------------------------------------------------------

Deno.test("resolveProjectContext - parses [server] booleans into overrides", async () => {
  const dir = await makeTempDir();
  try {
    await writeToml(
      dir,
      `name = "boolean-project"
[server]
require_auth = true
read_only = false
enable_cors = true
enable_websockets = false
enable_metrics = true
trust_proxy = true
cors_allow_credentials = true
`,
    );

    const result = resolveProjectContext(dir);
    assertNotEquals(result, null);
    const overrides = result!.serverOverrides;
    assertNotEquals(overrides, undefined);
    assertEquals(overrides!.requireAuth, true);
    assertEquals(overrides!.readOnly, false);
    assertEquals(overrides!.enableCors, true);
    assertEquals(overrides!.enableWebsockets, false);
    assertEquals(overrides!.enableMetrics, true);
    assertEquals(overrides!.trustProxy, true);
    assertEquals(overrides!.corsAllowCredentials, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveProjectContext - parses [server] integers into overrides", async () => {
  const dir = await makeTempDir();
  try {
    await writeToml(
      dir,
      `name = "integer-project"
[server]
max_request_body_bytes = 16777216
request_timeout = 30000
rate_limit_rpm = 600
`,
    );

    const result = resolveProjectContext(dir);
    assertNotEquals(result, null);
    const overrides = result!.serverOverrides;
    assertNotEquals(overrides, undefined);
    assertEquals(overrides!.maxRequestBodyBytes, 16777216);
    assertEquals(overrides!.requestTimeout, 30000);
    assertEquals(overrides!.rateLimitRpm, 600);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveProjectContext - parses cors_origins inline array", async () => {
  const dir = await makeTempDir();
  try {
    await writeToml(
      dir,
      `name = "cors-project"
[server]
cors_origins = ["https://app.example.com", "https://*.example.com"]
`,
    );

    const result = resolveProjectContext(dir);
    assertNotEquals(result, null);
    assertEquals(
      result!.serverOverrides?.corsOrigins,
      ["https://app.example.com", "https://*.example.com"],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveProjectContext - parses empty cors_origins array", async () => {
  const dir = await makeTempDir();
  try {
    await writeToml(
      dir,
      `name = "empty-cors"
[server]
cors_origins = []
`,
    );

    const result = resolveProjectContext(dir);
    assertNotEquals(result, null);
    // Empty array still surfaces — the user explicitly disabled the
    // permissive default, which is meaningful (vs. omitting the key).
    assertEquals(result!.serverOverrides?.corsOrigins, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveProjectContext - drops malformed boolean and integer values", async () => {
  const dir = await makeTempDir();
  try {
    await writeToml(
      dir,
      `name = "malformed-project"
[server]
require_auth = "yes"
max_request_body_bytes = "not-a-number"
rate_limit_rpm = -5
`,
    );

    const result = resolveProjectContext(dir);
    assertNotEquals(result, null);
    // All three values fail their respective coercions. Result: no
    // override fields, so the whole struct collapses to undefined.
    assertEquals(result!.serverOverrides, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveProjectContext - boolean parser is case-insensitive", async () => {
  const dir = await makeTempDir();
  try {
    await writeToml(
      dir,
      `name = "case-project"
[server]
require_auth = TRUE
read_only = False
`,
    );

    const result = resolveProjectContext(dir);
    assertNotEquals(result, null);
    assertEquals(result!.serverOverrides?.requireAuth, true);
    assertEquals(result!.serverOverrides?.readOnly, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// resolveDsn
// ---------------------------------------------------------------------------

Deno.test("resolveDsn - returns backendDsn when set", () => {
  const ctx: ProjectContext = {
    backendDsn: "postgresql://user:pass@host:5432/mydb",
    dataDir: "/home/user/.disc/instances/my-project/data",
    instanceName: "my-project",
    managed: false,
    projectName: "my-project",
    projectRoot: "/home/user/projects/my-project",
    serverHost: "localhost",
    serverPort: 5656,
    socketDir: "/home/user/.disc/instances/my-project/socket",
  };

  const dsn = resolveDsn(ctx);
  assertEquals(dsn, "postgresql://user:pass@host:5432/mydb");
});

Deno.test("resolveDsn - builds socket DSN for managed instance", () => {
  const ctx: ProjectContext = {
    dataDir: "/home/user/.disc/instances/my-project/data",
    instanceName: "my-project",
    managed: true,
    projectName: "my-project",
    projectRoot: "/home/user/projects/my-project",
    serverHost: "localhost",
    serverPort: 5656,
    socketDir: "/home/user/.disc/instances/my-project/socket",
  };

  const dsn = resolveDsn(ctx);
  assertEquals(
    dsn,
    "postgresql://disc@/my-project?host=/home/user/.disc/instances/my-project/socket",
  );
});

// ---------------------------------------------------------------------------
// isPgRunning
// ---------------------------------------------------------------------------

Deno.test("isPgRunning - returns false when no postmaster.pid", async () => {
  const dir = await makeTempDir();
  try {
    const ctx: ProjectContext = {
      dataDir: dir,
      instanceName: "test-instance",
      managed: true,
      projectName: "test-project",
      projectRoot: dir,
      serverHost: "localhost",
      serverPort: 5656,
      socketDir: join(dir, "socket"),
    };

    const running = await isPgRunning(ctx);
    assertEquals(running, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
