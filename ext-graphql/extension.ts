/**
 * GraphQL extension for Disc database
 *
 * Auto-generates a GraphQL schema from SDL type definitions, translates
 * incoming GraphQL queries into EdgeQL, and serves them via HTTP routes.
 *
 * Routes:
 * - POST /graphql     — Execute a GraphQL query
 * - GET  /graphql     — Simple GraphQL playground HTML
 * - GET  /graphql/schema — Return the generated GraphQL SDL
 */

import { BaseExtension } from "../extensions/base-extension.ts";
import type {
  ExtensionContext,
  ExtensionMetadata,
  ExtensionRoute,
} from "../extensions/types.ts";
import type { Schema } from "../compiler/context.ts";
import { generateGraphQLSchema } from "./schema-generator.ts";
import {
  isIntrospectionQuery,
  parseGraphQLQuery,
  resolveIntrospection,
  translateToEdgeQL,
} from "./query-translator.ts";
import type { GraphQLConfig, GraphQLResponse } from "./types.ts";

export class GraphQLExtension extends BaseExtension {
  readonly metadata: ExtensionMetadata = {
    description: "GraphQL API auto-generated from Disc schema",
    name: "graphql",
    version: "1.0.0",
  };

  private schema: Schema | undefined;
  private enableMutations: boolean;
  private maxDepth: number;
  private cachedSdl: string | undefined;

  constructor(config?: Partial<GraphQLConfig>) {
    super();
    this.enableMutations = config?.enableMutations ?? false;
    this.maxDepth = config?.maxDepth ?? 10;
    if (config?.schema) {
      this.schema = config.schema;
    }
  }

  override initialize(context: ExtensionContext): Promise<void> {
    this.setState("initializing");
    this.schema = context.schema;
    context.logger.info("GraphQL extension initializing", {
      enableMutations: this.enableMutations,
      maxDepth: this.maxDepth,
    });
    this.cachedSdl = generateGraphQLSchema(this.schema, {
      enableMutations: this.enableMutations,
    });
    this.setState("ready");
    return Promise.resolve();
  }

  override getRoutes(): ExtensionRoute[] {
    return [
      {
        handler: this.handleGraphQLQuery.bind(this),
        method: "POST",
        path: "/graphql",
      },
      {
        handler: this.handleGraphQLPlayground.bind(this),
        method: "GET",
        path: "/graphql",
      },
      {
        handler: this.handleGetSchema.bind(this),
        method: "GET",
        path: "/graphql/schema",
      },
    ];
  }

  override healthCheck(): Promise<{ healthy: boolean; details?: string }> {
    return Promise.resolve({
      details: this.state === "ready"
        ? `GraphQL endpoint ready (mutations: ${this.enableMutations})`
        : undefined,
      healthy: this.state === "ready",
    });
  }

  private async handleGraphQLQuery(request: Request): Promise<Response> {
    if (!this.schema) {
      return this.jsonResponse(
        { errors: [{ message: "GraphQL extension not initialized" }] },
        500,
      );
    }

    try {
      const body = await request.json() as {
        query?: string;
        variables?: Record<string, unknown>;
        operationName?: string;
      };

      if (!body.query) {
        return this.jsonResponse(
          { errors: [{ message: "Missing 'query' in request body" }] },
          400,
        );
      }

      // Check query depth
      const depth = this.measureDepth(body.query);
      if (depth > this.maxDepth) {
        return this.jsonResponse(
          {
            errors: [{
              message:
                `Query depth ${depth} exceeds maximum allowed depth of ${this.maxDepth}`,
            }],
          },
          400,
        );
      }

      // Parse GraphQL
      const parsed = parseGraphQLQuery(body.query);

      // Introspection (`__schema` / `__type`) is answered directly from
      // the cached schema — no EdgeQL translation, no DB roundtrip.
      // Tools like GraphiQL and codegen issue these on every connect to
      // render the schema browser, so the short-circuit matters for
      // perceived snappiness, not just correctness.
      if (isIntrospectionQuery(parsed)) {
        const introData = resolveIntrospection(parsed, this.schema);
        return this.jsonResponse({ data: introData }, 200);
      }

      // Translate to EdgeQL
      const result = translateToEdgeQL(parsed, this.schema);

      // Return the translated EdgeQL and the GraphQL info
      // In a full implementation, this would execute via the EdgeQL compiler
      const response: GraphQLResponse = {
        data: {
          __edgeql: result.edgeql,
          __variables: result.variables,
        },
      };

      return this.jsonResponse(response, 200);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.jsonResponse(
        { errors: [{ message }] },
        400,
      );
    }
  }

  private handleGraphQLPlayground(_request: Request): Promise<Response> {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Disc GraphQL Playground</title>
  <style>
    body { font-family: monospace; background: #1a1a2e; color: #e0e0e0; margin: 0; padding: 20px; }
    h1 { color: #00d4ff; }
    textarea { width: 100%; height: 200px; background: #16213e; color: #e0e0e0; border: 1px solid #0f3460; padding: 10px; font-family: monospace; }
    button { background: #00d4ff; color: #1a1a2e; border: none; padding: 10px 20px; cursor: pointer; font-family: monospace; font-weight: bold; }
    button:hover { background: #00b4d8; }
    pre { background: #16213e; padding: 10px; border: 1px solid #0f3460; overflow-x: auto; }
  </style>
</head>
<body>
  <h1>Disc GraphQL Playground</h1>
  <textarea id="query" placeholder="{ allUsers { name, email } }"></textarea>
  <br><br>
  <button onclick="runQuery()">Execute</button>
  <pre id="result">Results will appear here...</pre>
  <script>
    async function runQuery() {
      const query = document.getElementById("query").value;
      try {
        const res = await fetch("/ext/graphql/graphql", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query })
        });
        const json = await res.json();
        document.getElementById("result").textContent = JSON.stringify(json, null, 2);
      } catch (e) {
        document.getElementById("result").textContent = "Error: " + e.message;
      }
    }
  </script>
</body>
</html>`;

    return Promise.resolve(
      new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );
  }

  private handleGetSchema(_request: Request): Promise<Response> {
    if (!this.schema) {
      return Promise.resolve(
        new Response("GraphQL extension not initialized", { status: 500 }),
      );
    }

    const sdl = this.cachedSdl ??
      generateGraphQLSchema(this.schema, {
        enableMutations: this.enableMutations,
      });

    return Promise.resolve(
      new Response(sdl, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
    );
  }

  /**
   * Measure the maximum nesting depth of a GraphQL query by counting
   * nested braces. This is a simple heuristic, not a full parse.
   */
  private measureDepth(query: string): number {
    let depth = 0;
    let maxDepth = 0;
    let inString = false;

    for (let i = 0; i < query.length; i++) {
      const ch = query[i];
      if (ch === '"' && (i === 0 || query[i - 1] !== "\\")) {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === "{") {
        depth++;
        if (depth > maxDepth) maxDepth = depth;
      } else if (ch === "}") {
        depth--;
      }
    }

    return maxDepth;
  }

  private jsonResponse(data: unknown, status: number): Response {
    return new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json" },
      status,
    });
  }
}
