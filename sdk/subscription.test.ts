import { assertEquals, assertExists } from "@std/assert";

import {
  createSubscriptionClient,
  SubscriptionClient,
} from "./subscription.ts";

// --- Mock WebSocket ---

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = 0; // CONNECTING
  url: string;
  sent: string[] = [];

  onopen: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);

    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    }, 0);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: 1000 });
  }

  /** Test helper: simulate receiving a message from the server */
  simulateMessage(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

// --- Setup / teardown helpers ---

type GlobalWithWebSocket = typeof globalThis & {
  WebSocket: typeof MockWebSocket;
};

function installMockWebSocket(): () => void {
  const original = (globalThis as GlobalWithWebSocket).WebSocket;
  MockWebSocket.instances = [];
  (globalThis as GlobalWithWebSocket).WebSocket = MockWebSocket;

  return () => {
    (globalThis as GlobalWithWebSocket).WebSocket = original;
    MockWebSocket.instances = [];
  };
}

/** Wait for the mock socket to open (one macrotask) */
function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// --- Tests ---

Deno.test("subscription - connect() converts http URL to ws URL", async () => {
  const restore = installMockWebSocket();
  try {
    const client = new SubscriptionClient({ baseUrl: "http://localhost:5656" });
    await client.connect();
    const ws = MockWebSocket.instances[0];
    assertEquals(ws.url, "ws://localhost:5656");
  } finally {
    restore();
  }
});

Deno.test(
  "subscription - connect() converts https URL to wss URL",
  async () => {
    const restore = installMockWebSocket();
    try {
      const client = new SubscriptionClient({
        baseUrl: "https://db.example.com",
      });
      await client.connect();
      const ws = MockWebSocket.instances[0];
      assertEquals(ws.url, "wss://db.example.com");
    } finally {
      restore();
    }
  },
);

Deno.test("subscription - connect() resolves when socket opens", async () => {
  const restore = installMockWebSocket();
  try {
    const client = new SubscriptionClient();
    // connect() resolving without throwing is the assertion
    await client.connect();
    assertEquals(client.isConnected(), true);
  } finally {
    restore();
  }
});

Deno.test(
  "subscription - subscribe() sends subscribe message over WS",
  async () => {
    const restore = installMockWebSocket();
    try {
      const client = new SubscriptionClient();
      await client.connect();

      client.subscribe("select User { name }", {
        onData: (_data: unknown) => {},
      });

      const ws = MockWebSocket.instances[0];
      assertEquals(ws.sent.length, 1);

      const msg = JSON.parse(ws.sent[0]) as {
        type: string;
        payload: { id: string; query: string };
      };
      assertEquals(msg.type, "subscribe");
      assertEquals(msg.payload.query, "select User { name }");
      assertExists(msg.payload.id);
    } finally {
      restore();
    }
  },
);

Deno.test(
  "subscription - subscribe() returns handle with id and unsubscribe",
  async () => {
    const restore = installMockWebSocket();
    try {
      const client = new SubscriptionClient();
      await client.connect();

      const handle = client.subscribe("select 1", {
        onData: (_data: unknown) => {},
      });

      assertExists(handle.id);
      assertEquals(typeof handle.id, "string");
      assertEquals(typeof handle.unsubscribe, "function");
    } finally {
      restore();
    }
  },
);

Deno.test(
  "subscription - incoming data message routes to onData callback",
  async () => {
    const restore = installMockWebSocket();
    try {
      const client = new SubscriptionClient();
      await client.connect();

      const received: unknown[] = [];
      const handle = client.subscribe("select User { name }", {
        onData: (data: unknown) => {
          received.push(data);
        },
      });

      const ws = MockWebSocket.instances[0];
      ws.simulateMessage({
        id: handle.id,
        type: "data",
        payload: { name: "Ada" },
      });

      assertEquals(received.length, 1);
      assertEquals(received[0], { name: "Ada" });
    } finally {
      restore();
    }
  },
);

Deno.test(
  "subscription - incoming error message routes to onError callback",
  async () => {
    const restore = installMockWebSocket();
    try {
      const client = new SubscriptionClient();
      await client.connect();

      const errors: Error[] = [];
      const handle = client.subscribe("select User { name }", {
        onData: (_data: unknown) => {},
        onError: (err) => {
          errors.push(err);
        },
      });

      const ws = MockWebSocket.instances[0];
      ws.simulateMessage({
        id: handle.id,
        type: "error",
        payload: "Query failed",
      });

      assertEquals(errors.length, 1);
      assertEquals(errors[0].message, "Query failed");
    } finally {
      restore();
    }
  },
);

Deno.test(
  "subscription - incoming complete message routes to onComplete callback",
  async () => {
    const restore = installMockWebSocket();
    try {
      const client = new SubscriptionClient();
      await client.connect();

      let completed = false;
      const handle = client.subscribe("select User { name }", {
        onData: (_data: unknown) => {},
        onComplete: () => {
          completed = true;
        },
      });

      const ws = MockWebSocket.instances[0];
      ws.simulateMessage({ id: handle.id, type: "complete" });

      assertEquals(completed, true);
    } finally {
      restore();
    }
  },
);

Deno.test("subscription - unsubscribe() sends unsubscribe message", async () => {
  const restore = installMockWebSocket();
  try {
    const client = new SubscriptionClient();
    await client.connect();

    const handle = client.subscribe("select 1", {
      onData: (_data: unknown) => {},
    });

    const ws = MockWebSocket.instances[0];
    const sentBefore = ws.sent.length;

    client.unsubscribe(handle.id);

    assertEquals(ws.sent.length, sentBefore + 1);

    const msg = JSON.parse(ws.sent[ws.sent.length - 1]) as {
      type: string;
      payload: { subscriptionId: string };
    };
    assertEquals(msg.type, "unsubscribe");
    assertEquals(msg.payload.subscriptionId, handle.id);
  } finally {
    restore();
  }
});

Deno.test(
  "subscription - unsubscribe() removes callbacks (no more dispatching)",
  async () => {
    const restore = installMockWebSocket();
    try {
      const client = new SubscriptionClient();
      await client.connect();

      const received: unknown[] = [];
      const handle = client.subscribe("select 1", {
        onData: (data: unknown) => {
          received.push(data);
        },
      });

      const ws = MockWebSocket.instances[0];

      // Deliver one message before unsubscribing
      ws.simulateMessage({ id: handle.id, type: "data", payload: "before" });
      assertEquals(received.length, 1);

      client.unsubscribe(handle.id);

      // This message should be silently dropped
      ws.simulateMessage({ id: handle.id, type: "data", payload: "after" });
      assertEquals(received.length, 1);
    } finally {
      restore();
    }
  },
);

Deno.test("subscription - close() closes the WebSocket", async () => {
  const restore = installMockWebSocket();
  try {
    const client = new SubscriptionClient();
    await client.connect();

    const ws = MockWebSocket.instances[0];
    assertEquals(ws.readyState, MockWebSocket.OPEN);

    client.close();

    assertEquals(ws.readyState, MockWebSocket.CLOSED);
    assertEquals(client.isConnected(), false);
  } finally {
    restore();
  }
});

Deno.test("subscription - close() prevents auto-reconnect", async () => {
  const restore = installMockWebSocket();
  try {
    const client = new SubscriptionClient(
      { baseUrl: "http://localhost:5656" },
      { autoReconnect: true, reconnectDelay: 10 },
    );
    await client.connect();

    client.close();

    // After close, simulate the socket closing independently
    const ws = MockWebSocket.instances[0];
    ws.onclose?.({ code: 1006 });

    // Wait two ticks to confirm no reconnect is scheduled
    await nextTick();
    await nextTick();

    // Only the original instance should exist — no reconnect spawned a new one
    assertEquals(MockWebSocket.instances.length, 1);
  } finally {
    restore();
  }
});

Deno.test("subscription - isConnected() returns correct state", async () => {
  const restore = installMockWebSocket();
  try {
    const client = new SubscriptionClient();

    assertEquals(client.isConnected(), false);

    await client.connect();
    assertEquals(client.isConnected(), true);

    client.close();
    assertEquals(client.isConnected(), false);
  } finally {
    restore();
  }
});

Deno.test(
  "subscription - subscribe variables are sent in payload",
  async () => {
    const restore = installMockWebSocket();
    try {
      const client = new SubscriptionClient();
      await client.connect();

      client.subscribe(
        "select User filter .id = <uuid>$id",
        { onData: (_data: unknown) => {} },
        { id: "user-uuid-123" },
      );

      const ws = MockWebSocket.instances[0];
      const msg = JSON.parse(ws.sent[0]) as {
        type: string;
        payload: {
          id: string;
          query: string;
          variables: Record<string, unknown>;
        };
      };

      assertEquals(msg.type, "subscribe");
      assertEquals(msg.payload.variables, { id: "user-uuid-123" });
    } finally {
      restore();
    }
  },
);

Deno.test(
  "subscription - createSubscriptionClient factory returns instance",
  async () => {
    const restore = installMockWebSocket();
    try {
      const client = createSubscriptionClient({
        baseUrl: "http://localhost:5656",
      });
      await client.connect();
      assertExists(client);
      assertEquals(client.isConnected(), true);
    } finally {
      restore();
    }
  },
);
