/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

// deno-lint-ignore-file
import { assertEquals, assertExists } from "@std/assert";

import type {
  AuthTokens,
  AuthUser,
  DiscClientConfig,
  HealthStatus,
  IsolationLevel,
  LoginCredentials,
  QueryError,
  QueryExtensions,
  QueryRequest,
  QueryResponse,
  RegisterData,
  SubscriptionClientConfig,
  SubscriptionMessage,
  TransactionState
} from "./types.ts";

Deno.test("types - DiscClientConfig defaults", () => {
  const config: DiscClientConfig = {};
  assertEquals(config.baseUrl, undefined);
  assertEquals(config.timeout, undefined);
  assertEquals(config.retries, undefined);
});

Deno.test("types - DiscClientConfig full", () => {
  const config: DiscClientConfig = {
    baseUrl: "http://localhost:5656",
    timeout: 5000,
    headers: { "X-Custom": "value" },
    retries: 3,
    retryDelay: 500
  };
  assertEquals(config.baseUrl, "http://localhost:5656");
  assertEquals(config.retries, 3);
});

Deno.test("types - QueryRequest", () => {
  const req: QueryRequest = {
    query: "select User { name }",
    variables: { id: "123" }
  };
  assertEquals(req.query, "select User { name }");
  assertEquals(req.variables?.id, "123");
});

Deno.test("types - QueryResponse with data", () => {
  const res: QueryResponse<{ name: string; }[]> = {
    data: [{ name: "Ada" }],
    extensions: { parseMs: 1, compileMs: 2, executeMs: 3, cacheHit: false }
  };
  assertEquals(res.data?.[0].name, "Ada");
  assertEquals(res.errors, undefined);
});

Deno.test("types - QueryResponse with errors", () => {
  const res: QueryResponse = {
    errors: [{ message: "Syntax error", locations: [{ line: 1, column: 5 }] }]
  };
  assertEquals(res.errors?.length, 1);
  assertEquals(res.data, undefined);
});

Deno.test("types - QueryError structure", () => {
  const err: QueryError = {
    message: "Unknown type",
    path: ["users", 0, "name"],
    extensions: { code: "UNKNOWN_TYPE" }
  };
  assertEquals(err.path?.length, 3);
  assertExists(err.extensions);
});

Deno.test("types - QueryExtensions", () => {
  const ext: QueryExtensions = {
    parseMs: 1.2,
    compileMs: 3.4,
    executeMs: 5.6,
    cacheHit: true,
    custom: "value"
  };
  assertEquals(ext.cacheHit, true);
  assertEquals(ext.custom, "value");
});

Deno.test("types - HealthStatus variants", () => {
  const healthy: HealthStatus = { status: "healthy" };
  const degraded: HealthStatus = {
    status: "degraded",
    database: { connected: true, latencyMs: 500 }
  };
  const unhealthy: HealthStatus = {
    status: "unhealthy",
    database: { connected: false }
  };
  assertEquals(healthy.status, "healthy");
  assertEquals(degraded.database?.latencyMs, 500);
  assertEquals(unhealthy.database?.connected, false);
});

Deno.test("types - AuthTokens", () => {
  const tokens: AuthTokens = { token: "jwt.token.here", refreshToken: "rt" };
  assertEquals(tokens.token, "jwt.token.here");
});

Deno.test("types - AuthUser", () => {
  const user: AuthUser = {
    id: "u1",
    email: "a@b.com",
    createdAt: "2024-01-01",
    updatedAt: "2024-01-01",
    emailVerified: true,
    active: true
  };
  assertEquals(user.email, "a@b.com");
  assertEquals(user.username, undefined);
});

Deno.test("types - LoginCredentials variants", () => {
  const byEmail: LoginCredentials = { email: "a@b.com", password: "pass" };
  const byUsername: LoginCredentials = {
    username: "ada",
    password: "pass"
  };
  assertExists(byEmail.email);
  assertExists(byUsername.username);
});

Deno.test("types - RegisterData", () => {
  const data: RegisterData = {
    email: "a@b.com",
    password: "secure123",
    username: "ada",
    metadata: { role: "admin" }
  };
  assertEquals(data.metadata?.role, "admin");
});

Deno.test("types - IsolationLevel values", () => {
  const levels: IsolationLevel[] = [
    "read_committed",
    "repeatable_read",
    "serializable"
  ];
  assertEquals(levels.length, 3);
});

Deno.test("types - TransactionState values", () => {
  const states: TransactionState[] = ["active", "committed", "rolled_back"];
  assertEquals(states.length, 3);
});

Deno.test("types - SubscriptionClientConfig", () => {
  const config: SubscriptionClientConfig = {
    autoReconnect: true,
    maxReconnectAttempts: 10,
    reconnectDelay: 2000
  };
  assertEquals(config.maxReconnectAttempts, 10);
});

Deno.test("types - SubscriptionMessage variants", () => {
  const data: SubscriptionMessage<string> = {
    id: "s1",
    type: "data",
    payload: "hello"
  };
  const err: SubscriptionMessage = { id: "s1", type: "error" };
  const complete: SubscriptionMessage = { id: "s1", type: "complete" };
  assertEquals(data.type, "data");
  assertEquals(err.type, "error");
  assertEquals(complete.type, "complete");
});
