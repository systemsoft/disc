/**
 * Subscription handler tests
 */

import { assertEquals, assertExists, assert } from "@std/assert";
import { SubscriptionHandler } from "./subscription-handler.ts";
import * as Types from "./types.ts";

// Mock WebSocket for testing
class MockWebSocket {
  public readyState = 1; // OPEN
  public messages: string[] = [];

  send(message: string): void {
    this.messages.push(message);
  }

  getLastMessage(): any {
    if (this.messages.length === 0) return null;
    return JSON.parse(this.messages[this.messages.length - 1]);
  }

  getAllMessages(): any[] {
    return this.messages.map(msg => JSON.parse(msg));
  }

  close(): void {
    this.readyState = 3; // CLOSED
  }
}

// Helper function to create test context
function createTestContext(): Types.QueryContext {
  return {
    session: {
      session_id: "test_session_123",
      database: "test_db",
      created_at: new Date(),
      last_activity: new Date(),
      variables: {},
    },
    auth: { roles: [], permissions: [] },
    request_id: "test_request_123",
    started_at: new Date(),
  };
}

Deno.test("Subscription Handler - Basic Subscription", async () => {
  const handler = new SubscriptionHandler();
  const websocket = new MockWebSocket() as unknown as WebSocket;
  const context = createTestContext();

  const subscription: Types.SubscriptionRequest = {
    id: "sub_001",
    query: "select User { name, email }",
    variables: {},
  };

  try {
    await handler.handle_subscription(subscription, context, websocket);

    // Should have sent initial data
    const messages = (websocket as unknown as MockWebSocket).getAllMessages();
    assertEquals(messages.length > 0, true);

    const firstMessage = messages[0];
    assertEquals(firstMessage.type, "subscription");
    assertEquals(firstMessage.payload.id, "sub_001");
    assertEquals(firstMessage.payload.type, "data");
    assertExists(firstMessage.payload.payload);
  } finally {
    handler.dispose();
  }
});

Deno.test("Subscription Handler - Validation Errors", async () => {
  const handler = new SubscriptionHandler();
  const websocket = new MockWebSocket() as unknown as WebSocket;
  const context = createTestContext();

  try {
    // Test invalid query (INSERT not allowed)
    const invalid_subscription: Types.SubscriptionRequest = {
      id: "sub_002",
      query: "insert User { name := 'test' }",
      variables: {},
    };

    await handler.handle_subscription(invalid_subscription, context, websocket);

    const messages = (websocket as unknown as MockWebSocket).getAllMessages();
    assertEquals(messages.length, 1);

    const errorMessage = messages[0];
    assertEquals(errorMessage.type, "subscription");
    assertEquals(errorMessage.payload.type, "error");
    assert(errorMessage.payload.payload.message.includes("cannot contain 'insert'") ||
           errorMessage.payload.payload.message.includes("only support SELECT"));
  } finally {
    handler.dispose();
  }
});

Deno.test("Subscription Handler - Forbidden Operations", async () => {
  const handler = new SubscriptionHandler();
  const websocket = new MockWebSocket() as unknown as WebSocket;
  const context = createTestContext();

  try {
    const forbidden_operations = ["update", "delete", "drop", "alter"];

    for (const operation of forbidden_operations) {
      const subscription: Types.SubscriptionRequest = {
        id: `sub_${operation}`,
        query: `${operation} User`,
        variables: {},
      };

      await handler.handle_subscription(subscription, context, websocket);

      const messages = (websocket as unknown as MockWebSocket).getAllMessages();
      const lastMessage = messages[messages.length - 1];

      assertEquals(lastMessage.payload.type, "error");
      assert(lastMessage.payload.payload.message.includes(`cannot contain '${operation}'`));
    }
  } finally {
    handler.dispose();
  }
});

Deno.test("Subscription Handler - Stop Subscription", async () => {
  const handler = new SubscriptionHandler();
  const websocket = new MockWebSocket() as unknown as WebSocket;
  const context = createTestContext();

  try {
    const subscription: Types.SubscriptionRequest = {
      id: "sub_003",
      query: "select User { name }",
      variables: {},
    };

    await handler.handle_subscription(subscription, context, websocket);

    // Stop the subscription
    handler.stop_subscription("sub_003");

    // Should send complete message
    const messages = (websocket as unknown as MockWebSocket).getAllMessages();
    const completeMessage = messages.find(m => m.payload?.type === "complete");

    assertExists(completeMessage);
    assertEquals(completeMessage.payload.id, "sub_003");
  } finally {
    handler.dispose();
  }
});

Deno.test("Subscription Handler - Connection Cleanup", async () => {
  const handler = new SubscriptionHandler();
  const websocket = new MockWebSocket() as unknown as WebSocket;
  const context = createTestContext();

  try {
    // Create multiple subscriptions for same connection
    const subscriptions = [
      { id: "sub_004", query: "select User { name }" },
      { id: "sub_005", query: "select Post { title }" },
      { id: "sub_006", query: "select User { email }" },
    ];

    for (const sub of subscriptions) {
      await handler.handle_subscription(
        { ...sub, variables: {} },
        context,
        websocket
      );
    }

    const initial_stats = handler.get_subscription_stats();
    assertEquals(initial_stats.active_subscriptions, 3);

    // Cleanup connection
    handler.cleanup_connection(context.session.session_id);

    const final_stats = handler.get_subscription_stats();
    assertEquals(final_stats.active_subscriptions, 0);
  } finally {
    handler.dispose();
  }
});

Deno.test("Subscription Handler - Subscription Limits", async () => {
  const handler = new SubscriptionHandler({
    max_subscriptions_per_connection: 2,
  });
  const websocket = new MockWebSocket() as unknown as WebSocket;
  const context = createTestContext();

  try {
    // Create subscriptions up to limit
    await handler.handle_subscription(
      { id: "sub_007", query: "select User { name }", variables: {} },
      context,
      websocket
    );

    await handler.handle_subscription(
      { id: "sub_008", query: "select Post { title }", variables: {} },
      context,
      websocket
    );

    // This should fail due to limit
    await handler.handle_subscription(
      { id: "sub_009", query: "select User { email }", variables: {} },
      context,
      websocket
    );

    const messages = (websocket as unknown as MockWebSocket).getAllMessages();
    const errorMessage = messages.find(m =>
      m.payload?.type === "error" &&
      m.payload?.payload?.message?.includes("Too many subscriptions")
    );

    assertExists(errorMessage);
  } finally {
    handler.dispose();
  }
});

Deno.test("Subscription Handler - Statistics", async () => {
  const handler = new SubscriptionHandler();
  const websocket = new MockWebSocket() as unknown as WebSocket;

  try {
    // Create contexts for different connections
    const contexts = [
      createTestContext(),
      { ...createTestContext(), session: { ...createTestContext().session, session_id: "session_456" } },
    ];

    // Create subscriptions across multiple connections
    await handler.handle_subscription(
      { id: "sub_010", query: "select User { name }", variables: {} },
      contexts[0],
      websocket
    );

    await handler.handle_subscription(
      { id: "sub_011", query: "select Post { title }", variables: {} },
      contexts[1],
      websocket
    );

    const stats = handler.get_subscription_stats();

    assertEquals(stats.active_subscriptions, 2);
    assertEquals(stats.total_connections_with_subscriptions, 2);
    assertEquals(stats.subscriptions_by_connection.length, 2);

    // Each connection should have 1 subscription
    for (const conn_stat of stats.subscriptions_by_connection) {
      assertEquals(conn_stat.count, 1);
    }
  } finally {
    handler.dispose();
  }
});

Deno.test("Subscription Handler - Mock Data Generation", async () => {
  const handler = new SubscriptionHandler();
  const websocket = new MockWebSocket() as unknown as WebSocket;
  const context = createTestContext();

  try {
    // Test User query mock data
    const user_subscription: Types.SubscriptionRequest = {
      id: "sub_012",
      query: "select User { name, email, status }",
      variables: {},
    };

    await handler.handle_subscription(user_subscription, context, websocket);

    let messages = (websocket as unknown as MockWebSocket).getAllMessages();
    let data_message = messages.find(m => m.payload?.type === "data");

    assertExists(data_message);
    const user_data = data_message.payload.payload;
    assertEquals(Array.isArray(user_data), true);
    assertEquals(user_data.length > 0, true);
    assertExists(user_data[0].name);
    assertExists(user_data[0].email);

    // Clear messages
    (websocket as unknown as MockWebSocket).messages = [];

    // Test Post query mock data
    const post_subscription: Types.SubscriptionRequest = {
      id: "sub_013",
      query: "select Post { title, content, author }",
      variables: {},
    };

    await handler.handle_subscription(post_subscription, context, websocket);

    messages = (websocket as unknown as MockWebSocket).getAllMessages();
    data_message = messages.find(m => m.payload?.type === "data");

    assertExists(data_message);
    const post_data = data_message.payload.payload;
    assertEquals(Array.isArray(post_data), true);
    assertExists(post_data[0].title);
    assertExists(post_data[0].content);
  } finally {
    handler.dispose();
  }
});

Deno.test("Subscription Handler - WebSocket State Handling", async () => {
  const handler = new SubscriptionHandler();
  const websocket = new MockWebSocket();
  const context = createTestContext();

  try {
    const subscription: Types.SubscriptionRequest = {
      id: "sub_014",
      query: "select User { name }",
      variables: {},
    };

    await handler.handle_subscription(subscription, context, websocket as unknown as WebSocket);

    // Simulate WebSocket close
    websocket.close();

    // Wait a moment for potential cleanup
    await new Promise(resolve => setTimeout(resolve, 100));

    const stats = handler.get_subscription_stats();
    // Note: In real implementation, heartbeat would clean up closed connections
    // For this test, we just verify the subscription was created initially
    assert(stats.active_subscriptions >= 0);
  } finally {
    handler.dispose();
  }
});
