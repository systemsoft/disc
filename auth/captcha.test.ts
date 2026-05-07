/**
 * Tests for the pluggable captcha gate.
 * (gh/geldata#7341)
 */

import { assert, assertEquals } from "@std/assert";
import { type CaptchaConfig, createCaptchaVerifier, NoopCaptchaVerifier, RemoteCaptchaVerifier } from "./captcha.ts";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function makeFetch(
  responder: (req: CapturedRequest) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: CapturedRequest[]; } {
  const calls: CapturedRequest[] = [];
  const fetchImpl = ((
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    if (init?.headers instanceof Headers) {
      init.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    } else if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    const captured: CapturedRequest = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    };
    calls.push(captured);
    return Promise.resolve(responder(captured));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

// ── NoopCaptchaVerifier ───────────────────────────────────────────────

Deno.test("NoopCaptchaVerifier — never gates and always succeeds", async () => {
  const v = new NoopCaptchaVerifier();
  assertEquals(v.isGated("register"), false);
  assertEquals(v.isGated("login"), false);
  assertEquals(v.isGated("magicLink"), false);
  assertEquals(v.isGated("magicCode"), false);
  assertEquals(v.isGated("passwordReset"), false);
  const result = await v.verify("any-token");
  assertEquals(result.success, true);
});

// ── createCaptchaVerifier factory ─────────────────────────────────────

Deno.test("createCaptchaVerifier — returns NoopCaptchaVerifier when config omitted", () => {
  const v = createCaptchaVerifier(undefined);
  assert(v instanceof NoopCaptchaVerifier);
});

Deno.test("createCaptchaVerifier — returns RemoteCaptchaVerifier when configured", () => {
  const v = createCaptchaVerifier({ provider: "hcaptcha", secret: "x" });
  assert(v instanceof RemoteCaptchaVerifier);
});

// ── isGated / gate config ─────────────────────────────────────────────

Deno.test("RemoteCaptchaVerifier — default gate is register + login only", () => {
  const v = new RemoteCaptchaVerifier({ provider: "hcaptcha", secret: "x" });
  assertEquals(v.isGated("register"), true);
  assertEquals(v.isGated("login"), true);
  assertEquals(v.isGated("magicLink"), false);
  assertEquals(v.isGated("magicCode"), false);
  assertEquals(v.isGated("passwordReset"), false);
});

Deno.test("RemoteCaptchaVerifier — explicit gate config narrows or expands", () => {
  const v = new RemoteCaptchaVerifier({
    provider: "turnstile",
    secret: "x",
    gate: ["login", "magicLink"],
  });
  assertEquals(v.isGated("register"), false);
  assertEquals(v.isGated("login"), true);
  assertEquals(v.isGated("magicLink"), true);
  assertEquals(v.isGated("magicCode"), false);
});

// ── Happy path ────────────────────────────────────────────────────────

Deno.test("RemoteCaptchaVerifier — happy path POSTs form-encoded body and parses success", async () => {
  const { fetchImpl, calls } = makeFetch(() =>
    new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
  const v = new RemoteCaptchaVerifier(
    { provider: "hcaptcha", secret: "shh" },
    { fetchImpl },
  );
  const result = await v.verify("user-token", "203.0.113.5");
  assertEquals(result.success, true);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, "https://api.hcaptcha.com/siteverify");
  assertEquals(calls[0].method, "POST");
  assertEquals(
    calls[0].headers["content-type"],
    "application/x-www-form-urlencoded",
  );
  const params = new URLSearchParams(calls[0].body);
  assertEquals(params.get("secret"), "shh");
  assertEquals(params.get("response"), "user-token");
  assertEquals(params.get("remoteip"), "203.0.113.5");
});

Deno.test("RemoteCaptchaVerifier — omits remoteip when not provided", async () => {
  const { fetchImpl, calls } = makeFetch(() => new Response(JSON.stringify({ success: true }), { status: 200 }));
  const v = new RemoteCaptchaVerifier(
    { provider: "hcaptcha", secret: "shh" },
    { fetchImpl },
  );
  await v.verify("token");
  const params = new URLSearchParams(calls[0].body);
  assertEquals(params.has("remoteip"), false);
});

// ── Provider URL routing ──────────────────────────────────────────────

Deno.test("RemoteCaptchaVerifier — turnstile uses Cloudflare verify URL by default", async () => {
  const { fetchImpl, calls } = makeFetch(() => new Response(JSON.stringify({ success: true }), { status: 200 }));
  const v = new RemoteCaptchaVerifier(
    { provider: "turnstile", secret: "shh" },
    { fetchImpl },
  );
  await v.verify("token");
  assertEquals(
    calls[0].url,
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
  );
});

Deno.test("RemoteCaptchaVerifier — verifyUrl override wins", async () => {
  const { fetchImpl, calls } = makeFetch(() => new Response(JSON.stringify({ success: true }), { status: 200 }));
  const v = new RemoteCaptchaVerifier(
    {
      provider: "hcaptcha",
      secret: "shh",
      verifyUrl: "https://hcaptcha.example.com/verify",
    },
    { fetchImpl },
  );
  await v.verify("token");
  assertEquals(calls[0].url, "https://hcaptcha.example.com/verify");
});

// ── Failure modes ─────────────────────────────────────────────────────

Deno.test("RemoteCaptchaVerifier — non-2xx response returns failure", async () => {
  const { fetchImpl } = makeFetch(() => new Response("nope", { status: 502 }));
  const v = new RemoteCaptchaVerifier(
    { provider: "hcaptcha", secret: "x" },
    { fetchImpl },
  );
  const result = await v.verify("token");
  assertEquals(result.success, false);
  assertEquals(result.errorCodes, ["non-2xx-response"]);
});

Deno.test("RemoteCaptchaVerifier — fetch throw is folded into network-error result", async () => {
  const fetchImpl = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
  const v = new RemoteCaptchaVerifier(
    { provider: "hcaptcha", secret: "x" },
    { fetchImpl },
  );
  const result = await v.verify("token");
  assertEquals(result.success, false);
  assertEquals(result.errorCodes, ["network-error"]);
});

Deno.test("RemoteCaptchaVerifier — timeout aborts and returns network-error", async () => {
  const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const sig = init?.signal;
      if (sig) {
        sig.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      }
    });
  }) as typeof fetch;
  const v = new RemoteCaptchaVerifier(
    { provider: "hcaptcha", secret: "x", timeoutMs: 10 },
    { fetchImpl },
  );
  const result = await v.verify("token");
  assertEquals(result.success, false);
  assertEquals(result.errorCodes, ["network-error"]);
});

Deno.test("RemoteCaptchaVerifier — provider success: false propagates with error codes", async () => {
  const { fetchImpl } = makeFetch(() =>
    new Response(
      JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }),
      { status: 200 },
    )
  );
  const v = new RemoteCaptchaVerifier(
    { provider: "hcaptcha", secret: "x" },
    { fetchImpl },
  );
  const result = await v.verify("token");
  assertEquals(result.success, false);
  assertEquals(result.errorCodes, ["invalid-input-response"]);
});

// ── Config sanity ─────────────────────────────────────────────────────

Deno.test("RemoteCaptchaVerifier — config object literal type sanity", () => {
  const cfg: CaptchaConfig = {
    provider: "hcaptcha",
    secret: "x",
    gate: ["register", "login", "magicLink", "magicCode", "passwordReset"],
    timeoutMs: 1234,
    verifyUrl: "https://example.com/verify",
  };
  const v = new RemoteCaptchaVerifier(cfg);
  assertEquals(v.isGated("passwordReset"), true);
});
