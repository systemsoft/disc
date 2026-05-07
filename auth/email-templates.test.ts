/**
 * Unit tests for the built-in auth email templates.
 *
 * Each template must produce all three of subject / text / html, embed
 * the token in a fully-qualified link in the body, and never leak the
 * token into the subject line.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderMagicCodeEmail, renderMagicLinkEmail, renderPasswordResetEmail, renderVerificationEmail } from "./email-templates.ts";

Deno.test("renderVerificationEmail - returns subject, text, html", () => {
  const rendered = renderVerificationEmail({
    baseUrl: "https://app.example.com",
    recipient: "alice@example.com",
    verificationToken: "tok-verify-abc",
  });

  assertEquals(rendered.subject, "Verify your email");
  assert(rendered.text.length > 0);
  assert(rendered.html.length > 0);
});

Deno.test("renderVerificationEmail - link contains token and is on baseUrl", () => {
  const rendered = renderVerificationEmail({
    baseUrl: "https://app.example.com",
    recipient: "alice@example.com",
    verificationToken: "tok-verify-abc",
  });

  const expectedLink = "https://app.example.com/auth/verify?token=tok-verify-abc";
  assertStringIncludes(rendered.text, expectedLink);
  assertStringIncludes(rendered.html, expectedLink);
});

Deno.test("renderVerificationEmail - subject does not leak the token", () => {
  const rendered = renderVerificationEmail({
    baseUrl: "https://app.example.com",
    recipient: "alice@example.com",
    verificationToken: "tok-verify-abc",
  });

  assertEquals(rendered.subject.includes("tok-verify-abc"), false);
});

Deno.test("renderPasswordResetEmail - returns subject, text, html", () => {
  const rendered = renderPasswordResetEmail({
    baseUrl: "https://app.example.com",
    recipient: "bob@example.com",
    resetToken: "tok-reset-xyz",
  });

  assertEquals(rendered.subject, "Reset your password");
  assert(rendered.text.length > 0);
  assert(rendered.html.length > 0);
});

Deno.test("renderPasswordResetEmail - link contains token", () => {
  const rendered = renderPasswordResetEmail({
    baseUrl: "https://app.example.com",
    recipient: "bob@example.com",
    resetToken: "tok-reset-xyz",
  });

  const expectedLink = "https://app.example.com/auth/reset?token=tok-reset-xyz";
  assertStringIncludes(rendered.text, expectedLink);
  assertStringIncludes(rendered.html, expectedLink);
});

Deno.test("renderPasswordResetEmail - subject does not leak the token", () => {
  const rendered = renderPasswordResetEmail({
    baseUrl: "https://app.example.com",
    recipient: "bob@example.com",
    resetToken: "tok-reset-xyz",
  });

  assertEquals(rendered.subject.includes("tok-reset-xyz"), false);
});

Deno.test("renderMagicLinkEmail - returns subject, text, html", () => {
  const rendered = renderMagicLinkEmail({
    baseUrl: "https://app.example.com",
    magicLinkToken: "tok-magic-123",
    recipient: "carol@example.com",
  });

  assertEquals(rendered.subject, "Sign in to your account");
  assert(rendered.text.length > 0);
  assert(rendered.html.length > 0);
});

Deno.test("renderMagicLinkEmail - link contains token", () => {
  const rendered = renderMagicLinkEmail({
    baseUrl: "https://app.example.com",
    magicLinkToken: "tok-magic-123",
    recipient: "carol@example.com",
  });

  const expectedLink = "https://app.example.com/auth/magic?token=tok-magic-123";
  assertStringIncludes(rendered.text, expectedLink);
  assertStringIncludes(rendered.html, expectedLink);
});

Deno.test("renderMagicLinkEmail - subject does not leak the token", () => {
  const rendered = renderMagicLinkEmail({
    baseUrl: "https://app.example.com",
    magicLinkToken: "tok-magic-123",
    recipient: "carol@example.com",
  });

  assertEquals(rendered.subject.includes("tok-magic-123"), false);
});

Deno.test("templates - trailing slash on baseUrl is normalized", () => {
  const a = renderVerificationEmail({
    baseUrl: "https://app.example.com/",
    recipient: "x@y",
    verificationToken: "t",
  });
  const b = renderVerificationEmail({
    baseUrl: "https://app.example.com",
    recipient: "x@y",
    verificationToken: "t",
  });

  // Both produce links without a double slash on the path.
  assertStringIncludes(a.text, "https://app.example.com/auth/verify?token=t");
  assertStringIncludes(b.text, "https://app.example.com/auth/verify?token=t");
});

Deno.test("templates - tokens with URL-special chars are encoded", () => {
  const rendered = renderMagicLinkEmail({
    baseUrl: "https://app.example.com",
    magicLinkToken: "abc/def+ghi=",
    recipient: "x@y",
  });

  assertStringIncludes(rendered.text, "abc%2Fdef%2Bghi%3D");
});

Deno.test("templates - HTML escapes recipient address with special chars", () => {
  const rendered = renderVerificationEmail({
    baseUrl: "https://app.example.com",
    recipient: "<script>alert(1)</script>",
    verificationToken: "t",
  });

  // The recipient should be escaped where it appears in the body.
  assertStringIncludes(rendered.html, "&lt;script&gt;");
  assertEquals(rendered.html.includes("<script>alert(1)</script>"), false);
});

Deno.test("renderMagicCodeEmail - returns subject, text, html with code in body", () => {
  const rendered = renderMagicCodeEmail({
    code: "482917",
    recipient: "carol@example.com",
  });

  assertEquals(rendered.subject, "Your sign-in code");
  assert(rendered.text.length > 0);
  assert(rendered.html.length > 0);
  assertStringIncludes(rendered.text, "482917");
  assertStringIncludes(rendered.html, "482917");
});

Deno.test("renderMagicCodeEmail - subject does not leak the code", () => {
  const rendered = renderMagicCodeEmail({
    code: "482917",
    recipient: "carol@example.com",
  });

  assertEquals(rendered.subject.includes("482917"), false);
});

Deno.test("renderMagicCodeEmail - mentions the 10-minute TTL", () => {
  const rendered = renderMagicCodeEmail({
    code: "482917",
    recipient: "carol@example.com",
  });

  assertStringIncludes(rendered.text, "10 minutes");
  assertStringIncludes(rendered.html, "10 minutes");
});

// gh/geldata#7629 — bulletproof CTA button. Outlook on Windows drops
// `display: inline-block` + `padding` on `<a>` (and `<p>`), so the
// CTA renders as plain underlined text on the page background — when
// the brand color was the only thing providing contrast against white
// text, the result was invisible. Each button-bearing template now
// wraps the link/badge in a single-cell `<table>` carrying the
// background via the legacy `bgcolor` attribute.
Deno.test("renderVerificationEmail - CTA uses bulletproof table markup", () => {
  const rendered = renderVerificationEmail({
    baseUrl: "https://app.example.com",
    recipient: "alice@example.com",
    verificationToken: "tok-verify-abc",
  });

  assertStringIncludes(rendered.html, "<table role=\"presentation\"");
  assertStringIncludes(rendered.html, "bgcolor=");
  assertStringIncludes(rendered.html, "mso-padding-alt:");
});

Deno.test("renderPasswordResetEmail - CTA uses bulletproof table markup", () => {
  const rendered = renderPasswordResetEmail({
    baseUrl: "https://app.example.com",
    recipient: "bob@example.com",
    resetToken: "tok-reset-xyz",
  });

  assertStringIncludes(rendered.html, "<table role=\"presentation\"");
  assertStringIncludes(rendered.html, "bgcolor=");
  assertStringIncludes(rendered.html, "mso-padding-alt:");
});

Deno.test("renderMagicLinkEmail - CTA uses bulletproof table markup", () => {
  const rendered = renderMagicLinkEmail({
    baseUrl: "https://app.example.com",
    magicLinkToken: "tok-magic-123",
    recipient: "carol@example.com",
  });

  assertStringIncludes(rendered.html, "<table role=\"presentation\"");
  assertStringIncludes(rendered.html, "bgcolor=");
  assertStringIncludes(rendered.html, "mso-padding-alt:");
});

Deno.test("renderMagicCodeEmail - code badge uses bulletproof table markup", () => {
  const rendered = renderMagicCodeEmail({
    code: "482917",
    recipient: "carol@example.com",
  });

  assertStringIncludes(rendered.html, "<table role=\"presentation\"");
  assertStringIncludes(rendered.html, "bgcolor=");
  assertStringIncludes(rendered.html, "mso-padding-alt:");
});

Deno.test("buttonHtml - brandColor flows through to bgcolor attribute", () => {
  const rendered = renderVerificationEmail({
    baseUrl: "https://app.example.com",
    branding: { appName: "Acme", brandColor: "#ff0066" },
    recipient: "alice@example.com",
    verificationToken: "t",
  });

  // bgcolor on the <td> is what every email client uses; inline-block
  // styling on the <a> is the modern-client path. Both must reflect
  // the configured brand color so the rendering is consistent.
  assertStringIncludes(rendered.html, "bgcolor=\"#ff0066\"");
  assertStringIncludes(rendered.html, "background: #ff0066");
});
