/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

// deno-lint-ignore-file no-explicit-any
import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";

import type { ExtensionContext } from "../extensions/types.ts";
import { OAuthExtension } from "./extension.ts";
import { googleProvider } from "./providers.ts";
import { matchRedirectUri } from "./redirect-matcher.ts";

/**
 * gh/geldata#7468: redirect-URI matcher accepts wildcard subdomains in
 * the host position. Tests fall in two groups: pure unit tests on the
 * matcher (cheap, exhaustive) and integration tests through the
 * authorize handler (verifies the wiring + 400 paths).
 */

describe("matchRedirectUri", () => {
  describe("literal allowlist entries", () => {
    it("matches an exact URI", () => {
      assertEquals(
        matchRedirectUri("https://example.com/cb", [
          "https://example.com/cb"
        ]),
        true
      );
    });

    it("rejects path mismatch", () => {
      assertEquals(
        matchRedirectUri("https://example.com/other", [
          "https://example.com/cb"
        ]),
        false
      );
    });

    it("rejects scheme mismatch", () => {
      assertEquals(
        matchRedirectUri("http://example.com/cb", [
          "https://example.com/cb"
        ]),
        false
      );
    });

    it("rejects host mismatch", () => {
      assertEquals(
        matchRedirectUri("https://evil.com/cb", [
          "https://example.com/cb"
        ]),
        false
      );
    });

    it("ignores host case", () => {
      assertEquals(
        matchRedirectUri("https://EXAMPLE.com/cb", [
          "https://example.com/cb"
        ]),
        true
      );
    });
  });

  describe("wildcard allowlist entries", () => {
    const allowlist = ["https://*.example.com/cb"];

    it("matches a single-label subdomain", () => {
      assertEquals(
        matchRedirectUri("https://app.example.com/cb", allowlist),
        true
      );
    });

    it("rejects a two-label subdomain (only one label deep)", () => {
      assertEquals(
        matchRedirectUri("https://a.b.example.com/cb", allowlist),
        false
      );
    });

    it("rejects the bare base host (wildcard requires a subdomain)", () => {
      assertEquals(
        matchRedirectUri("https://example.com/cb", allowlist),
        false
      );
    });

    it("rejects unrelated host with similar suffix", () => {
      // `evilexample.com` ends with `example.com` as a string but not
      // as a DNS suffix. The matcher must reject this.
      assertEquals(
        matchRedirectUri("https://evilexample.com/cb", allowlist),
        false
      );
      assertEquals(
        matchRedirectUri("https://attackerexample.com/cb", allowlist),
        false
      );
    });

    it("rejects path mismatch even when host matches", () => {
      assertEquals(
        matchRedirectUri("https://app.example.com/other", allowlist),
        false
      );
    });

    it("rejects scheme mismatch", () => {
      assertEquals(
        matchRedirectUri("http://app.example.com/cb", allowlist),
        false
      );
    });
  });

  describe("multi-pattern allowlist", () => {
    const allowlist = [
      "https://example.com/cb",
      "https://*.example.com/cb",
      "https://localhost:3000/cb"
    ];

    it("succeeds on first matching pattern", () => {
      assertEquals(matchRedirectUri("https://example.com/cb", allowlist), true);
      assertEquals(
        matchRedirectUri("https://app.example.com/cb", allowlist),
        true
      );
      assertEquals(
        matchRedirectUri("https://localhost:3000/cb", allowlist),
        true
      );
    });

    it("fails when none match", () => {
      assertEquals(matchRedirectUri("https://other.com/cb", allowlist), false);
    });

    it("respects port differences", () => {
      assertEquals(
        matchRedirectUri("https://localhost:9999/cb", allowlist),
        false
      );
    });
  });

  describe("malformed input rejection", () => {
    it("rejects an unparseable URI", () => {
      assertEquals(
        matchRedirectUri("not a url", ["https://example.com/cb"]),
        false
      );
    });

    it("rejects URIs with userinfo (credentials)", () => {
      assertEquals(
        matchRedirectUri("https://attacker:pw@app.example.com/cb", [
          "https://*.example.com/cb"
        ]),
        false
      );
    });

    it("returns false on empty allowlist", () => {
      assertEquals(matchRedirectUri("https://example.com/cb", []), false);
    });
  });
});

// ── Handler integration ────────────────────────────────────────────────

function makeContext(): ExtensionContext {
  return {
    schema: { types: new Map(), functions: new Map() },
    config: {
      host: "localhost",
      port: 5656,
      databaseUrl: "postgres://localhost/disc_test",
      maxConnections: 5,
      requestTimeout: 5000,
      enableCors: false,
      enableWebsockets: false
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: function() {
        return this;
      },
      withRequest: function() {
        return this;
      }
    } as any
  };
}

describe("OAuthExtension - allowedRedirectUris (gh/geldata#7468)", () => {
  it("uses caller-supplied redirect_uri when allowlist matches", async () => {
    const provider = {
      ...googleProvider("cid", "csecret", "https://default.example.com/cb"),
      allowedRedirectUris: ["https://*.example.com/cb"]
    };
    const ext = new OAuthExtension({ providers: [provider] });
    await ext.initialize(makeContext());
    const route = ext.getRoutes().find(r => r.path === "/authorize/google")!;

    const response = await route.handler(
      new Request(
        "http://localhost/authorize/google?redirect_uri=https://tenant-a.example.com/cb"
      )
    );

    assertEquals(response.status, 200);
    const body = await response.json();
    const parsed = new URL(body.url);
    assertEquals(
      parsed.searchParams.get("redirect_uri"),
      "https://tenant-a.example.com/cb"
    );
  });

  it("rejects caller-supplied redirect_uri when not in allowlist", async () => {
    const provider = {
      ...googleProvider("cid", "csecret", "https://default.example.com/cb"),
      allowedRedirectUris: ["https://*.example.com/cb"]
    };
    const ext = new OAuthExtension({ providers: [provider] });
    await ext.initialize(makeContext());
    const route = ext.getRoutes().find(r => r.path === "/authorize/google")!;

    const response = await route.handler(
      new Request(
        "http://localhost/authorize/google?redirect_uri=https://evil.com/cb"
      )
    );

    assertEquals(response.status, 400);
    const body = await response.json();
    // gh/geldata#8950: structured error shape replaces flat string.
    assertEquals(body.error.code, "redirect_uri_not_allowed");
  });

  it("rejects caller override when no allowlist is configured", async () => {
    // Without an allowlist, callers can't supply a redirect_uri at all —
    // silent fallback would mask a misconfiguration.
    const provider = googleProvider(
      "cid",
      "csecret",
      "https://default.example.com/cb"
    );
    const ext = new OAuthExtension({ providers: [provider] });
    await ext.initialize(makeContext());
    const route = ext.getRoutes().find(r => r.path === "/authorize/google")!;

    const response = await route.handler(
      new Request(
        "http://localhost/authorize/google?redirect_uri=https://anywhere.com/cb"
      )
    );

    assertEquals(response.status, 400);
  });

  it("falls back to fixed redirectUri when no caller override + no allowlist", async () => {
    const provider = googleProvider(
      "cid",
      "csecret",
      "https://default.example.com/cb"
    );
    const ext = new OAuthExtension({ providers: [provider] });
    await ext.initialize(makeContext());
    const route = ext.getRoutes().find(r => r.path === "/authorize/google")!;

    const response = await route.handler(
      new Request("http://localhost/authorize/google")
    );

    assertEquals(response.status, 200);
    const body = await response.json();
    const parsed = new URL(body.url);
    assertEquals(
      parsed.searchParams.get("redirect_uri"),
      "https://default.example.com/cb"
    );
  });

  // gh/geldata#6433: when an allowlist is configured, a matching
  // caller-supplied redirect_uri is auto-allowed — no extra `allow=…`
  // confirmation flag is required. The allowlist itself is the
  // declarative permission. Pairs with the wildcard work in #7468.
  it("auto-allows allowlisted exact-match URLs without an allow= flag", async () => {
    const provider = {
      ...googleProvider("cid", "csecret", "https://default.example.com/cb"),
      allowedRedirectUris: ["https://app.example.com/cb"]
    };
    const ext = new OAuthExtension({ providers: [provider] });
    await ext.initialize(makeContext());
    const route = ext.getRoutes().find(r => r.path === "/authorize/google")!;

    // Note: no `allow=true` (or similar) anywhere in the request.
    const response = await route.handler(
      new Request(
        "http://localhost/authorize/google?redirect_uri=https://app.example.com/cb"
      )
    );

    assertEquals(response.status, 200);
    const body = await response.json();
    const parsed = new URL(body.url);
    assertEquals(
      parsed.searchParams.get("redirect_uri"),
      "https://app.example.com/cb"
    );
  });

  // gh/geldata#6433 + #7468: wildcard allowlist entries auto-allow
  // matching subdomains without an extra confirmation flag. Pins the
  // already-implemented behaviour against future regressions.
  it("auto-allows wildcard-matching URLs without an allow= flag", async () => {
    const provider = {
      ...googleProvider("cid", "csecret", "https://default.example.com/cb"),
      allowedRedirectUris: ["https://*.example.com/cb"]
    };
    const ext = new OAuthExtension({ providers: [provider] });
    await ext.initialize(makeContext());
    const route = ext.getRoutes().find(r => r.path === "/authorize/google")!;

    const response = await route.handler(
      new Request(
        "http://localhost/authorize/google?redirect_uri=https://tenant-b.example.com/cb"
      )
    );

    assertEquals(response.status, 200);
    const body = await response.json();
    const parsed = new URL(body.url);
    assertEquals(
      parsed.searchParams.get("redirect_uri"),
      "https://tenant-b.example.com/cb"
    );
  });
});
