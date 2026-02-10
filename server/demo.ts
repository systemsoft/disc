#!/usr/bin/env -S deno run --allow-net --allow-env

/**
 * Disc Server Demo
 * Demonstrates the HTTP server with EdgeQL protocol support
 */

import { DiscServer } from "./server.ts";

async function runDemo(): Promise<void> {
  console.log("🚀 Disc Server Demo");
  console.log("=".repeat(50));

  // Create server with demo configuration
  const server = new DiscServer({
    host: "localhost",
    port: 8080,
    enable_cors: true,
    enable_websockets: true,
    database_url: "postgresql://localhost:5432/disc_demo",
  });

  // Start server in background (not blocking)
  console.log("📡 Starting server...");
  
  const serverPromise = server.start().catch((error) => {
    console.error("Server failed:", error);
  });

  // Give server time to start
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Demo HTTP requests
  console.log("\n🌐 Testing HTTP endpoints:");

  try {
    // Test root endpoint
    console.log("GET /");
    const rootResponse = await fetch("http://localhost:8080/");
    const rootData = await rootResponse.text();
    console.log(rootData.substring(0, 200) + "...");

    // Test health endpoint
    console.log("\nGET /health");
    const healthResponse = await fetch("http://localhost:8080/health");
    const healthData = await healthResponse.text();
    console.log(healthData.substring(0, 200) + "...");

    // Test query endpoint
    console.log("\nPOST /query");
    const queryResponse = await fetch("http://localhost:8080/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "select User { name, email }",
        variables: {},
      }),
    });
    const queryData = await queryResponse.text();
    console.log(queryData.substring(0, 300) + "...");

    // Test stats endpoint
    console.log("\nGET /stats");
    const statsResponse = await fetch("http://localhost:8080/stats");
    const statsData = await statsResponse.text();
    console.log(statsData.substring(0, 200) + "...");

  } catch (error) {
    console.error("Demo request failed:", error);
  }

  console.log("\n✅ Demo completed successfully!");
  console.log("💡 Server is still running at http://localhost:8080");
  console.log("   Try these endpoints:");
  console.log("   • GET  http://localhost:8080/         (Server info)");
  console.log("   • GET  http://localhost:8080/health   (Health check)");
  console.log("   • GET  http://localhost:8080/stats    (Server stats)");
  console.log("   • POST http://localhost:8080/query    (Execute EdgeQL)");
  console.log("\n   Press Ctrl+C to stop the server");

  // Wait for server to finish (will run until Ctrl+C)
  await serverPromise;
}

if (import.meta.main) {
  await runDemo().catch((error) => {
    console.error("Demo failed:", error);
    Deno.exit(1);
  });
}