/**
 * Pluggable captcha gate for sensitive auth endpoints.
 *
 * Verifies user-supplied captcha tokens against a remote provider
 * (hCaptcha or Cloudflare Turnstile) before letting `register()` /
 * `login()` (and optionally other public endpoints) proceed. Both
 * providers expose the same wire shape — a POST of
 * `secret=...&response=<token>&remoteip=<ip>` returning
 * `{ success: bool, "error-codes"?: string[], ... }` — so a single
 * `RemoteCaptchaVerifier` handles both.
 *
 * Failures (network errors, non-2xx responses, timeouts) are folded
 * into `success: false` with synthetic error codes rather than thrown:
 * a captcha-verifier outage should reject auth attempts cleanly, not
 * crash the route.
 *
 * (gh/geldata#7341)
 */

import { getLogger } from "../lib/logger.ts";

const log = getLogger("auth-captcha");

export type CaptchaProvider = "hcaptcha" | "turnstile";

export type CaptchaEndpoint =
  | "register"
  | "login"
  | "magicLink"
  | "magicCode"
  | "passwordReset";

export interface CaptchaConfig {
  provider: CaptchaProvider;
  secret: string;
  /**
   * Endpoints to gate. Defaults to ["register", "login"]. Adding
   * "magicLink" / "magicCode" / "passwordReset" enables those too.
   */
  gate?: CaptchaEndpoint[];
  /** Per-call timeout (ms) talking to the verify endpoint. Default 5000. */
  timeoutMs?: number;
  /**
   * Override the verify endpoint URL. Useful for self-hosted hCaptcha
   * Enterprise or testing. Default per-provider:
   *   hcaptcha:  https://api.hcaptcha.com/siteverify
   *   turnstile: https://challenges.cloudflare.com/turnstile/v0/siteverify
   */
  verifyUrl?: string;
}

export interface CaptchaVerifyResult {
  success: boolean;
  /** Provider's error codes (e.g. ["missing-input-response"]) for logging. */
  errorCodes?: string[];
}

export interface CaptchaVerifier {
  /** Whether this endpoint kind requires a captcha. */
  isGated(endpoint: CaptchaEndpoint): boolean;
  /** Verify a captcha token against the provider. */
  verify(token: string, remoteIp?: string): Promise<CaptchaVerifyResult>;
}

const DEFAULT_GATE: CaptchaEndpoint[] = ["register", "login"];
const DEFAULT_TIMEOUT_MS = 5000;
const VERIFY_URLS: Record<CaptchaProvider, string> = {
  hcaptcha: "https://api.hcaptcha.com/siteverify",
  turnstile: "https://challenges.cloudflare.com/turnstile/v0/siteverify"
};

/** Always passes; used when no captcha is configured. */
export class NoopCaptchaVerifier implements CaptchaVerifier {
  isGated(_endpoint: CaptchaEndpoint): boolean {
    return false;
  }

  verify(_token: string, _remoteIp?: string): Promise<CaptchaVerifyResult> {
    return Promise.resolve({ success: true });
  }
}

export interface RemoteCaptchaVerifierOptions {
  /** Override `fetch`. Default uses global. */
  fetchImpl?: typeof fetch;
}

/**
 * Talks to hCaptcha / Turnstile's siteverify endpoint. Both share the
 * same form-encoded request shape and response JSON, so one class
 * covers both — only the default URL changes.
 */
export class RemoteCaptchaVerifier implements CaptchaVerifier {
  private readonly config: CaptchaConfig;
  private readonly gate: Set<CaptchaEndpoint>;
  private readonly timeoutMs: number;
  private readonly verifyUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: CaptchaConfig, opts: RemoteCaptchaVerifierOptions = {}) {
    this.config = config;
    this.gate = new Set(config.gate ?? DEFAULT_GATE);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.verifyUrl = config.verifyUrl ?? VERIFY_URLS[config.provider];
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  isGated(endpoint: CaptchaEndpoint): boolean {
    return this.gate.has(endpoint);
  }

  async verify(token: string, remoteIp?: string): Promise<CaptchaVerifyResult> {
    const params = new URLSearchParams();
    params.set("secret", this.config.secret);
    params.set("response", token);
    if (remoteIp)
      params.set("remoteip", remoteIp);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.verifyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
        signal: controller.signal
      });

      if (!response.ok) {
        log.warn("captcha verify returned non-2xx", {
          provider: this.config.provider,
          status: response.status
        });
        await response.body?.cancel().catch(() => {});
        return { success: false, errorCodes: ["non-2xx-response"] };
      }

      const json = await response.json() as {
        success?: boolean;
        "error-codes"?: string[];
      };
      const success = json.success === true;
      const errorCodes = json["error-codes"];
      if (!success) {
        log.warn("captcha verify reported failure", {
          provider: this.config.provider,
          errorCodes
        });
      }
      return errorCodes && errorCodes.length > 0 ? { success, errorCodes } : { success };
    } catch (err) {
      log.warn("captcha verify network error", {
        provider: this.config.provider,
        error: err instanceof Error ? err.message : String(err)
      });
      return { success: false, errorCodes: ["network-error"] };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Factory: returns a `NoopCaptchaVerifier` when no config is supplied,
 * otherwise wires up a `RemoteCaptchaVerifier` for the chosen provider.
 */
export function createCaptchaVerifier(
  config: CaptchaConfig | undefined,
  opts?: RemoteCaptchaVerifierOptions
): CaptchaVerifier {
  if (!config)
    return new NoopCaptchaVerifier();
  return new RemoteCaptchaVerifier(config, opts);
}
