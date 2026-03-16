/**
 * WebSocket Subscription Handler for Disc Server
 * Handles real-time subscriptions over WebSocket connections
 */

import * as Types from "./types.ts";

// WebSocket readyState constants (safe for both runtime and mock contexts)
const WS_OPEN = 1;

export interface SubscriptionOptions {
  max_subscriptions_per_connection?: number;
  subscription_timeout_ms?: number;
  heartbeat_interval_ms?: number;
}

export class SubscriptionHandler {
  private subscriptions = new Map<string, ActiveSubscription>();
  private connection_subscriptions = new Map<string, Set<string>>();
  private options: Required<SubscriptionOptions>;
  private heartbeat_id: number | undefined;
  private pending_timeouts = new Set<number>();

  constructor(options: SubscriptionOptions = {}) {
    this.options = {
      max_subscriptions_per_connection: options.max_subscriptions_per_connection || 10,
      subscription_timeout_ms: options.subscription_timeout_ms || 30 * 60 * 1000, // 30 minutes
      heartbeat_interval_ms: options.heartbeat_interval_ms || 30 * 1000, // 30 seconds
    };

    this.start_heartbeat();
  }

  async handle_subscription(
    subscription: Types.SubscriptionRequest,
    context: Types.QueryContext,
    websocket: WebSocket
  ): Promise<void> {
    const connection_id = context.session.session_id;

    // Check subscription limits
    const existing_subs = this.connection_subscriptions.get(connection_id) || new Set();
    if (existing_subs.size >= this.options.max_subscriptions_per_connection) {
      this.send_error(websocket, subscription.id, "Too many subscriptions");
      return;
    }

    // Validate subscription query
    const validation_errors = this.validate_subscription_query(subscription.query);
    if (validation_errors.length > 0) {
      // Send all validation errors concatenated for better diagnostics
      const combined = validation_errors.map(e => e.message).join("; ");
      this.send_error(websocket, subscription.id, combined);
      return;
    }

    try {
      // Create active subscription
      const active_subscription: ActiveSubscription = {
        id: subscription.id,
        query: subscription.query,
        variables: subscription.variables || {},
        connection_id,
        websocket,
        context,
        created_at: new Date(),
        last_ping: new Date(),
        status: "active",
      };

      // Store subscription
      this.subscriptions.set(subscription.id, active_subscription);
      existing_subs.add(subscription.id);
      this.connection_subscriptions.set(connection_id, existing_subs);

      // Start the subscription (for now, we'll send periodic updates)
      await this.start_subscription(active_subscription);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown subscription error";
      this.send_error(websocket, subscription.id, errorMessage);
    }
  }

  stop_subscription(subscription_id: string): void {
    const subscription = this.subscriptions.get(subscription_id);
    if (!subscription) return;

    subscription.status = "stopped";
    this.subscriptions.delete(subscription_id);

    const connection_subs = this.connection_subscriptions.get(subscription.connection_id);
    if (connection_subs) {
      connection_subs.delete(subscription_id);
    }

    this.send_complete(subscription.websocket, subscription_id);
  }

  cleanup_connection(connection_id: string): void {
    const subscription_ids = this.connection_subscriptions.get(connection_id);
    if (!subscription_ids) return;

    for (const subscription_id of subscription_ids) {
      this.stop_subscription(subscription_id);
    }

    this.connection_subscriptions.delete(connection_id);
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

  private async start_subscription(subscription: ActiveSubscription): Promise<void> {
    // Send initial data
    const initial_data = this.generate_mock_initial_data(subscription.query);
    this.send_data(subscription.websocket, subscription.id, initial_data);

    // Start periodic updates (for demonstration/mock purposes)
    const send_update = () => {
      if (subscription.status !== "active") return;

      const mock_data = this.generate_mock_update(subscription.query);
      this.send_data(subscription.websocket, subscription.id, mock_data);

      // Schedule next update (simulate real-time data)
      if (subscription.status === "active") {
        const id = setTimeout(send_update, 5000 + Math.random() * 5000);
        this.pending_timeouts.add(id);
      }
    };

    const id = setTimeout(send_update, 5000);
    this.pending_timeouts.add(id);
  }

  private validate_subscription_query(query: string): Types.QueryError[] {
    const errors: Types.QueryError[] = [];

    // Basic validation - subscription queries should typically be SELECT
    const normalized = query.trim().toLowerCase();

    // Check for forbidden operations in subscriptions
    const forbidden_keywords = ["insert", "update", "delete", "drop", "alter"];
    for (const keyword of forbidden_keywords) {
      // Check if query starts with or contains the forbidden keyword
      if (normalized.startsWith(keyword) || normalized.includes(` ${keyword} `)) {
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
          created_at: new Date().toISOString(),
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
        { type: "user_online", user_id: "user_003", name: "Charlie Wilson" },
        { type: "user_offline", user_id: "user_002" },
        { type: "user_updated", user_id: "user_001", field: "status", value: "busy" },
      ];
      return updates[Math.floor(Math.random() * updates.length)];
    } else if (query.includes("Post")) {
      return {
        type: "new_post",
        id: `post_${Date.now()}`,
        title: `New Post ${new Date().toLocaleTimeString()}`,
        author: "System",
        created_at: new Date().toISOString(),
      };
    }

    return {
      type: "heartbeat",
      timestamp: new Date().toISOString(),
      subscription_id: Math.random().toString(36).substring(7),
    };
  }

  private send_data(websocket: WebSocket, subscription_id: string, data: any): void {
    const message: Types.SubscriptionMessage = {
      id: subscription_id,
      type: "data",
      payload: data,
    };

    this.send_message(websocket, message);
  }

  private send_error(websocket: WebSocket, subscription_id: string, error_message: string): void {
    const message: Types.SubscriptionMessage = {
      id: subscription_id,
      type: "error",
      payload: { message: error_message },
    };

    this.send_message(websocket, message);
  }

  private send_complete(websocket: WebSocket, subscription_id: string): void {
    const message: Types.SubscriptionMessage = {
      id: subscription_id,
      type: "complete",
    };

    this.send_message(websocket, message);
  }

  private send_message(websocket: WebSocket, message: Types.SubscriptionMessage): void {
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
        const inactive_time = now.getTime() - subscription.last_ping.getTime();

        if (inactive_time > this.options.subscription_timeout_ms) {
          console.log(`Cleaning up inactive subscription: ${id}`);
          this.stop_subscription(id);
          continue;
        }

        // Send heartbeat
        if (subscription.websocket.readyState === WS_OPEN) {
          subscription.last_ping = now;
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
    }, this.options.heartbeat_interval_ms);
  }

  get_subscription_stats(): {
    active_subscriptions: number;
    total_connections_with_subscriptions: number;
    subscriptions_by_connection: Array<{ connection_id: string; count: number }>;
  } {
    const connections_with_subs = Array.from(this.connection_subscriptions.entries())
      .map(([connection_id, subs]) => ({
        connection_id,
        count: subs.size,
      }));

    return {
      active_subscriptions: this.subscriptions.size,
      total_connections_with_subscriptions: this.connection_subscriptions.size,
      subscriptions_by_connection: connections_with_subs,
    };
  }
}

interface ActiveSubscription {
  id: string;
  query: string;
  variables: Record<string, any>;
  connection_id: string;
  websocket: WebSocket;
  context: Types.QueryContext;
  created_at: Date;
  last_ping: Date;
  status: "active" | "stopped" | "error";
}
