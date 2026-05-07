/**
 * Tests for ExtensionRegistry
 */

import { assertEquals, assertRejects } from "@std/assert";
import type { FunctionDef, TypeDef } from "../compiler/context.ts";
import { BaseExtension } from "./base-extension.ts";
import { ExtensionDependencyError, ExtensionInitError } from "./errors.ts";
import { ExtensionRegistry } from "./registry.ts";
import type { CompilerHook, ExtensionContext, ExtensionDatabaseSetup, ExtensionMetadata, ExtensionMiddleware, ExtensionRoute } from "./types.ts";

// ── Test helpers ─────────────────────────────────────────────────────

function makeContext(): ExtensionContext {
  return {
    schema: { types: new Map(), functions: new Map() },
    config: {
      host: "localhost",
      port: 5656,
      databaseUrl: "postgres://localhost/disc_test",
      maxConnections: 5,
      requestTimeout: 5000,
      enableCors: false,
      enableWebsockets: false,
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: function() {
        return this;
      },
      withRequest: function() {
        return this;
      },
    } as unknown as ExtensionContext["logger"],
  };
}

// Concrete extension with configurable metadata and tracking
class MockExtension extends BaseExtension {
  readonly metadata: ExtensionMetadata;
  initCalled = false;
  shutdownCalled = false;
  private _functions: FunctionDef[];
  private _types: TypeDef[];
  private _routes: ExtensionRoute[];
  private _middleware: ExtensionMiddleware[];
  private _setup: ExtensionDatabaseSetup;
  private _hooks: CompilerHook[];

  constructor(options: {
    name: string;
    version?: string;
    dependencies?: string[];
    functions?: FunctionDef[];
    types?: TypeDef[];
    routes?: ExtensionRoute[];
    middleware?: ExtensionMiddleware[];
    setup?: ExtensionDatabaseSetup;
    hooks?: CompilerHook[];
  }) {
    super();
    this.metadata = {
      name: options.name,
      version: options.version ?? "1.0.0",
      dependencies: options.dependencies,
    };
    this._functions = options.functions ?? [];
    this._types = options.types ?? [];
    this._routes = options.routes ?? [];
    this._middleware = options.middleware ?? [];
    this._setup = options.setup ?? { setupSql: [] };
    this._hooks = options.hooks ?? [];
  }

  override async initialize(context: ExtensionContext): Promise<void> {
    this.initCalled = true;
    await super.initialize(context);
  }

  override async shutdown(): Promise<void> {
    this.shutdownCalled = true;
    await super.shutdown();
  }

  override getFunctions(): FunctionDef[] {
    return this._functions;
  }

  override getTypes(): TypeDef[] {
    return this._types;
  }

  override getRoutes(): ExtensionRoute[] {
    return this._routes;
  }

  override getMiddleware(): ExtensionMiddleware[] {
    return this._middleware;
  }

  override getDatabaseSetup(): ExtensionDatabaseSetup {
    return this._setup;
  }

  override getCompilerHooks(): CompilerHook[] {
    return this._hooks;
  }
}

// ── Registration ─────────────────────────────────────────────────────

Deno.test("ExtensionRegistry - register increases size", () => {
  const registry = new ExtensionRegistry();
  assertEquals(registry.size, 0);
  registry.register(new MockExtension({ name: "alpha" }));
  assertEquals(registry.size, 1);
});

Deno.test("ExtensionRegistry - get returns registered extension", () => {
  const registry = new ExtensionRegistry();
  const ext = new MockExtension({ name: "alpha" });
  registry.register(ext);
  assertEquals(registry.get("alpha"), ext);
});

Deno.test("ExtensionRegistry - get returns undefined for unknown name", () => {
  const registry = new ExtensionRegistry();
  assertEquals(registry.get("missing"), undefined);
});

Deno.test("ExtensionRegistry - duplicate registration throws ExtensionInitError", () => {
  const registry = new ExtensionRegistry();
  registry.register(new MockExtension({ name: "alpha" }));
  let threw = false;
  try {
    registry.register(new MockExtension({ name: "alpha" }));
  } catch (err) {
    threw = true;
    assertEquals(err instanceof ExtensionInitError, true);
  }
  assertEquals(threw, true);
});

Deno.test("ExtensionRegistry - getAll returns all registered extensions", () => {
  const registry = new ExtensionRegistry();
  registry.register(new MockExtension({ name: "alpha" }));
  registry.register(new MockExtension({ name: "beta" }));
  assertEquals(registry.getAll().length, 2);
});

// ── Dependency ordering ───────────────────────────────────────────────

Deno.test("ExtensionRegistry - initializeAll respects dependency order (B depends on A → A first)", async () => {
  const registry = new ExtensionRegistry();
  const initOrder: string[] = [];

  // B depends on A — A must be initialized first
  const extA = new MockExtension({ name: "A" });
  const extB = new MockExtension({ name: "B", dependencies: ["A"] });

  // Register B first to ensure ordering is driven by deps, not insertion
  registry.register(extB);
  registry.register(extA);

  const origInitA = extA.initialize.bind(extA);
  extA.initialize = async (ctx: ExtensionContext) => {
    initOrder.push("A");
    await origInitA(ctx);
  };

  const origInitB = extB.initialize.bind(extB);
  extB.initialize = async (ctx: ExtensionContext) => {
    initOrder.push("B");
    await origInitB(ctx);
  };

  await registry.initializeAll(makeContext());

  assertEquals(initOrder.indexOf("A") < initOrder.indexOf("B"), true);
});

Deno.test("ExtensionRegistry - initializeAll with no dependencies initializes all", async () => {
  const registry = new ExtensionRegistry();
  const extA = new MockExtension({ name: "A" });
  const extB = new MockExtension({ name: "B" });
  registry.register(extA);
  registry.register(extB);

  await registry.initializeAll(makeContext());

  assertEquals(extA.initCalled, true);
  assertEquals(extB.initCalled, true);
});

Deno.test("ExtensionRegistry - circular dependency throws ExtensionDependencyError", async () => {
  const registry = new ExtensionRegistry();
  // A → B → A forms a cycle
  registry.register(new MockExtension({ name: "A", dependencies: ["B"] }));
  registry.register(new MockExtension({ name: "B", dependencies: ["A"] }));

  await assertRejects(
    () => registry.initializeAll(makeContext()),
    ExtensionDependencyError,
  );
});

Deno.test("ExtensionRegistry - missing dependency throws ExtensionDependencyError", async () => {
  const registry = new ExtensionRegistry();
  registry.register(
    new MockExtension({ name: "A", dependencies: ["nonexistent"] }),
  );

  await assertRejects(
    () => registry.initializeAll(makeContext()),
    ExtensionDependencyError,
  );
});

// ── Shutdown ──────────────────────────────────────────────────────────

Deno.test("ExtensionRegistry - shutdownAll calls shutdown in reverse init order", async () => {
  const registry = new ExtensionRegistry();
  const shutdownOrder: string[] = [];

  const extA = new MockExtension({ name: "A" });
  const extB = new MockExtension({ name: "B", dependencies: ["A"] });
  registry.register(extA);
  registry.register(extB);

  // Capture shutdown order
  const origShutdownA = extA.shutdown.bind(extA);
  extA.shutdown = async () => {
    shutdownOrder.push("A");
    await origShutdownA();
  };

  const origShutdownB = extB.shutdown.bind(extB);
  extB.shutdown = async () => {
    shutdownOrder.push("B");
    await origShutdownB();
  };

  await registry.initializeAll(makeContext());
  await registry.shutdownAll();

  // B was initialized after A, so B should shut down first
  assertEquals(shutdownOrder.indexOf("B") < shutdownOrder.indexOf("A"), true);
});

// ── Aggregation helpers ───────────────────────────────────────────────

Deno.test("ExtensionRegistry - getAllFunctions aggregates from multiple extensions", () => {
  const registry = new ExtensionRegistry();

  const fn1: FunctionDef = {
    name: "ext_func_one",
    args: [],
    returnType: "str",
  };
  const fn2: FunctionDef = {
    name: "ext_func_two",
    args: [],
    returnType: "int32",
  };

  registry.register(new MockExtension({ name: "A", functions: [fn1] }));
  registry.register(new MockExtension({ name: "B", functions: [fn2] }));

  const fns = registry.getAllFunctions();
  assertEquals(fns.length, 2);
  assertEquals(fns.some((f) => f.name === "ext_func_one"), true);
  assertEquals(fns.some((f) => f.name === "ext_func_two"), true);
});

Deno.test("ExtensionRegistry - getAllTypes aggregates from multiple extensions", () => {
  const registry = new ExtensionRegistry();

  const type1: TypeDef = {
    name: "ExtTypeA",
    kind: "scalar",
    properties: new Map(),
    links: new Map(),
    tableName: "ext_type_a",
  };
  const type2: TypeDef = {
    name: "ExtTypeB",
    kind: "scalar",
    properties: new Map(),
    links: new Map(),
    tableName: "ext_type_b",
  };

  registry.register(new MockExtension({ name: "A", types: [type1] }));
  registry.register(new MockExtension({ name: "B", types: [type2] }));

  const types = registry.getAllTypes();
  assertEquals(types.length, 2);
});

Deno.test("ExtensionRegistry - getAllRoutes groups routes by extension name", () => {
  const registry = new ExtensionRegistry();

  const route: ExtensionRoute = {
    method: "GET",
    path: "/ext/resource",
    handler: (_req: Request) => Promise.resolve(new Response("ok")),
  };

  registry.register(new MockExtension({ name: "A", routes: [route] }));
  registry.register(new MockExtension({ name: "B" })); // no routes

  const routes = registry.getAllRoutes();
  assertEquals(routes.size, 1);
  assertEquals(routes.has("A"), true);
  assertEquals(routes.has("B"), false);
  assertEquals(routes.get("A")!.length, 1);
});

Deno.test("ExtensionRegistry - getAllMiddleware sorts by priority ascending", () => {
  const registry = new ExtensionRegistry();

  const mid1: ExtensionMiddleware = {
    name: "low-priority",
    priority: 100,
    handle: (_req: Request, next: () => Promise<Response>) => next(),
  };
  const mid2: ExtensionMiddleware = {
    name: "high-priority",
    priority: 10,
    handle: (_req: Request, next: () => Promise<Response>) => next(),
  };

  registry.register(new MockExtension({ name: "A", middleware: [mid1] }));
  registry.register(new MockExtension({ name: "B", middleware: [mid2] }));

  const middleware = registry.getAllMiddleware();
  assertEquals(middleware.length, 2);
  assertEquals(middleware[0].priority, 10);
  assertEquals(middleware[1].priority, 100);
});

Deno.test("ExtensionRegistry - getAllCompilerHooks aggregates hooks", () => {
  const registry = new ExtensionRegistry();

  const hook1: CompilerHook = { name: "hook-one" };
  const hook2: CompilerHook = { name: "hook-two" };

  registry.register(new MockExtension({ name: "A", hooks: [hook1] }));
  registry.register(new MockExtension({ name: "B", hooks: [hook2] }));

  const hooks = registry.getAllCompilerHooks();
  assertEquals(hooks.length, 2);
});

// ── Health status ─────────────────────────────────────────────────────

Deno.test("ExtensionRegistry - getHealthStatus aggregates health from all extensions", async () => {
  const registry = new ExtensionRegistry();

  const extA = new MockExtension({ name: "A" });
  const extB = new MockExtension({ name: "B" });
  registry.register(extA);
  registry.register(extB);

  await registry.initializeAll(makeContext());

  const status = await registry.getHealthStatus();
  assertEquals(status.size, 2);
  assertEquals(status.get("A")!.healthy, true);
  assertEquals(status.get("B")!.healthy, true);
});

Deno.test("ExtensionRegistry - getHealthStatus reports unhealthy for extensions that throw", async () => {
  const registry = new ExtensionRegistry();

  const ext = new MockExtension({ name: "broken" });
  ext.healthCheck = () => {
    throw new Error("health probe failed");
  };
  registry.register(ext);

  const status = await registry.getHealthStatus();
  assertEquals(status.get("broken")!.healthy, false);
  assertEquals(
    status.get("broken")!.details?.includes("health probe failed"),
    true,
  );
});
