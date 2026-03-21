/**
 * Unit tests for the GraphQL extension
 *
 * Tests cover:
 * - Schema generation from Disc types (8 tests)
 * - Query translation to EdgeQL (10 tests)
 * - GraphQL parser (5 tests)
 * - Extension lifecycle (2+ tests)
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { GraphQLExtension } from "./extension.ts";
import {
  generateGraphQLSchema,
  generateGraphQLTypes,
  mapEdgeQLTypeToGraphQL,
  SCALAR_TYPE_MAP,
} from "./schema-generator.ts";
import { parseGraphQLQuery, translateToEdgeQL } from "./query-translator.ts";
import type { ExtensionContext } from "../extensions/types.ts";
import type { Schema } from "../compiler/context.ts";
import { createTestSchema } from "../compiler/context.ts";

// ── Test helpers ───────────────────────────────────────────────────────

function makeContext(schema?: Schema): ExtensionContext {
  return {
    schema: schema ?? createTestSchema(),
    config: {
      host: "localhost",
      port: 5656,
      databaseUrl: "postgres://localhost/disc_test",
      maxConnections: 5,
      requestTimeout: 5000,
      enableCors: false,
      enableWebsockets: false,
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: function () {
        return this;
      },
      withRequest: function () {
        return this;
      },
    } as unknown as ExtensionContext["logger"],
  };
}

function makeRequest(
  path: string,
  method = "GET",
  body?: unknown,
): Request {
  const init: RequestInit = { method };
  if (body) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return new Request(`http://localhost${path}`, init);
}

// ── Schema Generation: Test 1 ──────────────────────────────────────────

Deno.test("GraphQL schema generation - generates type from simple TypeDef with scalar properties", () => {
  const schema = createTestSchema();
  const types = generateGraphQLTypes(schema);
  const userType = types.find((t) => t.name === "User");
  assertEquals(userType !== undefined, true);
  const fieldNames = userType!.fields.map((f) => f.name);
  assertEquals(fieldNames.includes("name"), true);
  assertEquals(fieldNames.includes("email"), true);
});

// ── Schema Generation: Test 2 ──────────────────────────────────────────

Deno.test("GraphQL schema generation - maps EdgeQL scalar types to correct GraphQL types", () => {
  assertEquals(SCALAR_TYPE_MAP["str"], "String");
  assertEquals(SCALAR_TYPE_MAP["int32"], "Int");
  assertEquals(SCALAR_TYPE_MAP["int64"], "String");
  assertEquals(SCALAR_TYPE_MAP["float64"], "Float");
  assertEquals(SCALAR_TYPE_MAP["bool"], "Boolean");
  assertEquals(SCALAR_TYPE_MAP["uuid"], "ID");
  assertEquals(SCALAR_TYPE_MAP["datetime"], "DateTime");
  assertEquals(SCALAR_TYPE_MAP["json"], "JSON");
});

// ── Schema Generation: Test 3 ──────────────────────────────────────────

Deno.test("GraphQL schema generation - generates type with required/optional fields", () => {
  const schema = createTestSchema();
  const types = generateGraphQLTypes(schema);
  const userType = types.find((t) => t.name === "User")!;

  const nameField = userType.fields.find((f) => f.name === "name")!;
  assertEquals(nameField.required, true);

  const activeField = userType.fields.find((f) => f.name === "active")!;
  assertEquals(activeField.required, false);
});

// ── Schema Generation: Test 4 ──────────────────────────────────────────

Deno.test("GraphQL schema generation - generates type for multi-link as array field", () => {
  const schema = createTestSchema();
  const types = generateGraphQLTypes(schema);
  const userType = types.find((t) => t.name === "User")!;

  const postsField = userType.fields.find((f) => f.name === "posts")!;
  assertEquals(postsField.isList, true);
  assertEquals(postsField.type, "Post");
});

// ── Schema Generation: Test 5 ──────────────────────────────────────────

Deno.test("GraphQL schema generation - generates enum types", () => {
  const schema = createTestSchema();
  const sdl = generateGraphQLSchema(schema);
  assertStringIncludes(sdl, "enum Status {");
  assertStringIncludes(sdl, "  active");
  assertStringIncludes(sdl, "  inactive");
  assertStringIncludes(sdl, "  pending");
});

// ── Schema Generation: Test 6 ──────────────────────────────────────────

Deno.test("GraphQL schema generation - generates Query type with fetch-by-id and list queries", () => {
  const schema = createTestSchema();
  const sdl = generateGraphQLSchema(schema);
  assertStringIncludes(sdl, "type Query {");
  assertStringIncludes(sdl, "user(id: ID!): User");
  assertStringIncludes(
    sdl,
    "allUsers(first: Int, offset: Int, filter: String): [User]",
  );
  assertStringIncludes(sdl, "post(id: ID!): Post");
  assertStringIncludes(
    sdl,
    "allPosts(first: Int, offset: Int, filter: String): [Post]",
  );
});

// ── Schema Generation: Test 7 ──────────────────────────────────────────

Deno.test("GraphQL schema generation - generates Mutation type with create/update/delete", () => {
  const schema = createTestSchema();
  const sdl = generateGraphQLSchema(schema, { enableMutations: true });
  assertStringIncludes(sdl, "type Mutation {");
  assertStringIncludes(sdl, "createUser(input: CreateUserInput!): User");
  assertStringIncludes(
    sdl,
    "updateUser(id: ID!, input: UpdateUserInput!): User",
  );
  assertStringIncludes(sdl, "deleteUser(id: ID!): Boolean");
});

// ── Schema Generation: Test 8 ──────────────────────────────────────────

Deno.test("GraphQL schema generation - generates input types for mutations", () => {
  const schema = createTestSchema();
  const sdl = generateGraphQLSchema(schema, { enableMutations: true });
  assertStringIncludes(sdl, "input CreateUserInput {");
  assertStringIncludes(sdl, "input UpdateUserInput {");
  // Create input should have required name
  assertStringIncludes(sdl, "  name: String!");
  // Update input should have optional name (no !)
  // Find the UpdateUserInput section
  const updateIdx = sdl.indexOf("input UpdateUserInput {");
  const updateEnd = sdl.indexOf("}", updateIdx);
  const updateSection = sdl.slice(updateIdx, updateEnd);
  assertStringIncludes(updateSection, "  name: String\n");
});

// ── Query Translation: Test 9 ──────────────────────────────────────────

Deno.test("GraphQL query translation - simple field selection produces EdgeQL SELECT with shape", () => {
  const schema = createTestSchema();
  const parsed = parseGraphQLQuery("{ allUsers { name, email } }");
  const result = translateToEdgeQL(parsed, schema);
  assertEquals(result.edgeql, "SELECT User {name, email}");
});

// ── Query Translation: Test 10 ─────────────────────────────────────────

Deno.test("GraphQL query translation - nested selection produces EdgeQL nested shape", () => {
  const schema = createTestSchema();
  const parsed = parseGraphQLQuery("{ allUsers { name, posts { title } } }");
  const result = translateToEdgeQL(parsed, schema);
  assertEquals(result.edgeql, "SELECT User {name, posts: {title}}");
});

// ── Query Translation: Test 11 ─────────────────────────────────────────

Deno.test("GraphQL query translation - query with id argument produces FILTER", () => {
  const schema = createTestSchema();
  const parsed = parseGraphQLQuery('{ user(id: "abc-123") { name, email } }');
  const result = translateToEdgeQL(parsed, schema);
  assertEquals(
    result.edgeql,
    'SELECT User {name, email} FILTER .id = <uuid>"abc-123"',
  );
});

// ── Query Translation: Test 12 ─────────────────────────────────────────

Deno.test("GraphQL query translation - list query with first/offset produces LIMIT/OFFSET", () => {
  const schema = createTestSchema();
  const parsed = parseGraphQLQuery(
    "{ allUsers(first: 10, offset: 5) { name } }",
  );
  const result = translateToEdgeQL(parsed, schema);
  assertEquals(result.edgeql, "SELECT User {name} LIMIT 10 OFFSET 5");
});

// ── Query Translation: Test 13 ─────────────────────────────────────────

Deno.test("GraphQL query translation - create mutation produces INSERT", () => {
  const schema = createTestSchema();
  const parsed = parseGraphQLQuery(
    'mutation { createUser(input: {name: "Ada", email: "ada@example.com"}) { id } }',
  );
  const result = translateToEdgeQL(parsed, schema);
  assertEquals(
    result.edgeql,
    'INSERT User {name := "Ada", email := "ada@example.com"}',
  );
});

// ── Query Translation: Test 14 ─────────────────────────────────────────

Deno.test("GraphQL query translation - update mutation produces UPDATE SET", () => {
  const schema = createTestSchema();
  const parsed = parseGraphQLQuery(
    'mutation { updateUser(id: "abc-123", input: {name: "Billie"}) { id } }',
  );
  const result = translateToEdgeQL(parsed, schema);
  assertEquals(
    result.edgeql,
    'UPDATE User FILTER .id = <uuid>"abc-123" SET {name := "Billie"}',
  );
});

// ── Query Translation: Test 15 ─────────────────────────────────────────

Deno.test("GraphQL query translation - delete mutation produces DELETE FILTER", () => {
  const schema = createTestSchema();
  const parsed = parseGraphQLQuery(
    'mutation { deleteUser(id: "abc-123") }',
  );
  const result = translateToEdgeQL(parsed, schema);
  assertEquals(
    result.edgeql,
    'DELETE User FILTER .id = <uuid>"abc-123"',
  );
});

// ── Query Translation: Test 16 ─────────────────────────────────────────

Deno.test("GraphQL query translation - multiple root selections", () => {
  const schema = createTestSchema();
  const parsed = parseGraphQLQuery(
    "{ allUsers { name } allPosts { title } }",
  );
  const result = translateToEdgeQL(parsed, schema);
  assertEquals(
    result.edgeql,
    "SELECT User {name}; SELECT Post {title}",
  );
});

// ── Query Translation: Test 17 ─────────────────────────────────────────

Deno.test("GraphQL query translation - field alias handling", () => {
  const schema = createTestSchema();
  const parsed = parseGraphQLQuery("{ allUsers { userName: name, email } }");
  // Aliases are tracked in the parsed structure but shape uses field names
  const result = translateToEdgeQL(parsed, schema);
  assertEquals(result.edgeql, "SELECT User {name, email}");
});

// ── Query Translation: Test 18 ─────────────────────────────────────────

Deno.test("GraphQL query translation - variables in query", () => {
  const schema = createTestSchema();
  const parsed = parseGraphQLQuery(
    "query GetUser { user(id: $userId) { name } }",
  );
  const result = translateToEdgeQL(parsed, schema);
  assertEquals(
    result.edgeql,
    "SELECT User {name} FILTER .id = <uuid><str>$userId",
  );
});

// ── GraphQL Parser: Test 19 ─────────────────────────────────────────────

Deno.test("GraphQL parser - parse simple query", () => {
  const parsed = parseGraphQLQuery("{ user { name } }");
  assertEquals(parsed.type, "query");
  assertEquals(parsed.selections.length, 1);
  assertEquals(parsed.selections[0].fieldName, "user");
  assertEquals(parsed.selections[0].subSelections!.length, 1);
  assertEquals(parsed.selections[0].subSelections![0].fieldName, "name");
});

// ── GraphQL Parser: Test 20 ─────────────────────────────────────────────

Deno.test("GraphQL parser - parse query with arguments", () => {
  const parsed = parseGraphQLQuery('{ user(id: "123") { name } }');
  assertEquals(parsed.selections[0].arguments.id, "123");
});

// ── GraphQL Parser: Test 21 ─────────────────────────────────────────────

Deno.test("GraphQL parser - parse nested selections", () => {
  const parsed = parseGraphQLQuery(
    "{ user { name posts { title body } } }",
  );
  const userSel = parsed.selections[0];
  assertEquals(userSel.subSelections!.length, 2);
  const postsSel = userSel.subSelections!.find((s) => s.fieldName === "posts")!;
  assertEquals(postsSel.subSelections!.length, 2);
  assertEquals(postsSel.subSelections![0].fieldName, "title");
  assertEquals(postsSel.subSelections![1].fieldName, "body");
});

// ── GraphQL Parser: Test 22 ─────────────────────────────────────────────

Deno.test("GraphQL parser - parse mutation", () => {
  const parsed = parseGraphQLQuery(
    'mutation { createUser(input: {name: "Ada"}) { id } }',
  );
  assertEquals(parsed.type, "mutation");
  assertEquals(parsed.selections[0].fieldName, "createUser");
  const input = parsed.selections[0].arguments.input as Record<string, unknown>;
  assertEquals(input.name, "Ada");
});

// ── GraphQL Parser: Test 23 ─────────────────────────────────────────────

Deno.test("GraphQL parser - parse with operation name", () => {
  const parsed = parseGraphQLQuery("query GetAllUsers { allUsers { name } }");
  assertEquals(parsed.type, "query");
  assertEquals(parsed.operationName, "GetAllUsers");
  assertEquals(parsed.selections[0].fieldName, "allUsers");
});

// ── Extension Lifecycle: Test 24 ────────────────────────────────────────

Deno.test("GraphQLExtension - creates with correct metadata", () => {
  const ext = new GraphQLExtension();
  assertEquals(ext.metadata.name, "graphql");
  assertEquals(ext.metadata.version, "1.0.0");
  assertEquals(
    ext.metadata.description,
    "GraphQL API auto-generated from Disc schema",
  );
});

// ── Extension Lifecycle: Test 25 ────────────────────────────────────────

Deno.test("GraphQLExtension - getRoutes returns 3 routes", () => {
  const ext = new GraphQLExtension();
  const routes = ext.getRoutes();
  assertEquals(routes.length, 3);
  assertEquals(routes[0].method, "POST");
  assertEquals(routes[0].path, "/graphql");
  assertEquals(routes[1].method, "GET");
  assertEquals(routes[1].path, "/graphql");
  assertEquals(routes[2].method, "GET");
  assertEquals(routes[2].path, "/graphql/schema");
});

// ── Extension Lifecycle: Test 26 ────────────────────────────────────────

Deno.test("GraphQLExtension - state starts as uninitialized", () => {
  const ext = new GraphQLExtension();
  assertEquals(ext.state, "uninitialized");
});

// ── Extension Lifecycle: Test 27 ────────────────────────────────────────

Deno.test("GraphQLExtension - initialize sets state to ready", async () => {
  const ext = new GraphQLExtension();
  await ext.initialize(makeContext());
  assertEquals(ext.state, "ready");
});

// ── Extension Lifecycle: Test 28 ────────────────────────────────────────

Deno.test("GraphQLExtension - healthCheck reports unhealthy before initialize", async () => {
  const ext = new GraphQLExtension();
  const health = await ext.healthCheck();
  assertEquals(health.healthy, false);
});

// ── Extension Lifecycle: Test 29 ────────────────────────────────────────

Deno.test("GraphQLExtension - healthCheck reports healthy after initialize", async () => {
  const ext = new GraphQLExtension();
  await ext.initialize(makeContext());
  const health = await ext.healthCheck();
  assertEquals(health.healthy, true);
  assertEquals(health.details, "GraphQL endpoint ready (mutations: false)");
});

// ── Extension Route Handlers: Test 30 ──────────────────────────────────

Deno.test("GraphQLExtension - POST /graphql returns translated EdgeQL", async () => {
  const ext = new GraphQLExtension();
  await ext.initialize(makeContext());
  const routes = ext.getRoutes();
  const postRoute = routes.find((r) =>
    r.method === "POST" && r.path === "/graphql"
  )!;

  const response = await postRoute.handler(
    makeRequest("/graphql", "POST", {
      query: "{ allUsers { name, email } }",
    }),
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.data.__edgeql, "SELECT User {name, email}");
});

// ── Extension Route Handlers: Test 31 ──────────────────────────────────

Deno.test("GraphQLExtension - POST /graphql returns error for missing query", async () => {
  const ext = new GraphQLExtension();
  await ext.initialize(makeContext());
  const routes = ext.getRoutes();
  const postRoute = routes.find((r) =>
    r.method === "POST" && r.path === "/graphql"
  )!;

  const response = await postRoute.handler(
    makeRequest("/graphql", "POST", {}),
  );
  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.errors[0].message, "Missing 'query' in request body");
});

// ── Extension Route Handlers: Test 32 ──────────────────────────────────

Deno.test("GraphQLExtension - GET /graphql returns HTML playground", async () => {
  const ext = new GraphQLExtension();
  await ext.initialize(makeContext());
  const routes = ext.getRoutes();
  const getRoute = routes.find((r) =>
    r.method === "GET" && r.path === "/graphql"
  )!;

  const response = await getRoute.handler(makeRequest("/graphql"));
  assertEquals(response.status, 200);
  const contentType = response.headers.get("Content-Type");
  assertEquals(contentType, "text/html; charset=utf-8");
  const html = await response.text();
  assertStringIncludes(html, "Disc GraphQL Playground");
});

// ── Extension Route Handlers: Test 33 ──────────────────────────────────

Deno.test("GraphQLExtension - GET /graphql/schema returns GraphQL SDL", async () => {
  const ext = new GraphQLExtension();
  await ext.initialize(makeContext());
  const routes = ext.getRoutes();
  const schemaRoute = routes.find((r) => r.path === "/graphql/schema")!;

  const response = await schemaRoute.handler(makeRequest("/graphql/schema"));
  assertEquals(response.status, 200);
  const sdl = await response.text();
  assertStringIncludes(sdl, "type User {");
  assertStringIncludes(sdl, "type Query {");
});

// ── Schema Generation: mapEdgeQLTypeToGraphQL ──────────────────────────

Deno.test("GraphQL schema generation - mapEdgeQLTypeToGraphQL handles enum types", () => {
  const schema = createTestSchema();
  const result = mapEdgeQLTypeToGraphQL("Status", schema);
  assertEquals(result, "Status");
});

// ── Schema Generation: skips computed properties ───────────────────────

Deno.test("GraphQL schema generation - skips computed properties", () => {
  const schema = createTestSchema();
  const types = generateGraphQLTypes(schema);
  const userType = types.find((t) => t.name === "User")!;
  const postCountField = userType.fields.find((f) => f.name === "postCount");
  assertEquals(postCountField, undefined);
});

// ── Query depth check ──────────────────────────────────────────────────

Deno.test("GraphQLExtension - rejects queries exceeding max depth", async () => {
  const ext = new GraphQLExtension({ maxDepth: 2 });
  await ext.initialize(makeContext());
  const routes = ext.getRoutes();
  const postRoute = routes.find((r) =>
    r.method === "POST" && r.path === "/graphql"
  )!;

  // This query has depth 3 (outer { + allUsers { + posts { )
  const response = await postRoute.handler(
    makeRequest("/graphql", "POST", {
      query: "{ allUsers { posts { title } } }",
    }),
  );
  assertEquals(response.status, 400);
  const body = await response.json();
  assertStringIncludes(body.errors[0].message, "exceeds maximum allowed depth");
});
