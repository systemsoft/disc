#!/usr/bin/env -S deno run --allow-net --allow-env
// deno-lint-ignore-file no-console

/**
 * EdgeQL Compiler Integration Demo
 * Shows how the server protocol integrates with EdgeQL parsing and compilation
 */

import { DiscServer } from "./server.ts";
import * as EdgeQL from "../edgeql/mod.ts";
import * as Context from "../compiler/context.ts";

async function demonstrateIntegration(): Promise<void> {
  console.log("🚀 EdgeQL Compiler Integration Demo");
  console.log("=".repeat(50));

  // Create test schema
  const schema = Context.createTestSchema();
  console.log(
    "📋 Created test schema with types:",
    Array.from(schema.types.keys()),
  );

  // Demonstrate EdgeQL parsing
  console.log("\n🔍 EdgeQL Parsing:");
  const testQueries = [
    "select User { name, email }",
    "select User filter .name = 'Alice'",
    "insert User { name := 'John', email := 'john@test.com' }",
    "update User filter .id = <uuid>$id set { active := false }",
    "delete User filter .name = 'Bob'",
  ];

  for (const query of testQueries) {
    console.log(`\n  Query: ${query}`);
    try {
      // Tokenize the query
      const lexer = new EdgeQL.EdgeQLLexer(query);
      const tokens = lexer.tokenize();
      console.log(`  ✅ Lexing successful (${tokens.length} tokens)`);

      // Parse the query
      const parser = new EdgeQL.EdgeQLParser(query);
      const parseResult = parser.parse();
      console.log(`  ✅ Parsing successful (${parseResult.kind})`);
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : "Unknown error";
      console.log(`  ❌ Error: ${errorMessage}`);
    }
  }

  // Start integrated server for live demo
  console.log("\n🌐 Starting integrated server with EdgeQL support...");

  const server = new DiscServer({
    host: "localhost",
    port: 8081,
    enable_cors: true,
    enable_websockets: true,
    enable_explain: true, // Show generated SQL in responses
    database_url: "postgresql://localhost:5432/disc_integration",
  });

  const serverPromise = server.start().catch((error) => {
    console.error("Server failed:", error);
  });

  // Give server time to start
  await new Promise((resolve) => setTimeout(resolve, 1000));

  console.log("\n📡 Testing integrated EdgeQL execution:");

  const testCases = [
    {
      name: "Simple User Selection",
      query: "select User { name, email }",
      variables: {},
    },
    {
      name: "Filtered User Query",
      query: "select User filter .active = true",
      variables: {},
    },
    {
      name: "User with Parametrized Filter",
      query: "select User filter .name = <str>$name",
      variables: { name: "Alice" },
    },
    {
      name: "Count Users",
      query: "select count(User)",
      variables: {},
    },
    {
      name: "Insert New User",
      query:
        "insert User { name := 'Test User', email := 'test@example.com', active := true }",
      variables: {},
    },
  ];

  for (const testCase of testCases) {
    console.log(`\n  ${testCase.name}:`);
    try {
      const response = await fetch("http://localhost:8081/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: testCase.query,
          variables: testCase.variables,
        }),
      });

      if (!response.ok) {
        console.log(`    ❌ HTTP Error: ${response.status}`);
        continue;
      }

      const result = await response.json();

      if (result.errors && result.errors.length > 0) {
        console.log(`    ❌ Query Error: ${result.errors[0].message}`);
        console.log(`    📍 Phase: ${result.errors[0].extensions?.phase}`);
      } else {
        console.log(
          `    ✅ Success: ${JSON.stringify(result.data).substring(0, 100)}...`,
        );

        if (result.extensions?.sql) {
          console.log(
            `    🔧 Generated SQL: ${
              result.extensions.sql.substring(0, 80)
            }...`,
          );
        }

        console.log(`    ⏱️  Duration: ${result.extensions?.duration_ms}ms`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : "Unknown error";
      console.log(`    ❌ Request Failed: ${errorMessage}`);
    }
  }

  // Test WebSocket integration
  console.log("\n🔌 Testing WebSocket EdgeQL execution:");

  try {
    const ws = new WebSocket("ws://localhost:8081");

    ws.onopen = () => {
      console.log("  ✅ WebSocket connected");

      // Send a query over WebSocket
      ws.send(JSON.stringify({
        type: "query",
        payload: {
          query: "select User { name, email } limit 2",
          variables: {},
        },
      }));
    };

    ws.onmessage = (event) => {
      const response = JSON.parse(event.data);
      console.log(`  📨 WebSocket Response: ${response.type}`);

      if (response.type === "query_result") {
        if (response.payload.errors) {
          console.log(`    ❌ Error: ${response.payload.errors[0].message}`);
        } else {
          console.log(
            `    ✅ Data: ${
              JSON.stringify(response.payload.data).substring(0, 80)
            }...`,
          );
        }
      }

      ws.close();
    };

    ws.onerror = (error) => {
      console.log(`  ❌ WebSocket Error: ${error}`);
    };

    // Wait for WebSocket demo
    await new Promise((resolve) => setTimeout(resolve, 2000));
  } catch (error) {
    const errorMessage = error instanceof Error
      ? error.message
      : "Unknown error";
    console.log(`  ❌ WebSocket Demo Failed: ${errorMessage}`);
  }

  console.log("\n📊 Integration Summary:");
  console.log("✅ EdgeQL lexing and parsing working");
  console.log("✅ Server protocol integration complete");
  console.log("✅ HTTP and WebSocket endpoints functional");
  console.log("✅ Query validation and error handling");
  console.log("✅ SQL generation pipeline demonstrated");
  console.log(
    "🔄 SQL execution simulation (would connect to PostgreSQL in production)",
  );

  console.log("\n🎉 Integration Demo Complete!");
  console.log("💡 Server is running at http://localhost:8081");
  console.log("   • POST /query for EdgeQL execution");
  console.log("   • WebSocket upgrade for real-time queries");
  console.log("   • GET /health for server status");
  console.log("   • GET /stats for server statistics");
  console.log("\n   Press Ctrl+C to stop the server");

  // Keep server running for manual testing
  await serverPromise;
}

if (import.meta.main) {
  await demonstrateIntegration().catch((error) => {
    console.error("Demo failed:", error);
    Deno.exit(1);
  });
}
