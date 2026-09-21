/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * EdgeQL Protocol Handler with Real Compiler Integration
 */

import { SQLCodeGenerator } from "../compiler/codegen.ts";
import * as Compiler from "../compiler/compiler.ts";
import * as Context from "../compiler/context.ts";
import * as SQL from "../compiler/sql.ts";
import * as EdgeQL from "../edgeql/mod.ts";
import { isWriteQuery } from "../edgeql/query-capabilities.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { DatabaseExecutionError, QueryError, QueryTimeoutError, ValidationError } from "../lib/errors.ts";
import { ExplainCache, ExplainCacheStats } from "../lib/explain-cache.ts";
import { getLogger } from "../lib/logger.ts";
import { DISC_VERSION } from "../lib/version.ts";
import { authContextToAccessContext } from "./access-bridge.ts";
import type { DatabaseRegistry } from "./database-registry.ts";
import { normalizeRows } from "./row-normalizer.ts";
import * as Types from "./types.ts";

const log = getLogger("edgeql-protocol");
import {
  hashAccessContext,
  hashString,
  makeCompilationCacheKey,
  QueryCache
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
  /**
   * When true, reject queries that would write (INSERT/UPDATE/DELETE/
   * CONFIGURE DATABASE|INSTANCE|SYSTEM) with a `READ_ONLY_MODE` error.
   * Read queries proceed normally. (gh/geldata#5524, ports
   * geldata/gel#5543)
   */
  readOnly?: boolean;
}

interface CachedCompilation {
  /*** Variable names in bind order (`parameterNames[i]` binds to `$${i + 1}`). Kept with the SQL
       because a cache hit has no query AST to derive it from, and variables bind by name. ***/
  parameterNames: string[];
  /*** What the response is made of (row set or bare-mutation shape, and the mutated type a
       `RETURNING *` row maps through). From the query AST, so it is kept for cache hits too. ***/
  resultInfo: Compiler.ResultInfo;
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
    cacheHits: 0
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
        ttl_ms: options.explainCacheTtlMs
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
        // gh/geldata#9034: tag pool connections so the migrate-CLI
        // preflight can spot a running server attached to the same DB.
        applicationName: "disc-server"
      });
    }
  }

  private createCompiler(schema: Context.Schema): Compiler.EdgeQLCompiler {
    const compilerOptions: Compiler.CompilerOptions = this.options.enableAccessPolicies ?
      {
        enableAccessControl: true,
        accessConfig: {
          mode: "permissive",
          defaultAllow: true,
          enableRLS: true,
          enableAudit: false
        }
      } :
      { enableAccessControl: false };

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

      const queryHash = hashString(request.query);
      let cacheHit = false;
      let sqlString: string;
      let sqlStatement: SQL.SQLStatement;
      let parameterNames: string[];
      let resultInfo: Compiler.ResultInfo;
      let parsedAST: EdgeQL.Query | undefined;
      let parseMs = 0;
      let compileMs = 0;

      // Build compilation cache key (includes access context when policies enabled)
      let compilationKey = queryHash;

      // Per-request override (gh/geldata#6358): admins can opt out of
      // policy injection via `X-Disc-Apply-Access-Policies: false`.
      // The HTTP layer enforces the role gate; we just thread the flag
      // through. The cache key embeds the bypass flag so a bypassed
      // result can't be served to a non-bypassed call (or vice versa).
      const policiesActive = this.options.enableAccessPolicies === true;
      const bypass = policiesActive && context.bypassAccessPolicies === true;

      if (policiesActive && context.auth) {
        const ctxHash = hashAccessContext(
          context.auth.userId,
          context.auth.roles?.[0]
        );
        // Embed both bypass flag and the disabled-policies set in the
        // cache key (gh/geldata#6358 + #6432 slice 3). A disabled-
        // policies query produces different SQL than a regular query,
        // so they must not share a cache slot.
        let suffix = ctxHash;
        if (bypass) {
          suffix += "|bypass";
        }
        if (context.disabledPolicies && context.disabledPolicies.size > 0) {
          // Sort for stable hashing — Set iteration order matches insertion,
          // not the header's textual order.
          const disabled = [...context.disabledPolicies].sort().join(",");
          suffix += `|disabled=${disabled}`;
        }
        compilationKey = makeCompilationCacheKey(queryHash, suffix);
      }

      // Check compilation cache first
      const cached = this.compilationCache.get(compilationKey);

      if (cached) {
        cacheHit = true;
        parameterNames = cached.parameterNames;
        resultInfo = cached.resultInfo;
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
                  phase: "parsing"
                }
              }]
            };
          }

          ast = parseResult.ast;
          this.parseCache.set(queryHash, ast);
        }

        parsedAST = ast;

        // Read-only-mode gate. Refuse writes after parse but before
        // compile + execute so the rejection is cheap and uniform
        // across SimpleEdgeQL and the full handler.
        // (gh/geldata#5524, ports geldata/gel#5543)
        if (this.options.readOnly && isWriteQuery(ast)) {
          return {
            errors: [{
              message: "the server is currently in read-only mode; this query would write to the database",
              extensions: {
                code: "READ_ONLY_MODE",
                queryKind: ast.kind
              }
            }]
          };
        }

        // Set access context before compilation (affects generated SQL).
        // When `context.bypassAccessPolicies` is set, the AccessContext
        // carries `bypass: true` so the compiler short-circuits
        // `applyAccessControl` and emits unfiltered SQL
        // (gh/geldata#6358). When `context.disabledPolicies` is set, the
        // AccessContext threads it to the evaluator which silently
        // skips matching policies (gh/geldata#6432 slice 3).
        if (policiesActive && context.auth) {
          const accessCtx = authContextToAccessContext(context.auth);
          if (bypass) {
            accessCtx.bypass = true;
          }
          if (context.disabledPolicies && context.disabledPolicies.size > 0) {
            accessCtx.disabledPolicies = context.disabledPolicies;
          }
          this.compiler.setAccessContext(accessCtx);
        }

        // Compile EdgeQL to SQL
        // The parameter map is built here and handed to the compiler, so the
        // handler knows which variable each `$n` stands for (see
        // prepareParameters) without reaching into the compiler.
        const compileStart = Date.now();
        const parameterIndex = Compiler.buildParameterIndex(ast);
        const compileResult = this.compiler.compile(ast, {
          parameterMap: parameterIndex
        });
        compileMs = Date.now() - compileStart;

        if (!compileResult.ok) {
          return {
            errors: [{
              message: compileResult.error.message,
              extensions: {
                code: "COMPILATION_ERROR",
                phase: "compilation"
              }
            }]
          };
        }

        sqlStatement = compileResult.value;
        sqlString = this.generateSQLString(sqlStatement);
        parameterNames = Compiler.parameterBindOrder(ast, parameterIndex);
        resultInfo = Compiler.describeResult(ast);

        // Store in compilation cache
        this.compilationCache.set(compilationKey, {
          parameterNames,
          resultInfo,
          sqlAST: sqlStatement,
          sqlString
        });
      }

      // Detect SET GLOBAL queries — store the global in the session and
      // execute the SET LOCAL on the connection, then return a success response.
      if (parsedAST && parsedAST.kind === "SetGlobalQuery") {
        const setGlobalAST = parsedAST as EdgeQL.SetGlobalQuery;
        const globalKey = `global::${setGlobalAST.module || "default"}::${setGlobalAST.name}`;
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
            cacheHit
          }
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
        parameterNames,
        resultInfo.kind,
        sqlStatement
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
        const truncatedQuery = request.query.length > 200 ?
          request.query.substring(0, 200) + "..." :
          request.query;
        const truncatedSQL = sqlString.length > 200 ?
          sqlString.substring(0, 200) + "..." :
          sqlString;

        log.warn("Slow query", {
          durationMs,
          parseMs,
          compileMs,
          executeMs,
          cacheHit,
          query: truncatedQuery,
          sql: truncatedSQL
        });
      }

      // Mutation responses come back from `RETURNING *` as raw PG rows
      // with snake_case column names. Map them back through the schema's
      // PropertyDef to give callers the camelCase property shape they
      // see for SELECTs — otherwise `row.created_at` vs `row.createdAt`
      // varies by query type, which is hostile to clients. The mutated type
      // comes from the cache entry, so a repeated call maps like the first.
      const mappedData = this.mapMutationResponseToSchema(
        result.data,
        resultInfo.mutatedType
      );

      // Return successful response
      const response: Types.QueryResponse = {
        data: mappedData,
        extensions: {
          durationMs,
          parseMs,
          compileMs,
          executeMs,
          cacheHit,
          queryHash: queryHash,
          sql: this.options.enableExplain ? sqlString : undefined,
          compilation_info: this.options.enableExplain ?
            {
              ast: parsedAST,
              sql_ast: sqlStatement
            } :
            undefined,
          explain_plan: this.options.enableExplain ?
            await this.getExplainPlan(queryHash, sqlString) :
            undefined
        }
      };

      if (result.warnings && result.warnings.length > 0) {
        response.errors = result.warnings.map(warning => ({
          message: warning,
          extensions: { code: "WARNING" }
        }));
      }

      return response;
    } catch (error) {
      // The request's variables do not match the query's parameters: the
      // caller's mistake, reported as such (HTTP 400) and never executed.
      if (error instanceof ValidationError) {
        return {
          errors: [{
            message: error.message,
            extensions: { code: "VALIDATION_ERROR" }
          }]
        };
      }

      log.error("Query execution error", {
        error: error instanceof Error ? error.message : String(error)
      });

      if (error instanceof QueryTimeoutError) {
        return {
          errors: [{
            message: error.message,
            extensions: {
              code: "TIMEOUT",
              durationMs: Date.now() - startTime,
              timeoutMs: error.timeoutMs
            }
          }]
        };
      }

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

  private parseEdgeQLQuery(
    query: string
  ): { success: true; ast: EdgeQL.Query; } | { success: false; error: string; } {
    try {
      // Use the EdgeQL parser (which internally lexes the source)
      const parser = new EdgeQL.EdgeQLParser(query);
      const ast = parser.parse();

      return { success: true, ast };
    } catch (error) {
      const errorMessage = error instanceof Error ?
        error.message :
        "Unknown parsing error";
      return {
        success: false,
        error: errorMessage
      };
    }
  }

  /**
   * Convert a SQL AST to a PG-ready string by delegating to the shared
   * SQLCodeGenerator. The handler used to maintain its own hand-rolled
   * generator that silently returned "NULL" for any expression kind it
   * didn't enumerate (CastExpression, CaseExpression, AggregateExpression,
   * JsonbAccessExpression, etc.) — every one of those was a latent bug
   * waiting to surface as `WHERE id = NULL`. Delegating to the canonical
   * generator removes the entire class.
   */
  private generateSQLString(sqlAST: SQL.SQLStatement): string {
    return new SQLCodeGenerator().generate(sqlAST);
  }

  /**
   * Resolve the connection pool for the current query context.
   * If a DatabaseRegistry is available and the session specifies a database,
   * look up the pool from the registry. Otherwise, fall back to the handler's
   * own pool.
   */
  /**
   * Rename snake_case PG column keys back to camelCase property names
   * for INSERT/UPDATE responses. SELECT shapes are already camelCase
   * because the compiler emits `jsonb_build_object('camelCase', col)`
   * pairs; mutations bypass that and return raw `RETURNING *` rows.
   *
   * `mutatedType` is `ResultInfo.mutatedType`: set for a bare insert/update
   * only. Returns the input unchanged without it, when the type isn't in the
   * schema, or when data isn't an object (e.g. `{ deleted: 1 }` or
   * `{ success: true }` placeholders).
   */
  private mapMutationResponseToSchema(
    data: any,
    mutatedType: string | undefined
  ): any {
    if (!mutatedType) {
      return data;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return data;
    }

    const typeDef = Context.resolveTypeName(
      { schema: this.schema } as any,
      mutatedType
    );
    if (!typeDef) {
      return data;
    }

    const colToProp = new Map<string, string>();
    for (const [propName, prop] of typeDef.properties) {
      if (prop.columnName) {
        colToProp.set(prop.columnName, propName);
      }
    }
    for (const [linkName, link] of typeDef.links) {
      if (link.columnName) {
        colToProp.set(link.columnName, linkName);
      }
    }

    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(data)) {
      out[colToProp.get(k) ?? k] = v;
    }
    return out;
  }

  /**
   * Unwrap rows whose only column is the literal SQL function name
   * `jsonb_build_object` — an artifact of how the EdgeQL→SQL compiler
   * projects shape expressions. Rows that have any other shape are
   * returned unchanged.
   */
  private unwrapJsonbRows(rows: any[]): any[] {
    if (!Array.isArray(rows) || rows.length === 0) {
      return rows;
    }
    return rows.map(row => {
      if (
        row && typeof row === "object" && !Array.isArray(row) &&
        Object.keys(row).length === 1 &&
        Object.prototype.hasOwnProperty.call(row, "jsonb_build_object")
      ) {
        return row.jsonb_build_object;
      }
      return row;
    });
  }

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
    parameterNames: string[],
    resultKind: Compiler.ResultInfo["kind"],
    sqlStatement?: SQL.SQLStatement
  ): Promise<{ data: any; warnings?: string[]; }> {
    log.debug("Executing SQL", {
      sessionId: context.session.sessionId,
      sql
    });

    log.debug("Query variables", {
      sessionId: context.session.sessionId,
      variables: JSON.stringify(variables)
    });

    if (this.options.dryRun) {
      return {
        data: {
          sql,
          variables,
          dryRun: true
        },
        warnings: ["Query executed in dry-run mode"]
      };
    }

    // An explicit transaction pins this query to the connection holding its
    // open PostgreSQL transaction; anything else resolves a pool (registry-
    // aware or default). A pooled connection is a different PG session and
    // would not see the transaction's uncommitted state.
    const transactionConnection = context.transactionConnection;
    const pool = transactionConnection ? undefined : this.resolvePool(context);

    // Use the transaction's connection, or the pool if one is available
    if (transactionConnection || pool) {
      // Outside the try: a variables mismatch is a ValidationError for the
      // caller, not a database failure.
      const params = this.prepareParameters(variables, parameterNames, sqlStatement);

      try {
        const timeoutMs = this.options.requestTimeout ?? 0;

        // `queryWithTimeout` is pool-only; a transactional query relies on
        // the HTTP-level timeout in `handle_query` instead.
        let result;
        if (transactionConnection) {
          result = await transactionConnection.query(sql, params);
        } else if (timeoutMs > 0) {
          result = await pool!.queryWithTimeout(sql, params, timeoutMs);
        } else {
          result = await pool!.query(sql, params);
        }

        // Driver values with no JSON form (int64 → bigint) get their wire
        // representation here, where rows become response data, so every
        // response shape below — and every cache hit — is covered.
        const rows = normalizeRows(result.rows);

        // A select answers with its row set as-is, `[]` when empty — also when
        // it selects from a mutation (`select (update …) { id }`, the
        // with-form). Decided by the compiler from the query, not from the SQL
        // text: those statements and the multi-link writes below share the
        // `WITH … INSERT/UPDATE … SELECT` shape.
        //
        // The compiler emits `SELECT jsonb_build_object(...)` for shape
        // expressions, which surfaces as rows of `{jsonb_build_object: {...}}`.
        // Unwrap that single-column wrapper so callers see clean object
        // shapes — UI/SDK consumers expect `row.id` to work directly.
        if (resultKind === "rows") {
          return { data: this.unwrapJsonbRows(rows) };
        }

        // Everything else keeps the bare-mutation response shapes, still keyed
        // on the SQL text.
        const normalizedSQL = sql.toLowerCase().trim();

        // Junction-backed multi-link writes compile to a data-modifying CTE:
        // `WITH ins/upd AS (INSERT|UPDATE ...), link_n AS (...) SELECT * FROM ...`.
        // Such SQL begins with `with` and contains a top-level `select`, but it
        // is still a mutation — the leading INSERT/UPDATE drives a single row
        // back through the final `SELECT *`. Detect it first so the response
        // keeps the single-object mutation shape (not the SELECT array shape).
        const isCteWrite = normalizedSQL.startsWith("with") &&
          (normalizedSQL.includes("insert into") ||
            normalizedSQL.includes("update "));

        if (isCteWrite) {
          return { data: rows[0] || { success: true } };
        } else if (normalizedSQL.includes("select")) {
          // Non-select statements whose SQL selects (for/group queries, an
          // insert with a link subselect): the row set, unwrapped as above.
          return { data: this.unwrapJsonbRows(rows) };
        } else if (
          normalizedSQL.includes("insert") &&
          normalizedSQL.includes("returning")
        ) {
          return { data: rows[0] || { success: true } };
        } else if (
          normalizedSQL.includes("update") &&
          normalizedSQL.includes("returning")
        ) {
          return { data: rows[0] || { updated: result.rowCount } };
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

        const dbError = error instanceof Error ?
          error :
          new Error(String(error));
        log.error("Database execution error", { error: dbError.message });
        throw new DatabaseExecutionError(
          `Database query failed: ${dbError.message}`,
          sql,
          dbError
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
    context: Types.QueryContext
  ): Promise<void> {
    log.debug("Executing SET GLOBAL", {
      sessionId: context.session.sessionId,
      sql
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

  /**
   * Build PostgreSQL's positional bind array from the request's variables, BY
   * NAME: `parameterNames[i]` is the variable `$${i + 1}` stands for. The
   * client's key order means nothing — slots follow the compiler's AST walk,
   * which is not even the textual order of the parameters.
   *
   * Throws a ValidationError naming the variable when one is missing, or when
   * the request carries one the query does not use (a typo would otherwise
   * surface as a PostgreSQL bind-count error, or not at all).
   */
  private prepareParameters(
    variables: Record<string, any>,
    parameterNames: string[],
    sqlStatement?: SQL.SQLStatement
  ): any[] {
    const expected = new Set(parameterNames);

    for (const name of expected) {
      if (name !== undefined && !Object.hasOwn(variables, name)) {
        throw new ValidationError(`Missing variable: the query uses $${name}, but no value was provided for it`);
      }
    }
    for (const name of Object.keys(variables)) {
      if (!expected.has(name)) {
        throw new ValidationError(`Unknown variable: $${name} was provided, but the query has no such parameter`);
      }
    }

    // Parameters cast to `jsonb` (tuples, array-of-tuple, json) must be bound as
    // JSON text. deno-postgres encodes a JS array as a PG array literal (`{a,b}`),
    // which a jsonb cast rejects with "invalid input syntax for type json"; an
    // explicit JSON.stringify makes every jsonb param bind uniformly. Native PG
    // arrays (`text[]`, etc.) and scalars are left for the driver to encode.
    const typeMap = sqlStatement ?
      Compiler.buildParameterTypeMap(sqlStatement) :
      new Map<number, string>();

    // Array.from, not map: a gap in numeric parameters (`$1` without `$0`)
    // leaves a hole in parameterNames that must still occupy its slot.
    return Array.from(parameterNames, (name, i) => {
      const value = name === undefined ? undefined : variables[name];
      // `parameterNames[i]` is the parameter at 1-indexed position i + 1.
      if (typeMap.get(i + 1) === "jsonb" && value !== undefined) {
        return JSON.stringify(value);
      }
      return value;
    });
  }

  private executeMockSQL(
    sql: string,
    _variables: Record<string, any>,
    context: Types.QueryContext
  ): { data: any; warnings?: string[]; } {
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
      "configure",
      "set"
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
      active: true,
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

  private async getExplainPlan(
    queryHash: string,
    sql: string
  ): Promise<unknown | undefined> {
    if (!this.pool) {
      return undefined;
    }

    // Check cache first
    if (this.explainCache) {
      const cached = this.explainCache.get(queryHash);
      if (cached) {
        return cached;
      }
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

  /**
   * Direct entry point for the Gel binary wire-protocol layer.
   *
   * Skips the QueryRequest/QueryResponse/AuthContext shape (which is a
   * poor fit for the binary path) and runs parse → compile → execute
   * against the same compiler and pool the HTTP handler uses. The
   * returned rows are already in the same shape executeSQL produces:
   *   - SELECT  → unwrapped jsonb_build_object objects, one per row
   *   - INSERT  → single RETURNING row mapped back to camelCase
   *   - UPDATE  → single RETURNING row mapped back to camelCase
   *   - DELETE  → empty rows; status reports the deleted count
   *
   * `args` is keyed by the bare parameter name (no leading `$`). The
   * compiler's parameterIndex (built from the same AST) decides the
   * positional ordering for the bind values, so we marshal `args` into
   * an array using that same map. Without this the historical
   * `Object.values(args)` ordering was incidental and could collide.
   */
  async executeBinaryQuery(
    commandText: string,
    args: Record<string, unknown>
  ): Promise<{ rows: Record<string, unknown>[]; status: string; }> {
    const parser = new EdgeQL.EdgeQLParser(commandText);
    const ast = parser.parse();

    // Same read-only gate as handleRequest (gh/geldata#5524).
    if (this.options.readOnly && isWriteQuery(ast)) {
      throw new QueryError("the server is currently in read-only mode; this query would write to the database");
    }

    const parameterIndex = Compiler.buildParameterIndex(ast);

    // The compiler is shared with the HTTP path and keeps the access context
    // of whoever compiled last — possibly a bypassing admin. This path has no
    // Disc user of its own (the binary listener authenticates a connection),
    // so it compiles as an anonymous caller, explicitly.
    this.compiler.setAccessContext({});

    const compileResult = this.compiler.compile(ast, {
      parameterMap: parameterIndex
    });
    if (!compileResult.ok) {
      throw new DatabaseExecutionError(
        compileResult.error.message,
        commandText,
        compileResult.error
      );
    }
    const sql = this.generateSQLString(compileResult.value);

    const positionalValues: unknown[] = new Array(parameterIndex.size);
    for (const [name, idx] of parameterIndex) {
      positionalValues[idx - 1] = args[name];
    }

    const status = this.detectStatusFromAst(ast);

    if (!this.pool) {
      // Mirrors executeSQL's "no pool" branch — rare in real flow but
      // present for tests/dry-run.
      return { rows: [], status };
    }

    const result = await this.pool.query(sql, positionalValues);

    if (status === "SELECT") {
      return { rows: this.unwrapJsonbRows(result.rows), status };
    }
    if (status === "INSERT" || status === "UPDATE") {
      const row = result.rows[0];
      if (row && typeof row === "object") {
        const mapped = this.mapMutationResponseToSchema(row, Compiler.describeResult(ast).mutatedType);
        return { rows: [mapped as Record<string, unknown>], status };
      }
      return { rows: [], status };
    }
    if (status === "DELETE") {
      return { rows: [], status };
    }
    return { rows: result.rows ?? [], status };
  }

  private detectStatusFromAst(ast: EdgeQL.Query): string {
    switch (ast.kind) {
      case "SelectQuery":
        return "SELECT";
      case "InsertQuery":
        return "INSERT";
      case "UpdateQuery":
        return "UPDATE";
      case "DeleteQuery":
        return "DELETE";
      default:
        return "SELECT";
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

  getCacheStats(): { compilation: CacheStats; parse: CacheStats; } {
    return {
      compilation: this.compilationCache.stats(),
      parse: this.parseCache.stats()
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
      totalQueries: this.metrics.totalQueries
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
          size: compilationStats.size
        },
        parse: {
          evictions: parseStats.evictions,
          hitRate: cacheHitRate(parseStats),
          hits: parseStats.hits,
          misses: parseStats.misses,
          size: parseStats.size
        }
      },
      explain_cache: this.explainCache?.stats(),
      queryMetrics: metrics
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
        pool: this.buildPoolStats()
      };
    }

    try {
      const start = Date.now();
      await this.pool.query("SELECT 1");
      const latencyMs = Date.now() - start;

      const poolStats = this.buildPoolStats();
      const status: Types.HealthStatus["status"] = poolStats.waiters > 0 ?
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

  getCompilerInfo(): { version: string; features: string[]; } {
    return {
      version: DISC_VERSION,
      features: [
        "EdgeQL SELECT queries",
        "EdgeQL INSERT/UPDATE/DELETE operations",
        "JSON object generation",
        "Basic expression compilation",
        "Query validation and error reporting"
      ]
    };
  }
}
