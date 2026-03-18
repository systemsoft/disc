/**
 * Extension Server End-to-End Tests
 *
 * Tests full server integration with extension types: CustomFunctionsExtension,
 * OAuthExtension, and VectorExtension. Uses HttpServer directly with a mock
 * protocol handler (same pattern as extension-integration.test.ts) to avoid
 * requiring a real PostgreSQL connection.
 *
 * These tests verify:
 * - Server lifecycle with extension initialization
 * - Extension routes are accessible at /ext/<name>/<path>
 * - /health includes extension health status
 * - Multiple extensions loaded simultaneously
 */

import { assert, assertEquals } from "@std/assert";
import { HttpServer } from "../server/http.ts";
import type {
  ProtocolHandler,
  QueryContext,
  QueryRequest,
  QueryResponse,
} from "../server/types.ts";
import { ExtensionRegistry } from "./registry.ts";
import { CustomFunctionsExtension } from "../ext-custom-functions/extension.ts";
import { OAuthExtension } from "../ext-oauth/extension.ts";
import { VectorExtension } from "../ext-vector/extension.ts";
import { getLogger } from "../lib/logger.ts";

const TEST_HOST = "127.0.0.1";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pick a random high port to avoid conflicts between parallel tests. */
function randomPort(): number {
  return 38000 + Math.floor(Math.random() * 2000);
}

/** Minimal mock protocol handler — no connection pool, safe for unit tests. */
function makeMockHandler(): ProtocolHandler {
  return {
    handleRequest(
      _request: QueryRequest,
      _context: QueryContext,
    ): Promise<QueryResponse> {
      return Promise.resolve({ data: { ok: true } });
    },
    validateRequest(_request: QueryRequest) {
      return [];
    },
  };
}

/** Shared minimal ServerConfig values used across all tests. */
const BASE_CONFIG = {
  host: TEST_HOST,
  databaseUrl: "postgresql://localhost:5432/disc_test",
  maxConnections: 5,
  requestTimeout: 5000,
  enableCors: true,
  enableWebsockets: false,
};

/** A no-op logger compatible with ExtensionContext.logger. */
const MOCK_LOGGER = getLogger("test-extension-e2e");

// ---------------------------------------------------------------------------
// Test 1: Server starts with CustomFunctionsExtension and /health returns 200
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "Extension Server E2E - server starts with CustomFunctionsExtension and /health returns 200",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const port = randomPort();

    const ext = new CustomFunctionsExtension({
      functions: [
        {
          name: "my_upper",
          args: [{ name: "input", type: "str", required: true }],
          returnType: "str",
          implementation: { kind: "sql_name", sqlName: "upper" },
        },
      ],
    });

    const registry = new ExtensionRegistry();
    registry.register(ext);

    await registry.initializeAll({
      schema: { types: new Map(), functions: new Map() },
      config: { ...BASE_CONFIG, port },
      logger: MOCK_LOGGER,
    });

    assertEquals(ext.state, "ready");

    const server = new HttpServer({
      config: { ...BASE_CONFIG, port },
      protocolHandler: makeMockHandler(),
      extensionRoutes: registry.getAllRoutes(),
      extensionHealthGetter: () => registry.getHealthStatus(),
    });

    void server.start();
    await new Promise((r) => setTimeout(r, 200));

    try {
      const res = await fetch(`http://${TEST_HOST}:${port}/health`);
      assertEquals(res.status, 200);

      const body = await res.json();
      assertEquals(body.status, "healthy");

      // Extension health should be present
      assert(
        body.extensions !== undefined,
        "/health should include extensions key",
      );
      assert(
        body.extensions["custom-functions"] !== undefined,
        "custom-functions extension should appear in health",
      );
      assertEquals(body.extensions["custom-functions"].healthy, true);
    } finally {
      await server.stop();
    }
  },
});

// ---------------------------------------------------------------------------
// Test 2: OAuthExtension route /ext/oauth/providers returns JSON
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "Extension Server E2E - OAuthExtension GET /ext/oauth/providers returns provider list",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const port = randomPort();

    const ext = new OAuthExtension({
      providers: [
        {
          name: "github",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          authorizeUrl: "https://github.com/login/oauth/authorize",
          tokenUrl: "https://github.com/login/oauth/access_token",
          userInfoUrl: "https://api.github.com/user",
          scopes: ["read:user", "user:email"],
        },
        {
          name: "google",
          clientId: "google-client-id",
          clientSecret: "google-client-secret",
          authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenUrl: "https://oauth2.googleapis.com/token",
          userInfoUrl: "https://www.googleapis.com/oauth2/v3/userinfo",
          scopes: ["openid", "email", "profile"],
        },
      ],
    });

    const registry = new ExtensionRegistry();
    registry.register(ext);

    await registry.initializeAll({
      schema: { types: new Map(), functions: new Map() },
      config: { ...BASE_CONFIG, port },
      logger: MOCK_LOGGER,
    });

    const server = new HttpServer({
      config: { ...BASE_CONFIG, port },
      protocolHandler: makeMockHandler(),
      extensionRoutes: registry.getAllRoutes(),
    });

    void server.start();
    await new Promise((r) => setTimeout(r, 200));

    try {
      const res = await fetch(
        `http://${TEST_HOST}:${port}/ext/oauth/providers`,
      );
      assertEquals(res.status, 200);

      const body = await res.json();
      assert(Array.isArray(body.providers), "providers should be an array");
      assertEquals(body.providers.length, 2);
      assert(
        body.providers.includes("github"),
        "github should be in providers",
      );
      assert(
        body.providers.includes("google"),
        "google should be in providers",
      );
    } finally {
      await server.stop();
    }
  },
});

// ---------------------------------------------------------------------------
// Test 3: VectorExtension and CustomFunctionsExtension both initialize
//         and appear in /health
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "Extension Server E2E - VectorExtension and CustomFunctionsExtension both initialize and appear in /health",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const port = randomPort();

    const vectorExt = new VectorExtension({
      defaultDimensions: 128,
      indexType: "ivfflat",
    });

    const customExt = new CustomFunctionsExtension({
      functions: [
        {
          name: "disc_e2e_double",
          args: [{ name: "n", type: "int32", required: true }],
          returnType: "int32",
          implementation: { kind: "sql_expression", expression: "$1 * 2" },
        },
      ],
    });

    const registry = new ExtensionRegistry();
    registry.register(vectorExt);
    registry.register(customExt);

    await registry.initializeAll({
      schema: { types: new Map(), functions: new Map() },
      config: { ...BASE_CONFIG, port },
      logger: MOCK_LOGGER,
    });

    // Both extensions should be ready after initialization
    assertEquals(vectorExt.state, "ready");
    assertEquals(customExt.state, "ready");

    // Both should contribute functions to the registry
    const functions = registry.getAllFunctions();
    const funcNames = functions.map((f) => f.name);
    assert(
      funcNames.includes("cosine_similarity"),
      "cosine_similarity from VectorExtension should be registered",
    );
    assert(
      funcNames.includes("disc_e2e_double"),
      "disc_e2e_double from CustomFunctionsExtension should be registered",
    );

    const server = new HttpServer({
      config: { ...BASE_CONFIG, port },
      protocolHandler: makeMockHandler(),
      extensionRoutes: registry.getAllRoutes(),
      extensionHealthGetter: () => registry.getHealthStatus(),
    });

    void server.start();
    await new Promise((r) => setTimeout(r, 200));

    try {
      const res = await fetch(`http://${TEST_HOST}:${port}/health`);
      assertEquals(res.status, 200);

      const body = await res.json();
      assert(
        body.extensions !== undefined,
        "/health should include extensions key",
      );

      // Both extensions should appear in health output
      assert(
        body.extensions["vector"] !== undefined,
        "vector extension should appear in /health",
      );
      assert(
        body.extensions["custom-functions"] !== undefined,
        "custom-functions extension should appear in /health",
      );
      assertEquals(body.extensions["vector"].healthy, true);
      assertEquals(body.extensions["custom-functions"].healthy, true);
    } finally {
      await server.stop();
      await registry.shutdownAll();
    }
  },
});
