/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

import { assert, assertStringIncludes } from "@std/assert";
import { DeployCommand } from "../../cli/deploy.ts";

const cmd = new DeployCommand();

// ---------------------------------------------------------------------------
// 1. Generated Dockerfile has FROM before EXPOSE
// ---------------------------------------------------------------------------
Deno.test("Production E2E: Generated Dockerfile has FROM before EXPOSE", () => {
  const content = cmd.generateDockerfile("test-app");
  const fromIndex = content.indexOf("FROM");
  const exposeIndex = content.indexOf("EXPOSE");

  assert(fromIndex !== -1, "Dockerfile must contain FROM");
  assert(exposeIndex !== -1, "Dockerfile must contain EXPOSE");
  assert(
    fromIndex < exposeIndex,
    `FROM (index ${fromIndex}) must appear before EXPOSE (index ${exposeIndex})`
  );
});

// ---------------------------------------------------------------------------
// 2. Dockerfile CMD references cli/main.ts serve
// ---------------------------------------------------------------------------
Deno.test("Production E2E: Dockerfile CMD references cli/main.ts serve", () => {
  const content = cmd.generateDockerfile("test-app");

  // Find lines starting with CMD
  const cmdLine = content
    .split("\n")
    .find(line => line.startsWith("CMD"));

  assert(cmdLine !== undefined, "Dockerfile must contain a CMD instruction");
  assertStringIncludes(cmdLine, "cli/main.ts");
  assertStringIncludes(cmdLine, "serve");
});

// ---------------------------------------------------------------------------
// 3. Compose disc service depends_on postgres with health condition
// ---------------------------------------------------------------------------
Deno.test(
  "Production E2E: Compose disc service depends_on postgres with health condition",
  () => {
    const content = cmd.generateCompose("test-app");

    assertStringIncludes(content, "depends_on:");
    assertStringIncludes(content, "condition: service_healthy");
  }
);

// ---------------------------------------------------------------------------
// 4. Compose postgres has pg_isready healthcheck
// ---------------------------------------------------------------------------
Deno.test(
  "Production E2E: Compose postgres has pg_isready healthcheck",
  () => {
    const content = cmd.generateCompose("test-app");

    assertStringIncludes(content, "pg_isready");
  }
);

// ---------------------------------------------------------------------------
// 5. Compose includes pgdata volume definition
// ---------------------------------------------------------------------------
Deno.test(
  "Production E2E: Compose includes pgdata volume definition",
  () => {
    const content = cmd.generateCompose("test-app");

    assertStringIncludes(content, "volumes:");
    assertStringIncludes(content, "pgdata");
  }
);

// ---------------------------------------------------------------------------
// 6. Systemd unit has security hardening
// ---------------------------------------------------------------------------
Deno.test("Production E2E: Systemd unit has security hardening", () => {
  const content = cmd.generateSystemd("test-app");

  assertStringIncludes(content, "NoNewPrivileges=true");
  assertStringIncludes(content, "ProtectSystem=strict");
  assertStringIncludes(content, "ProtectHome=true");
});

// ---------------------------------------------------------------------------
// 7. Env template covers all DISC_* vars read by createServerFromEnv()
// ---------------------------------------------------------------------------
Deno.test(
  "Production E2E: Env template covers all DISC_* vars read by createServerFromEnv()",
  () => {
    const content = cmd.generateEnv("test-app");

    const requiredVars = [
      "DATABASE_URL",
      "DISC_HOST",
      "DISC_PORT",
      "DISC_JWT_SECRET",
      "DISC_ENABLE_AUTH",
      "DISC_ENABLE_ACCESS_POLICIES",
      "DISC_LOG_LEVEL",
      "DISC_LOG_FORMAT",
      "DISC_SLOW_QUERY_MS",
      "DISC_CACHE_MAX_SIZE",
      "DISC_TLS_CERT",
      "DISC_TLS_KEY",
      "DISC_ENABLE_METRICS"
    ];

    for (const varName of requiredVars) {
      assertStringIncludes(
        content,
        varName,
        `Env template must include ${varName}`
      );
    }
  }
);

// ---------------------------------------------------------------------------
// 8. All four formats generate non-empty content containing project name
// ---------------------------------------------------------------------------
Deno.test(
  "Production E2E: All four formats generate non-empty content containing project name",
  () => {
    const projectName = "my-project";

    const generators: Array<{
      name: string;
      fn: () => string;
    }> = [
      { name: "docker", fn: () => cmd.generateDockerfile(projectName) },
      { name: "compose", fn: () => cmd.generateCompose(projectName) },
      { name: "systemd", fn: () => cmd.generateSystemd(projectName) },
      { name: "env", fn: () => cmd.generateEnv(projectName) }
    ];

    for (const { name, fn } of generators) {
      const content = fn();

      assert(
        content.length > 0,
        `${name} generator must produce non-empty content`
      );
      assertStringIncludes(
        content,
        projectName,
        `${name} output must contain project name "${projectName}"`
      );
    }
  }
);
