/**
 * WebSocket protocol tests for Disc server
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { DiscServer } from "./server.ts";

const TEST_PORT = 5658;
const TEST_HOST = "localhost";
const WS_URL = `ws://${TEST_HOST}:${TEST_PORT}`;

// Helper class for WebSocket testing
class WebSocketTestClient {
  private socket?: WebSocket;
  private messages: any[] = [];
  private errors: any[] = [];
  private connected = false;

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(WS_URL);

      this.socket.onopen = () => {
        this.connected = true;
        resolve();
      };

      this.socket.onerror = (error) => {
        this.errors.push(error);
        reject(error);
      };

      this.socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          this.messages.push(message);
        } catch (error) {
          this.errors.push(error);
        }
      };

      this.socket.onclose = () => {
        this.connected = false;
      };

      // Timeout if connection takes too long
      setTimeout(() => {
        if (!this.connected) {
          reject(new Error("WebSocket connection timeout"));
        }
      }, 5000);
    });
  }

  send(message: any): void {
    if (this.socket && this.connected) {
      this.socket.send(JSON.stringify(message));
    } else {
      throw new Error("WebSocket not connected");
    }
  }

  waitForMessage(timeout = 5000): Promise<any> {
    return new Promise((resolve, reject) => {
      const checkForMessage = () => {
        if (this.messages.length > 0) {
          resolve(this.messages.shift());
        } else {
          setTimeout(checkForMessage, 10);
        }
      };

      setTimeout(() => {
        reject(new Error("Message timeout"));
      }, timeout);

      checkForMessage();
    });
  }

  getMessages(): any[] {
    return [...this.messages];
  }

  getErrors(): any[] {
    return [...this.errors];
  }

  closeAndWait(): Promise<void> {
    if (this.socket) {
      return new Promise((resolve) => {
        const prevOnClose = this.socket!.onclose;
        this.socket!.onclose = (ev) => {
          this.connected = false;
          if (prevOnClose && typeof prevOnClose === "function") {
            prevOnClose.call(this.socket!, ev);
          }
          resolve();
        };
        this.socket!.close();
      });
    }
    return Promise.resolve();
  }

  close(): void {
    if (this.socket) {
      this.socket.close();
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  sendRaw(data: string): void {
    if (this.socket) {
      this.socket.send(data);
    }
  }
}

// Server harness for WebSocket tests
class WebSocketServerHarness {
  private server?: DiscServer;
  private server_promise?: Promise<void>;

  async start(): Promise<void> {
    this.server = new DiscServer({
      host: TEST_HOST,
      port: TEST_PORT,
      enableCors: true,
      enableWebsockets: true,
      dryRun: true,
    });

    this.server_promise = this.server.start();

    // Wait for server to be ready
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  async stop(): Promise<void> {
    if (this.server) {
      await this.server.stop();
    }
    if (this.server_promise) {
      try {
        await this.server_promise;
      } catch {
        // Expected during shutdown
      }
    }
  }
}

Deno.test({
  name: "WebSocket - Basic Connection",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const harness = new WebSocketServerHarness();
    await harness.start();

    const client = new WebSocketTestClient();

    try {
      await client.connect();
      assertEquals(client.isConnected(), true);
    } finally {
      await client.closeAndWait();
      await harness.stop();
    }
  },
});

Deno.test({
  name: "WebSocket - Query Message",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const harness = new WebSocketServerHarness();
    await harness.start();

    const client = new WebSocketTestClient();

    try {
      await client.connect();

      // Send a query
      client.send({
        type: "query",
        payload: {
          query: "select User { name, email }",
          variables: {},
        },
      });

      // Wait for response
      const response = await client.waitForMessage();

      assertEquals(response.type, "query_result");
      assertExists(response.payload);
      assertExists(response.payload.data);
    } finally {
      await client.closeAndWait();
      await harness.stop();
    }
  },
});

Deno.test({
  name: "WebSocket - Invalid Query",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const harness = new WebSocketServerHarness();
    await harness.start();

    const client = new WebSocketTestClient();

    try {
      await client.connect();

      // Send invalid query
      client.send({
        type: "query",
        payload: {
          query: "", // Empty query
          variables: {},
        },
      });

      // Wait for error response
      const response = await client.waitForMessage();

      assertEquals(response.type, "query_result");
      assertExists(response.payload.errors);
      assert(Array.isArray(response.payload.errors));
      assertEquals(response.payload.errors.length > 0, true);
    } finally {
      await client.closeAndWait();
      await harness.stop();
    }
  },
});

Deno.test({
  name: "WebSocket - Multiple Queries",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const harness = new WebSocketServerHarness();
    await harness.start();

    const client = new WebSocketTestClient();

    try {
      await client.connect();

      // Send multiple queries
      const queries = [
        "select User { name }",
        "select User { email }",
        "select User { name, email }",
      ];

      for (const query of queries) {
        client.send({
          type: "query",
          payload: { query, variables: {} },
        });
      }

      // Wait for all responses
      const responses = [];
      for (let i = 0; i < queries.length; i++) {
        const response = await client.waitForMessage();
        responses.push(response);
      }

      // All should be successful query results
      for (const response of responses) {
        assertEquals(response.type, "query_result");
        assertExists(response.payload.data);
      }
    } finally {
      await client.closeAndWait();
      await harness.stop();
    }
  },
});

Deno.test({
  name: "WebSocket - Subscription Request",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const harness = new WebSocketServerHarness();
    await harness.start();

    const client = new WebSocketTestClient();

    try {
      await client.connect();

      // Send subscription request
      client.send({
        type: "subscribe",
        payload: {
          id: "sub_ws_test",
          query: "select User { name, email }",
          variables: {},
        },
      });

      // Should get subscription data response (handler is implemented now)
      const response = await client.waitForMessage();

      assertEquals(response.type, "subscription");
      assertExists(response.payload);
      // The subscription handler sends data or error
      assert(
        response.payload.type === "data" || response.payload.type === "error",
      );
    } finally {
      await client.closeAndWait();
      await harness.stop();
    }
  },
});

Deno.test({
  name: "WebSocket - Unknown Message Type",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const harness = new WebSocketServerHarness();
    await harness.start();

    const client = new WebSocketTestClient();

    try {
      await client.connect();

      // Send unknown message type
      client.send({
        type: "unknown",
        payload: { some: "data" },
      });

      // Should get error response
      const response = await client.waitForMessage();

      assertEquals(response.type, "error");
      assertExists(response.payload);
      assert(response.payload.message.includes("Unknown message type"));
    } finally {
      await client.closeAndWait();
      await harness.stop();
    }
  },
});

Deno.test({
  name: "WebSocket - Invalid JSON Message",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const harness = new WebSocketServerHarness();
    await harness.start();

    const client = new WebSocketTestClient();

    try {
      await client.connect();

      // Send invalid JSON directly
      client.sendRaw("{ invalid json }");

      // Should get error response
      const response = await client.waitForMessage();

      assertEquals(response.type, "error");
      assertEquals(response.payload.message, "Invalid message format");
    } finally {
      await client.closeAndWait();
      await harness.stop();
    }
  },
});

Deno.test({
  name: "WebSocket - Connection Close Cleanup",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const harness = new WebSocketServerHarness();
    await harness.start();

    const client = new WebSocketTestClient();

    try {
      await client.connect();
      assertEquals(client.isConnected(), true);

      // Close connection
      await client.closeAndWait();

      assertEquals(client.isConnected(), false);
    } finally {
      await harness.stop();
    }
  },
});

Deno.test({
  name: "WebSocket - Concurrent Connections",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const harness = new WebSocketServerHarness();
    await harness.start();

    const clients: WebSocketTestClient[] = [];
    const NUM_CLIENTS = 5;

    try {
      // Create multiple concurrent connections
      for (let i = 0; i < NUM_CLIENTS; i++) {
        const client = new WebSocketTestClient();
        await client.connect();
        clients.push(client);
      }

      // All clients should be connected
      for (const client of clients) {
        assertEquals(client.isConnected(), true);
      }

      // Send queries from all clients
      for (let i = 0; i < NUM_CLIENTS; i++) {
        clients[i].send({
          type: "query",
          payload: {
            query: `select User { name } limit ${i + 1}`,
            variables: {},
          },
        });
      }

      // Wait for all responses
      for (const client of clients) {
        const response = await client.waitForMessage();
        assertEquals(response.type, "query_result");
        assertExists(response.payload.data);
      }
    } finally {
      // Close all clients
      for (const client of clients) {
        await client.closeAndWait();
      }
      await harness.stop();
    }
  },
});

Deno.test({
  name: "WebSocket - Query with Variables",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const harness = new WebSocketServerHarness();
    await harness.start();

    const client = new WebSocketTestClient();

    try {
      await client.connect();

      // Send query with variables
      client.send({
        type: "query",
        payload: {
          query: "select User filter .id = <uuid>$userId { name, email }",
          variables: {
            userId: "01234567-89ab-cdef-0123-456789abcdef",
          },
        },
      });

      // Wait for response
      const response = await client.waitForMessage();

      assertEquals(response.type, "query_result");
      assertExists(response.payload.data);
      // In dry-run mode, warnings may be present but data should still be returned
    } finally {
      await client.closeAndWait();
      await harness.stop();
    }
  },
});

Deno.test({
  name: "WebSocket - Error Handling During Query",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const harness = new WebSocketServerHarness();
    await harness.start();

    const client = new WebSocketTestClient();

    try {
      await client.connect();

      // Send query with syntax error
      client.send({
        type: "query",
        payload: {
          query: "select User { name email }", // Missing comma
          variables: {},
        },
      });

      // Wait for response
      const response = await client.waitForMessage();

      assertEquals(response.type, "query_result");
      assertExists(response.payload.errors);
      assert(Array.isArray(response.payload.errors));
    } finally {
      await client.closeAndWait();
      await harness.stop();
    }
  },
});
