/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * SubscriptionClient — WebSocket-based subscription client for Disc database
 */

import { DiscConnectionError } from "./errors.ts";
import type {
  DiscClientConfig,
  SubscriptionCallbacks,
  SubscriptionClientConfig,
  SubscriptionHandle
} from "./types.ts";

const DEFAULT_BASE_URL = "http://localhost:5656";
const DEFAULT_AUTO_RECONNECT = true;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const DEFAULT_RECONNECT_DELAY = 1000;

/** Stored registration for an active subscription */
interface ActiveSubscription<T = unknown> {
  callbacks: SubscriptionCallbacks<T>;
  query: string;
  variables?: Record<string, unknown>;
}

/** Shape of an incoming subscription message from the server */
interface IncomingMessage {
  id?: string;
  type: string;
  payload?: unknown;
}

/** Generate a unique subscription ID */
function generateSubscriptionId(): string {
  return `sub_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Convert an http(s) URL to a ws(s) URL */
function toWebSocketUrl(baseUrl: string): string {
  return baseUrl
    .replace(/^https:\/\//i, "wss://")
    .replace(/^http:\/\//i, "ws://");
}

export class SubscriptionClient {
  private readonly baseUrl: string;
  private readonly autoReconnect: boolean;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectDelay: number;

  private socket: WebSocket | null = null;
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // deno-lint-ignore no-explicit-any
  private subscriptions = new Map<string, ActiveSubscription<any>>();

  constructor(config?: DiscClientConfig, options?: SubscriptionClientConfig) {
    this.baseUrl = (config?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.autoReconnect = options?.autoReconnect ?? DEFAULT_AUTO_RECONNECT;
    this.maxReconnectAttempts = options?.maxReconnectAttempts ??
      DEFAULT_MAX_RECONNECT_ATTEMPTS;
    this.reconnectDelay = options?.reconnectDelay ?? DEFAULT_RECONNECT_DELAY;
  }

  /**
   * Connect to the Disc WebSocket server.
   * Resolves when the connection is open, rejects on error.
   *
   * @param connectTimeoutMs  Max milliseconds to wait for the open event.
   *   Without this, a silently-dropped TCP handshake makes connect() hang
   *   forever. Default: 30_000. (P1-31)
   */
  connect(connectTimeoutMs = 30_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const wsUrl = toWebSocketUrl(this.baseUrl);

      const socket = new WebSocket(wsUrl);
      this.socket = socket;

      const timeoutId = setTimeout(() => {
        // Abort the half-open connection and reject the promise. onclose /
        // onerror may fire later — handleClose is a no-op once the caller
        // has resolved/rejected, so this is safe.
        try {
          socket.close();
        } catch {
          // ignore
        }
        reject(
          new DiscConnectionError(
            `WebSocket connect timed out after ${connectTimeoutMs}ms: ${wsUrl}`
          )
        );
      }, connectTimeoutMs);

      socket.onopen = () => {
        clearTimeout(timeoutId);
        this.reconnectAttempt = 0;
        resolve();
      };

      socket.onerror = event => {
        clearTimeout(timeoutId);
        reject(
          new DiscConnectionError(
            `WebSocket connection failed: ${wsUrl}`,
            event instanceof Error ? event : undefined
          )
        );
      };

      socket.onmessage = (event: MessageEvent) => {
        this.handleMessage(event.data as string);
      };

      socket.onclose = (event: CloseEvent) => {
        clearTimeout(timeoutId);
        this.handleClose(event.code);
      };
    });
  }

  /**
   * Subscribe to a query.
   * Returns a handle containing the subscription ID and an unsubscribe function.
   */
  subscribe<T>(
    query: string,
    callbacks: SubscriptionCallbacks<T>,
    variables?: Record<string, unknown>
  ): SubscriptionHandle {
    const id = generateSubscriptionId();

    this.subscriptions.set(id, { callbacks, query, variables });

    const payload: Record<string, unknown> = { id, query };
    if (variables !== undefined) {
      payload["variables"] = variables;
    }

    this.sendRaw({ type: "subscribe", payload });

    return {
      id,
      unsubscribe: () => this.unsubscribe(id)
    };
  }

  /**
   * Unsubscribe from a subscription by ID.
   * Sends an unsubscribe message to the server and removes local callbacks.
   */
  unsubscribe(id: string): void {
    if (!this.subscriptions.has(id)) {
      return;
    }

    this.sendRaw({ type: "unsubscribe", payload: { subscriptionId: id } });
    this.subscriptions.delete(id);
  }

  /**
   * Close the WebSocket connection and clean up all subscriptions.
   * Prevents any further auto-reconnect attempts.
   */
  close(): void {
    this.closed = true;
    this.clearReconnectTimer();
    this.subscriptions.clear();

    if (this.socket !== null) {
      this.socket.close();
      this.socket = null;
    }
  }

  /**
   * Returns true when the WebSocket is in the OPEN state.
   */
  isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  // --- Private helpers ---

  private handleMessage(raw: string): void {
    let message: IncomingMessage;

    try {
      message = JSON.parse(raw) as IncomingMessage;
    } catch {
      // Unparseable message — silently discard
      return;
    }

    const { id, type, payload } = message;

    if (id === undefined) {
      // Not a subscription message (e.g. a server-level event)
      return;
    }

    const subscription = this.subscriptions.get(id);
    if (subscription === undefined) {
      return;
    }

    const { callbacks } = subscription;

    if (type === "data") {
      callbacks.onData(payload as Parameters<typeof callbacks.onData>[0]);
    } else if (type === "error") {
      if (callbacks.onError) {
        const err = payload instanceof Error ? payload : new Error(
          typeof payload === "string" ?
            payload :
            JSON.stringify(payload ?? "Subscription error")
        );
        callbacks.onError(err);
      }
    } else if (type === "complete") {
      if (callbacks.onComplete) {
        callbacks.onComplete();
      }
      this.subscriptions.delete(id);
    }
  }

  private handleClose(code: number): void {
    if (this.closed) {
      return;
    }

    if (
      this.autoReconnect &&
      this.reconnectAttempt < this.maxReconnectAttempts
    ) {
      const delay = this.reconnectDelay *
        Math.pow(2, this.reconnectAttempt);
      this.reconnectAttempt++;

      this.reconnectTimer = setTimeout(() => {
        this.reconnect();
      }, delay);
    } else {
      // Notify all subscriptions of the terminal close
      this.notifyAllError(
        new DiscConnectionError(
          `WebSocket closed (code ${code}) after ${this.reconnectAttempt} reconnect attempt${this.reconnectAttempt === 1 ? "" : "s"}`
        )
      );
    }
  }

  private reconnect(): void {
    if (this.closed) {
      return;
    }

    // Capture snapshot of subscriptions to re-register after reconnect
    const pending = new Map(this.subscriptions);
    this.subscriptions.clear();
    this.socket = null;

    this
      .connect()
      .then(() => {
        // Re-subscribe all active subscriptions
        for (const [id, sub] of pending) {
          this.subscriptions.set(id, sub);
          const payload: Record<string, unknown> = { id, query: sub.query };
          if (sub.variables !== undefined) {
            payload["variables"] = sub.variables;
          }
          this.sendRaw({ type: "subscribe", payload });
        }
      })
      .catch(() => {
        // Restore subscriptions so handleClose can try again
        for (const [id, sub] of pending) {
          this.subscriptions.set(id, sub);
        }
      });
  }

  private sendRaw(message: Record<string, unknown>): void {
    if (this.socket !== null && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private notifyAllError(error: Error): void {
    for (const sub of this.subscriptions.values()) {
      if (sub.callbacks.onError) {
        sub.callbacks.onError(error);
      }
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

/** Create a SubscriptionClient with the given configuration */
export function createSubscriptionClient(
  config?: DiscClientConfig,
  options?: SubscriptionClientConfig
): SubscriptionClient {
  return new SubscriptionClient(config, options);
}
