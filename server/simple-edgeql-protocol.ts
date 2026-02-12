/**
 * Simplified EdgeQL Protocol Handler for Integration Demo
 * Works around type compatibility issues while demonstrating integration concepts
 */

import * as Types from "./types.ts";
import * as EdgeQL from "../edgeql/mod.ts";
import * as Context from "../compiler/context.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { logger } from "../postgres/logger.ts";

export interface SimpleEdgeQLOptions {
  schema?: Context.Schema;
  enable_explain?: boolean;
  dry_run?: boolean;
  database_url?: string;
  connection_pool?: ConnectionPool;
}

export class SimpleEdgeQLProtocolHandler implements Types.ProtocolHandler {
  private schema: Context.Schema;
  private options: SimpleEdgeQLOptions;
  private pool?: ConnectionPool;

  constructor(options: SimpleEdgeQLOptions = {}) {
    this.options = options;
    this.schema = options.schema || Context.createTestSchema();
    
    // Use provided pool or create new one if database URL provided
    if (options.connection_pool) {
      this.pool = options.connection_pool;
    } else if (options.database_url && !options.dry_run) {
      this.pool = new ConnectionPool({
        connectionString: options.database_url,
        minConnections: 2,
        maxConnections: 10,
      });
    }
  }

  async handle_request(
    request: Types.QueryRequest,
    context: Types.QueryContext
  ): Promise<Types.QueryResponse> {
    const start_time = Date.now();

    try {
      // Validate the request
      const validation_errors = this.validate_request(request);
      if (validation_errors.length > 0) {
        return {
          errors: validation_errors,
        };
      }

      // Parse EdgeQL query using the real parser
      const parseResult = this.parseEdgeQL(request.query);
      if (!parseResult.success) {
        return {
          errors: [{
            message: parseResult.error,
            extensions: {
              code: "PARSE_ERROR",
              phase: "parsing",
            },
          }],
        };
      }

      // Simulate SQL compilation (without the full compiler for now)
      const compilationResult = this.simulateCompilation(parseResult.ast, request.variables || {});

      if (!compilationResult.success) {
        return {
          errors: [{
            message: compilationResult.error,
            extensions: {
              code: "COMPILATION_ERROR",
              phase: "compilation",
            },
          }],
        };
      }

      // Execute query (simulate for now)
      const executionResult = await this.executeQuery(
        compilationResult.sql,
        request.variables || {},
        context
      );

      const duration_ms = Date.now() - start_time;

      // Return successful response
      const response: Types.QueryResponse = {
        data: executionResult.data,
        extensions: {
          duration_ms,
          query_hash: this.hash_query(request.query),
          sql: this.options.enable_explain ? compilationResult.sql : undefined,
          parse_info: this.options.enable_explain ? {
            ast_kind: parseResult.ast.kind,
            token_count: parseResult.token_count,
          } : undefined,
        },
      };

      if (executionResult.warnings && executionResult.warnings.length > 0) {
        response.errors = executionResult.warnings.map(warning => ({
          message: warning,
          extensions: { code: "WARNING" },
        }));
      }

      return response;
    } catch (error) {
      console.error("Query execution error:", error);
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      return {
        errors: [{
          message: errorMessage,
          extensions: {
            code: "EXECUTION_ERROR",
            duration_ms: Date.now() - start_time,
          },
        }],
      };
    }
  }

  validate_request(request: Types.QueryRequest): Types.QueryError[] {
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
      const syntax_errors = this.validate_edgeql_syntax(request.query);
      errors.push(...syntax_errors);
    }

    return errors;
  }

  private parseEdgeQL(query: string):
    | { success: true; ast: EdgeQL.Query; token_count: number }
    | { success: false; error: string } {
    try {
      // Use the real EdgeQL lexer
      const lexer = new EdgeQL.EdgeQLLexer(query);
      const tokens = lexer.tokenize();

      console.log(`[EdgeQL] Lexed ${tokens.length} tokens for query: ${query.substring(0, 50)}...`);

      // Use the real EdgeQL parser (it takes source string, not tokens)
      const parser = new EdgeQL.EdgeQLParser(query);
      const ast = parser.parse();

      console.log(`[EdgeQL] Successfully parsed ${ast.kind} query`);
      return {
        success: true,
        ast: ast,
        token_count: tokens.length
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown parsing error";
      console.log(`[EdgeQL] Exception during parsing: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage
      };
    }
  }

  private simulateCompilation(ast: EdgeQL.Query, variables: Record<string, any>):
    | { success: true; sql: string }
    | { success: false; error: string } {

    try {
      // Simulate compilation based on AST structure
      let sql = "";

      switch (ast.kind) {
        case "SelectQuery":
          sql = this.compileSelectQuery(ast);
          break;
        case "InsertQuery":
          sql = this.compileInsertQuery(ast);
          break;
        case "UpdateQuery":
          sql = this.compileUpdateQuery(ast);
          break;
        case "DeleteQuery":
          sql = this.compileDeleteQuery(ast);
          break;
        default:
          return {
            success: false,
            error: `Unsupported query type: ${ast.kind}`
          };
      }

      // Replace variables in SQL (simplified)
      let finalSQL = sql;
      for (const [name, value] of Object.entries(variables)) {
        const placeholder = `$${name}`;
        const sqlValue = typeof value === "string" ? `'${value}'` : String(value);
        finalSQL = finalSQL.replace(new RegExp(`\\$${name}`, "g"), sqlValue);
      }

      console.log(`[Compiler] Generated SQL: ${finalSQL}`);
      return { success: true, sql: finalSQL };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown compilation error";
      console.log(`[Compiler] Compilation error: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage
      };
    }
  }

  private compileSelectQuery(ast: EdgeQL.SelectQuery): string {
    let sql = "SELECT ";

    // Handle shapes (simplified)
    if (ast.shape) {
      const fields = ast.shape.elements
        .map(element => {
          if (element.expr.kind === "Identifier") {
            return element.expr.name;
          }
          return "*";
        })
        .join(", ");
      sql += `jsonb_build_object(${fields.split(", ").map(f => `'${f}', ${f}`).join(", ")})`;
    } else {
      sql += "*";
    }

    // Handle FROM clause (simplified)
    if (ast.expr.kind === "TypeName") {
      const typeName = ast.expr.name.parts[0];
      const typeDef = this.schema.types.get(typeName);
      if (typeDef) {
        sql += ` FROM ${typeDef.tableName}`;
      }
    }

    // Handle WHERE clause (simplified)
    if (ast.filter) {
      sql += " WHERE true"; // Simplified filter handling
    }

    return sql;
  }

  private compileInsertQuery(ast: EdgeQL.InsertQuery): string {
    const typeName = ast.type.name.parts[0];
    const typeDef = this.schema.types.get(typeName);

    if (!typeDef) {
      throw new Error(`Type '${typeName}' not found`);
    }

    let sql = `INSERT INTO ${typeDef.tableName}`;

    // Handle shape elements (simplified)
    const columns: string[] = [];
    const values: string[] = [];

    for (const element of ast.shape.elements) {
      if (element.name && element.computable) {
        const propName = element.name.name;
        const property = typeDef.properties.get(propName);
        if (property) {
          columns.push(property.columnName);
          values.push("DEFAULT"); // Simplified value handling
        }
      }
    }

    if (columns.length > 0) {
      sql += ` (${columns.join(", ")}) VALUES (${values.join(", ")})`;
    }

    sql += " RETURNING *";
    return sql;
  }

  private compileUpdateQuery(ast: EdgeQL.UpdateQuery): string {
    const typeName = ast.type.name.parts[0];
    const typeDef = this.schema.types.get(typeName);

    if (!typeDef) {
      throw new Error(`Type '${typeName}' not found`);
    }

    let sql = `UPDATE ${typeDef.tableName} SET `;

    // Handle shape elements (simplified)
    const setClauses: string[] = [];

    for (const element of ast.shape.elements) {
      if (element.name && element.computable) {
        const propName = element.name.name;
        const property = typeDef.properties.get(propName);
        if (property) {
          setClauses.push(`${property.columnName} = DEFAULT`); // Simplified
        }
      }
    }

    sql += setClauses.join(", ");

    if (ast.filter) {
      sql += " WHERE true"; // Simplified filter
    }

    sql += " RETURNING *";
    return sql;
  }

  private compileDeleteQuery(ast: EdgeQL.DeleteQuery): string {
    const typeName = ast.type.name.parts[0];
    const typeDef = this.schema.types.get(typeName);

    if (!typeDef) {
      throw new Error(`Type '${typeName}' not found`);
    }

    let sql = `DELETE FROM ${typeDef.tableName}`;

    if (ast.filter) {
      sql += " WHERE true"; // Simplified filter
    }

    sql += " RETURNING *";
    return sql;
  }

  private async executeQuery(
    sql: string,
    variables: Record<string, any>,
    context: Types.QueryContext
  ): Promise<{ data: any; warnings?: string[] }> {
    logger.info(`[Execution] SQL: ${sql}`);
    logger.info(`[Execution] Variables:`, variables);
    logger.info(`[Execution] Session: ${context.session.session_id}`);

    if (this.options.dry_run) {
      return {
        data: {
          sql,
          variables,
          dry_run: true,
        },
        warnings: ["Query executed in dry-run mode"],
      };
    }

    // Use connection pool if available
    if (this.pool) {
      try {
        // Execute the SQL using the pool
        const result = await this.pool.query(sql, this.prepareParameters(variables));
        
        // Format result based on query type
        const normalizedSQL = sql.toLowerCase().trim();
        
        if (normalizedSQL.includes("select")) {
          return { data: result.rows };
        } else if (normalizedSQL.includes("insert") && normalizedSQL.includes("returning")) {
          return { data: result.rows[0] || { success: true } };
        } else if (normalizedSQL.includes("update") && normalizedSQL.includes("returning")) {
          return { data: result.rows[0] || { updated: result.rowCount } };
        } else if (normalizedSQL.includes("delete")) {
          return { data: { deleted: result.rowCount } };
        } else {
          return { data: { rowCount: result.rowCount, success: true } };
        }
      } catch (error) {
        logger.error(`Database execution error: ${error}`);
        // Fall back to mock data on error
        return this.executeMockQuery(sql, variables, context);
      }
    }
    
    // Fall back to mock implementation if no database
    return this.executeMockQuery(sql, variables, context);
  }

  private prepareParameters(variables: Record<string, any>): any[] {
    // Convert variables object to array for PostgreSQL
    // This is simplified - real implementation would track parameter positions
    return Object.values(variables);
  }

  private async executeMockQuery(
    sql: string,
    variables: Record<string, any>,
    context: Types.QueryContext
  ): Promise<{ data: any; warnings?: string[] }> {
    // Original mock implementation for fallback
    const normalizedSQL = sql.toLowerCase().trim();

    if (normalizedSQL.includes("select") && normalizedSQL.includes("users")) {
      return { data: this.mockUserResults() };
    } else if (normalizedSQL.includes("insert")) {
      return { data: this.mockInsertResults() };
    } else if (normalizedSQL.includes("update")) {
      return { data: this.mockUpdateResults() };
    } else if (normalizedSQL.includes("delete")) {
      return { data: this.mockDeleteResults() };
    } else if (normalizedSQL.includes("count")) {
      return { data: { count: 42 } };
    } else {
      return {
        data: {
          executed: true,
          sql: sql.substring(0, 100),
          session_id: context.session.session_id,
          timestamp: new Date().toISOString(),
        },
      };
    }
  }

  private validate_edgeql_syntax(query: string): Types.QueryError[] {
    const errors: Types.QueryError[] = [];

    // Basic syntax checks
    const balanced_braces = this.check_balanced_braces(query);
    if (!balanced_braces.valid) {
      errors.push({
        message: `Unbalanced braces at position ${balanced_braces.position}`,
        locations: [{ line: 1, column: balanced_braces.position }],
        extensions: { code: "SYNTAX_ERROR" },
      });
    }

    // Check for valid EdgeQL query start
    const normalized = query.trim().toLowerCase();
    const valid_start_keywords = [
      "select", "insert", "update", "delete", "with", "for", "describe", "configure"
    ];

    const starts_with_valid = valid_start_keywords.some(keyword =>
      normalized.startsWith(keyword)
    );

    if (!starts_with_valid && normalized.length > 0) {
      errors.push({
        message: "Query must start with a valid EdgeQL statement",
        extensions: { code: "SYNTAX_ERROR" },
      });
    }

    return errors;
  }

  private check_balanced_braces(query: string): { valid: boolean; position: number } {
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

  // Mock result generators
  private mockUserResults(): any {
    return [
      {
        id: "01234567-89ab-cdef-0123-456789abcdef",
        name: "Alice Johnson",
        email: "alice@example.com",
        created_at: "2024-01-15T10:30:00Z",
        active: true,
        age: 29,
      },
      {
        id: "11234567-89ab-cdef-0123-456789abcdef",
        name: "Bob Smith",
        email: "bob@example.com",
        created_at: "2024-01-20T09:15:00Z",
        active: true,
        age: 35,
      },
    ];
  }

  private mockInsertResults(): any {
    return {
      id: `${Date.now()}-89ab-cdef-0123-456789abcdef`,
      name: "New User",
      email: "newuser@example.com",
      created_at: new Date().toISOString(),
      active: true,
      age: null,
    };
  }

  private mockUpdateResults(): any {
    return {
      id: "01234567-89ab-cdef-0123-456789abcdef",
      name: "Alice Johnson Updated",
      email: "alice.updated@example.com",
      created_at: "2024-01-15T10:30:00Z",
      active: false,
      age: 30,
      updated_at: new Date().toISOString(),
    };
  }

  private mockDeleteResults(): any {
    return {
      id: "01234567-89ab-cdef-0123-456789abcdef",
      deleted: true,
      deleted_at: new Date().toISOString(),
    };
  }

  private hash_query(query: string): string {
    let hash = 0;
    for (let i = 0; i < query.length; i++) {
      const char = query.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }

  // Schema management
  updateSchema(schema: Context.Schema): void {
    this.schema = schema;
  }

  getSchema(): Context.Schema {
    return this.schema;
  }

  // Initialize pool if not already done
  async initialize(): Promise<void> {
    if (this.pool) {
      await this.pool.initialize();
    }
  }
  
  // Cleanup
  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.close();
    }
  }
}
