/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Simplified EdgeQL Protocol Handler — test/dev fixture, NOT for serving real queries.
 *
 * This handler ships a hand-rolled "simulated" SQL compiler that
 * intentionally omits FROM/LIMIT/ORDER and most expression kinds.
 * It exists for two narrow uses:
 *   1. Unit tests for pool wiring + error propagation that don't care
 *      about the SQL string itself (see error-propagation.test.ts,
 *      pg-integration.test.ts, tls.test.ts).
 *   2. The dev-mode mock-data fallback when no DB is configured.
 *
 * The default protocol path in `disc serve` is `EdgeQLProtocolHandler`
 * (the real compiler). Set `DISC_PROTOCOL=simple` to opt into this
 * handler — but expect broken queries beyond `select Type` for non-
 * default modules.
 */

import * as Context from "../compiler/context.ts";
import * as EdgeQL from "../edgeql/mod.ts";
import { isWriteQuery } from "../edgeql/query-capabilities.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { DatabaseExecutionError } from "../lib/errors.ts";
import { getLogger } from "../lib/logger.ts";
import type { DatabaseRegistry } from "./database-registry.ts";
import * as Types from "./types.ts";
import type { HealthStatus } from "./types.ts";

const log = getLogger("simple-edgeql-protocol");

export interface SimpleEdgeQLOptions {
  schema?: Context.Schema;
  enableExplain?: boolean;
  dryRun?: boolean;
  databaseUrl?: string;
  connectionPool?: ConnectionPool;
  enableAccessPolicies?: boolean;
  databaseRegistry?: DatabaseRegistry;
  /**
   * When true, reject writes (INSERT/UPDATE/DELETE/CONFIGURE
   * DATABASE|INSTANCE|SYSTEM) with a `READ_ONLY_MODE` error.
   * (gh/geldata#5524, ports geldata/gel#5543)
   */
  readOnly?: boolean;
}

export class SimpleEdgeQLProtocolHandler implements Types.ProtocolHandler {
  private schema: Context.Schema;
  private options: SimpleEdgeQLOptions;
  private pool?: ConnectionPool;

  constructor(options: SimpleEdgeQLOptions = {}) {
    this.options = options;
    this.schema = options.schema || Context.createTestSchema();

    if (options.enableAccessPolicies) {
      log.warn(
        "Access policies are not supported by SimpleEdgeQLProtocolHandler. Use protocol: \"full\" for access policy enforcement."
      );
    }

    // Use provided pool or create new one if database URL provided
    if (options.connectionPool) {
      this.pool = options.connectionPool;
    } else if (options.databaseUrl && !options.dryRun) {
      this.pool = new ConnectionPool({
        connectionString: options.databaseUrl,
        minConnections: 2,
        maxConnections: 10
      });
    }
  }

  async handleRequest(
    request: Types.QueryRequest,
    context: Types.QueryContext
  ): Promise<Types.QueryResponse> {
    const startTime = Date.now();

    try {
      // Validate the request
      const validationErrors = this.validateRequest(request);
      if (validationErrors.length > 0) {
        return {
          errors: validationErrors
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
              phase: "parsing"
            }
          }]
        };
      }

      // Read-only-mode gate. (gh/geldata#5524, ports geldata/gel#5543)
      if (this.options.readOnly && isWriteQuery(parseResult.ast)) {
        return {
          errors: [{
            message: "the server is currently in read-only mode; this query would write to the database",
            extensions: {
              code: "READ_ONLY_MODE",
              queryKind: parseResult.ast.kind
            }
          }]
        };
      }

      // Simulate SQL compilation (without the full compiler for now)
      const compilationResult = this.simulateCompilation(
        parseResult.ast,
        request.variables || {}
      );

      if (!compilationResult.success) {
        return {
          errors: [{
            message: compilationResult.error,
            extensions: {
              code: "COMPILATION_ERROR",
              phase: "compilation"
            }
          }]
        };
      }

      // Execute query (simulate for now)
      const executionResult = await this.executeQuery(
        compilationResult.sql,
        request.variables || {},
        context
      );

      const durationMs = Date.now() - startTime;

      // Return successful response
      const response: Types.QueryResponse = {
        data: executionResult.data,
        extensions: {
          durationMs,
          queryHash: this.hash_query(request.query),
          sql: this.options.enableExplain ? compilationResult.sql : undefined,
          parse_info: this.options.enableExplain ?
            {
              ast_kind: parseResult.ast.kind,
              token_count: parseResult.token_count
            } :
            undefined
        }
      };

      if (executionResult.warnings && executionResult.warnings.length > 0) {
        response.errors = executionResult.warnings.map(warning => ({
          message: warning,
          extensions: { code: "WARNING" }
        }));
      }

      return response;
    } catch (error) {
      log.error("Query execution error", {
        error: error instanceof Error ? error.message : String(error)
      });
      const errorMessage = error instanceof Error ?
        error.message :
        "Unknown error";

      return {
        errors: [{
          message: errorMessage,
          extensions: {
            code: "EXECUTION_ERROR",
            durationMs: Date.now() - startTime
          }
        }]
      };
    }
  }

  validateRequest(request: Types.QueryRequest): Types.QueryError[] {
    const errors: Types.QueryError[] = [];

    // Check if query is provided
    if (!request.query || typeof request.query !== "string") {
      errors.push({
        message: "Query is required and must be a string",
        extensions: { code: "VALIDATION_ERROR" }
      });
    }

    // Check query length
    if (request.query && request.query.length > 100_000) {
      errors.push({
        message: "Query too large (max 100KB)",
        extensions: { code: "QUERY_TOO_LARGE" }
      });
    }

    // Validate variables if provided
    if (request.variables && typeof request.variables !== "object") {
      errors.push({
        message: "Variables must be an object",
        extensions: { code: "VALIDATION_ERROR" }
      });
    }

    // Basic EdgeQL syntax validation
    if (request.query) {
      const syntaxErrors = this.validate_edgeql_syntax(request.query);
      errors.push(...syntaxErrors);
    }

    return errors;
  }

  private parseEdgeQL(query: string):
    | { success: true; ast: EdgeQL.Query; token_count: number; }
    | { success: false; error: string; } {
    try {
      // Use the real EdgeQL lexer
      const lexer = new EdgeQL.EdgeQLLexer(query);
      const tokens = lexer.tokenize();

      log.debug("Lexed tokens for query", {
        token_count: tokens.length,
        query_prefix: query.substring(0, 50)
      });

      // Use the real EdgeQL parser (it takes source string, not tokens)
      const parser = new EdgeQL.EdgeQLParser(query);
      const ast = parser.parse();

      log.debug("Successfully parsed query", { kind: ast.kind });
      return {
        success: true,
        ast: ast,
        token_count: tokens.length
      };
    } catch (error) {
      const errorMessage = error instanceof Error ?
        error.message :
        "Unknown parsing error";
      log.debug("Exception during parsing", { error: errorMessage });
      return {
        success: false,
        error: errorMessage
      };
    }
  }

  private simulateCompilation(
    ast: EdgeQL.Query,
    variables: Record<string, any>
  ):
    | { success: true; sql: string; }
    | { success: false; error: string; } {
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
        const sqlValue = typeof value === "string" ?
          `'${value}'` :
          String(value);
        finalSQL = finalSQL.replace(new RegExp(`\\$${name}`, "g"), sqlValue);
      }

      log.debug("Generated SQL", { sql: finalSQL });
      return { success: true, sql: finalSQL };
    } catch (error) {
      const errorMessage = error instanceof Error ?
        error.message :
        "Unknown compilation error";
      log.debug("Compilation error", { error: errorMessage });
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
      const fields = ast
        .shape
        .elements
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

    // Handle FROM clause (simplified). For qualified names like
    // `default::Item`, the type is the trailing part — `parts[0]` would
    // resolve to the module name and silently miss the lookup.
    if (ast.expr.kind === "TypeName") {
      const parts = ast.expr.name.parts;
      const typeName = parts[parts.length - 1];
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
    const parts = ast.type.name.parts;
    const typeName = parts[parts.length - 1];
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
    const parts = ast.type.name.parts;
    const typeName = parts[parts.length - 1];
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
    const parts = ast.type.name.parts;
    const typeName = parts[parts.length - 1];
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

  /**
   * Resolve the connection pool for the current query context.
   * If a DatabaseRegistry is available and the session specifies a database,
   * look up the pool from the registry. Otherwise, fall back to the handler's
   * own pool.
   */
  private resolvePool(context: Types.QueryContext): ConnectionPool | undefined {
    const registry = this.options.databaseRegistry;
    if (registry && context.session.database) {
      const entry = registry.getDatabase(context.session.database);

      if (entry)
        return entry.pool;
    }

    return this.pool;
  }

  private async executeQuery(
    sql: string,
    variables: Record<string, any>,
    context: Types.QueryContext
  ): Promise<{ data: any; warnings?: string[]; }> {
    log.debug("Executing SQL", { sql });
    log.debug("Query variables", { variables: JSON.stringify(variables) });
    log.debug("Query session", { sessionId: context.session.sessionId });

    if (this.options.dryRun) {
      return {
        data: {
          dryRun: true,
          sql,
          variables
        },
        warnings: ["Query executed in dry-run mode"]
      };
    }

    // Resolve the correct pool (registry-aware or default)
    const pool = this.resolvePool(context);

    // Use connection pool if available
    if (pool) {
      try {
        // Execute the SQL using the pool
        const result = await pool.query(sql, this.prepareParameters(variables));
        // Format result based on query type
        const normalizedSQL = sql.toLowerCase().trim();

        if (normalizedSQL.includes("select")) {
          return { data: result.rows };
        } else if (
          normalizedSQL.includes("insert") &&
          normalizedSQL.includes("returning")
        ) {
          return { data: result.rows[0] || { success: true } };
        } else if (
          normalizedSQL.includes("update") &&
          normalizedSQL.includes("returning")
        ) {
          return { data: result.rows[0] || { updated: result.rowCount } };
        } else if (normalizedSQL.includes("delete")) {
          return { data: { deleted: result.rowCount } };
        } else {
          return { data: { rowCount: result.rowCount, success: true } };
        }
      } catch (error) {
        const dbError = error instanceof Error ?
          error :
          new Error(String(error));

        log.error("Database execution error", { error: dbError.message });
        throw new DatabaseExecutionError(`Database query failed: ${dbError.message}`, sql, dbError);
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

  private executeMockQuery(
    sql: string,
    _variables: Record<string, any>,
    context: Types.QueryContext
  ): { data: any; warnings?: string[]; } {
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
          sessionId: context.session.sessionId,
          timestamp: new Date().toISOString()
        }
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
        extensions: { code: "SYNTAX_ERROR" }
      });
    }

    // Check for valid EdgeQL query start
    const normalized = query.trim().toLowerCase();
    const validStartKeywords = [
      "select",
      "insert",
      "update",
      "delete",
      "with",
      "for",
      "describe",
      "configure"
    ];

    const startsWithValid = validStartKeywords.some(keyword => normalized.startsWith(keyword));

    if (!startsWithValid && normalized.length > 0) {
      errors.push({
        message: "Query must start with a valid EdgeQL statement",
        extensions: { code: "SYNTAX_ERROR" }
      });
    }

    return errors;
  }

  private check_balanced_braces(
    query: string
  ): { valid: boolean; position: number; } {
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
        name: "Ada Johnson",
        email: "ada@example.com",
        createdAt: "2024-01-15T10:30:00Z",
        active: true,
        age: 29
      },
      {
        id: "11234567-89ab-cdef-0123-456789abcdef",
        name: "Billie Smith",
        email: "billie@example.com",
        createdAt: "2024-01-20T09:15:00Z",
        active: true,
        age: 35
      }
    ];
  }

  private mockInsertResults(): any {
    return {
      id: `${Date.now()}-89ab-cdef-0123-456789abcdef`,
      name: "New User",
      email: "newuser@example.com",
      createdAt: new Date().toISOString(),
      active: true,
      age: null
    };
  }

  private mockUpdateResults(): any {
    return {
      id: "01234567-89ab-cdef-0123-456789abcdef",
      name: "Ada Johnson Updated",
      email: "ada.updated@example.com",
      createdAt: "2024-01-15T10:30:00Z",
      active: false,
      age: 30,
      updatedAt: new Date().toISOString()
    };
  }

  private mockDeleteResults(): any {
    return {
      id: "01234567-89ab-cdef-0123-456789abcdef",
      deleted: true,
      deleted_at: new Date().toISOString()
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

  async checkHealth(): Promise<HealthStatus> {
    if (!this.pool) {
      // No pool configured (dev/dry-run mode) — report healthy with no DB info
      return { status: "healthy" };
    }

    if (this.pool.isClosed()) {
      return {
        status: "unhealthy",
        database: { connected: false },
        pool: this.buildPoolStats()
      };
    }

    try {
      const start = Date.now();
      await this.pool.query("SELECT 1");
      const latencyMs = Date.now() - start;

      const poolStats = this.buildPoolStats();
      const status: HealthStatus["status"] = poolStats.waiters > 0 ?
        "degraded" :
        "healthy";

      return {
        status,
        database: { connected: true, latencyMs },
        pool: poolStats
      };
    } catch (_error) {
      return {
        status: "unhealthy",
        database: { connected: false },
        pool: this.buildPoolStats()
      };
    }
  }

  getPoolStats(): {
    total: number;
    idle: number;
    active: number;
    waiters: number;
  } | null {
    if (!this.pool) {
      return null;
    }
    return this.buildPoolStats();
  }

  private buildPoolStats(): {
    total: number;
    idle: number;
    active: number;
    waiters: number;
  } {
    const stats = this.pool!.getStatistics();
    return {
      total: stats.totalConnections,
      idle: stats.idleConnections,
      active: stats.activeConnections,
      waiters: stats.waitQueueSize
    };
  }

  /**
   * Resolve live PostgreSQL setting values for the given GUC names.
   * Backs the `/config` admin endpoint's current-value column.
   *
   * `current_setting(name)` yields the same human-formatted string `SHOW`
   * returns ("128MB", "30s", "on") rather than the raw block/unit count in
   * `pg_settings.setting`. Restricting the SELECT to `pg_settings` rows
   * guarantees `current_setting()` only ever sees names PostgreSQL knows,
   * so it cannot throw on an unrecognized GUC. Keys absent from
   * `pg_settings` simply don't appear in the result map (→ null upstream).
   */
  async getConfigValues(
    pgNames: string[]
  ): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    if (!this.pool || this.pool.isClosed() || pgNames.length === 0) {
      return out;
    }

    const result = await this.pool.query(
      "SELECT name, current_setting(name) AS value " +
        "FROM pg_settings WHERE name = ANY($1::text[])",
      [pgNames]
    );
    for (const row of result.rows) {
      out.set(row.name as string, (row.value ?? null) as string | null);
    }
    return out;
  }

  /**
   * Persist a new value for a single PostgreSQL GUC and report the value
   * that is now live. Backs the `/config` admin endpoint's edit affordance.
   *
   * `ALTER SYSTEM SET` is the only write that round-trips through
   * `getConfigValues()`: SESSION (`SET LOCAL`) is per-transaction and the
   * `disc_config` table (DATABASE/INSTANCE scope) is not applied to pooled
   * connections, so neither is visible on the next read. After writing we
   * `pg_reload_conf()` so SIGHUP-class settings take effect immediately,
   * then re-read. Restart-class settings (e.g. `shared_buffers`,
   * `max_connections`) report `pendingRestart: true` and keep their old
   * live value until the server restarts.
   *
   * `ALTER SYSTEM` is a utility statement and cannot be parameterized, so
   * the value is interpolated as a single-quoted literal with embedded
   * quotes doubled. `pgName` is whitelisted by the caller against the
   * registry; we re-validate its identifier shape here as defense in depth
   * since it is interpolated into DDL.
   */
  async setConfigValue(
    pgName: string,
    value: string
  ): Promise<{ value: string | null; pendingRestart: boolean; }> {
    if (!this.pool || this.pool.isClosed()) {
      throw new Error("No database connection configured");
    }
    if (!/^[a-z_][a-z0-9_]*$/.test(pgName)) {
      throw new Error(`Invalid configuration key: ${pgName}`);
    }

    const escaped = value.replace(/'/g, "''");
    await this.pool.query(`ALTER SYSTEM SET ${pgName} = '${escaped}'`);
    await this.pool.query("SELECT pg_reload_conf()");

    const result = await this.pool.query(
      "SELECT current_setting($1) AS value, " +
        "(SELECT pending_restart FROM pg_settings WHERE name = $1) " +
        "AS pending_restart",
      [pgName]
    );
    const row = result.rows[0] ?? {};
    return {
      value: (row.value ?? null) as string | null,
      pendingRestart: row.pending_restart === true
    };
  }

  /**
   * Set the database registry for multi-database pool routing.
   */
  setDatabaseRegistry(registry: DatabaseRegistry): void {
    this.options.databaseRegistry = registry;
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
