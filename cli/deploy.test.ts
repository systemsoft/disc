import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { DeployCommand, VALID_FORMATS } from "./deploy.ts";

Deno.test("DeployCommand - rejects invalid format with helpful message", () => {
  const command = new DeployCommand();
  assertThrows(
    () => command.validateFormat("kubernetes"),
    Error,
    "Invalid format",
  );
  // Verify the error message includes valid formats
  try {
    command.validateFormat("kubernetes");
  } catch (e) {
    assertStringIncludes((e as Error).message, "docker");
    assertStringIncludes((e as Error).message, "compose");
    assertStringIncludes((e as Error).message, "systemd");
    assertStringIncludes((e as Error).message, "env");
  }
});

Deno.test("DeployCommand - default output directory is ./deploy", () => {
  const command = new DeployCommand();
  assertEquals(command.resolveOutputDir(undefined), "./deploy");
  assertEquals(command.resolveOutputDir("./custom"), "./custom");
});

Deno.test("DeployCommand - docker format generates valid Dockerfile", () => {
  const command = new DeployCommand();
  const content = command.generateDockerfile("my-app");

  assertStringIncludes(content, "FROM denoland/deno");
  assertStringIncludes(content, "EXPOSE 5656");
  assertStringIncludes(content, "DATABASE_URL");
  assertStringIncludes(content, "cli/main.ts");
  assertStringIncludes(content, "serve");
  assertStringIncludes(content, "my-app");
});

Deno.test("DeployCommand - compose format generates valid docker-compose.yml", () => {
  const command = new DeployCommand();
  const content = command.generateCompose("my-app");

  assertStringIncludes(content, "services:");
  assertStringIncludes(content, "disc:");
  assertStringIncludes(content, "postgres:");
  assertStringIncludes(content, "postgres:16-alpine");
  assertStringIncludes(content, "DATABASE_URL");
  assertStringIncludes(content, "DISC_HOST");
  assertStringIncludes(content, "pgdata");
  assertStringIncludes(content, "my-app");
});

Deno.test("DeployCommand - systemd format generates valid disc.service", () => {
  const command = new DeployCommand();
  const content = command.generateSystemd("my-app");

  assertStringIncludes(content, "[Unit]");
  assertStringIncludes(content, "[Service]");
  assertStringIncludes(content, "[Install]");
  assertStringIncludes(content, "After=network.target postgresql.service");
  // P2-10: paths are parameterized via env vars with the old defaults
  // as fallbacks, so the literal "/etc/disc/disc.env" appears inside
  // the ${…:-default} expansion.
  assertStringIncludes(content, "/etc/disc/disc.env");
  assertStringIncludes(content, "Restart=on-failure");
  assertStringIncludes(content, "ExecStart=");
  assertStringIncludes(content, "my-app");
});

Deno.test("DeployCommand - env format generates .env.production with all vars", () => {
  const command = new DeployCommand();
  const content = command.generateEnv("my-app");

  // Verify all documented env vars are present
  const requiredVars = [
    "DATABASE_URL",
    "DISC_HOST",
    "DISC_PORT",
    "DISC_JWT_SECRET",
    "DISC_ENABLE_AUTH",
    "DISC_ENABLE_ACCESS_POLICIES",
    "DISC_LOG_LEVEL",
    "DISC_LOG_FORMAT",
    "DISC_RATE_LIMIT_REQUESTS",
    "DISC_RATE_LIMIT_WINDOW_MS",
    "DISC_CACHE_MAX_SIZE",
    "DISC_SLOW_QUERY_MS",
    "DISC_TLS_CERT",
    "DISC_TLS_KEY",
    "DISC_ENABLE_METRICS",
  ];

  for (const varName of requiredVars) {
    assertStringIncludes(content, varName);
  }

  // Verify project name is used
  assertStringIncludes(content, "my-app");

  // Verify all valid formats are accounted for
  assertEquals(VALID_FORMATS.length, 4);
});
