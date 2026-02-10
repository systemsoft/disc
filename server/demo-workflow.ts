/**
 * Demo script showing the complete Disc server protocol implementation
 * Demonstrates HTTP endpoints, EdgeQL processing, and WebSocket subscriptions
 */

import { DiscServer } from "./server.ts";

const DEMO_PORT = 5659;

async function runDemo() {
  console.log("🎯 Disc Server Protocol Demo");
  console.log("=============================");

  // Start the server
  const server = new DiscServer({
    host: "localhost",
    port: DEMO_PORT,
    enable_cors: true,
    enable_websockets: true,
    dry_run: true,
    enable_explain: true,
  });

  try {
    console.log("\n📡 Starting Disc server...");
    const serverPromise = server.start();

    // Give server time to start
    await new Promise(resolve => setTimeout(resolve, 200));

    console.log("\n🔍 Testing HTTP Endpoints:");
    console.log("==========================");

    // Test server info endpoint
    console.log("\n1. Server Info Endpoint:");
    const infoResponse = await fetch(`http://localhost:${DEMO_PORT}/`);
    const info = await infoResponse.json();
    console.log("   Status:", infoResponse.status);
    console.log("   Name:", info.name);
    console.log("   Version:", info.version);
    console.log("   Protocol:", info.protocol);

    // Test health endpoint
    console.log("\n2. Health Check Endpoint:");
    const healthResponse = await fetch(`http://localhost:${DEMO_PORT}/health`);
    const health = await healthResponse.json();
    console.log("   Status:", healthResponse.status);
    console.log("   Server Status:", health.status);
    console.log("   Uptime:", Math.round(health.uptime_ms / 1000), "seconds");

    // Test EdgeQL query endpoint
    console.log("\n3. EdgeQL Query Endpoint:");
    const queryResponse = await fetch(`http://localhost:${DEMO_PORT}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "select User { name, email, age }",
        variables: {},
      }),
    });
    
    const queryResult = await queryResponse.json();
    console.log("   Status:", queryResponse.status);
    console.log("   Query successful:", !queryResult.errors);
    if (queryResult.data) {
      console.log("   Results count:", Array.isArray(queryResult.data) ? queryResult.data.length : 1);
    }
    if (queryResult.extensions) {
      console.log("   Duration:", queryResult.extensions.duration_ms, "ms");
      console.log("   Query hash:", queryResult.extensions.query_hash);
    }

    // Test EdgeQL with variables
    console.log("\n4. EdgeQL Query with Variables:");
    const variableQueryResponse = await fetch(`http://localhost:${DEMO_PORT}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "select User filter .id = <uuid>$user_id { name, email }",
        variables: {
          user_id: "01234567-89ab-cdef-0123-456789abcdef",
        },
      }),
    });
    
    const variableResult = await variableQueryResponse.json();
    console.log("   Status:", variableQueryResponse.status);
    console.log("   Query successful:", !variableResult.errors);

    // Test invalid query
    console.log("\n5. Invalid EdgeQL Query:");
    const invalidQueryResponse = await fetch(`http://localhost:${DEMO_PORT}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "select User { name email }", // Missing comma
        variables: {},
      }),
    });
    
    const invalidResult = await invalidQueryResponse.json();
    console.log("   Status:", invalidQueryResponse.status);
    console.log("   Has errors:", !!invalidResult.errors);
    if (invalidResult.errors) {
      console.log("   Error message:", invalidResult.errors[0].message);
    }

    // Test stats endpoint
    console.log("\n6. Statistics Endpoint:");
    const statsResponse = await fetch(`http://localhost:${DEMO_PORT}/stats`);
    const stats = await statsResponse.json();
    console.log("   Status:", statsResponse.status);
    console.log("   Total queries:", stats.queries.total);
    console.log("   Successful queries:", stats.queries.successful);
    console.log("   Failed queries:", stats.queries.failed);
    console.log("   Active connections:", stats.connections.active);

    console.log("\n🔌 Testing WebSocket Protocol:");
    console.log("==============================");

    // Test WebSocket connection
    console.log("\n7. WebSocket Connection:");
    const websocket = new WebSocket(`ws://localhost:${DEMO_PORT}`);
    
    const wsTestPromise = new Promise<void>((resolve) => {
      let messageCount = 0;

      websocket.onopen = () => {
        console.log("   ✅ WebSocket connected successfully");

        // Send a query
        websocket.send(JSON.stringify({
          type: "query",
          payload: {
            query: "select User { name, email } limit 3",
            variables: {},
          },
        }));

        // Send a subscription request
        websocket.send(JSON.stringify({
          type: "subscribe",
          payload: {
            id: "demo_sub_001",
            query: "select User { name, status }",
            variables: {},
          },
        }));
      };

      websocket.onmessage = (event) => {
        messageCount++;
        const message = JSON.parse(event.data);
        
        if (message.type === "query_result") {
          console.log("   📨 Query result received");
          console.log("       Has data:", !!message.payload.data);
          console.log("       Has errors:", !!message.payload.errors);
        } else if (message.type === "subscription") {
          console.log("   📡 Subscription message received");
          console.log("       Type:", message.payload.type);
          console.log("       Subscription ID:", message.payload.id);
        } else if (message.type === "error") {
          console.log("   ❌ Error received:", message.payload.message);
        }

        // After receiving a few messages, close connection
        if (messageCount >= 3) {
          websocket.close();
        }
      };

      websocket.onclose = () => {
        console.log("   🔌 WebSocket connection closed");
        resolve();
      };

      websocket.onerror = (error) => {
        console.log("   ❌ WebSocket error:", error);
        resolve();
      };

      // Timeout after 5 seconds
      setTimeout(() => {
        if (websocket.readyState === WebSocket.OPEN) {
          websocket.close();
        }
        resolve();
      }, 5000);
    });

    // Wait for WebSocket test to complete
    await wsTestPromise;

    console.log("\n📊 Final Statistics:");
    console.log("====================");
    
    const finalStatsResponse = await fetch(`http://localhost:${DEMO_PORT}/stats`);
    const finalStats = await finalStatsResponse.json();
    console.log("   Total requests processed:", finalStats.queries.total);
    console.log("   Average response time:", Math.round(finalStats.queries.avg_duration_ms), "ms");
    console.log("   Server uptime:", Math.round(finalStats.uptime_ms / 1000), "seconds");
    console.log("   Memory usage:", Math.round(finalStats.memory_usage.heap_used / 1024 / 1024), "MB");

    if (finalStats.subscriptions) {
      console.log("   Active subscriptions:", finalStats.subscriptions.active_subscriptions);
      console.log("   Connections with subscriptions:", finalStats.subscriptions.total_connections_with_subscriptions);
    }

    console.log("\n✅ Demo completed successfully!");
    console.log("\nKey Features Demonstrated:");
    console.log("• HTTP/JSON protocol with EdgeQL queries");
    console.log("• CORS support for web clients");
    console.log("• Query validation and error handling");
    console.log("• Variable substitution in queries");
    console.log("• WebSocket support for real-time queries");
    console.log("• Subscription system for live data");
    console.log("• Connection and session management");
    console.log("• Comprehensive server statistics");
    console.log("• Health monitoring endpoints");

  } catch (error) {
    console.error("❌ Demo failed:", error);
  } finally {
    console.log("\n🛑 Shutting down server...");
    await server.stop();
    console.log("✅ Server shutdown complete");
  }
}

// Run the demo if this script is executed directly
if (import.meta.main) {
  await runDemo();
}