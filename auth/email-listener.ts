/**
 * In-process auth-event subscriber that turns lifecycle events into
 * outbound transactional email.
 *
 * Sits alongside `WebhookSender`'s HTTP fan-out: when the auth core
 * fires a token-bearing event (verification, password reset, magic
 * link), this listener resolves the recipient's email, renders a
 * template, and hands the message to the SMTP `Mailer`. Non-email
 * event types (`IdentityCreated`, `IdentityAuthenticated`,
 * `EmailVerified`) are ignored — they're notification-only and have
 * no payload that requires email delivery.
 *
 * Mirrors `WebhookSender`'s fire-and-forget posture: every error
 * (recipient lookup, template render, mailer send) is logged at
 * `warn` and swallowed. The auth flow must never break because email
 * delivery failed (gh/geldata#8224).
 */

import { getLogger } from "../lib/logger.ts";
import type { Mailer } from "../smtp/mailer.ts";
import {
  type EmailTemplateOverrides,
  type RenderedEmail,
  renderMagicCodeEmail,
  renderMagicLinkEmail,
  renderPasswordResetEmail,
  renderVerificationEmail,
} from "./email-templates.ts";
import type { WebhookEvent } from "./webhooks.ts";

const log = getLogger("auth-email-listener");

export interface EmailListenerConfig {
  /**
   * Base URL used to construct verification / reset / magic-link
   * targets in the rendered templates. No trailing slash required.
   * Required because tokens alone are useless — they need the route
   * that consumes them.
   */
  baseUrl: string;
  /** SMTP transport. Pass a `NoopMailer` to dry-run the wiring. */
  mailer: Mailer;
  /**
   * Map `identityId` → recipient email. Webhook events carry only the
   * identity id and the relevant token, never the address — the
   * implementor looks the address up from the auth DB. Returning
   * `null` (e.g. user deleted between event-fire and handler) skips
   * the send without throwing.
   */
  resolveRecipient: (identityId: string) => Promise<string | null>;
  templates?: EmailTemplateOverrides;
}

export class EmailEventListener {
  private readonly config: EmailListenerConfig;

  constructor(config: EmailListenerConfig) {
    this.config = config;
  }

  /**
   * Consume one event from the auth lifecycle. Routes by `eventType`
   * to the matching template and sends. Always resolves; failures are
   * logged but never re-thrown.
   */
  async handle(event: WebhookEvent): Promise<void> {
    try {
      switch (event.eventType) {
        case "EmailVerificationRequested":
          await this.handleVerification(event.identityId, event.verificationToken);
          return;
        case "PasswordResetRequested":
          await this.handlePasswordReset(event.identityId, event.resetToken);
          return;
        case "MagicLinkRequested":
          await this.handleMagicLink(event.identityId, event.magicLinkToken);
          return;
        case "MagicCodeRequested":
          await this.handleMagicCode(event.identityId, event.magicCode);
          return;
        case "IdentityCreated":
        case "IdentityAuthenticated":
        case "EmailVerified":
          // Notification-only events — nothing to mail.
          return;
      }
    } catch (err) {
      log.warn("email listener errored", {
        eventType: event.eventType,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleVerification(identityId: string, verificationToken: string): Promise<void> {
    const recipient = await this.lookup(identityId, "EmailVerificationRequested");
    if (!recipient) return;
    const rendered = (this.config.templates?.verification ?? renderVerificationEmail)({
      baseUrl: this.config.baseUrl,
      recipient,
      verificationToken,
    });
    await this.deliver(recipient, rendered, "EmailVerificationRequested");
  }

  private async handlePasswordReset(identityId: string, resetToken: string): Promise<void> {
    const recipient = await this.lookup(identityId, "PasswordResetRequested");
    if (!recipient) return;
    const rendered = (this.config.templates?.passwordReset ?? renderPasswordResetEmail)({
      baseUrl: this.config.baseUrl,
      recipient,
      resetToken,
    });
    await this.deliver(recipient, rendered, "PasswordResetRequested");
  }

  private async handleMagicLink(identityId: string, magicLinkToken: string): Promise<void> {
    const recipient = await this.lookup(identityId, "MagicLinkRequested");
    if (!recipient) return;
    const rendered = (this.config.templates?.magicLink ?? renderMagicLinkEmail)({
      baseUrl: this.config.baseUrl,
      magicLinkToken,
      recipient,
    });
    await this.deliver(recipient, rendered, "MagicLinkRequested");
  }

  private async handleMagicCode(identityId: string, code: string): Promise<void> {
    const recipient = await this.lookup(identityId, "MagicCodeRequested");
    if (!recipient) return;
    const rendered = (this.config.templates?.magicCode ?? renderMagicCodeEmail)({
      code,
      recipient,
    });
    await this.deliver(recipient, rendered, "MagicCodeRequested");
  }

  private async lookup(identityId: string, eventType: string): Promise<string | null> {
    try {
      const recipient = await this.config.resolveRecipient(identityId);
      if (!recipient) {
        log.warn("recipient lookup returned null; skipping email", {
          eventType,
          identityId,
        });
        return null;
      }
      return recipient;
    } catch (err) {
      log.warn("recipient lookup failed", {
        eventType,
        identityId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private async deliver(recipient: string, rendered: RenderedEmail, eventType: string): Promise<void> {
    try {
      await this.config.mailer.send({
        html: rendered.html,
        subject: rendered.subject,
        text: rendered.text,
        to: recipient,
      });
    } catch (err) {
      log.warn("mailer send failed", {
        eventType,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
