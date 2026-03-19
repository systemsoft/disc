/**
 * Production WebSocket end-to-end scenario tests for Disc server.
 *
 * Uses a random-port test server (via Deno.serve with port 0) to avoid
 * conflicts with other tests or running instances.
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { HttpServer } from "./http.ts";
import type {
  ProtocolHandler,
  QueryContext,
  QueryError,
  QueryRequest,
  QueryResponse,
  ServerConfig,
} from "./types.ts";

// --- Helpers ---

function createTestConfig(
  overrides: Partial<ServerConfig> = {},
): ServerConfig {
  return {
    host: "localhost",
    port: 0,
    databaseUrl: "postgresql://localhost:5432/test",
    maxConnections: 10,
    requestTimeout: 5000,
    enableCors: false,
    enableWebsockets: true,
    ...overrides,
  };
}

function createWSProtocolHandler(): ProtocolHandler {
  return {
    handleRequest(
      _request: QueryRequest,
      _context: QueryContext,
    ): Promise<QueryResponse> {
      return Promise.resolve({ data: { result: "ok" } });
    },
    validateRequest(_request: QueryRequest): QueryError[] {
      return [];
    },
  };
}

/**
 * Spins up a temporary HTTP server wrapping an HttpServer instance with
 * WebSocket support enabled. Returns the dynamically assigned port and
 * a cleanup function.
 */
function withTestServer(
  handler: ProtocolHandler,
  configOverrides: Partial<ServerConfig> = {},
): {
  port: number;
  cleanup: () => Promise<void>;
  server: HttpServer;
  testServer: Deno.HttpServer<Deno.NetAddr>;
  abortController: AbortController;
} {
  const config = createTestConfig(configOverrides);
  const server = new HttpServer({
    config,
    protocolHandler: handler,
  });

  const abortController = new AbortController();
  const testServer = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      signal: abortController.signal,
      onListen() {},
    },
    (request: Request, info: Deno.ServeHandlerInfo) => {
      return (server as any).handleRequest(request, info);
    },
  );

  const port = testServer.addr.port;

  const cleanup = async () => {
    abortController.abort();
    await testServer.finished;
    await server.stop();
  };

  return { port, cleanup, server, testServer, abortController };
}

/**
 * Minimal WebSocket test client that connects to a dynamic URL and
 * collects parsed JSON messages.
 */
class WebSocketTestClient {
  private socket?: WebSocket;
  private messages: any[] = [];
  private connected = false;

  connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(url);

      this.socket.onopen = () => {
        this.connected = true;
        resolve();
      };

      this.socket.onerror = (error) => {
        reject(error);
      };

      this.socket.onmessage = (event) => {
        try {
          this.messages.push(JSON.parse(event.data));
        } catch {
          // Ignore non-JSON messages
        }
      };

      this.socket.onclose = () => {
        this.connected = false;
      };

      setTimeout(() => {
        if (!this.connected) {
          reject(new Error("WS connection timeout"));
        }
      }, 5000);
    });
  }

  send(message: any): void {
    if (this.socket && this.connected) {
      this.socket.send(JSON.stringify(message));
    } else {
      throw new Error("Not connected");
    }
  }

  waitForMessage(timeout = 5000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Message timeout")),
        timeout,
      );

      const check = () => {
        if (this.messages.length > 0) {
          clearTimeout(timer);
          resolve(this.messages.shift());
        } else {
          setTimeout(check, 10);
        }
      };

      check();
    });
  }

  /**
   * Wait for a message of a specific type, skipping any others.
   */
  waitForMessageOfType(type: string, timeout = 5000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Message timeout waiting for type: ${type}`)),
        timeout,
      );

      const check = () => {
        const idx = this.messages.findIndex((m: any) => m.type === type);
        if (idx >= 0) {
          clearTimeout(timer);
          const [msg] = this.messages.splice(idx, 1);
          resolve(msg);
        } else {
          setTimeout(check, 10);
        }
      };

      check();
    });
  }

  closeAndWait(): Promise<void> {
    if (this.socket) {
      return new Promise((resolve) => {
        this.socket!.onclose = () => {
          this.connected = false;
          resolve();
        };
        this.socket!.close();
      });
    }
    return Promise.resolve();
  }

  isConnected(): boolean {
    return this.connected;
  }

  getMessages(): any[] {
    return [...this.messages];
  }
}

// --- Tests ---

Deno.test({
  name: "Production E2E: Subscribe then unsubscribe returns subscription_stopped",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const handler = createWSProtocolHandler();
    const { port, cleanup } = withTestServer(handler);
    const client = new WebSocketTestClient();

    try {
      await client.connect(`ws://127.0.0.1:${port}`);

      // Subscribe
      client.send({
        type: "subscribe",
        payload: {
          id: "sub1",
          query: "select User { name }",
          variables: {},
        },
      });

      // Wait for the subscription data response (initial data from SubscriptionHandler)
      const subResponse = await client.waitForMessage();
      assertEquals(subResponse.type, "subscription");
      assertExists(subResponse.payload);

      // Unsubscribe
      client.send({
        type: "unsubscribe",
        payload: { subscriptionId: "sub1" },
      });

      // stop_subscription() sends a "subscription" (complete) message first,
      // then the WS handler sends "subscription_stopped". Skip the former.
      const stopResponse = await client.waitForMessageOfType(
        "subscription_stopped",
      );
      assertExists(stopResponse.payload);
      assertEquals(stopResponse.payload.subscriptionId, "sub1");
    } finally {
      await client.closeAndWait();
      await cleanup();
    }
  },
});

Deno.test({
  name: "Production E2E: Unsubscribe with missing subscriptionId returns error",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const handler = createWSProtocolHandler();
    const { port, cleanup } = withTestServer(handler);
    const client = new WebSocketTestClient();

    try {
      await client.connect(`ws://127.0.0.1:${port}`);

      // Send unsubscribe with empty payload (no subscriptionId)
      client.send({
        type: "unsubscribe",
        payload: {},
      });

      const response = await client.waitForMessage();
      assertEquals(response.type, "error");
      assertExists(response.payload);
      assert(
        response.payload.message.includes("subscriptionId is required"),
        `Expected error about missing subscriptionId, got: ${response.payload.message}`,
      );
    } finally {
      await client.closeAndWait();
      await cleanup();
    }
  },
});

Deno.test({
  name: "Production E2E: Multiple subscriptions on one connection",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const handler = createWSProtocolHandler();
    const { port, cleanup } = withTestServer(handler);
    const client = new WebSocketTestClient();

    try {
      await client.connect(`ws://127.0.0.1:${port}`);

      // Subscribe with two different ids
      client.send({
        type: "subscribe",
        payload: {
          id: "sub1",
          query: "select User { name }",
          variables: {},
        },
      });

      const sub1Response = await client.waitForMessage();
      assertEquals(sub1Response.type, "subscription");
      assertExists(sub1Response.payload);

      client.send({
        type: "subscribe",
        payload: {
          id: "sub2",
          query: "select Post { title }",
          variables: {},
        },
      });

      const sub2Response = await client.waitForMessage();
      assertEquals(sub2Response.type, "subscription");
      assertExists(sub2Response.payload);

      // Unsubscribe both (stop_subscription sends "subscription" complete
      // before handler sends "subscription_stopped" — use typed wait)
      client.send({
        type: "unsubscribe",
        payload: { subscriptionId: "sub1" },
      });

      const stop1 = await client.waitForMessageOfType("subscription_stopped");
      assertEquals(stop1.payload.subscriptionId, "sub1");

      client.send({
        type: "unsubscribe",
        payload: { subscriptionId: "sub2" },
      });

      const stop2 = await client.waitForMessageOfType("subscription_stopped");
      assertEquals(stop2.payload.subscriptionId, "sub2");
    } finally {
      await client.closeAndWait();
      await cleanup();
    }
  },
});

Deno.test({
  name: "Production E2E: Connection close cleans up subscriptions cleanly",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const handler = createWSProtocolHandler();
    const { port, cleanup } = withTestServer(handler);
    const client1 = new WebSocketTestClient();

    try {
      await client1.connect(`ws://127.0.0.1:${port}`);

      // Subscribe
      client1.send({
        type: "subscribe",
        payload: {
          id: "sub1",
          query: "select User { name }",
          variables: {},
        },
      });

      // Receive initial subscription data
      const subResponse = await client1.waitForMessage();
      assertEquals(subResponse.type, "subscription");

      // Close the client abruptly (server onclose should clean up)
      await client1.closeAndWait();

      // Give the server a moment to process the close event
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Open a new connection to verify the server is still operational
      const client2 = new WebSocketTestClient();
      await client2.connect(`ws://127.0.0.1:${port}`);
      assertEquals(client2.isConnected(), true);

      // Verify the new connection can send and receive
      client2.send({
        type: "query",
        payload: { query: "select User { name }", variables: {} },
      });

      const queryResponse = await client2.waitForMessage();
      assertEquals(queryResponse.type, "query_result");
      assertExists(queryResponse.payload.data);

      await client2.closeAndWait();
    } finally {
      await cleanup();
    }
  },
});

Deno.test({
  name: "Production E2E: Query over WS works without auth configured",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // Server created without jwtSecret or authConfig
    const handler = createWSProtocolHandler();
    const { port, cleanup } = withTestServer(handler);
    const client = new WebSocketTestClient();

    try {
      await client.connect(`ws://127.0.0.1:${port}`);

      client.send({
        type: "query",
        payload: {
          query: "select User { name }",
          variables: {},
        },
      });

      const response = await client.waitForMessage();
      assertEquals(response.type, "query_result");
      assertExists(response.payload);
      assertExists(response.payload.data);
      assertEquals(response.payload.data.result, "ok");
    } finally {
      await client.closeAndWait();
      await cleanup();
    }
  },
});
