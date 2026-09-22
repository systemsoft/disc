/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Service credential — configuration side (`DiscServer`).
 *
 * Env/CLI only (`DISC_SERVICE_TOKEN`; the CLI forwards `--service-token`
 * to it), at least 32 bytes or the server refuses to boot, never
 * hot-reloaded, and never written to a log line — not even the one that
 * rejects it or the one that says it cannot be reloaded.
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { configureLogging } from "../lib/logger.ts";
import { EnvMock } from "../tests/test-utils.ts";
import { HttpServer } from "./http.ts";
import { buildEnvOptions, checkServiceToken, DiscServer } from "./server.ts";
import type { ProtocolHandler, QueryError, QueryRequest, QueryResponse } from "./types.ts";

const TOKEN_A = "service-token-A-0123456789abcdef-0123456789";
const TOKEN_B = "service-token-B-0123456789abcdef-0123456789";
const TINY = "tiny-token";

/** Capture every log line while `fn` runs, then restore the default output. */
async function captureLogs(fn: () => Promise<void> | void): Promise<string[]> {
  const lines: string[] = [];
  configureLogging({ output: line => lines.push(line) });
  try {
    await fn();
  } finally {
    configureLogging({ output: undefined });
  }
  return lines;
}

function stubHandler(): ProtocolHandler {
  return {
    handleRequest(_request: QueryRequest): Promise<QueryResponse> {
      return Promise.resolve({ data: null });
    },
    validateRequest(_request: QueryRequest): QueryError[] {
      return [];
    }
  };
}

Deno.test("service token config: buildEnvOptions reads DISC_SERVICE_TOKEN and nothing else", () => {
  const env = new EnvMock();
  try {
    env.clear("DISC_SERVICE_TOKEN");
    assertEquals(buildEnvOptions().serviceToken, undefined);

    env.set("DISC_SERVICE_TOKEN", TOKEN_A);
    assertEquals(buildEnvOptions().serviceToken, TOKEN_A);
  } finally {
    env.restore();
  }
});

Deno.test("service token config: the option lands on the server config", () => {
  const server = new DiscServer({ serviceToken: TOKEN_A });
  assertEquals(server.get_config().serviceToken, TOKEN_A);
  assertEquals(new DiscServer().get_config().serviceToken, undefined);
});

Deno.test("service token config: checkServiceToken rejects a token under 32 bytes without echoing it", () => {
  let message = "";
  try {
    checkServiceToken({ serviceToken: TINY });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertStringIncludes(message, "at least 32 bytes");
  assertStringIncludes(message, "DISC_SERVICE_TOKEN");
  assertStringIncludes(message, `got ${TINY.length}`);
  assert(!message.includes(TINY), "the rejected token must not appear in the error message");
});

Deno.test("service token config: checkServiceToken measures bytes, not characters", () => {
  // 31 characters, 33 UTF-8 bytes: passes the byte rule; 31 ASCII does not.
  checkServiceToken({ enableAccessPolicies: true, serviceToken: "é" + "a".repeat(30) + "é" });
  let threw = false;
  try {
    checkServiceToken({ enableAccessPolicies: true, serviceToken: "a".repeat(31) });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("service token config: no token configured is fine, and an empty one counts as none", () => {
  checkServiceToken({});
  checkServiceToken({ serviceToken: undefined });
  checkServiceToken({ serviceToken: "" });
});

Deno.test("service token config: start() refuses to boot on a short token before touching anything", async () => {
  const server = new DiscServer({ dryRun: true, protocol: "full", serviceToken: TINY });
  const lines = await captureLogs(async () => {
    await assertRejects(() => server.start(), Error, "at least 32 bytes");
  });
  assertEquals(server.getHttpServer(), undefined, "nothing should have been started");
  for (const line of lines) {
    assert(!line.includes(TINY), `log line echoes the token: ${line}`);
  }
});

Deno.test("service token config: warns at boot when a token is set while access policies are off", async () => {
  const lines = await captureLogs(() => {
    checkServiceToken({ serviceToken: TOKEN_A });
  });
  const warning = lines.find(line => /WARN/.test(line) && /service token/i.test(line));
  assert(warning, `expected a warning about access policies, got: ${JSON.stringify(lines)}`);
  assertStringIncludes(warning, "DISC_ENABLE_ACCESS_POLICIES");
  assert(!warning.includes(TOKEN_A), "the warning must not echo the token");

  const quiet = await captureLogs(() => {
    checkServiceToken({ enableAccessPolicies: true, serviceToken: TOKEN_A });
  });
  assertEquals(quiet.filter(line => /service token/i.test(line)), []);
});

Deno.test("service token config: SIGHUP reload neither changes nor drops the token, and redacts it in the log", async () => {
  const env = new EnvMock();
  try {
    env.set("DISC_SERVICE_TOKEN", TOKEN_A);
    const server = new DiscServer({ serviceToken: TOKEN_A });
    const http = new HttpServer({ config: server.get_config(), protocolHandler: stubHandler() });
    (server as unknown as { httpServer: HttpServer; }).httpServer = http;
    try {
      env.set("DISC_SERVICE_TOKEN", TOKEN_B);
      const changed = await captureLogs(() => server.reloadConfig());
      assertEquals(server.get_config().serviceToken, TOKEN_A);
      const notice = changed.find(line => line.includes("serviceToken"));
      assert(notice, "the ignored change should be reported");
      assertStringIncludes(notice, "restart required");
      assert(!notice.includes(TOKEN_A) && !notice.includes(TOKEN_B), `log line echoes a token: ${notice}`);

      env.clear("DISC_SERVICE_TOKEN");
      await captureLogs(() => server.reloadConfig());
      assertEquals(server.get_config().serviceToken, TOKEN_A, "an unset env var must not drop the token");
    } finally {
      (http as unknown as { subscription_handler: { dispose(): void; }; }).subscription_handler.dispose();
    }
  } finally {
    env.restore();
  }
});
