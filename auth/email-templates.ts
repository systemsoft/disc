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

/**
 * Branding values surfaced on every render context. Mirrors
 * `AuthBrandingConfig` but the listener fills in defaults so
 * downstream renderers always see a usable `appName` etc. — they
 * don't have to special-case unset branding.
 *
 * (gh/geldata#6731 / #6732)
 */
export interface BrandingCtx {
  /** Defaulted to "Your account" when the operator didn't set one. */
  appName: string;
  brandColor?: string;
  darkLogoUrl?: string;
  logoUrl?: string;
}

export interface VerificationCtx {
  baseUrl: string;
  /** Defaults to `defaultBranding()` when omitted. */
  branding?: BrandingCtx;
  recipient: string;
  verificationToken: string;
}

export interface PasswordResetCtx {
  baseUrl: string;
  /** Defaults to `defaultBranding()` when omitted. */
  branding?: BrandingCtx;
  recipient: string;
  resetToken: string;
}

export interface MagicLinkCtx {
  baseUrl: string;
  /** Defaults to `defaultBranding()` when omitted. */
  branding?: BrandingCtx;
  /**
   * Pre-built link target. The listener substitutes
   * `magicLinkUrlTemplate` (gh/geldata#8028) when configured; falls
   * back to `${baseUrl}/auth/magic?token=<token>` otherwise. Optional
   * — direct callers that don't have a fully-formed link can pass
   * just `baseUrl + magicLinkToken` and the renderer constructs the
   * default-shape link on their behalf.
   */
  link?: string;
  magicLinkToken: string;
  recipient: string;
}

export interface MagicCodeCtx {
  /** Defaults to `defaultBranding()` when omitted. */
  branding?: BrandingCtx;
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
 * Default branding values applied when no operator config is present.
 * Surfaced from a single helper so every template gets the same
 * fallbacks. (gh/geldata#6731 / #6732)
 */
export const DEFAULT_APP_NAME = "Your account";

export function defaultBranding(): BrandingCtx {
  return { appName: DEFAULT_APP_NAME };
}

/**
 * Render the optional logo as an inline `<img>`. Empty string when
 * neither logo is set so the surrounding markup stays compact.
 */
function logoHtml(branding: BrandingCtx): string {
  const url = branding.logoUrl;
  if (!url) return "";
  return `<p style="margin: 0 0 16px 0;"><img src="${escapeHtml(url)}" alt="${escapeHtml(branding.appName)}" style="max-height: 48px;"></p>`;
}

/**
 * Pick a button background color, honoring `brandColor` when set.
 * `brandColor` is hex-validated at config time so this is safe to
 * splat into inline CSS without an escape pass.
 */
function buttonStyle(branding: BrandingCtx): string {
  const bg = branding.brandColor ?? "#111";
  return `display: inline-block; padding: 10px 16px; background: ${bg}; color: #fff; text-decoration: none; border-radius: 4px;`;
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
  const branding = ctx.branding ?? defaultBranding();
  const branded = branding.appName !== DEFAULT_APP_NAME;
  const link = `${trimBase(ctx.baseUrl)}/auth/verify?token=${encodeURIComponent(ctx.verificationToken)}`;
  // Subject + body fall back to the historical generic wording when
  // no operator branding is supplied. Branded deployments get the
  // appName interpolated so the email is unambiguous about which
  // service it's coming from. (gh/geldata#6731)
  const subject = branded ? `Verify your email for ${branding.appName}` : "Verify your email";
  const intro = branded
    ? `Confirm your email address to finish setting up your ${branding.appName} account:`
    : "Confirm your email address to finish setting up your account:";
  const introHtml = branded
    ? `Confirm your email address to finish setting up your ${escapeHtml(branding.appName)} account:`
    : "Confirm your email address to finish setting up your account:";

  const text = [
    `Hi ${ctx.recipient},`,
    "",
    intro,
    "",
    link,
    "",
    "If you didn't create this account, you can safely ignore this message.",
  ].join("\n");

  const html = htmlShell(
    subject,
    [
      logoHtml(branding),
      `<p>Hi ${escapeHtml(ctx.recipient)},</p>`,
      `<p>${introHtml}</p>`,
      `<p><a href="${escapeHtml(link)}" style="${buttonStyle(branding)}">Verify email</a></p>`,
      `<p style="font-size: 13px; color: #555;">Or paste this link into your browser:<br><span style="word-break: break-all;">${escapeHtml(link)}</span></p>`,
      '<p style="font-size: 13px; color: #555;">If you didn\'t create this account, you can safely ignore this message.</p>',
    ].filter((s) => s.length > 0).join("\n"),
  );

  return { html, subject, text };
}

export function renderPasswordResetEmail(ctx: PasswordResetCtx): RenderedEmail {
  const branding = ctx.branding ?? defaultBranding();
  const branded = branding.appName !== DEFAULT_APP_NAME;
  const link = `${trimBase(ctx.baseUrl)}/auth/reset?token=${encodeURIComponent(ctx.resetToken)}`;
  const subject = branded ? `Reset your ${branding.appName} password` : "Reset your password";
  const intro = branded
    ? `We received a request to reset your ${branding.appName} password. Use the link below to choose a new one:`
    : "We received a request to reset your password. Use the link below to choose a new one:";
  const introHtml = branded
    ? `We received a request to reset your ${escapeHtml(branding.appName)} password. Click the button below to choose a new one:`
    : "We received a request to reset your password. Click the button below to choose a new one:";

  const text = [
    `Hi ${ctx.recipient},`,
    "",
    intro,
    "",
    link,
    "",
    "If you didn't request a password reset, you can safely ignore this message — your password will stay the same.",
  ].join("\n");

  const html = htmlShell(
    subject,
    [
      logoHtml(branding),
      `<p>Hi ${escapeHtml(ctx.recipient)},</p>`,
      `<p>${introHtml}</p>`,
      `<p><a href="${escapeHtml(link)}" style="${buttonStyle(branding)}">Reset password</a></p>`,
      `<p style="font-size: 13px; color: #555;">Or paste this link into your browser:<br><span style="word-break: break-all;">${escapeHtml(link)}</span></p>`,
      '<p style="font-size: 13px; color: #555;">If you didn\'t request a password reset, you can safely ignore this message — your password will stay the same.</p>',
    ].filter((s) => s.length > 0).join("\n"),
  );

  return { html, subject, text };
}

export function renderMagicCodeEmail(ctx: MagicCodeCtx): RenderedEmail {
  const branding = ctx.branding ?? defaultBranding();
  const branded = branding.appName !== DEFAULT_APP_NAME;
  const subject = branded ? `Your ${branding.appName} sign-in code` : "Your sign-in code";
  const intro = branded
    ? `Use the code below to sign in to ${branding.appName}. It will expire in 10 minutes:`
    : "Use the code below to sign in. It will expire in 10 minutes:";
  const introHtml = branded
    ? `Use the code below to sign in to ${escapeHtml(branding.appName)}. It will expire in 10 minutes:`
    : "Use the code below to sign in. It will expire in 10 minutes:";
  const codeBg = branding.brandColor ?? "#111";

  const text = [
    `Hi ${ctx.recipient},`,
    "",
    intro,
    "",
    `    ${ctx.code}`,
    "",
    "If you didn't request this, you can safely ignore this email.",
  ].join("\n");

  const html = htmlShell(
    subject,
    [
      logoHtml(branding),
      `<p>Hi ${escapeHtml(ctx.recipient)},</p>`,
      `<p>${introHtml}</p>`,
      `<p style="font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 28px; letter-spacing: 6px; font-weight: 700; padding: 16px 24px; background: ${codeBg}; color: #fff; border-radius: 6px; display: inline-block;">${
        escapeHtml(ctx.code)
      }</p>`,
      '<p style="font-size: 13px; color: #555;">If you didn\'t request this, you can safely ignore this email.</p>',
    ].filter((s) => s.length > 0).join("\n"),
  );

  return { html, subject, text };
}

export function renderMagicLinkEmail(ctx: MagicLinkCtx): RenderedEmail {
  const branding = ctx.branding ?? defaultBranding();
  // Prefer the listener-supplied `link` (which honors
  // `magicLinkUrlTemplate`); fall back to the historical
  // `${baseUrl}/auth/magic?token=…` shape so direct callers of this
  // renderer keep working without setting up a template.
  const link = ctx.link ??
    `${trimBase(ctx.baseUrl)}/auth/magic?token=${encodeURIComponent(ctx.magicLinkToken)}`;
  const branded = branding.appName !== DEFAULT_APP_NAME;
  const subject = branded ? `Sign in to ${branding.appName}` : "Sign in to your account";
  const intro = branded
    ? `Click the link below to sign in to ${branding.appName}. The link is single-use and will expire shortly:`
    : "Click the link below to sign in. The link is single-use and will expire shortly:";
  const introHtml = branded
    ? `Click the button below to sign in to ${escapeHtml(branding.appName)}. The link is single-use and will expire shortly:`
    : "Click the button below to sign in. The link is single-use and will expire shortly:";

  const text = [
    `Hi ${ctx.recipient},`,
    "",
    intro,
    "",
    link,
    "",
    "If you didn't request this, you can safely ignore this message.",
  ].join("\n");

  const html = htmlShell(
    subject,
    [
      logoHtml(branding),
      `<p>Hi ${escapeHtml(ctx.recipient)},</p>`,
      `<p>${introHtml}</p>`,
      `<p><a href="${escapeHtml(link)}" style="${buttonStyle(branding)}">Sign in</a></p>`,
      `<p style="font-size: 13px; color: #555;">Or paste this link into your browser:<br><span style="word-break: break-all;">${escapeHtml(link)}</span></p>`,
      '<p style="font-size: 13px; color: #555;">If you didn\'t request this, you can safely ignore this message.</p>',
    ].filter((s) => s.length > 0).join("\n"),
  );

  return { html, subject, text };
}
