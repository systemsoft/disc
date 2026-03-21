/**
 * EdgeQL Protocol Handler with Real Compiler Integration
 */

import * as Types from "./types.ts";
import * as EdgeQL from "../edgeql/mod.ts";
import * as Compiler from "../compiler/compiler.ts";
import * as Context from "../compiler/context.ts";
import * as SQL from "../compiler/sql.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { DatabaseExecutionError, QueryTimeoutError } from "../lib/errors.ts";
import type { DatabaseRegistry } from "./database-registry.ts";
import { ExplainCache, ExplainCacheStats } from "../lib/explain-cache.ts";
import { getLogger } from "../lib/logger.ts";
import { authContextToAccessContext } from "./access-bridge.ts";

const log = getLogger("edgeql-protocol");
import {
  hashAccessContext,
  hashString,
  makeCompilationCacheKey,
  QueryCache,
} from "../lib/query-cache.ts";
import type { CacheStats } from "../lib/query-cache.ts";

export interface EdgeQLExecutionOptions {
  schema?: Context.Schema;
  enableExplain?: boolean;
  explainCacheTtlMs?: number;
  dryRun?: boolean;
  databaseUrl?: string;
  connectionPool?: ConnectionPool;
  enableAccessPolicies?: boolean;
  cacheMaxSize?: number;
  slowQueryThresholdMs?: number;
  requestTimeout?: number;
  databaseRegistry?: DatabaseRegistry;
}

interface CachedCompilation {
  sqlAST: SQL.SQLStatement;
  sqlString: string;
}

export class EdgeQLProtocolHandler implements Types.ProtocolHandler {
  private compiler: Compiler.EdgeQLCompiler;
  private schema: Context.Schema;
  private options: EdgeQLExecutionOptions;
  private pool?: ConnectionPool;
  private compilationCache: QueryCache<CachedCompilation>;
  private parseCache: QueryCache<EdgeQL.Query>;
  private explainCache?: ExplainCache;
  private metrics = {
    totalQueries: 0,
    totalParseMs: 0,
    totalCompileMs: 0,
    totalExecuteMs: 0,
    cacheHits: 0,
  };

  constructor(options: EdgeQLExecutionOptions = {}) {
    this.options = options;
    this.schema = options.schema || Context.createTestSchema();
    this.compiler = this.createCompiler(this.schema);

    const cacheSize = options.cacheMaxSize ?? 1000;
    this.compilationCache = new QueryCache<CachedCompilation>(cacheSize);
    this.parseCache = new QueryCache<EdgeQL.Query>(cacheSize);

    if (options.enableExplain) {
      this.explainCache = new ExplainCache({
        ttl_ms: options.explainCacheTtlMs,
      });
    }

    // Use provided pool or create new one if database URL provided
    if (options.connectionPool) {
      this.pool = options.connectionPool;
    } else if (options.databaseUrl && !options.dryRun) {
      this.pool = new ConnectionPool({
        connectionString: options.databaseUrl,
        minConnections: 2,
        maxConnections: 10,
      });
    }
  }

  private createCompiler(schema: Context.Schema): Compiler.EdgeQLCompiler {
    const compilerOptions: Compiler.CompilerOptions =
      this.options.enableAccessPolicies
        ? {
          enableAccessControl: true,
          accessConfig: {
            mode: "permissive",
            defaultAllow: true,
            enableRLS: true,
            enableAudit: false,
          },
        }
        : { enableAccessControl: false };

    const compiler = new Compiler.EdgeQLCompiler(schema, compilerOptions);

    // Register policies from schema TypeDefs
    if (this.options.enableAccessPolicies) {
      for (const typeDef of schema.types.values()) {
        if (typeDef.accessPolicies) {
          for (const policy of typeDef.accessPolicies) {
            compiler.registerAccessPolicy(policy);
          }
        }
      }
    }

    return compiler;
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

      const queryHash = hashString(request.query);
      let cacheHit = false;
      let sqlString: string;
      let sqlStatement: SQL.SQLStatement;
      let parsedAST: EdgeQL.Query | undefined;
      let parseMs = 0;
      let compileMs = 0;

      // Build compilation cache key (includes access context when policies enabled)
      let compilationKey = queryHash;

      if (this.options.enableAccessPolicies && context.auth) {
        const ctxHash = hashAccessContext(
          context.auth.userId,
          context.auth.roles?.[0],
        );
        compilationKey = makeCompilationCacheKey(queryHash, ctxHash);
      }

      // Check compilation cache first
      const cached = this.compilationCache.get(compilationKey);

      if (cached) {
        cacheHit = true;
        sqlString = cached.sqlString;
        sqlStatement = cached.sqlAST;
      } else {
        // Cache miss — parse and compile

        // Check parse cache
        const parseStart = Date.now();
        let ast = this.parseCache.get(queryHash);

        if (ast) {
          parseMs = Date.now() - parseStart;
        } else {
          const parseResult = this.parseEdgeQLQuery(request.query);
          parseMs = Date.now() - parseStart;

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

          ast = parseResult.ast;
          this.parseCache.set(queryHash, ast);
        }

        parsedAST = ast;

        // Set access context before compilation (affects generated SQL)
        if (this.options.enableAccessPolicies && context.auth) {
          this.compiler.setAccessContext(
            authContextToAccessContext(context.auth),
          );
        }

        // Compile EdgeQL to SQL
        const compileStart = Date.now();
        const compileResult = this.compiler.compile(ast);
        compileMs = Date.now() - compileStart;

        if (!compileResult.ok) {
          return {
            errors: [{
              message: compileResult.error.message,
              extensions: {
                code: "COMPILATION_ERROR",
                phase: "compilation",
              },
            }],
          };
        }

        sqlStatement = compileResult.value;
        sqlString = this.generateSQLString(sqlStatement);

        // Store in compilation cache
        this.compilationCache.set(compilationKey, {
          sqlAST: sqlStatement,
          sqlString,
        });
      }

      // Detect SET GLOBAL queries — store the global in the session and
      // execute the SET LOCAL on the connection, then return a success response.
      if (parsedAST && parsedAST.kind === "SetGlobalQuery") {
        const setGlobalAST = parsedAST as EdgeQL.SetGlobalQuery;
        const globalKey = `global::${
          setGlobalAST.module || "default"
        }::${setGlobalAST.name}`;
        context.session.variables[globalKey] = sqlString;

        const executeStart = Date.now();
        await this.executeSetGlobal(sqlString, context);
        const executeMs = Date.now() - executeStart;
        const durationMs = Date.now() - startTime;

        this.metrics.totalQueries++;
        this.metrics.totalParseMs += parseMs;
        this.metrics.totalCompileMs += compileMs;
        this.metrics.totalExecuteMs += executeMs;

        return {
          data: { success: true, global: setGlobalAST.name },
          extensions: {
            durationMs,
            parseMs,
            compileMs,
            executeMs,
            cacheHit,
          },
        };
      }

      // Execute query (or simulate execution)
      // Inject SET LOCAL statements for active session globals before the main query
      const globalsPrefix = this.buildGlobalsPrefix(context);
      const executeStart = Date.now();
      const result = await this.executeSQL(
        globalsPrefix + sqlString,
        request.variables || {},
        context,
      );
      const executeMs = Date.now() - executeStart;

      const durationMs = Date.now() - startTime;

      // Accumulate metrics
      this.metrics.totalQueries++;
      this.metrics.totalParseMs += parseMs;
      this.metrics.totalCompileMs += compileMs;
      this.metrics.totalExecuteMs += executeMs;

      if (cacheHit) {
        this.metrics.cacheHits++;
      }

      // Slow query logging
      const threshold = this.options.slowQueryThresholdMs ?? 1000;

      if (durationMs >= threshold) {
        const truncatedQuery = request.query.length > 200
          ? request.query.substring(0, 200) + "..."
          : request.query;
        const truncatedSQL = sqlString.length > 200
          ? sqlString.substring(0, 200) + "..."
          : sqlString;

        log.warn("Slow query", {
          durationMs,
          parseMs,
          compileMs,
          executeMs,
          cacheHit,
          query: truncatedQuery,
          sql: truncatedSQL,
        });
      }

      // Return successful response
      const response: Types.QueryResponse = {
        data: result.data,
        extensions: {
          durationMs,
          parseMs,
          compileMs,
          executeMs,
          cacheHit,
          queryHash: queryHash,
          sql: this.options.enableExplain ? sqlString : undefined,
          compilation_info: this.options.enableExplain
            ? {
              ast: parsedAST,
              sql_ast: sqlStatement,
            }
            : undefined,
          explain_plan: this.options.enableExplain
            ? await this.getExplainPlan(queryHash, sqlString)
            : undefined,
        },
      };

      if (result.warnings && result.warnings.length > 0) {
        response.errors = result.warnings.map((warning) => ({
          message: warning,
          extensions: { code: "WARNING" },
        }));
      }

      return response;
    } catch (error) {
      log.error("Query execution error", {
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof QueryTimeoutError) {
        return {
          errors: [{
            message: error.message,
            extensions: {
              code: "TIMEOUT",
              durationMs: Date.now() - startTime,
              timeoutMs: error.timeoutMs,
            },
          }],
        };
      }

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

  private parseEdgeQLQuery(
    query: string,
  ): { success: true; ast: EdgeQL.Query } | { success: false; error: string } {
    try {
      // Use the EdgeQL parser (which internally lexes the source)
      const parser = new EdgeQL.EdgeQLParser(query);
      const ast = parser.parse();

      return { success: true, ast };
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : "Unknown parsing error";
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  private generateSQLString(sqlAST: SQL.SQLStatement): string {
    // Convert the SQL AST to a string
    // This is a simplified implementation - a full version would handle proper formatting

    switch (sqlAST.kind) {
      case "SelectStatement":
        return this.generateSelectSQL(sqlAST);
      case "InsertStatement":
        return this.generateInsertSQL(sqlAST);
      case "UpdateStatement":
        return this.generateUpdateSQL(sqlAST);
      case "DeleteStatement":
        return this.generateDeleteSQL(sqlAST);
      case "RawSQLStatement":
        return (sqlAST as SQL.RawSQLStatement).sql;
      default:
        throw new Error(`Unsupported SQL statement type: ${sqlAST.kind}`);
    }
  }

  private generateSelectSQL(stmt: SQL.SelectStatement): string {
    let sql = "SELECT ";

    // SELECT clause
    if (stmt.select.distinct) {
      sql += "DISTINCT ";
    }

    const selectItems = stmt.select.columns.map((item) =>
      this.generateSelectItem(item)
    ).join(", ");
    sql += selectItems;

    // FROM clause
    if (stmt.from && stmt.from.tables.length > 0) {
      sql += " FROM ";
      const tables = stmt.from.tables.map((table) =>
        this.generateTableReference(table)
      ).join(", ");
      sql += tables;
    }

    // WHERE clause
    if (stmt.where) {
      sql += " WHERE " + this.generateExpression(stmt.where.condition);
    }

    // ORDER BY clause
    if (stmt.orderBy) {
      sql += " ORDER BY ";
      const orderItems = stmt.orderBy.items.map((item) =>
        `${this.generateExpression(item.expression)} ${item.direction || "ASC"}`
      ).join(", ");
      sql += orderItems;
    }

    // LIMIT clause
    if (stmt.limit) {
      sql += " LIMIT " + this.generateExpression(stmt.limit.count);
    }

    // OFFSET clause
    if (stmt.offset) {
      sql += " OFFSET " + this.generateExpression(stmt.offset.count);
    }

    return sql;
  }

  private generateInsertSQL(stmt: SQL.InsertStatement): string {
    let sql = `INSERT INTO ${stmt.table}`;

    if (stmt.columns.length > 0) {
      sql += ` (${stmt.columns.join(", ")})`;
    }

    if (stmt.values.length > 0) {
      sql += " VALUES ";
      const valueRows = stmt.values.map((row) =>
        `(${row.map((expr) => this.generateExpression(expr)).join(", ")})`
      ).join(", ");
      sql += valueRows;
    }

    if (stmt.onConflict) {
      sql += " ON CONFLICT";
      if (stmt.onConflict.target) {
        sql += ` (${stmt.onConflict.target.join(", ")})`;
      }
      sql += ` ${stmt.onConflict.action}`;
    }

    if (stmt.returning) {
      sql += " RETURNING ";
      const returningItems = stmt.returning.map((item) =>
        this.generateSelectItem(item)
      ).join(", ");
      sql += returningItems;
    }

    return sql;
  }

  private generateUpdateSQL(stmt: SQL.UpdateStatement): string {
    let sql = `UPDATE ${stmt.table} SET `;

    const setClauses = stmt.set.map((setClause) =>
      `${setClause.column} = ${this.generateExpression(setClause.value)}`
    ).join(", ");
    sql += setClauses;

    if (stmt.where) {
      sql += " WHERE " + this.generateExpression(stmt.where.condition);
    }

    if (stmt.returning) {
      sql += " RETURNING ";
      const returningItems = stmt.returning.map((item) =>
        this.generateSelectItem(item)
      ).join(", ");
      sql += returningItems;
    }

    return sql;
  }

  private generateDeleteSQL(stmt: SQL.DeleteStatement): string {
    let sql = `DELETE FROM ${stmt.table}`;

    if (stmt.where) {
      sql += " WHERE " + this.generateExpression(stmt.where.condition);
    }

    if (stmt.returning) {
      sql += " RETURNING ";
      const returningItems = stmt.returning.map((item) =>
        this.generateSelectItem(item)
      ).join(", ");
      sql += returningItems;
    }

    return sql;
  }

  private generateSelectItem(item: SQL.SelectItem): string {
    let sql = this.generateExpression(item.expression);

    if (item.alias) {
      sql += ` AS ${item.alias}`;
    }

    return sql;
  }

  private generateTableReference(table: SQL.TableReference): string {
    let sql = table.name;

    if (table.alias) {
      sql += ` AS ${table.alias}`;
    }

    return sql;
  }

  private generateExpression(expr: SQL.SQLExpression): string {
    switch (expr.kind) {
      case "LiteralExpression":
        return this.generateLiteral(expr);
      case "ColumnReference":
        return expr.table ? `${expr.table}.${expr.column}` : expr.column;
      case "BinaryExpression":
        return `(${this.generateExpression(expr.left)} ${expr.operator} ${
          this.generateExpression(expr.right)
        })`;
      case "UnaryExpression":
        return `${expr.operator} ${this.generateExpression(expr.operand)}`;
      case "FunctionCall": {
        const args = expr.args.map((arg) => this.generateExpression(arg)).join(
          ", ",
        );
        return `${expr.name}(${args})`;
      }
      case "JsonBuildObject": {
        const fields = expr.fields.map((field) =>
          `'${field.key}', ${this.generateExpression(field.value)}`
        ).join(", ");
        return `jsonb_build_object(${fields})`;
      }
      case "ParameterReference":
        return `$${expr.index}`;
      case "RawSQLExpression":
        // Raw SQL is injected as-is. Used by DESCRIBE TYPE/SCHEMA which
        // embed compile-time-resolved JSON as a SQL string literal
        // (e.g., SELECT '<json>'::jsonb). No special handling needed —
        // the result passes through PG normally.
        return (expr as SQL.RawSQLExpression).sql;
      default:
        return "NULL";
    }
  }

  private generateLiteral(literal: SQL.LiteralExpression): string {
    switch (literal.type) {
      case "string":
        return `'${String(literal.value).replace(/'/g, "''")}'`;
      case "number":
        return String(literal.value);
      case "boolean":
        return literal.value ? "TRUE" : "FALSE";
      case "null":
        return "NULL";
      default:
        return "NULL";
    }
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
      if (entry) {
        return entry.pool;
      }
      // If the database name is not found in the registry, fall through
      // to the default pool for backward compatibility.
    }
    return this.pool;
  }

  private async executeSQL(
    sql: string,
    variables: Record<string, any>,
    context: Types.QueryContext,
  ): Promise<{ data: any; warnings?: string[] }> {
    log.info("Executing SQL", {
      sessionId: context.session.sessionId,
      sql,
    });
    log.info("Query variables", {
      sessionId: context.session.sessionId,
      variables: JSON.stringify(variables),
    });

    if (this.options.dryRun) {
      return {
        data: {
          sql,
          variables,
          dryRun: true,
        },
        warnings: ["Query executed in dry-run mode"],
      };
    }

    // Resolve the correct pool (registry-aware or default)
    const pool = this.resolvePool(context);

    // Use connection pool if available
    if (pool) {
      try {
        const params = this.prepareParameters(variables);
        const timeoutMs = this.options.requestTimeout ?? 0;

        const result = timeoutMs > 0
          ? await pool.queryWithTimeout(sql, params, timeoutMs)
          : await pool.query(sql, params);

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
        // Let QueryTimeoutError propagate directly
        if (error instanceof QueryTimeoutError) {
          throw error;
        }

        const dbError = error instanceof Error
          ? error
          : new Error(String(error));
        log.error("Database execution error", { error: dbError.message });
        throw new DatabaseExecutionError(
          `Database query failed: ${dbError.message}`,
          sql,
          dbError,
        );
      }
    }

    // Fall back to mock implementation if no database
    return this.executeMockSQL(sql, variables, context);
  }

  /**
   * Execute a SET GLOBAL statement (compiled to set_config() SQL).
   * Runs directly against the connection pool or as a dry-run.
   */
  private async executeSetGlobal(
    sql: string,
    context: Types.QueryContext,
  ): Promise<void> {
    log.info("Executing SET GLOBAL", {
      sessionId: context.session.sessionId,
      sql,
    });

    if (this.options.dryRun) {
      return;
    }

    const pool = this.resolvePool(context);
    if (pool) {
      await pool.query(sql);
    }
  }

  /**
   * Build a prefix of set_config() calls for all active session globals.
   * These are injected before regular query execution to ensure globals
   * are available within the transaction scope.
   */
  private buildGlobalsPrefix(context: Types.QueryContext): string {
    const parts: string[] = [];
    for (const [key, sql] of Object.entries(context.session.variables)) {
      if (key.startsWith("global::") && typeof sql === "string") {
        parts.push(sql + "; ");
      }
    }
    return parts.join("");
  }

  private prepareParameters(variables: Record<string, any>): any[] {
    // Convert variables object to array for PostgreSQL parameterized queries
    // This is simplified — a full implementation would track parameter positions
    return Object.values(variables);
  }

  private executeMockSQL(
    sql: string,
    _variables: Record<string, any>,
    context: Types.QueryContext,
  ): { data: any; warnings?: string[] } {
    // Mock implementation for fallback when no pool is available
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
          timestamp: new Date().toISOString(),
        },
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
      "configure",
      "set",
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

  private mockUserResults(): any {
    return [
      {
        id: "01234567-89ab-cdef-0123-456789abcdef",
        name: "Ada Johnson",
        email: "ada@example.com",
        createdAt: "2024-01-15T10:30:00Z",
        active: true,
        age: 29,
      },
      {
        id: "11234567-89ab-cdef-0123-456789abcdef",
        name: "Billie Smith",
        email: "billie@example.com",
        createdAt: "2024-01-20T09:15:00Z",
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
      createdAt: new Date().toISOString(),
      active: true,
      age: null,
    };
  }

  private mockUpdateResults(): any {
    return {
      id: "01234567-89ab-cdef-0123-456789abcdef",
      name: "Ada Johnson Updated",
      email: "ada.updated@example.com",
      createdAt: "2024-01-15T10:30:00Z",
      active: true,
      age: 30,
      updatedAt: new Date().toISOString(),
    };
  }

  private mockDeleteResults(): any {
    return {
      id: "01234567-89ab-cdef-0123-456789abcdef",
      deleted: true,
      deleted_at: new Date().toISOString(),
    };
  }

  private async getExplainPlan(
    queryHash: string,
    sql: string,
  ): Promise<unknown | undefined> {
    if (!this.pool) return undefined;

    // Check cache first
    if (this.explainCache) {
      const cached = this.explainCache.get(queryHash);
      if (cached) return cached;
    }

    try {
      const result = await this.pool.query(`EXPLAIN (FORMAT JSON) ${sql}`);
      const plan = result.rows[0];
      if (this.explainCache) {
        this.explainCache.set(queryHash, plan);
      }
      return plan;
    } catch {
      return undefined;
    }
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

  /**
   * Set the database registry for multi-database pool routing.
   * When set, executeSQL resolves the pool from the registry based on
   * the session's database name.
   */
  setDatabaseRegistry(registry: DatabaseRegistry): void {
    this.options.databaseRegistry = registry;
  }

  // Schema management methods
  updateSchema(schema: Context.Schema): void {
    this.schema = schema;
    this.compiler = this.createCompiler(schema);
    this.compilationCache.clear();
    this.parseCache.clear();
  }

  getSchema(): Context.Schema {
    return this.schema;
  }

  getCacheStats(): { compilation: CacheStats; parse: CacheStats } {
    return {
      compilation: this.compilationCache.stats(),
      parse: this.parseCache.stats(),
    };
  }

  getMetrics(): {
    avgCompileMs: number;
    avgExecuteMs: number;
    avgParseMs: number;
    cacheHitRate: number;
    totalQueries: number;
  } {
    const q = this.metrics.totalQueries || 1; // avoid divide-by-zero
    return {
      avgCompileMs: this.metrics.totalCompileMs / q,
      avgExecuteMs: this.metrics.totalExecuteMs / q,
      avgParseMs: this.metrics.totalParseMs / q,
      cacheHitRate: this.metrics.cacheHits / q,
      totalQueries: this.metrics.totalQueries,
    };
  }

  getStats(): {
    cache?: Types.ServerStats["cache"];
    explain_cache?: ExplainCacheStats;
    queryMetrics?: Types.ServerStats["queryMetrics"];
  } {
    const compilationStats = this.compilationCache.stats();
    const parseStats = this.parseCache.stats();
    const metrics = this.getMetrics();

    const cacheHitRate = (s: CacheStats) => {
      const total = s.hits + s.misses;
      return total > 0 ? s.hits / total : 0;
    };

    return {
      cache: {
        compilation: {
          evictions: compilationStats.evictions,
          hitRate: cacheHitRate(compilationStats),
          hits: compilationStats.hits,
          misses: compilationStats.misses,
          size: compilationStats.size,
        },
        parse: {
          evictions: parseStats.evictions,
          hitRate: cacheHitRate(parseStats),
          hits: parseStats.hits,
          misses: parseStats.misses,
          size: parseStats.size,
        },
      },
      explain_cache: this.explainCache?.stats(),
      queryMetrics: metrics,
    };
  }

  async checkHealth(): Promise<Types.HealthStatus> {
    if (!this.pool) {
      // No pool configured (dev/dry-run mode) — report healthy with no DB info
      return { status: "healthy" };
    }

    if (this.pool.isClosed()) {
      return {
        status: "unhealthy",
        database: { connected: false },
        pool: this.buildPoolStats(),
      };
    }

    try {
      const start = Date.now();
      await this.pool.query("SELECT 1");
      const latencyMs = Date.now() - start;

      const poolStats = this.buildPoolStats();
      const status: Types.HealthStatus["status"] = poolStats.waiters > 0
        ? "degraded"
        : "healthy";

      return {
        status,
        database: { connected: true, latencyMs },
        pool: poolStats,
      };
    } catch (_error) {
      return {
        status: "unhealthy",
        database: { connected: false },
        pool: this.buildPoolStats(),
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
      waiters: stats.waitQueueSize,
    };
  }

  getCompilerInfo(): { version: string; features: string[] } {
    return {
      version: "0.1.0",
      features: [
        "EdgeQL SELECT queries",
        "EdgeQL INSERT/UPDATE/DELETE operations",
        "JSON object generation",
        "Basic expression compilation",
        "Query validation and error reporting",
      ],
    };
  }
}
