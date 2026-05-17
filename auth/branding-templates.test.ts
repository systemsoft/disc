/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Cross-cutting tests for branding flowing through email templates
 * and the email-listener. (gh/geldata#6731 / #6732 / #7938 / #8028)
 */

/*** NATIVE ------------------------------------------- ***/

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

/*** UTILITY ------------------------------------------ ***/

import { EmailEventListener } from "./email-listener.ts";

import {
  renderMagicCodeEmail,
  renderMagicLinkEmail,
  renderPasswordResetEmail,
  renderVerificationEmail,
  type BrandingCtx
} from "./email-templates.ts";

import type { Email, MailerResult } from "../smtp/types.ts";
import type { Mailer } from "../smtp/mailer.ts";

const branding: BrandingCtx = {
  appName: "Acme",
  brandColor: "#0af",
  logoUrl: "https://cdn.acme.com/logo.png"
};

/*** RUNTIME ------------------------------------------ ***/

Deno.test("renderVerificationEmail: branded subject + appName in body", () => {
  const r = renderVerificationEmail({
    baseUrl: "https://app.acme.com",
    branding,
    recipient: "alice@example.com",
    verificationToken: "tok"
  });

  assertEquals(r.subject, "Verify your email for Acme");
  assertStringIncludes(r.text, "Acme account");
  assertStringIncludes(r.html, "Acme account");
});

Deno.test("renderVerificationEmail: logoUrl appears in HTML when set", () => {
  const r = renderVerificationEmail({
    baseUrl: "https://app.acme.com",
    branding,
    recipient: "alice@example.com",
    verificationToken: "tok"
  });

  assertStringIncludes(r.html, "https://cdn.acme.com/logo.png");
});

Deno.test("renderVerificationEmail: brandColor appears in button CSS", () => {
  const r = renderVerificationEmail({
    baseUrl: "https://app.acme.com",
    branding,
    recipient: "alice@example.com",
    verificationToken: "tok"
  });

  assertStringIncludes(r.html, "background: #0af");
});

Deno.test("renderPasswordResetEmail: branded subject", () => {
  const r = renderPasswordResetEmail({
    baseUrl: "https://app.acme.com",
    branding,
    recipient: "bob@example.com",
    resetToken: "reset"
  });

  assertEquals(r.subject, "Reset your Acme password");
});

Deno.test("renderMagicCodeEmail: branded subject + brandColor on code box", () => {
  const r = renderMagicCodeEmail({
    branding,
    code: "482917",
    recipient: "carol@example.com"
  });

  assertEquals(r.subject, "Your Acme sign-in code");
  /*** brandColor flows into the bulletproof code box. The `<td bgcolor>` attribute is the
       cross-client carrier (gh/geldata#7629). ***/
  assertStringIncludes(r.html, "bgcolor=\"#0af\"");
});

Deno.test("renderMagicLinkEmail: branded subject", () => {
  const r = renderMagicLinkEmail({
    baseUrl: "https://app.acme.com",
    branding,
    magicLinkToken: "tok",
    recipient: "carol@example.com"
  });

  assertEquals(r.subject, "Sign in to Acme");
});

Deno.test("renderMagicLinkEmail: prefers ctx.link when supplied (template path)", () => {
  const r = renderMagicLinkEmail({
    baseUrl: "https://app.acme.com",
    branding,
    link: "https://other.acme.com/login/tok",
    magicLinkToken: "tok",
    recipient: "carol@example.com"
  });

  assertStringIncludes(r.text, "https://other.acme.com/login/tok");
  assertStringIncludes(r.html, "https://other.acme.com/login/tok");
  /*** Falls back to baseUrl when no link supplied — verified by other tests. ***/
});

Deno.test("EmailEventListener: branding flows into rendered emails", async () => {
  const { mailer, sends } = makeStubMailer();

  const listener = new EmailEventListener({
    baseUrl: "https://app.acme.com",
    branding: { appName: "Acme", brandColor: "#0af" },
    mailer,
    resolveRecipient: () => Promise.resolve("alice@example.com")
  });

  await listener.handle({
    eventId: "ev",
    eventType: "EmailVerificationRequested",
    identityId: "u-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    verificationToken: "tok-v"
  });

  assertEquals(sends.length, 1);
  assertEquals(sends[0].subject, "Verify your email for Acme");
  assertStringIncludes(sends[0].html ?? "", "background: #0af");
});

Deno.test("EmailEventListener: magicLinkUrlTemplate replaces default URL shape", async () => {
  const { mailer, sends } = makeStubMailer();

  const listener = new EmailEventListener({
    baseUrl: "https://app.acme.com",
    magicLinkUrlTemplate: "https://other.acme.com/login/{token}",
    mailer,
    resolveRecipient: () => Promise.resolve("carol@example.com")
  });

  await listener.handle({
    eventId: "ev",
    eventType: "MagicLinkRequested",
    identityId: "u-1",
    magicLinkToken: "tok-m",
    timestamp: "2026-01-01T00:00:00.000Z"
  });

  assertEquals(sends.length, 1);
  assertStringIncludes(sends[0].text, "https://other.acme.com/login/tok-m");
  /*** The fallback `${baseUrl}/auth/magic?token=…` shape must not appear. ***/
  assert(!sends[0].text.includes("/auth/magic?token="));
});

Deno.test("EmailEventListener: no branding falls back to historical wording", async () => {
  const { mailer, sends } = makeStubMailer();

  const listener = new EmailEventListener({
    baseUrl: "https://app.acme.com",
    mailer,
    resolveRecipient: () => Promise.resolve("alice@example.com")
  });

  await listener.handle({
    eventId: "ev",
    eventType: "EmailVerificationRequested",
    identityId: "u-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    verificationToken: "tok"
  });

  /*** Subject reverts to the unbranded form when no operator branding is supplied — preserves
       historical compatibility for callers that string-match on the subject. ***/
  assertEquals(sends[0].subject, "Verify your email");
});

/*** HELPER ------------------------------------------- ***/

function makeStubMailer(): { mailer: Mailer; sends: Email[]; } {
  const sends: Email[] = [];

  const mailer: Mailer = {
    send(email: Email): Promise<MailerResult> {
      sends.push(email);

      return Promise.resolve({
        accepted: Array.isArray(email.to) ? email.to : [email.to],
        messageId: "stub@disc.local",
        rejected: []
      });
    }
  };

  return { mailer, sends };
}
