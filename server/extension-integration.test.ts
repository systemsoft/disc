/**
 * Extension Integration Tests
 *
 * Tests that ExtensionRegistry is correctly wired into the DiscServer lifecycle:
 * initialize() on start, shutdown() on stop, routes dispatched, health reported.
 *
 * Uses HttpServer directly with mock protocol handlers (same pattern as
 * auth-integration.test.ts) to avoid requiring a real PostgreSQL connection.
 * DiscServer tests use a no-op protocol handler to bypass the connection pool.
 */

import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { FunctionDef } from "../compiler/context.ts";
import { BaseExtension } from "../extensions/base-extension.ts";
import { ExtensionRegistry } from "../extensions/registry.ts";
import type { ExtensionContext, ExtensionMetadata, ExtensionRoute } from "../extensions/types.ts";
import { getLogger } from "../lib/logger.ts";
import { HttpServer } from "./http.ts";
import type { ProtocolHandler, QueryContext, QueryRequest, QueryResponse } from "./types.ts";

const TEST_HOST = "127.0.0.1";

/** Pick a random high port to avoid conflicts between parallel tests */
function randomPort(): number {
  return 30000 + Math.floor(Math.random() * 5000);
}

// ---------------------------------------------------------------------------
// Minimal mock protocol handler — no connection pool, safe for unit tests
// ---------------------------------------------------------------------------

function makeMockHandler(): ProtocolHandler {
  return {
    handleRequest(
      _request: QueryRequest,
      _context: QueryContext
    ): Promise<QueryResponse> {
      return Promise.resolve({ data: { ok: true } });
    },
    validateRequest(_request: QueryRequest) {
      return [];
    }
  };
}

// ---------------------------------------------------------------------------
// Mock extensions
// ---------------------------------------------------------------------------

class MinimalExtension extends BaseExtension {
  readonly metadata: ExtensionMetadata = {
    name: "minimal",
    version: "1.0.0",
    description: "Minimal test extension"
  };
}

class TrackingExtension extends BaseExtension {
  readonly metadata: ExtensionMetadata;
  initializeCalled = false;
  shutdownCalled = false;
  initContext: ExtensionContext | null = null;

  constructor(name = "tracking") {
    super();
    this.metadata = { name, version: "1.0.0" };
  }

  override async initialize(ctx: ExtensionContext): Promise<void> {
    this.initializeCalled = true;
    this.initContext = ctx;
    await super.initialize(ctx);
  }

  override async shutdown(): Promise<void> {
    this.shutdownCalled = true;
    await super.shutdown();
  }
}

class FunctionExtension extends BaseExtension {
  readonly metadata: ExtensionMetadata = {
    name: "functions",
    version: "1.0.0"
  };

  private readonly extraFunction: FunctionDef = {
    name: "ext_greet",
    args: [{ name: "name", type: "str", required: true }],
    returnType: "str",
    sqlName: "ext_greet"
  };

  override getFunctions(): FunctionDef[] {
    return [this.extraFunction];
  }
}

class RouteExtension extends BaseExtension {
  readonly metadata: ExtensionMetadata = {
    name: "routes",
    version: "1.0.0"
  };

  override getRoutes(): ExtensionRoute[] {
    return [
      {
        method: "GET",
        path: "/ping",
        handler: async _req => {
          await Promise.resolve();
          return new Response(
            JSON.stringify({ pong: true }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" }
            }
          );
        }
      },
      {
        method: "POST",
        path: "/echo",
        handler: async req => {
          const body = await req.text();
          return new Response(body, {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
      }
    ];
  }
}

class FailingExtension extends BaseExtension {
  readonly metadata: ExtensionMetadata = {
    name: "failing",
    version: "1.0.0"
  };

  override initialize(_ctx: ExtensionContext): Promise<void> {
    return Promise.reject(new Error("Intentional init failure"));
  }
}

// ---------------------------------------------------------------------------
// Helper: build HttpServer with extension routes
// ---------------------------------------------------------------------------

function createExtHttpServer(
  port: number,
  ext: RouteExtension
): HttpServer {
  const routes = new Map<string, ExtensionRoute[]>();
  routes.set(ext.metadata.name, ext.getRoutes());

  return new HttpServer({
    config: {
      host: TEST_HOST,
      port,
      databaseUrl: "postgresql://localhost:5432/test",
      maxConnections: 10,
      requestTimeout: 5000,
      enableCors: true,
      enableWebsockets: false
    },
    protocolHandler: makeMockHandler(),
    extensionRoutes: routes
  });
}

// ---------------------------------------------------------------------------
// Helper: build HttpServer with extension health getter
// ---------------------------------------------------------------------------

function createHealthHttpServer(
  port: number,
  healthGetter: () => Promise<
    Map<string, { healthy: boolean; details?: string; }>
  >
): HttpServer {
  return new HttpServer({
    config: {
      host: TEST_HOST,
      port,
      databaseUrl: "postgresql://localhost:5432/test",
      maxConnections: 10,
      requestTimeout: 5000,
      enableCors: true,
      enableWebsockets: false
    },
    protocolHandler: makeMockHandler(),
    extensionHealthGetter: healthGetter
  });
}

// ---------------------------------------------------------------------------
// Test 1: Server starts with no extensions (backward compatibility)
// ---------------------------------------------------------------------------

Deno.test({
  name: "Extension Integration - server starts with no extensions",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const port = randomPort();
    const server = new HttpServer({
      config: {
        host: TEST_HOST,
        port,
        databaseUrl: "postgresql://localhost:5432/test",
        maxConnections: 10,
        requestTimeout: 5000,
        enableCors: true,
        enableWebsockets: false
      },
      protocolHandler: makeMockHandler()
      // No extensionRoutes — should default to empty map
    });

    void server.start();
    await new Promise(r => setTimeout(r, 200));

    try {
      const res = await fetch(`http://${TEST_HOST}:${port}/`);
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.name, "Disc Database");
      // No extensions key when no extension routes are configured
      assertEquals(body.endpoints.extensions, undefined);
    } finally {
      await server.stop();
    }
  }
});

// ---------------------------------------------------------------------------
// Test 2: Extension initialize() is called when registry runs initializeAll
// ---------------------------------------------------------------------------

Deno.test({
  name: "Extension Integration - initialize() called via registry",
  fn: async () => {
    const ext = new TrackingExtension();
    const registry = new ExtensionRegistry();
    registry.register(ext);

    assertEquals(ext.initializeCalled, false);
    assertEquals(ext.state, "uninitialized");

    await registry.initializeAll({
      schema: { types: new Map(), functions: new Map() },
      config: {
        host: "localhost",
        port: 5656,
        databaseUrl: "postgresql://localhost:5432/test",
        maxConnections: 10,
        requestTimeout: 5000,
        enableCors: true,
        enableWebsockets: false
      },
      logger: getLogger("test")
    });

    assert(ext.initializeCalled, "initialize() should have been called");
    assertEquals(ext.state, "ready");
  }
});

// ---------------------------------------------------------------------------
// Test 3: Extension shutdown() called when registry runs shutdownAll
// ---------------------------------------------------------------------------

Deno.test({
  name: "Extension Integration - shutdown() called via registry",
  fn: async () => {
    const ext = new TrackingExtension("shutdown-tracker");
    const registry = new ExtensionRegistry();
    registry.register(ext);

    await registry.initializeAll({
      schema: { types: new Map(), functions: new Map() },
      config: {
        host: "localhost",
        port: 5656,
        databaseUrl: "postgresql://localhost:5432/test",
        maxConnections: 10,
        requestTimeout: 5000,
        enableCors: true,
        enableWebsockets: false
      },
      logger: getLogger("test")
    });

    assertEquals(ext.shutdownCalled, false);
    await registry.shutdownAll();

    assert(ext.shutdownCalled, "shutdown() should have been called");
    assertEquals(ext.state, "shutdown");
  }
});

// ---------------------------------------------------------------------------
// Test 4: Extension routes accessible at /ext/<name>/<path>
// ---------------------------------------------------------------------------

Deno.test({
  name: "Extension Integration - routes accessible at /ext/<name>/<path>",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const port = randomPort();
    const ext = new RouteExtension();
    const server = createExtHttpServer(port, ext);

    void server.start();
    await new Promise(r => setTimeout(r, 200));

    try {
      // GET /ext/routes/ping
      const pingRes = await fetch(
        `http://${TEST_HOST}:${port}/ext/routes/ping`
      );
      assertEquals(pingRes.status, 200);
      const pingBody = await pingRes.json();
      assertEquals(pingBody.pong, true);

      // POST /ext/routes/echo
      const echoRes = await fetch(
        `http://${TEST_HOST}:${port}/ext/routes/echo`,
        {
          method: "POST",
          body: JSON.stringify({ hello: "world" }),
          headers: { "Content-Type": "application/json" }
        }
      );
      assertEquals(echoRes.status, 200);
      const echoBody = await echoRes.json();
      assertEquals(echoBody.hello, "world");
    } finally {
      await server.stop();
    }
  }
});

// ---------------------------------------------------------------------------
// Test 5: Unknown extension returns 404
// ---------------------------------------------------------------------------

Deno.test({
  name: "Extension Integration - unknown extension returns 404",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const port = randomPort();
    const ext = new RouteExtension();
    const server = createExtHttpServer(port, ext);

    void server.start();
    await new Promise(r => setTimeout(r, 200));

    try {
      const res = await fetch(
        `http://${TEST_HOST}:${port}/ext/nonexistent/ping`
      );
      assertEquals(res.status, 404);
      const body = await res.json();
      assert(
        body.error.includes("nonexistent"),
        `Error "${body.error}" should mention extension name`
      );
    } finally {
      await server.stop();
    }
  }
});

// ---------------------------------------------------------------------------
// Test 6: Extension health included in /health response
// ---------------------------------------------------------------------------

Deno.test({
  name: "Extension Integration - extension health included in /health response",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const port = randomPort();

    const healthMap = new Map<string, { healthy: boolean; details?: string; }>();
    healthMap.set("my-ext", { healthy: false, details: "always broken" });

    const server = createHealthHttpServer(
      port,
      () => Promise.resolve(healthMap)
    );

    void server.start();
    await new Promise(r => setTimeout(r, 200));

    try {
      const res = await fetch(`http://${TEST_HOST}:${port}/health`);
      // Server itself is healthy (mock handler has no checkHealth)
      assertEquals(res.status, 200);
      const body = await res.json();
      assert(
        body.extensions !== undefined,
        "extensions key should be present in /health"
      );
      assertEquals(body.extensions["my-ext"].healthy, false);
      assertEquals(body.extensions["my-ext"].details, "always broken");
    } finally {
      await server.stop();
    }
  }
});

// ---------------------------------------------------------------------------
// Test 7: Extension init failure propagates as error
// ---------------------------------------------------------------------------

Deno.test({
  name: "Extension Integration - init failure propagates as error",
  fn: async () => {
    const ext = new FailingExtension();
    const registry = new ExtensionRegistry();
    registry.register(ext);

    await assertRejects(
      () =>
        registry.initializeAll({
          schema: { types: new Map(), functions: new Map() },
          config: {
            host: "localhost",
            port: 5656,
            databaseUrl: "postgresql://localhost:5432/test",
            maxConnections: 10,
            requestTimeout: 5000,
            enableCors: true,
            enableWebsockets: false
          },
          logger: getLogger("test")
        }),
      Error,
      "failing"
    );
  }
});

// ---------------------------------------------------------------------------
// Test 8: Extension functions appear in getAllFunctions after registry init
// ---------------------------------------------------------------------------

Deno.test({
  name: "Extension Integration - extension functions available after registry init",
  fn: async () => {
    const ext = new FunctionExtension();
    const registry = new ExtensionRegistry();
    registry.register(ext);

    await registry.initializeAll({
      schema: { types: new Map(), functions: new Map() },
      config: {
        host: "localhost",
        port: 5656,
        databaseUrl: "postgresql://localhost:5432/test",
        maxConnections: 10,
        requestTimeout: 5000,
        enableCors: true,
        enableWebsockets: false
      },
      logger: getLogger("test")
    });

    const functions = registry.getAllFunctions();
    const names = functions.map(f => f.name);
    assert(names.includes("ext_greet"), "ext_greet should be in registry");
  }
});

// ---------------------------------------------------------------------------
// Test 9: Multiple extensions all initialize and shut down correctly
// ---------------------------------------------------------------------------

Deno.test({
  name: "Extension Integration - multiple extensions all initialize and shut down",
  fn: async () => {
    const ext1 = new TrackingExtension("ext-alpha");
    const ext2 = new TrackingExtension("ext-beta");
    const ext3 = new MinimalExtension();

    const registry = new ExtensionRegistry();
    registry.register(ext1);
    registry.register(ext2);
    registry.register(ext3);

    assertEquals(registry.size, 3);

    const ctx = {
      schema: { types: new Map(), functions: new Map() },
      config: {
        host: "localhost",
        port: 5656,
        databaseUrl: "postgresql://localhost:5432/test",
        maxConnections: 10,
        requestTimeout: 5000,
        enableCors: true,
        enableWebsockets: false
      },
      logger: getLogger("test")
    };

    await registry.initializeAll(ctx);

    assert(ext1.initializeCalled, "ext-alpha initialize() should be called");
    assert(ext2.initializeCalled, "ext-beta initialize() should be called");
    assertEquals(ext1.state, "ready");
    assertEquals(ext2.state, "ready");
    assertEquals(ext3.state, "ready");

    await registry.shutdownAll();

    assert(ext1.shutdownCalled, "ext-alpha shutdown() should be called");
    assert(ext2.shutdownCalled, "ext-beta shutdown() should be called");
  }
});

// ---------------------------------------------------------------------------
// Test 10: Extension routes appear in root endpoint listing
// ---------------------------------------------------------------------------

Deno.test({
  name: "Extension Integration - extension routes listed in root endpoint",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const port = randomPort();
    const ext = new RouteExtension();
    const server = createExtHttpServer(port, ext);

    void server.start();
    await new Promise(r => setTimeout(r, 200));

    try {
      const res = await fetch(`http://${TEST_HOST}:${port}/`);
      assertEquals(res.status, 200);
      const body = await res.json();

      assert(
        body.endpoints.extensions !== undefined,
        "extensions should appear in root endpoint listing"
      );
      assert(
        Array.isArray(body.endpoints.extensions["routes"]),
        "routes extension should be listed"
      );
      const routeList: string[] = body.endpoints.extensions["routes"];
      assert(
        routeList.some((r: string) => r.includes("GET") && r.includes("/ping")),
        "GET /ping should be listed"
      );
    } finally {
      await server.stop();
    }
  }
});
