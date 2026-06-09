/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

import { assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import {
  isPgRunning,
  resolveDsn,
  resolveProjectContext,
  type ProjectContext
} from "./project-context.ts";

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
`
    );

    const result = resolveProjectContext(dir);
    assertNotEquals(result, null);
    assertEquals(result!.projectName, "full-project");
    assertEquals(result!.instanceName, "custom-instance");
    assertEquals(result!.managed, false);
    assertEquals(result!.backendDsn, "postgresql://user:pass@host:5432/mydb");
    assertEquals(result!.serverPort, 8080);
    assertEquals(result!.serverHost, "0.0.0.0");
    /*** port/host must also reach serverOverrides so `disc serve` applies them
         (the serve command consumes serverOverrides, not serverPort/Host). ***/
    assertEquals(result!.serverOverrides?.port, 8080);
    assertEquals(result!.serverOverrides?.host, "0.0.0.0");
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
`
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
`
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

Deno.test("resolveProjectContext - [server] port/host reach overrides; absent leaves them out", async () => {
  const withPort = await makeTempDir();
  try {
    await writeToml(withPort, `name = "ported"\n[server]\nport = 9000\nhost = "0.0.0.0"\n`);
    const result = resolveProjectContext(withPort);
    assertEquals(result!.serverOverrides?.port, 9000);
    assertEquals(result!.serverOverrides?.host, "0.0.0.0");
  } finally {
    await Deno.remove(withPort, { recursive: true });
  }

  /*** When [server] omits port/host, they must NOT appear in overrides — that
       absence is what lets the env-derived DISC_PORT/DISC_HOST defaults survive
       (#1325 precedence: env < disc.toml < CLI flag). ***/
  const noPort = await makeTempDir();
  try {
    await writeToml(noPort, `name = "unported"\n[server]\nrequire_auth = true\n`);
    const result = resolveProjectContext(noPort);
    assertEquals(result!.serverOverrides?.port, undefined);
    assertEquals(result!.serverOverrides?.host, undefined);
  } finally {
    await Deno.remove(noPort, { recursive: true });
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
`
    );

    const result = resolveProjectContext(dir);
    assertNotEquals(result, null);
    assertEquals(
      result!.serverOverrides?.corsOrigins,
      ["https://app.example.com", "https://*.example.com"]
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
`
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
`
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
`
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
    socketDir: "/home/user/.disc/instances/my-project/socket"
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
    socketDir: "/home/user/.disc/instances/my-project/socket"
  };

  const dsn = resolveDsn(ctx);
  assertEquals(
    dsn,
    "postgresql://disc@/my-project?host=/home/user/.disc/instances/my-project/socket"
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
      socketDir: join(dir, "socket")
    };

    const running = await isPgRunning(ctx);
    assertEquals(running, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/**
 * Build a synthetic postmaster.pid in `dataDir` pointing at `pid`, with the
 * port + socket dir fields populated so isPgRunning's socket check can run.
 * Uses Deno.pid (the test runner) as a known-alive PID by default.
 */
async function writePostmasterPid(
  dataDir: string,
  options: { pid?: number; port?: number; socketDir: string; }
): Promise<void> {
  const pid = options.pid ?? Deno.pid;
  const port = options.port ?? 5432;
  // PG 16 postmaster.pid layout: PID, data dir, start epoch, port, socket dir,
  // listen address, shmem, status. Disc only reads lines 1, 4, 5.
  const contents = [
    String(pid),
    dataDir,
    "1700000000",
    String(port),
    options.socketDir,
    "",
    "",
    "ready"
  ]
    .join("\n") + "\n";
  await Deno.writeTextFile(join(dataDir, "postmaster.pid"), contents);
}

Deno.test(
  "isPgRunning - returns false when process is alive but socket file is missing",
  async () => {
    const dir = await makeTempDir();
    const socketDir = join(dir, "socket");
    await Deno.mkdir(socketDir);
    try {
      await writePostmasterPid(dir, { socketDir });

      const ctx: ProjectContext = {
        dataDir: dir,
        instanceName: "test-instance",
        managed: true,
        projectName: "test-project",
        projectRoot: dir,
        serverHost: "localhost",
        serverPort: 5656,
        socketDir
      };

      const running = await isPgRunning(ctx);
      assertEquals(running, false);

      // pid file must NOT be removed here — the live process still owns it,
      // and only the instance-level recovery path may kill the orphan.
      const pidStat = await Deno.stat(join(dir, "postmaster.pid"));
      assertEquals(pidStat.isFile, true);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
);

Deno.test(
  "isPgRunning - returns true when process is alive and socket file exists",
  async () => {
    const dir = await makeTempDir();
    const socketDir = join(dir, "socket");
    await Deno.mkdir(socketDir);
    try {
      await writePostmasterPid(dir, { socketDir });
      // Create a placeholder file at the socket path so lstat succeeds. We
      // don't need a real Unix socket — isPgRunning only checks for entry
      // existence.
      await Deno.writeTextFile(join(socketDir, ".s.PGSQL.5432"), "");

      const ctx: ProjectContext = {
        dataDir: dir,
        instanceName: "test-instance",
        managed: true,
        projectName: "test-project",
        projectRoot: dir,
        serverHost: "localhost",
        serverPort: 5656,
        socketDir
      };

      const running = await isPgRunning(ctx);
      assertEquals(running, true);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
);
