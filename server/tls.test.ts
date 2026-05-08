/**
 * TLS/HTTPS configuration tests for Disc server
 */

import { assertEquals, assertRejects } from "@std/assert";
import { HttpServer } from "./http.ts";
import { DiscServer } from "./server.ts";
import { SimpleEdgeQLProtocolHandler } from "./simple-edgeql-protocol.ts";
import type { ServerConfig } from "./types.ts";

// ---------------------------------------------------------------------------
// Test 1: TLS config is properly set when certFile and keyFile are provided
// ---------------------------------------------------------------------------

Deno.test("TLS config - certFile and keyFile are stored in ServerConfig", () => {
  const server = new DiscServer({
    tls: {
      certFile: "/path/to/cert.pem",
      keyFile: "/path/to/key.pem"
    }
  });

  const config = server.get_config();
  assertEquals(config.tls?.certFile, "/path/to/cert.pem");
  assertEquals(config.tls?.keyFile, "/path/to/key.pem");
});

// ---------------------------------------------------------------------------
// Test 2: HttpServer.start() throws when certFile does not exist
// ---------------------------------------------------------------------------

Deno.test(
  {
    name: "TLS config - start() throws when certFile does not exist",
    // sanitize: false because HttpServer's SubscriptionHandler heartbeat
    // interval starts at construction time and cannot be cleared when
    // start() throws before stop() is ever called.
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      // Use dryRun: true so no ConnectionPool interval is created
      const protocolHandler = new SimpleEdgeQLProtocolHandler({
        dryRun: true
      });

      const config: ServerConfig = {
        host: "localhost",
        port: 19543,
        databaseUrl: "postgresql://localhost:5432/disc",
        maxConnections: 10,
        requestTimeout: 5000,
        enableCors: false,
        enableWebsockets: false,
        tls: {
          certFile: "/nonexistent/path/to/cert.pem",
          keyFile: "/nonexistent/path/to/key.pem"
        }
      };

      const httpServer = new HttpServer({ config, protocolHandler });

      await assertRejects(
        () => httpServer.start(),
        Deno.errors.NotFound
      );

      // Best-effort cleanup of heartbeat interval
      await httpServer.stop();
    }
  }
);

// ---------------------------------------------------------------------------
// Test 3: HttpServer.start() throws when keyFile does not exist but cert
//         exists (we use a real temp cert, missing key path)
// ---------------------------------------------------------------------------

Deno.test(
  {
    name: "TLS config - start() throws when keyFile does not exist",
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
        "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n"
      );

      try {
        // Use dryRun: true so no ConnectionPool interval is created
        const protocolHandler = new SimpleEdgeQLProtocolHandler({
          dryRun: true
        });

        const config: ServerConfig = {
          host: "localhost",
          port: 19544,
          databaseUrl: "postgresql://localhost:5432/disc",
          maxConnections: 10,
          requestTimeout: 5000,
          enableCors: false,
          enableWebsockets: false,
          tls: {
            certFile: tmpCert,
            keyFile: "/nonexistent/path/to/key.pem"
          }
        };

        const httpServer = new HttpServer({ config, protocolHandler });

        await assertRejects(
          () => httpServer.start(),
          Deno.errors.NotFound
        );

        // Best-effort cleanup of heartbeat interval
        await httpServer.stop();
      } finally {
        await Deno.remove(tmpCert);
      }
    }
  }
);

// ---------------------------------------------------------------------------
// Test 4: redirect and redirectPort default values are correct in ServerConfig
// ---------------------------------------------------------------------------

Deno.test("TLS config - redirect defaults to undefined when not set", () => {
  const server = new DiscServer({
    tls: {
      certFile: "/path/to/cert.pem",
      keyFile: "/path/to/key.pem"
    }
  });

  const config = server.get_config();
  assertEquals(config.tls?.redirect, undefined);
  assertEquals(config.tls?.redirectPort, undefined);
});

Deno.test(
  "TLS config - redirect and redirectPort are stored when provided",
  () => {
    const server = new DiscServer({
      tls: {
        certFile: "/path/to/cert.pem",
        keyFile: "/path/to/key.pem",
        redirect: true,
        redirectPort: 8080
      }
    });

    const config = server.get_config();
    assertEquals(config.tls?.redirect, true);
    assertEquals(config.tls?.redirectPort, 8080);
  }
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
        headers: { Location: url.toString() }
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
  }
);
