/**
 * WebSocket Subscription Handler for Disc Server
 * Handles real-time subscriptions over WebSocket connections
 */

import { getLogger } from "../lib/logger.ts";
import * as Types from "./types.ts";

const log = getLogger("subscription");

// WebSocket readyState constants (safe for both runtime and mock contexts)
const WS_OPEN = 1;

export interface SubscriptionOptions {
  maxSubscriptionsPerConnection?: number;
  subscriptionTimeoutMs?: number;
  heartbeatIntervalMs?: number;
}

export class SubscriptionHandler {
  private subscriptions = new Map<string, ActiveSubscription>();
  private connection_subscriptions = new Map<string, Set<string>>();
  private options: Required<SubscriptionOptions>;
  private heartbeat_id: number | undefined;
  private pending_timeouts = new Set<number>();

  constructor(options: SubscriptionOptions = {}) {
    this.options = {
      maxSubscriptionsPerConnection: options.maxSubscriptionsPerConnection ||
        10,
      subscriptionTimeoutMs: options.subscriptionTimeoutMs ||
        30 * 60 * 1000, // 30 minutes
      heartbeatIntervalMs: options.heartbeatIntervalMs || 30 * 1000, // 30 seconds
    };

    this.start_heartbeat();
  }

  async handleSubscription(
    subscription: Types.SubscriptionRequest,
    context: Types.QueryContext,
    websocket: WebSocket,
  ): Promise<void> {
    const connectionId = context.session.sessionId;

    // Check subscription limits
    const existingSubs = this.connection_subscriptions.get(connectionId) ||
      new Set();
    if (existingSubs.size >= this.options.maxSubscriptionsPerConnection) {
      this.send_error(websocket, subscription.id, "Too many subscriptions");
      return;
    }

    // Validate subscription query
    const validationErrors = this.validate_subscription_query(
      subscription.query,
    );
    if (validationErrors.length > 0) {
      // Send all validation errors concatenated for better diagnostics
      const combined = validationErrors.map((e) => e.message).join("; ");
      this.send_error(websocket, subscription.id, combined);
      return;
    }

    try {
      // Create active subscription
      const activeSubscription: ActiveSubscription = {
        id: subscription.id,
        query: subscription.query,
        variables: subscription.variables || {},
        connectionId,
        websocket,
        context,
        createdAt: new Date(),
        lastPing: new Date(),
        status: "active",
      };

      // Store subscription
      this.subscriptions.set(subscription.id, activeSubscription);
      existingSubs.add(subscription.id);
      this.connection_subscriptions.set(connectionId, existingSubs);

      // Start the subscription (for now, we'll send periodic updates)
      await this.start_subscription(activeSubscription);
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : "Unknown subscription error";
      this.send_error(websocket, subscription.id, errorMessage);
    }
  }

  stop_subscription(subscriptionId: string): void {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return;

    subscription.status = "stopped";
    this.subscriptions.delete(subscriptionId);

    const connectionSubs = this.connection_subscriptions.get(
      subscription.connectionId,
    );
    if (connectionSubs) {
      connectionSubs.delete(subscriptionId);
    }

    this.send_complete(subscription.websocket, subscriptionId);
  }

  cleanup_connection(connectionId: string): void {
    const subscriptionIds = this.connection_subscriptions.get(connectionId);
    if (!subscriptionIds) return;

    for (const subscriptionId of subscriptionIds) {
      this.stop_subscription(subscriptionId);
    }

    this.connection_subscriptions.delete(connectionId);
  }

  /**
   * Dispose all timers and clean up resources.
   * Must be called in tests to avoid resource leaks.
   */
  dispose(): void {
    if (this.heartbeat_id !== undefined) {
      clearInterval(this.heartbeat_id);
      this.heartbeat_id = undefined;
    }

    for (const timeoutId of this.pending_timeouts) {
      clearTimeout(timeoutId);
    }
    this.pending_timeouts.clear();

    // Stop all active subscriptions
    for (const [id] of this.subscriptions) {
      const sub = this.subscriptions.get(id);
      if (sub) {
        sub.status = "stopped";
      }
    }
    this.subscriptions.clear();
    this.connection_subscriptions.clear();
  }

  private start_subscription(
    subscription: ActiveSubscription,
  ): void {
    // Send initial data
    const initialData = this.generate_mock_initial_data(subscription.query);
    this.send_data(subscription.websocket, subscription.id, initialData);

    // Start periodic updates (for demonstration/mock purposes)
    const sendUpdate = () => {
      if (subscription.status !== "active") return;

      const mockData = this.generate_mock_update(subscription.query);
      this.send_data(subscription.websocket, subscription.id, mockData);

      // Schedule next update (simulate real-time data)
      if (subscription.status === "active") {
        const id = setTimeout(sendUpdate, 5000 + Math.random() * 5000);
        this.pending_timeouts.add(id);
      }
    };

    const id = setTimeout(sendUpdate, 5000);
    this.pending_timeouts.add(id);
  }

  private validate_subscription_query(query: string): Types.QueryError[] {
    const errors: Types.QueryError[] = [];

    // Basic validation - subscription queries should typically be SELECT
    const normalized = query.trim().toLowerCase();

    // Check for forbidden operations in subscriptions
    const forbiddenKeywords = ["insert", "update", "delete", "drop", "alter"];
    for (const keyword of forbiddenKeywords) {
      // Check if query starts with or contains the forbidden keyword
      if (
        normalized.startsWith(keyword) || normalized.includes(` ${keyword} `)
      ) {
        errors.push({
          message: `Subscription queries cannot contain '${keyword}'`,
          extensions: { code: "INVALID_SUBSCRIPTION" },
        });
      }
    }

    // If no forbidden keyword matched but still not a SELECT
    if (errors.length === 0 && !normalized.startsWith("select")) {
      errors.push({
        message: "Subscriptions only support SELECT queries",
        extensions: { code: "INVALID_SUBSCRIPTION" },
      });
    }

    return errors;
  }

  private generate_mock_initial_data(query: string): any {
    // Generate initial data based on query pattern
    if (query.includes("User")) {
      return [
        {
          id: "user_001",
          name: "Alice Johnson",
          email: "alice@example.com",
          status: "online",
          last_seen: new Date().toISOString(),
        },
        {
          id: "user_002",
          name: "Bob Smith",
          email: "bob@example.com",
          status: "offline",
          last_seen: new Date(Date.now() - 300000).toISOString(),
        },
      ];
    } else if (query.includes("Post")) {
      return [
        {
          id: "post_001",
          title: "Welcome to Disc Database",
          content: "This is the first post in our new database!",
          author: "Alice Johnson",
          createdAt: new Date().toISOString(),
        },
      ];
    }

    return {
      message: "Subscription active",
      query,
      timestamp: new Date().toISOString(),
    };
  }

  private generate_mock_update(query: string): any {
    if (query.includes("User")) {
      const updates = [
        { type: "user_online", userId: "user_003", name: "Charlie Wilson" },
        { type: "user_offline", userId: "user_002" },
        {
          type: "user_updated",
          userId: "user_001",
          field: "status",
          value: "busy",
        },
      ];
      return updates[Math.floor(Math.random() * updates.length)];
    } else if (query.includes("Post")) {
      return {
        type: "new_post",
        id: `post_${Date.now()}`,
        title: `New Post ${new Date().toLocaleTimeString()}`,
        author: "System",
        createdAt: new Date().toISOString(),
      };
    }

    return {
      type: "heartbeat",
      timestamp: new Date().toISOString(),
      subscriptionId: Math.random().toString(36).substring(7),
    };
  }

  private send_data(
    websocket: WebSocket,
    subscriptionId: string,
    data: any,
  ): void {
    const message: Types.SubscriptionMessage = {
      id: subscriptionId,
      type: "data",
      payload: data,
    };

    this.send_message(websocket, message);
  }

  private send_error(
    websocket: WebSocket,
    subscriptionId: string,
    errorMessage: string,
  ): void {
    const message: Types.SubscriptionMessage = {
      id: subscriptionId,
      type: "error",
      payload: { message: errorMessage },
    };

    this.send_message(websocket, message);
  }

  private send_complete(websocket: WebSocket, subscriptionId: string): void {
    const message: Types.SubscriptionMessage = {
      id: subscriptionId,
      type: "complete",
    };

    this.send_message(websocket, message);
  }

  private send_message(
    websocket: WebSocket,
    message: Types.SubscriptionMessage,
  ): void {
    // Use numeric constant for readyState check (works with both real WebSocket and mocks)
    if (websocket.readyState === WS_OPEN) {
      websocket.send(JSON.stringify({
        type: "subscription",
        payload: message,
      }));
    }
  }

  private start_heartbeat(): void {
    this.heartbeat_id = setInterval(() => {
      const now = new Date();

      for (const [id, subscription] of this.subscriptions) {
        // Check if subscription has been inactive
        const inactiveTime = now.getTime() - subscription.lastPing.getTime();

        if (inactiveTime > this.options.subscriptionTimeoutMs) {
          log.debug("Cleaning up inactive subscription", {
            subscriptionId: id,
          });
          this.stop_subscription(id);
          continue;
        }

        // Send heartbeat
        if (subscription.websocket.readyState === WS_OPEN) {
          subscription.lastPing = now;
          this.send_message(subscription.websocket, {
            id: subscription.id,
            type: "data",
            payload: { type: "heartbeat", timestamp: now.toISOString() },
          });
        } else {
          // WebSocket is closed, clean up subscription
          this.stop_subscription(id);
        }
      }
    }, this.options.heartbeatIntervalMs);
  }

  get_subscription_stats(): {
    active_subscriptions: number;
    total_connections_with_subscriptions: number;
    subscriptions_by_connection: Array<
      { connectionId: string; count: number }
    >;
  } {
    const connectionsWithSubs = Array.from(
      this.connection_subscriptions.entries(),
    )
      .map(([connectionId, subs]) => ({
        connectionId,
        count: subs.size,
      }));

    return {
      active_subscriptions: this.subscriptions.size,
      total_connections_with_subscriptions: this.connection_subscriptions.size,
      subscriptions_by_connection: connectionsWithSubs,
    };
  }
}

interface ActiveSubscription {
  id: string;
  query: string;
  variables: Record<string, any>;
  connectionId: string;
  websocket: WebSocket;
  context: Types.QueryContext;
  createdAt: Date;
  lastPing: Date;
  status: "active" | "stopped" | "error";
}
