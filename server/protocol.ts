/**
 * Protocol handler for EdgeQL queries
 */

import { getLogger } from "../lib/logger.ts";
import * as Types from "./types.ts";

const log = getLogger("protocol");

export class EdgeQLProtocolHandler implements Types.ProtocolHandler {
  constructor() {
    // Legacy mock handler — real compiler integration is in EdgeQLProtocolHandler (edgeql-protocol.ts)
  }

  async handleRequest(
    request: Types.QueryRequest,
    context: Types.QueryContext,
  ): Promise<Types.QueryResponse> {
    const startTime = Date.now();

    try {
      // Validate the request
      const validationErrors = this.validateRequest(request);
      if (validationErrors.length > 0) {
        return {
          errors: validationErrors,
        };
      }

      // Mock execution — real compiler integration is in EdgeQLProtocolHandler (edgeql-protocol.ts)
      const result = await this.execute_edgeql_query(
        request.query,
        request.variables || {},
        context,
      );

      const durationMs = Date.now() - startTime;

      return {
        data: result,
        extensions: {
          durationMs,
          queryHash: this.hash_query(request.query),
        },
      };
    } catch (error) {
      log.error("Query execution error", {
        error: error instanceof Error ? error.message : String(error),
      });
      const errorMessage = error instanceof Error
        ? error.message
        : "Unknown error";

      return {
        errors: [{
          message: errorMessage,
          extensions: {
            code: "EXECUTION_ERROR",
            durationMs: Date.now() - startTime,
          },
        }],
      };
    }
  }

  validateRequest(request: Types.QueryRequest): Types.QueryError[] {
    const errors: Types.QueryError[] = [];

    // Check if query is provided
    if (!request.query || typeof request.query !== "string") {
      errors.push({
        message: "Query is required and must be a string",
        extensions: { code: "VALIDATION_ERROR" },
      });
    }

    // Check query length
    if (request.query && request.query.length > 100_000) {
      errors.push({
        message: "Query too large (max 100KB)",
        extensions: { code: "QUERY_TOO_LARGE" },
      });
    }

    // Validate variables if provided
    if (request.variables && typeof request.variables !== "object") {
      errors.push({
        message: "Variables must be an object",
        extensions: { code: "VALIDATION_ERROR" },
      });
    }

    // Basic EdgeQL syntax validation
    if (request.query) {
      const syntaxErrors = this.validate_edgeql_syntax(request.query);
      errors.push(...syntaxErrors);
    }

    return errors;
  }

  private async execute_edgeql_query(
    query: string,
    variables: Record<string, any>,
    context: Types.QueryContext,
  ): Promise<any> {
    // Mock implementation - would integrate with real EdgeQL compiler

    // Simulate different types of queries
    const normalizedQuery = query.trim().toLowerCase();

    if (normalizedQuery.startsWith("select user")) {
      return this.mock_user_data();
    } else if (normalizedQuery.startsWith("insert user")) {
      return this.mock_insert_result();
    } else if (normalizedQuery.startsWith("update user")) {
      return this.mock_update_result();
    } else if (normalizedQuery.startsWith("delete user")) {
      return this.mock_delete_result();
    } else if (normalizedQuery.includes("count")) {
      return { count: 42 };
    } else {
      // Generic mock response
      return {
        result: "Query executed successfully",
        query: query.substring(0, 100),
        variables,
        sessionId: context.session.sessionId,
        timestamp: new Date().toISOString(),
      };
    }
  }

  private validate_edgeql_syntax(query: string): Types.QueryError[] {
    const errors: Types.QueryError[] = [];

    // Basic syntax checks
    const balancedBraces = this.check_balanced_braces(query);
    if (!balancedBraces.valid) {
      errors.push({
        message: `Unbalanced braces at position ${balancedBraces.position}`,
        locations: [{ line: 1, column: balancedBraces.position }],
        extensions: { code: "SYNTAX_ERROR" },
      });
    }

    // Check for SQL injection patterns (basic protection)
    const sqlInjectionPatterns = [
      /;\s*(drop|delete|truncate|alter)\s+/i,
      /union\s+select/i,
      /--\s*$/m,
      /\/\*.*\*\//,
    ];

    for (const pattern of sqlInjectionPatterns) {
      if (pattern.test(query)) {
        errors.push({
          message: "Query contains potentially dangerous patterns",
          extensions: { code: "SECURITY_ERROR" },
        });
        break;
      }
    }

    // Check for reserved EdgeQL keywords in correct context
    const invalidKeywords = this.check_keyword_usage(query);
    if (invalidKeywords.length > 0) {
      errors.push(...invalidKeywords);
    }

    return errors;
  }

  private check_balanced_braces(
    query: string,
  ): { valid: boolean; position: number } {
    let depth = 0;
    let position = 0;

    for (let i = 0; i < query.length; i++) {
      const char = query[i];
      if (char === "{") {
        depth++;
      } else if (char === "}") {
        depth--;
        if (depth < 0) {
          return { valid: false, position: i };
        }
      }
      position++;
    }

    return { valid: depth === 0, position: depth > 0 ? position : 0 };
  }

  private check_keyword_usage(query: string): Types.QueryError[] {
    const errors: Types.QueryError[] = [];

    // Check for proper EdgeQL query structure
    const normalized = query.trim().toLowerCase();

    const validStartKeywords = [
      "select",
      "insert",
      "update",
      "delete",
      "with",
      "for",
      "describe",
      "configure",
    ];

    const startsWithValid = validStartKeywords.some((keyword) =>
      normalized.startsWith(keyword)
    );

    if (!startsWithValid && normalized.length > 0) {
      errors.push({
        message: "Query must start with a valid EdgeQL statement",
        extensions: { code: "SYNTAX_ERROR" },
      });
    }

    return errors;
  }

  private mock_user_data(): any {
    return [
      {
        id: "user_001",
        name: "Alice Johnson",
        email: "alice@example.com",
        createdAt: "2024-01-15T10:30:00Z",
        active: true,
        posts: [
          {
            id: "post_001",
            title: "Hello World",
            content: "This is my first post!",
            published: true,
            createdAt: "2024-01-16T14:20:00Z",
          },
        ],
      },
      {
        id: "user_002",
        name: "Bob Smith",
        email: "bob@example.com",
        createdAt: "2024-01-20T09:15:00Z",
        active: true,
        posts: [],
      },
    ];
  }

  private mock_insert_result(): any {
    return {
      id: `user_${Date.now()}`,
      name: "New User",
      email: "newuser@example.com",
      createdAt: new Date().toISOString(),
      active: true,
    };
  }

  private mock_update_result(): any {
    return {
      updated: 1,
      id: "user_001",
      name: "Alice Johnson Updated",
      email: "alice.updated@example.com",
      updatedAt: new Date().toISOString(),
    };
  }

  private mock_delete_result(): any {
    return {
      deleted: 1,
      id: "user_001",
    };
  }

  private hash_query(query: string): string {
    // Simple hash for query identification
    let hash = 0;
    for (let i = 0; i < query.length; i++) {
      const char = query.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(16);
  }
}

export class GraphQLProtocolHandler implements Types.ProtocolHandler {
  async handleRequest(
    _request: Types.QueryRequest,
    _context: Types.QueryContext,
  ): Promise<Types.QueryResponse> {
    // GraphQL implementation would go here
    // For now, return not implemented
    return {
      errors: [{
        message: "GraphQL protocol not yet implemented",
        extensions: { code: "NOT_IMPLEMENTED" },
      }],
    };
  }

  validateRequest(_request: Types.QueryRequest): Types.QueryError[] {
    return [{
      message: "GraphQL protocol not yet implemented",
      extensions: { code: "NOT_IMPLEMENTED" },
    }];
  }
}
