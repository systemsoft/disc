/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * `/query` schema-drift response headers (Stage 2).
 *
 * Exercises the real HTTP wiring in `http-handlers.ts`
 * (`apply_schema_drift_headers`) over a live `HttpServer`, driven by a stub
 * `SchemaDriftProvider`. No PostgreSQL needed: the provider's classification
 * verdict is supplied directly, and the real PG-backed classification logic
 * is covered separately by the `classifyDrift` unit tests (migration/engine)
 * and the `getSchemaModulesByHash` real-PG tests (migration/tracker).
 *
 * Contract under test:
 *   - `X-Disc-Schema-Version`  — set whenever the current epoch is known.
 *   - `X-Disc-Schema-Mismatch` — set ONLY when the request sent
 *     `X-Disc-Expected-Schema`; carries none|compatible|breaking|unknown.
 *   - the query always still executes and returns data.
 */

import { assertEquals, assertExists } from "@std/assert";
import type { SchemaDriftProvider } from "./http-base.ts";
import { HttpServer } from "./http.ts";
import * as Types from "./types.ts";

const CURRENT_EPOCH = "epoch_current_abc";

/** Minimal protocol handler that validates non-empty queries and returns data. */
const mockProtocolHandler: Types.ProtocolHandler = {
  handleRequest(): Promise<Types.QueryResponse> {
    return Promise.resolve({ data: [{ id: "1", name: "Ada" }] });
  },
  validateRequest(request: Types.QueryRequest): Types.QueryError[] {
    return request.query && request.query.length > 0 ?
      [] :
      [{ message: "Query is required" }];
  }
};

/**
 * Stub drift provider. `currentEpoch` is fixed; `classify` returns `none` when
 * the expected epoch matches current, `unknown` for unrecognized epochs, and
 * any verdict pinned via `verdicts` otherwise.
 */
function makeDriftProvider(
  currentEpoch: string | null,
  verdicts: Record<string, "none" | "compatible" | "breaking" | "unknown"> = {}
): SchemaDriftProvider {
  return {
    currentEpoch(): Promise<string | null> {
      return Promise.resolve(currentEpoch);
    },
    classify(
      expected: string
    ): Promise<"none" | "compatible" | "breaking" | "unknown"> {
      if (expected === currentEpoch) {
        return Promise.resolve("none");
      }
      return Promise.resolve(verdicts[expected] ?? "unknown");
    },
    invalidate(): void {}
  };
}

function makeConfig(): Types.ServerConfig {
  return {
    host: "localhost",
    port: 0, // OS-assigned ephemeral port — read back via boundPort.
    databaseUrl: "postgresql://localhost:5432/disc_test",
    maxConnections: 10,
    requestTimeout: 5000,
    enableCors: true,
    enableWebsockets: false
  };
}

/**
 * Start an HttpServer with the given drift provider. `start()` only resolves
 * once the server stops (it awaits `server.finished`), so we kick it off
 * without awaiting and poll `boundPort` until the listener is up. `stop()`
 * resolves the returned `started` promise.
 */
async function startServer(
  driftProvider: SchemaDriftProvider
): Promise<{ server: HttpServer; baseUrl: string; started: Promise<void>; }> {
  const server = new HttpServer({
    config: makeConfig(),
    protocolHandler: mockProtocolHandler,
    schemaDriftProvider: driftProvider
  });
  const started = server.start();

  // Wait for the OS to assign + bind the ephemeral port.
  let port = 0;
  for (let i = 0; i < 200 && port === 0; i++) {
    try {
      port = server.boundPort;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  return { server, baseUrl: `http://localhost:${port}`, started };
}

/** Stop the server and drain its `start()` promise. */
async function stopServer(
  server: HttpServer,
  started: Promise<void>
): Promise<void> {
  await server.stop();
  await started.catch(() => {});
}

async function postQuery(
  baseUrl: string,
  headers: Record<string, string> = {}
): Promise<Response> {
  return await fetch(`${baseUrl}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ query: "select User { name }" })
  });
}

Deno.test({
  name: "drift headers - no X-Disc-Expected-Schema → version set, mismatch absent, data returned",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { server, baseUrl, started } = await startServer(
      makeDriftProvider(CURRENT_EPOCH)
    );
    try {
      const res = await postQuery(baseUrl);
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("X-Disc-Schema-Version"), CURRENT_EPOCH);
      assertEquals(res.headers.get("X-Disc-Schema-Mismatch"), null);

      const body = await res.json();
      assertExists(body.data);
      assertEquals(body.data[0].name, "Ada");
    } finally {
      await stopServer(server, started);
    }
  }
});

Deno.test({
  name: "drift headers - expected epoch == current → mismatch none",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { server, baseUrl, started } = await startServer(
      makeDriftProvider(CURRENT_EPOCH)
    );
    try {
      const res = await postQuery(baseUrl, {
        "X-Disc-Expected-Schema": CURRENT_EPOCH
      });
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("X-Disc-Schema-Version"), CURRENT_EPOCH);
      assertEquals(res.headers.get("X-Disc-Schema-Mismatch"), "none");
      await res.body?.cancel();
    } finally {
      await stopServer(server, started);
    }
  }
});

Deno.test({
  name: "drift headers - unknown expected epoch → mismatch unknown, query still returns data",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { server, baseUrl, started } = await startServer(
      makeDriftProvider(CURRENT_EPOCH)
    );
    try {
      const res = await postQuery(baseUrl, {
        "X-Disc-Expected-Schema": "epoch_bogus_xyz"
      });
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("X-Disc-Schema-Mismatch"), "unknown");

      const body = await res.json();
      assertExists(body.data);
      assertEquals(body.data[0].name, "Ada");
    } finally {
      await stopServer(server, started);
    }
  }
});

Deno.test({
  name: "drift headers - compatible/breaking verdicts surface on the mismatch header",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { server, baseUrl, started } = await startServer(
      makeDriftProvider(CURRENT_EPOCH, {
        epoch_additive: "compatible",
        epoch_removed: "breaking"
      })
    );
    try {
      const compatRes = await postQuery(baseUrl, {
        "X-Disc-Expected-Schema": "epoch_additive"
      });
      assertEquals(
        compatRes.headers.get("X-Disc-Schema-Mismatch"),
        "compatible"
      );
      await compatRes.body?.cancel();

      const breakingRes = await postQuery(baseUrl, {
        "X-Disc-Expected-Schema": "epoch_removed"
      });
      assertEquals(
        breakingRes.headers.get("X-Disc-Schema-Mismatch"),
        "breaking"
      );
      await breakingRes.body?.cancel();
    } finally {
      await stopServer(server, started);
    }
  }
});

Deno.test({
  name: "drift headers - no current epoch → version absent, query still returns data",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { server, baseUrl, started } = await startServer(makeDriftProvider(null));
    try {
      const res = await postQuery(baseUrl, {
        "X-Disc-Expected-Schema": CURRENT_EPOCH
      });
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("X-Disc-Schema-Version"), null);
      // currentEpoch is null → classify returns "unknown".
      assertEquals(res.headers.get("X-Disc-Schema-Mismatch"), "unknown");

      const body = await res.json();
      assertExists(body.data);
    } finally {
      await stopServer(server, started);
    }
  }
});
