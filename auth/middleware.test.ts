import { assertEquals, assertExists } from "@std/assert";
import { describe, it, beforeEach, afterEach } from "@std/testing/bdd";
import { AuthMiddleware } from "./middleware.ts";
import { AuthProvider } from "./provider.ts";
import { AuthConfig } from "./types.ts";
import { TestDatabase } from "./test-database.ts";

describe("AuthMiddleware", () => {
  let middleware: AuthMiddleware;
  let provider: AuthProvider;
  let db: TestDatabase;
  let testToken: string;
  let testUserId: string;

  const testConfig: AuthConfig = {
    jwt_secret: "test-secret-key-at-least-32-characters-long",
    bcrypt_rounds: 4,
    token_expiry: 3600,
    password_min_length: 6,
  };

  beforeEach(async () => {
    db = new TestDatabase();
    await db.connect();
    provider = new AuthProvider(testConfig, db);
    await provider.initialize();

    middleware = new AuthMiddleware(provider);

    // Create a test user and token
    const response = await provider.register({
      email: "test@example.com",
      password: "TestPass123!",
    });
    testToken = response.token;
    testUserId = response.user.id;
  });

  afterEach(async () => {
    await db.close();
  });

  describe("Request Authentication", () => {
    it("should extract bearer token from Authorization header", async () => {
      const request = new Request("http://localhost/test", {
        headers: {
          "Authorization": `Bearer ${testToken}`,
        },
      });

      const context = await middleware.authenticate(request);
      
      assertExists(context);
      assertEquals(context.user_id, testUserId);
      assertEquals(context.email, "test@example.com");
    });

    it("should extract token from cookie", async () => {
      const request = new Request("http://localhost/test", {
        headers: {
          "Cookie": `auth_token=${testToken}`,
        },
      });

      const context = await middleware.authenticate(request);
      
      assertExists(context);
      assertEquals(context.user_id, testUserId);
    });

    it("should extract token from query parameter", async () => {
      const request = new Request(`http://localhost/test?token=${testToken}`);

      const context = await middleware.authenticate(request);
      
      assertExists(context);
      assertEquals(context.user_id, testUserId);
    });

    it("should return null for missing token", async () => {
      const request = new Request("http://localhost/test");

      const context = await middleware.authenticate(request);
      
      assertEquals(context, null);
    });

    it("should return null for invalid token", async () => {
      const request = new Request("http://localhost/test", {
        headers: {
          "Authorization": "Bearer invalid-token",
        },
      });

      const context = await middleware.authenticate(request);
      
      assertEquals(context, null);
    });
  });

  describe("Route Protection", () => {
    it("should allow authenticated requests to protected routes", async () => {
      const request = new Request("http://localhost/api/protected", {
        headers: {
          "Authorization": `Bearer ${testToken}`,
        },
      });

      const handler = (_req: Request) => new Response("Success");
      const protectedHandler = middleware.requireAuth(handler);

      const response = await protectedHandler(request);
      assertEquals(response.status, 200);
      const text = await response.text();
      assertEquals(text, "Success");
    });

    it("should reject unauthenticated requests to protected routes", async () => {
      const request = new Request("http://localhost/api/protected");

      const handler = (_req: Request) => new Response("Success");
      const protectedHandler = middleware.requireAuth(handler);

      const response = await protectedHandler(request);
      assertEquals(response.status, 401);
      const json = await response.json();
      assertEquals(json.error, "Authentication required");
    });

    it("should pass auth context to handler", async () => {
      const request = new Request("http://localhost/api/protected", {
        headers: {
          "Authorization": `Bearer ${testToken}`,
        },
      });

      let capturedContext: any;
      const handler = (_req: Request, context?: any) => {
        capturedContext = context;
        return new Response("Success");
      };
      const protectedHandler = middleware.requireAuth(handler);
      
      await protectedHandler(request);
      
      assertExists(capturedContext);
      assertEquals(capturedContext.user_id, testUserId);
      assertEquals(capturedContext.email, "test@example.com");
    });
  });

  describe("Optional Authentication", () => {
    it("should add context for authenticated requests", async () => {
      const request = new Request("http://localhost/api/public", {
        headers: {
          "Authorization": `Bearer ${testToken}`,
        },
      });

      let capturedContext: any;
      const handler = (_req: Request, context?: any) => {
        capturedContext = context;
        return new Response("Success");
      };
      const optionalHandler = middleware.optionalAuth(handler);

      await optionalHandler(request);

      assertExists(capturedContext);
      assertEquals(capturedContext.user_id, testUserId);
    });

    it("should allow unauthenticated requests with null context", async () => {
      const request = new Request("http://localhost/api/public");

      let capturedContext: any;
      const handler = (_req: Request, context?: any) => {
        capturedContext = context;
        return new Response("Success");
      };
      const optionalHandler = middleware.optionalAuth(handler);
      
      const response = await optionalHandler(request);
      
      assertEquals(response.status, 200);
      assertEquals(capturedContext, null);
    });
  });

  describe("CORS and Security Headers", () => {
    it("should add security headers to responses", async () => {
      const request = new Request("http://localhost/test", {
        headers: {
          "Authorization": `Bearer ${testToken}`,
        },
      });

      const handler = (_req: Request) => new Response("Success");
      const secureHandler = middleware.withSecurityHeaders(handler);
      
      const response = await secureHandler(request);
      
      assertEquals(response.headers.get("X-Content-Type-Options"), "nosniff");
      assertEquals(response.headers.get("X-Frame-Options"), "DENY");
      assertEquals(response.headers.get("X-XSS-Protection"), "1; mode=block");
    });

    it("should handle CORS preflight requests", async () => {
      const request = new Request("http://localhost/api/test", {
        method: "OPTIONS",
        headers: {
          "Origin": "http://example.com",
          "Access-Control-Request-Method": "POST",
        },
      });

      const handler = (_req: Request) => new Response("Success");
      const corsHandler = middleware.withCORS(handler, {
        origins: ["http://example.com"],
        methods: ["GET", "POST"],
      });
      
      const response = await corsHandler(request);
      
      assertEquals(response.status, 204);
      assertEquals(response.headers.get("Access-Control-Allow-Origin"), "http://example.com");
      assertEquals(response.headers.get("Access-Control-Allow-Methods"), "GET, POST");
    });

    it("should reject CORS requests from disallowed origins", async () => {
      const request = new Request("http://localhost/api/test", {
        headers: {
          "Origin": "http://evil.com",
        },
      });

      const handler = (_req: Request) => new Response("Success");
      const corsHandler = middleware.withCORS(handler, {
        origins: ["http://example.com"],
      });
      
      const response = await corsHandler(request);
      
      assertEquals(response.headers.get("Access-Control-Allow-Origin"), null);
    });
  });
});