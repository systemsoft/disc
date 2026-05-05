/**
 * Auth lifecycle webhooks.
 *
 * Fires HTTP POSTs at registered URLs when authentication events
 * happen — sign-up, login, password reset, email verification.
 * Optional HMAC-SHA256 signature in the `x-disc-auth-signature-sha256`
 * header so receivers can verify the payload's integrity and origin.
 * Fire-and-forget by default: dispatch never blocks the auth flow,
 * delivery failures are logged but don't surface to the caller.
 *
 * Ports geldata/gel#7813 (gh/geldata#7484). Mirrors Gel's event shape
 * and signing scheme; uses `fetch` rather than Gel's std::net job
 * queue (no retries — that's a follow-up alongside a real job queue).
 */

import { getLogger } from "../lib/logger.ts";

const log = getLogger("auth-webhooks");

/**
 * Discriminated union of every event disc emits. Mirrors Gel's
 * `webhook.py` dataclasses. Field naming uses camelCase (TypeScript
 * convention); receivers expecting Gel's snake_case can normalize on
 * their side.
 */
export type WebhookEvent =
  | IdentityCreatedEvent
  | IdentityAuthenticatedEvent
  | EmailVerificationRequestedEvent
  | EmailVerifiedEvent
  | PasswordResetRequestedEvent
  | MagicLinkRequestedEvent
  | MagicCodeRequestedEvent;

export interface BaseWebhookEvent {
  eventId: string;
  eventType: WebhookEvent["eventType"];
  timestamp: string;
  identityId: string;
}

export interface IdentityCreatedEvent extends BaseWebhookEvent {
  eventType: "IdentityCreated";
}

export interface IdentityAuthenticatedEvent extends BaseWebhookEvent {
  eventType: "IdentityAuthenticated";
}

export interface EmailVerificationRequestedEvent extends BaseWebhookEvent {
  eventType: "EmailVerificationRequested";
  /**
   * Plaintext verification token. Same value the registration response
   * surfaces to the caller — webhooks let an out-of-band email-sender
   * service receive it without the calling app having to relay.
   */
  verificationToken: string;
}

export interface EmailVerifiedEvent extends BaseWebhookEvent {
  eventType: "EmailVerified";
}

export interface PasswordResetRequestedEvent extends BaseWebhookEvent {
  eventType: "PasswordResetRequested";
  /**
   * Plaintext reset token. Cannot be recovered after the
   * `requestPasswordReset()` call returns — webhooks are the only way
   * for a separate email service to receive it.
   */
  resetToken: string;
}

export interface MagicLinkRequestedEvent extends BaseWebhookEvent {
  eventType: "MagicLinkRequested";
  /**
   * Plaintext magic-link token. Same delivery rationale as
   * `verificationToken` and `resetToken`: cannot be recovered after
   * `requestMagicLink()` returns, so webhooks are how a separate
   * email-sender learns about it. (gh/geldata#8186)
   */
  magicLinkToken: string;
}

export interface MagicCodeRequestedEvent extends BaseWebhookEvent {
  eventType: "MagicCodeRequested";
  /**
   * Plaintext 6-digit code. Same delivery rationale as `magicLinkToken`:
   * cannot be recovered after `requestMagicCode()` returns, so webhooks
   * are how out-of-band email/SMS senders learn it. (gh/geldata#7367)
   */
  magicCode: string;
}

export type WebhookEventType = WebhookEvent["eventType"];

/**
 * One webhook subscription. The same URL can be registered multiple
 * times with different `events` filters if desired.
 */
export interface WebhookConfig {
  url: string;
  /** Subset of event types this URL should receive. */
  events: WebhookEventType[];
  /**
   * If set, body is HMAC-SHA256-signed with this secret and the hex
   * digest is sent in the `x-disc-auth-signature-sha256` header.
   * Receivers verify by recomputing HMAC over the raw body.
   */
  secret?: string;
  /**
   * Override the default per-request timeout (ms). Defaults to 5000.
   * Aggressive cap because dispatch is fire-and-forget — a slow
   * downstream shouldn't keep request handlers tied up forever.
   */
  timeoutMs?: number;
}

/**
 * Optional injection points for tests + custom transports.
 */
export interface WebhookSenderOptions {
  /** Override `fetch`. Default uses global. */
  fetchImpl?: typeof fetch;
  /**
   * Synchronous mode for tests — when true, `dispatch()` awaits the
   * actual delivery instead of scheduling it on a microtask. Default
   * false (production: fire-and-forget).
   */
  synchronous?: boolean;
}

/**
 * In-process listener for auth events. Same fire-and-forget posture
 * as HTTP webhooks — `WebhookSender.dispatch()` schedules listeners
 * on a microtask in production mode, awaits them under
 * `synchronous: true` for deterministic tests. Listeners are
 * responsible for swallowing their own errors; `dispatch()` catches
 * any that escape and logs at warn level so a buggy in-process
 * subscriber can't take down the auth flow.
 */
export type WebhookListener = (event: WebhookEvent) => Promise<void> | void;

export class WebhookSender {
  private subscriptions: WebhookConfig[];
  private fetchImpl: typeof fetch;
  private synchronous: boolean;
  private listeners: WebhookListener[] = [];

  constructor(
    subscriptions: WebhookConfig[],
    options: WebhookSenderOptions = {},
  ) {
    this.subscriptions = subscriptions;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.synchronous = options.synchronous ?? false;
  }

  /**
   * Register an in-process listener that receives every dispatched
   * event regardless of `WebhookConfig` filters (those gate HTTP
   * subscriptions only — listeners are expected to filter for
   * themselves). Used by the SMTP email subscriber and similar
   * sidecars that want to react to auth events without standing up
   * an HTTP receiver.
   */
  addListener(listener: WebhookListener): void {
    this.listeners.push(listener);
  }

  /**
   * Dispatch a single event to every matching subscription and every
   * registered in-process listener. Returns a promise that resolves
   * once *scheduling* is done — actual HTTP delivery and listener
   * invocation happen on a microtask in production mode.
   */
  async dispatch(event: WebhookEvent): Promise<void> {
    const matched = this.subscriptions.filter((s) => s.events.includes(event.eventType));

    if (matched.length === 0 && this.listeners.length === 0) return;

    if (this.synchronous) {
      // Tests: serialize so assertions can observe state after dispatch.
      for (const sub of matched) {
        await this.deliver(sub, event);
      }
      for (const listener of this.listeners) {
        await this.runListener(listener, event);
      }
      return;
    }

    // Production: fire and forget. Don't await; failures shouldn't
    // surface to the auth caller.
    for (const sub of matched) {
      queueMicrotask(() => {
        void this.deliver(sub, event);
      });
    }
    for (const listener of this.listeners) {
      queueMicrotask(() => {
        void this.runListener(listener, event);
      });
    }
  }

  private async runListener(listener: WebhookListener, event: WebhookEvent): Promise<void> {
    try {
      await listener(event);
    } catch (err) {
      log.warn("in-process listener errored", {
        eventType: event.eventType,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async deliver(
    sub: WebhookConfig,
    event: WebhookEvent,
  ): Promise<void> {
    const body = JSON.stringify(event);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (sub.secret) {
      headers["x-disc-auth-signature-sha256"] = await signHmacSha256(
        sub.secret,
        body,
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      sub.timeoutMs ?? 5000,
    );

    try {
      const response = await this.fetchImpl(sub.url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        log.warn("webhook delivery returned non-2xx", {
          url: sub.url,
          eventType: event.eventType,
          status: response.status,
        });
      }
      // Drain body so Deno doesn't complain about leaked streams.
      await response.body?.cancel().catch(() => {});
    } catch (err) {
      log.warn("webhook delivery failed", {
        url: sub.url,
        eventType: event.eventType,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

const textEncoder = new TextEncoder();

async function signHmacSha256(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(body),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Build a fresh event id for an event payload. Centralised so tests
 * can stub it.
 */
export function newEventId(): string {
  return crypto.randomUUID();
}

/**
 * ISO-8601 UTC timestamp for an event payload.
 */
export function newEventTimestamp(): string {
  return new Date().toISOString();
}
