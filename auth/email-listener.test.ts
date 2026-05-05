/**
 * Unit tests for the in-process auth-email subscriber.
 *
 * Uses a stub `Mailer` that records every `send()` call so we can
 * assert recipient routing and rendered content without binding a
 * real socket. Real SMTP delivery is integration-level and lives in
 * smtp/ tests.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { EmailEventListener } from "./email-listener.ts";
import type { Mailer } from "../smtp/mailer.ts";
import type { Email, MailerResult } from "../smtp/types.ts";
import type { WebhookEvent } from "./webhooks.ts";

interface CapturedSend {
  email: Email;
}

function makeStubMailer(): { mailer: Mailer; sends: CapturedSend[] } {
  const sends: CapturedSend[] = [];
  const mailer: Mailer = {
    send(email: Email): Promise<MailerResult> {
      sends.push({ email });
      return Promise.resolve({
        accepted: Array.isArray(email.to) ? email.to : [email.to],
        messageId: "stub@disc.local",
        rejected: [],
      });
    },
  };
  return { mailer, sends };
}

function makeResolver(map: Record<string, string | null>): (id: string) => Promise<string | null> {
  return (id) => Promise.resolve(map[id] ?? null);
}

const baseEvent = {
  eventId: "ev-1",
  identityId: "u-1",
  timestamp: "2026-01-01T00:00:00.000Z",
};

Deno.test("EmailEventListener - sends verification email with correct recipient + content", async () => {
  const { mailer, sends } = makeStubMailer();
  const listener = new EmailEventListener({
    baseUrl: "https://app.example.com",
    mailer,
    resolveRecipient: makeResolver({ "u-1": "alice@example.com" }),
  });

  const event: WebhookEvent = {
    ...baseEvent,
    eventType: "EmailVerificationRequested",
    verificationToken: "tok-verify-1",
  };
  await listener.handle(event);

  assertEquals(sends.length, 1);
  assertEquals(sends[0].email.to, "alice@example.com");
  assertEquals(sends[0].email.subject, "Verify your email");
  assertStringIncludes(sends[0].email.text, "tok-verify-1");
  assertStringIncludes(sends[0].email.text, "https://app.example.com/auth/verify?token=tok-verify-1");
  assert(sends[0].email.html);
});

Deno.test("EmailEventListener - sends password reset email with correct recipient + content", async () => {
  const { mailer, sends } = makeStubMailer();
  const listener = new EmailEventListener({
    baseUrl: "https://app.example.com",
    mailer,
    resolveRecipient: makeResolver({ "u-1": "bob@example.com" }),
  });

  const event: WebhookEvent = {
    ...baseEvent,
    eventType: "PasswordResetRequested",
    resetToken: "tok-reset-1",
  };
  await listener.handle(event);

  assertEquals(sends.length, 1);
  assertEquals(sends[0].email.to, "bob@example.com");
  assertEquals(sends[0].email.subject, "Reset your password");
  assertStringIncludes(sends[0].email.text, "tok-reset-1");
});

Deno.test("EmailEventListener - sends magic link email with correct recipient + content", async () => {
  const { mailer, sends } = makeStubMailer();
  const listener = new EmailEventListener({
    baseUrl: "https://app.example.com",
    mailer,
    resolveRecipient: makeResolver({ "u-1": "carol@example.com" }),
  });

  const event: WebhookEvent = {
    ...baseEvent,
    eventType: "MagicLinkRequested",
    magicLinkToken: "tok-magic-1",
  };
  await listener.handle(event);

  assertEquals(sends.length, 1);
  assertEquals(sends[0].email.to, "carol@example.com");
  assertEquals(sends[0].email.subject, "Sign in to your account");
  assertStringIncludes(sends[0].email.text, "tok-magic-1");
});

Deno.test("EmailEventListener - sends magic code email with correct recipient + content", async () => {
  const { mailer, sends } = makeStubMailer();
  const listener = new EmailEventListener({
    baseUrl: "https://app.example.com",
    mailer,
    resolveRecipient: makeResolver({ "u-1": "dave@example.com" }),
  });

  const event: WebhookEvent = {
    ...baseEvent,
    eventType: "MagicCodeRequested",
    magicCode: "482917",
  };
  await listener.handle(event);

  assertEquals(sends.length, 1);
  assertEquals(sends[0].email.to, "dave@example.com");
  assertEquals(sends[0].email.subject, "Your sign-in code");
  assertStringIncludes(sends[0].email.text, "482917");
});

Deno.test("EmailEventListener - non-email events are ignored", async () => {
  const { mailer, sends } = makeStubMailer();
  const listener = new EmailEventListener({
    baseUrl: "https://app.example.com",
    mailer,
    resolveRecipient: makeResolver({ "u-1": "alice@example.com" }),
  });

  for (const eventType of ["IdentityCreated", "IdentityAuthenticated", "EmailVerified"] as const) {
    await listener.handle({ ...baseEvent, eventType });
  }

  assertEquals(sends.length, 0);
});

Deno.test("EmailEventListener - resolveRecipient returning null skips send without throwing", async () => {
  const { mailer, sends } = makeStubMailer();
  const listener = new EmailEventListener({
    baseUrl: "https://app.example.com",
    mailer,
    resolveRecipient: makeResolver({}), // u-1 not present → null
  });

  await listener.handle({
    ...baseEvent,
    eventType: "PasswordResetRequested",
    resetToken: "tok-reset-1",
  });

  assertEquals(sends.length, 0);
});

Deno.test("EmailEventListener - resolveRecipient throwing is swallowed", async () => {
  const { mailer, sends } = makeStubMailer();
  const listener = new EmailEventListener({
    baseUrl: "https://app.example.com",
    mailer,
    resolveRecipient: () => Promise.reject(new Error("db down")),
  });

  // Must not throw.
  await listener.handle({
    ...baseEvent,
    eventType: "MagicLinkRequested",
    magicLinkToken: "tok-1",
  });
  assertEquals(sends.length, 0);
});

Deno.test("EmailEventListener - mailer send throwing is swallowed", async () => {
  const failingMailer: Mailer = {
    send: () => Promise.reject(new Error("smtp 421")),
  };
  const listener = new EmailEventListener({
    baseUrl: "https://app.example.com",
    mailer: failingMailer,
    resolveRecipient: makeResolver({ "u-1": "alice@example.com" }),
  });

  // Must not throw.
  await listener.handle({
    ...baseEvent,
    eventType: "EmailVerificationRequested",
    verificationToken: "tok-1",
  });
});

Deno.test("EmailEventListener - per-event template overrides take precedence", async () => {
  const { mailer, sends } = makeStubMailer();
  const listener = new EmailEventListener({
    baseUrl: "https://app.example.com",
    mailer,
    resolveRecipient: makeResolver({ "u-1": "alice@example.com" }),
    templates: {
      verification: (ctx) => ({
        html: `<custom>${ctx.verificationToken}</custom>`,
        subject: "Custom verify",
        text: `custom token ${ctx.verificationToken}`,
      }),
    },
  });

  await listener.handle({
    ...baseEvent,
    eventType: "EmailVerificationRequested",
    verificationToken: "tok-X",
  });

  assertEquals(sends.length, 1);
  assertEquals(sends[0].email.subject, "Custom verify");
  assertStringIncludes(sends[0].email.text, "custom token tok-X");
  assertStringIncludes(sends[0].email.html ?? "", "<custom>tok-X</custom>");
});
