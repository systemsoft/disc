/**
 * Built-in email templates for the auth lifecycle.
 *
 * Three transactional emails ship with Disc out of the box: account
 * verification, password reset, and magic-link sign-in. Each renders
 * to a `RenderedEmail` ({ subject, text, html }) — the SMTP listener
 * passes it straight to `Mailer.send(...)`.
 *
 * Defaults are deliberately plain so they render in any client and
 * don't require external assets. Operators who want branded mail can
 * supply per-event overrides via `EmailTemplateOverrides` on the
 * `AuthConfig`.
 *
 * Tokens never leak into the subject line — they only appear in the
 * body's link, where the server-side route consumes them. This keeps
 * tokens out of mail-server log lines that often capture subjects.
 */

/** Output of every template renderer — passed straight to `Mailer.send`. */
export interface RenderedEmail {
  html: string;
  subject: string;
  text: string;
}

export interface VerificationCtx {
  baseUrl: string;
  recipient: string;
  verificationToken: string;
}

export interface PasswordResetCtx {
  baseUrl: string;
  recipient: string;
  resetToken: string;
}

export interface MagicLinkCtx {
  baseUrl: string;
  magicLinkToken: string;
  recipient: string;
}

export interface MagicCodeCtx {
  /**
   * Plaintext 6-digit code. Rendered prominently in the body; never
   * leaks into the subject (mail-server logs frequently capture
   * subjects).
   */
  code: string;
  recipient: string;
}

/**
 * Per-event renderer overrides. Any field left undefined falls back
 * to the corresponding `render*` default below.
 */
export interface EmailTemplateOverrides {
  magicCode?: (ctx: MagicCodeCtx) => RenderedEmail;
  magicLink?: (ctx: MagicLinkCtx) => RenderedEmail;
  passwordReset?: (ctx: PasswordResetCtx) => RenderedEmail;
  verification?: (ctx: VerificationCtx) => RenderedEmail;
}

/** Strip a trailing slash from `baseUrl` so link concat is consistent. */
function trimBase(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

/**
 * Minimal HTML escape for any string we interpolate into the body.
 * Tokens themselves are URL-safe so this is mostly defensive — guards
 * against the rare case of a recipient address containing `<` or `&`
 * leaking into the rendered HTML.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Wrap body content in a minimal HTML shell. Inline CSS only, no
 * images, no JS — keeps spam scores low and works in every client.
 */
function htmlShell(title: string, bodyHtml: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    "</head>",
    "<body style=\"font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.5; color: #111; max-width: 560px; margin: 24px auto; padding: 0 16px;\">",
    bodyHtml,
    "</body>",
    "</html>",
  ].join("\n");
}

export function renderVerificationEmail(ctx: VerificationCtx): RenderedEmail {
  const link = `${trimBase(ctx.baseUrl)}/auth/verify?token=${encodeURIComponent(ctx.verificationToken)}`;
  const subject = "Verify your email";

  const text = [
    `Hi ${ctx.recipient},`,
    "",
    "Confirm your email address to finish setting up your account:",
    "",
    link,
    "",
    "If you didn't create this account, you can safely ignore this message.",
  ].join("\n");

  const html = htmlShell(
    subject,
    [
      `<p>Hi ${escapeHtml(ctx.recipient)},</p>`,
      "<p>Confirm your email address to finish setting up your account:</p>",
      `<p><a href="${
        escapeHtml(link)
      }" style="display: inline-block; padding: 10px 16px; background: #111; color: #fff; text-decoration: none; border-radius: 4px;">Verify email</a></p>`,
      `<p style="font-size: 13px; color: #555;">Or paste this link into your browser:<br><span style="word-break: break-all;">${escapeHtml(link)}</span></p>`,
      '<p style="font-size: 13px; color: #555;">If you didn\'t create this account, you can safely ignore this message.</p>',
    ].join("\n"),
  );

  return { html, subject, text };
}

export function renderPasswordResetEmail(ctx: PasswordResetCtx): RenderedEmail {
  const link = `${trimBase(ctx.baseUrl)}/auth/reset?token=${encodeURIComponent(ctx.resetToken)}`;
  const subject = "Reset your password";

  const text = [
    `Hi ${ctx.recipient},`,
    "",
    "We received a request to reset your password. Use the link below to choose a new one:",
    "",
    link,
    "",
    "If you didn't request a password reset, you can safely ignore this message — your password will stay the same.",
  ].join("\n");

  const html = htmlShell(
    subject,
    [
      `<p>Hi ${escapeHtml(ctx.recipient)},</p>`,
      "<p>We received a request to reset your password. Click the button below to choose a new one:</p>",
      `<p><a href="${
        escapeHtml(link)
      }" style="display: inline-block; padding: 10px 16px; background: #111; color: #fff; text-decoration: none; border-radius: 4px;">Reset password</a></p>`,
      `<p style="font-size: 13px; color: #555;">Or paste this link into your browser:<br><span style="word-break: break-all;">${escapeHtml(link)}</span></p>`,
      '<p style="font-size: 13px; color: #555;">If you didn\'t request a password reset, you can safely ignore this message — your password will stay the same.</p>',
    ].join("\n"),
  );

  return { html, subject, text };
}

export function renderMagicCodeEmail(ctx: MagicCodeCtx): RenderedEmail {
  const subject = "Your sign-in code";

  const text = [
    `Hi ${ctx.recipient},`,
    "",
    "Use the code below to sign in. It will expire in 10 minutes:",
    "",
    `    ${ctx.code}`,
    "",
    "If you didn't request this, you can safely ignore this email.",
  ].join("\n");

  const html = htmlShell(
    subject,
    [
      `<p>Hi ${escapeHtml(ctx.recipient)},</p>`,
      "<p>Use the code below to sign in. It will expire in 10 minutes:</p>",
      `<p style="font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 28px; letter-spacing: 6px; font-weight: 700; padding: 16px 24px; background: #111; color: #fff; border-radius: 6px; display: inline-block;">${
        escapeHtml(ctx.code)
      }</p>`,
      '<p style="font-size: 13px; color: #555;">If you didn\'t request this, you can safely ignore this email.</p>',
    ].join("\n"),
  );

  return { html, subject, text };
}

export function renderMagicLinkEmail(ctx: MagicLinkCtx): RenderedEmail {
  const link = `${trimBase(ctx.baseUrl)}/auth/magic?token=${encodeURIComponent(ctx.magicLinkToken)}`;
  const subject = "Sign in to your account";

  const text = [
    `Hi ${ctx.recipient},`,
    "",
    "Click the link below to sign in. The link is single-use and will expire shortly:",
    "",
    link,
    "",
    "If you didn't request this, you can safely ignore this message.",
  ].join("\n");

  const html = htmlShell(
    subject,
    [
      `<p>Hi ${escapeHtml(ctx.recipient)},</p>`,
      "<p>Click the button below to sign in. The link is single-use and will expire shortly:</p>",
      `<p><a href="${
        escapeHtml(link)
      }" style="display: inline-block; padding: 10px 16px; background: #111; color: #fff; text-decoration: none; border-radius: 4px;">Sign in</a></p>`,
      `<p style="font-size: 13px; color: #555;">Or paste this link into your browser:<br><span style="word-break: break-all;">${escapeHtml(link)}</span></p>`,
      '<p style="font-size: 13px; color: #555;">If you didn\'t request this, you can safely ignore this message.</p>',
    ].join("\n"),
  );

  return { html, subject, text };
}
