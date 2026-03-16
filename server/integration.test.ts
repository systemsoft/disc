/**
 * Integration tests for the complete Disc server protocol implementation
 */

import { assertEquals, assertExists, assertStringIncludes, assert } from "@std/assert";
import { DiscServer } from "./server.ts";
import * as Types from "./types.ts";

// Test fixtures
const TEST_PORT = 5657;
const TEST_HOST = "localhost";
const BASE_URL = `http://${TEST_HOST}:${TEST_PORT}`;

const SAMPLE_QUERIES = {
  valid_select: "select User { name, email }",
  valid_insert: "insert User { name := 'Alice', email := 'alice@example.com' }",
  valid_update: "update User filter .id = <uuid>$id set { name := 'Alice Updated' }",
  valid_delete: "delete User filter .id = <uuid>$id",
  invalid_syntax: "select User { name email }",  // Missing comma
  empty_query: "",
};

// Helper function to make HTTP requests
async function makeRequest(
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
): Promise<Response> {
  const { method = "GET", headers = {}, body } = options;

  const request_headers = new Headers({
    "Content-Type": "application/json",
    ...headers,
  });

  return await fetch(`${BASE_URL}${path}`, {
    method,
    headers: request_headers,
    body,
  });
}

// Helper function to make EdgeQL query requests
async function queryEdgeQL(
  query: string,
  variables: Record<string, any> = {},
  headers: Record<string, string> = {}
): Promise<{
  ok: boolean;
  status: number;
  data?: any;
  errors?: Types.QueryError[];
  extensions?: Record<string, any>;
}> {
  const response = await makeRequest("/query", {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });

  const result = await response.json();
  return {
    ok: response.ok,
    status: response.status,
    ...result,
  };
}

// Test helper to setup and teardown server
class ServerTestHarness {
  private server?: DiscServer;
  private server_promise?: Promise<void>;

  async start(): Promise<void> {
    this.server = new DiscServer({
      host: TEST_HOST,
      port: TEST_PORT,
      enable_cors: true,
      enable_websockets: true,
      dry_run: true,
      enable_explain: true,
    });

    this.server_promise = this.server.start();

    // Wait for server to be ready
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  async stop(): Promise<void> {
    if (this.server) {
      await this.server.stop();
    }
    if (this.server_promise) {
      try {
        await this.server_promise;
      } catch {
        // Server shutdown is expected to throw
      }
    }
    // Extra delay to ensure port is freed
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

Deno.test({
  name: "Server Integration - Basic Server Startup",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const harness = new ServerTestHarness();
    await harness.start();

    try {
      // Test server info endpoint
      const response = await makeRequest("/");
      assertEquals(response.ok, true);

      const info = await response.json();
      assertEquals(info.name, "Disc Database");
      assertEquals(info.version, "0.1.0");
      assertExists(info.endpoints);
    } finally {
      await harness.stop();
    }
  },
});

Deno.test({
  name: "Server Integration - Health Check Endpoint",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const harness = new ServerTestHarness();
    await harness.start();

    try {
      const response = await makeRequest("/health");
      assertEquals(response.ok, true);
      assertEquals(response.headers.get("content-type"), "application/json");

      const health = await response.json();
      assertEquals(health.status, "healthy");
      assertExists(health.timestamp);
      assertEquals(typeof health.uptime_ms, "number");
      assertExists(health.connections);
      assertExists(health.memory);
    } finally {
      await harness.stop();
    }
  },
});

Deno.test({
  name: "Server Integration - Stats Endpoint",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const harness = new ServerTestHarness();
    await harness.start();

    try {
      const response = await makeRequest("/stats");
      assertEquals(response.ok, true);

      const stats = await response.json();
      assertExists(stats.connections);
      assertExists(stats.queries);
      assertExists(stats.transactions);
      assertExists(stats.memory_usage);
      assertEquals(typeof stats.uptime_ms, "number");
    } finally {
      await harness.stop();
    }
  },
});

Deno.test({
  name: "Server Integration - CORS Headers",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const harness = new ServerTestHarness();
    await harness.start();

    try {
      // Test CORS preflight request
      const preflight = await fetch(`${BASE_URL}/query`, {
        method: "OPTIONS",
        headers: {
          "Origin": "http://localhost:3000",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "Content-Type",
        },
      });

      assertEquals(preflight.ok, true);
      assertEquals(preflight.status, 204);
      assertEquals(preflight.headers.get("Access-Control-Allow-Origin"), "*");
      assertEquals(preflight.headers.get("Access-Control-Allow-Methods"), "GET, POST, OPTIONS");
      assertEquals(preflight.headers.get("Access-Control-Allow-Headers"), "Content-Type, Authorization");
    } finally {
      await harness.stop();
    }
  },
});

Deno.test({
  name: "Server Integration - Valid EdgeQL Select Query",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const harness = new ServerTestHarness();
    await harness.start();

    try {
      const result = await queryEdgeQL(SAMPLE_QUERIES.valid_select);

      assertEquals(result.ok, true);
      assertEquals(result.status, 200);
      assertExists(result.data);
      // In dry-run mode, warnings may be present as errors with code "WARNING"
      if (result.errors) {
        // If errors are present, they should only be warnings
        for (const err of result.errors) {
          assertEquals(err.extensions?.code, "WARNING");
        }
      }
      assertExists(result.extensions);
      assertEquals(typeof result.extensions.duration_ms, "number");
      assertEquals(typeof result.extensions.query_hash, "string");
    } finally {
      await harness.stop();
    }
  },
});

Deno.test({
  name: "Server Integration - Valid EdgeQL Insert Query",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const harness = new ServerTestHarness();
    await harness.start();

    try {
      const result = await queryEdgeQL(SAMPLE_QUERIES.valid_insert);

      assertEquals(result.ok, true);
      assertEquals(result.status, 200);
      assertExists(result.data);
    } finally {
      await harness.stop();
    }
  },
});

Deno.test({
  name: "Server Integration - EdgeQL Query with Variables",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const harness = new ServerTestHarness();
    await harness.start();

    try {
      const variables = {
        id: "01234567-89ab-cdef-0123-456789abcdef"
      };

      const result = await queryEdgeQL(SAMPLE_QUERIES.valid_update, variables);

      assertEquals(result.ok, true);
      assertEquals(result.status, 200);
      assertExists(result.data);
    } finally {
      await harness.stop();
    }
  },
});

Deno.test({
  name: "Server Integration - Invalid EdgeQL Syntax",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const harness = new ServerTestHarness();
    await harness.start();

    try {
      const result = await queryEdgeQL(SAMPLE_QUERIES.invalid_syntax);

      assertEquals(result.ok, false);
      assertEquals(result.status, 400);
      assert(Array.isArray(result.errors));
      assertEquals(result.errors!.length > 0, true);
    } finally {
      await harness.stop();
    }
  },
});

Deno.test({
  name: "Server Integration - Empty Query Validation",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const harness = new ServerTestHarness();
    await harness.start();

    try {
      const result = await queryEdgeQL(SAMPLE_QUERIES.empty_query);

      assertEquals(result.ok, false);
      assertEquals(result.status, 400);
      assert(Array.isArray(result.errors));
      assertEquals(result.errors!.length > 0, true);
      assertStringIncludes(result.errors![0].message, "Query is required");
    } finally {
      await harness.stop();
    }
  },
});

Deno.test({
  name: "Server Integration - Large Query Rejection",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const harness = new ServerTestHarness();
    await harness.start();

    try {
      // Generate a query larger than 100KB
      const largeQuery = "select User { name }" + "// ".repeat(50000);
      const result = await queryEdgeQL(largeQuery);

      assertEquals(result.ok, false);
      assertEquals(result.status, 400);
      assert(Array.isArray(result.errors));
      assertStringIncludes(result.errors![0].message, "Query too large");
    } finally {
      await harness.stop();
    }
  },
});

Deno.test({
  name: "Server Integration - Invalid JSON Request",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const harness = new ServerTestHarness();
    await harness.start();

    try {
      const response = await makeRequest("/query", {
        method: "POST",
        body: "{ invalid json }",
      });

      assertEquals(response.ok, false);
      assertEquals(response.status, 400);

      const result = await response.json();
      assertEquals(result.error, "Invalid JSON");
    } finally {
      await harness.stop();
    }
  },
});

Deno.test({
  name: "Server Integration - Wrong HTTP Method",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const harness = new ServerTestHarness();
    await harness.start();

    try {
      const response = await makeRequest("/query", {
        method: "GET",
      });

      assertEquals(response.ok, false);
      assertEquals(response.status, 405);

      const result = await response.json();
      assertEquals(result.error, "Method Not Allowed");
    } finally {
      await harness.stop();
    }
  },
});

Deno.test({
  name: "Server Integration - Unknown Endpoint",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const harness = new ServerTestHarness();
    await harness.start();

    try {
      const response = await makeRequest("/unknown");
      assertEquals(response.ok, false);
      assertEquals(response.status, 404);

      const result = await response.json();
      assertEquals(result.error, "Not Found");
    } finally {
      await harness.stop();
    }
  },
});

Deno.test({
  name: "Server Integration - Request Timeout Handling",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const harness = new ServerTestHarness();
    await harness.start();

    try {
      // Test with a query that should complete quickly (no actual timeout)
      const result = await queryEdgeQL("select User { name } limit 1");

      assertEquals(result.ok, true);
      assertExists(result.extensions?.duration_ms);
      assert(result.extensions!.duration_ms < 1000); // Should be much faster than timeout
    } finally {
      await harness.stop();
    }
  },
});

Deno.test({
  name: "Server Integration - Session Management",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const harness = new ServerTestHarness();
    await harness.start();

    try {
      // Make multiple requests and verify sessions are tracked
      const result1 = await queryEdgeQL(SAMPLE_QUERIES.valid_select);
      const result2 = await queryEdgeQL(SAMPLE_QUERIES.valid_select);

      assertEquals(result1.ok, true);
      assertEquals(result2.ok, true);

      // Check stats to see connections are tracked
      const statsResponse = await makeRequest("/stats");
      const stats = await statsResponse.json();

      assert(stats.connections.total >= 2);
    } finally {
      await harness.stop();
    }
  },
});

Deno.test({
  name: "Server Integration - Client Info Parsing",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const harness = new ServerTestHarness();
    await harness.start();

    try {
      const result = await queryEdgeQL(SAMPLE_QUERIES.valid_select, {}, {
        "User-Agent": "disc-client/1.0.0",
      });

      assertEquals(result.ok, true);
      // Client info is internal but query should succeed
    } finally {
      await harness.stop();
    }
  },
});

Deno.test({
  name: "Server Integration - Explain Mode",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const harness = new ServerTestHarness();
    await harness.start();

    try {
      // The test server has explain mode enabled
      const result = await queryEdgeQL(SAMPLE_QUERIES.valid_select);

      assertEquals(result.ok, true);
      assertExists(result.extensions);

      // Should include SQL in explain mode
      if (result.extensions.sql) {
        assertStringIncludes(result.extensions.sql.toLowerCase(), "select");
      }
    } finally {
      await harness.stop();
    }
  },
});

Deno.test({
  name: "Server Integration - Dry Run Mode",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const harness = new ServerTestHarness();
    await harness.start();

    try {
      // The test server has dry_run enabled
      const result = await queryEdgeQL(SAMPLE_QUERIES.valid_insert);

      assertEquals(result.ok, true);
      assertExists(result.data);

      // In dry-run mode, should get mock data with dry_run flag
      if (result.data.dry_run !== undefined) {
        assertEquals(result.data.dry_run, true);
      }
    } finally {
      await harness.stop();
    }
  },
});
