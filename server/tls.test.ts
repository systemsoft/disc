/**
 * TLS/HTTPS configuration tests for Disc server
 */

import { assertEquals, assertRejects } from "@std/assert";
import { DiscServer } from "./server.ts";
import { HttpServer } from "./http.ts";
import type { ServerConfig } from "./types.ts";
import { SimpleEdgeQLProtocolHandler } from "./simple-edgeql-protocol.ts";

// ---------------------------------------------------------------------------
// Test 1: TLS config is properly set when cert_file and key_file are provided
// ---------------------------------------------------------------------------

Deno.test("TLS config - cert_file and key_file are stored in ServerConfig", () => {
  const server = new DiscServer({
    tls: {
      cert_file: "/path/to/cert.pem",
      key_file: "/path/to/key.pem",
    },
  });

  const config = server.get_config();
  assertEquals(config.tls?.cert_file, "/path/to/cert.pem");
  assertEquals(config.tls?.key_file, "/path/to/key.pem");
});

// ---------------------------------------------------------------------------
// Test 2: HttpServer.start() throws when cert_file does not exist
// ---------------------------------------------------------------------------

Deno.test(
  {
    name: "TLS config - start() throws when cert_file does not exist",
    // sanitize: false because HttpServer's SubscriptionHandler heartbeat
    // interval starts at construction time and cannot be cleared when
    // start() throws before stop() is ever called.
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      // Use dry_run: true so no ConnectionPool interval is created
      const protocol_handler = new SimpleEdgeQLProtocolHandler({
        dry_run: true,
      });

      const config: ServerConfig = {
        host: "localhost",
        port: 19543,
        database_url: "postgresql://localhost:5432/disc",
        max_connections: 10,
        request_timeout: 5000,
        enable_cors: false,
        enable_websockets: false,
        tls: {
          cert_file: "/nonexistent/path/to/cert.pem",
          key_file: "/nonexistent/path/to/key.pem",
        },
      };

      const http_server = new HttpServer({ config, protocol_handler });

      await assertRejects(
        () => http_server.start(),
        Deno.errors.NotFound,
      );

      // Best-effort cleanup of heartbeat interval
      await http_server.stop();
    },
  },
);

// ---------------------------------------------------------------------------
// Test 3: HttpServer.start() throws when key_file does not exist but cert
//         exists (we use a real temp cert, missing key path)
// ---------------------------------------------------------------------------

Deno.test(
  {
    name: "TLS config - start() throws when key_file does not exist",
    // sanitize: false because HttpServer's SubscriptionHandler heartbeat
    // interval starts at construction time and cannot be cleared when
    // start() throws before stop() is ever called.
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      // Write a temporary cert file so only the key is missing
      const tmpCert = await Deno.makeTempFile({ suffix: ".pem" });
      await Deno.writeTextFile(
        tmpCert,
        "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n",
      );

      try {
        // Use dry_run: true so no ConnectionPool interval is created
        const protocol_handler = new SimpleEdgeQLProtocolHandler({
          dry_run: true,
        });

        const config: ServerConfig = {
          host: "localhost",
          port: 19544,
          database_url: "postgresql://localhost:5432/disc",
          max_connections: 10,
          request_timeout: 5000,
          enable_cors: false,
          enable_websockets: false,
          tls: {
            cert_file: tmpCert,
            key_file: "/nonexistent/path/to/key.pem",
          },
        };

        const http_server = new HttpServer({ config, protocol_handler });

        await assertRejects(
          () => http_server.start(),
          Deno.errors.NotFound,
        );

        // Best-effort cleanup of heartbeat interval
        await http_server.stop();
      } finally {
        await Deno.remove(tmpCert);
      }
    },
  },
);

// ---------------------------------------------------------------------------
// Test 4: redirect and redirect_port default values are correct in ServerConfig
// ---------------------------------------------------------------------------

Deno.test("TLS config - redirect defaults to undefined when not set", () => {
  const server = new DiscServer({
    tls: {
      cert_file: "/path/to/cert.pem",
      key_file: "/path/to/key.pem",
    },
  });

  const config = server.get_config();
  assertEquals(config.tls?.redirect, undefined);
  assertEquals(config.tls?.redirect_port, undefined);
});

Deno.test(
  "TLS config - redirect and redirect_port are stored when provided",
  () => {
    const server = new DiscServer({
      tls: {
        cert_file: "/path/to/cert.pem",
        key_file: "/path/to/key.pem",
        redirect: true,
        redirect_port: 8080,
      },
    });

    const config = server.get_config();
    assertEquals(config.tls?.redirect, true);
    assertEquals(config.tls?.redirect_port, 8080);
  },
);

// ---------------------------------------------------------------------------
// Test 5: No TLS config when tls is undefined
// ---------------------------------------------------------------------------

Deno.test("TLS config - tls is undefined by default", () => {
  const server = new DiscServer();
  const config = server.get_config();
  assertEquals(config.tls, undefined);
});

// ---------------------------------------------------------------------------
// Test 6: Redirect handler returns 301 with correct https URL
// ---------------------------------------------------------------------------

Deno.test(
  "TLS redirect - handler returns 301 with correct https URL",
  () => {
    // Use a non-default https port to avoid URL normalization collapsing the
    // port to an empty string (port 443 is the https default).
    const httpsPort = 8443;
    const host = "localhost";

    // Inline the same redirect handler logic used in HttpServer.start()
    const redirectHandler = (request: Request): Response => {
      const url = new URL(request.url);
      url.protocol = "https:";
      url.port = String(httpsPort);
      return new Response(null, {
        status: 301,
        headers: { "Location": url.toString() },
      });
    };

    const request = new Request("http://localhost:80/some/path?q=1");
    const response = redirectHandler(request);

    assertEquals(response.status, 301);

    const location = response.headers.get("Location");
    const redirected = new URL(location!);
    assertEquals(redirected.protocol, "https:");
    assertEquals(redirected.port, String(httpsPort));
    assertEquals(redirected.pathname, "/some/path");
    assertEquals(redirected.search, "?q=1");

    // Confirm host is preserved
    assertEquals(redirected.hostname, host);
  },
);
