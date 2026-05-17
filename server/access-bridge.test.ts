/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

import { assertEquals } from "@std/assert";
import { authContextToAccessContext } from "./access-bridge.ts";
import type { AuthContext } from "./types.ts";

Deno.test("access-bridge: maps full auth context", () => {
  const auth: AuthContext = {
    userId: "user-123",
    roles: ["admin", "editor"],
    permissions: ["read", "write"],
    jwtClaims: { sub: "user-123", exp: 9999999999 }
  };

  const result = authContextToAccessContext(auth);

  assertEquals(result.userId, "user-123");
  assertEquals(result.userRole, "admin");
  assertEquals(result.sessionData, { sub: "user-123", exp: 9999999999 });
  assertEquals(result.requestContext, {
    roles: ["admin", "editor"],
    permissions: ["read", "write"]
  });
});

Deno.test("access-bridge: maps empty auth context", () => {
  const auth: AuthContext = {
    roles: [],
    permissions: []
  };

  const result = authContextToAccessContext(auth);

  assertEquals(result.userId, undefined);
  assertEquals(result.userRole, undefined);
  assertEquals(result.sessionData, undefined);
  assertEquals(result.requestContext, {
    roles: [],
    permissions: []
  });
});

Deno.test("access-bridge: uses only first role as userRole", () => {
  const auth: AuthContext = {
    userId: "user-456",
    roles: ["viewer", "editor", "admin"],
    permissions: ["read"]
  };

  const result = authContextToAccessContext(auth);

  assertEquals(result.userRole, "viewer");
  assertEquals(result.requestContext, {
    roles: ["viewer", "editor", "admin"],
    permissions: ["read"]
  });
});

Deno.test("access-bridge: jwt claims flow through to sessionData", () => {
  const auth: AuthContext = {
    userId: "user-789",
    roles: ["member"],
    permissions: [],
    jwtClaims: { iss: "disc-auth", iat: 1700000000, custom_field: "value" }
  };

  const result = authContextToAccessContext(auth);

  assertEquals(result.sessionData, {
    iss: "disc-auth",
    iat: 1700000000,
    custom_field: "value"
  });
});
