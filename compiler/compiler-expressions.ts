/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Expression compilation layer: scalar/set expressions, literals, operators,
 * function calls (including window functions), parameters, casts, and
 * collection/subquery expression forms of the EdgeQL compiler.
 */

import * as EdgeQLAST from "../edgeql/ast.ts";
import { CompilationError } from "../lib/errors.ts";
import {
  backlinkIntersectionName,
  CompilerBase,
  edgeqlTypeToPgType,
  renderEdgeQLTypeName
} from "./compiler-base.ts";
import * as Context from "./context.ts";
import { describeSchema, describeType } from "./introspection.ts";
import * as SQL from "./sql.ts";

export abstract class ExpressionCompilerLayer extends CompilerBase {
  // Implemented by higher layers of the compiler inheritance chain.
  protected abstract compileQuery(query: EdgeQLAST.Query): SQL.SQLStatement;
  protected abstract compilePathInExpression(
    path: EdgeQLAST.Path
  ): SQL.SQLExpression;
  protected abstract compileGlobalRef(
    expr: EdgeQLAST.GlobalRef
  ): SQL.SQLExpression;
  protected abstract compileTypeName(
    typeName: EdgeQLAST.TypeName
  ): SQL.SQLExpression;
  protected abstract compileIntrospectionFunction(
    qualifiedName: string,
    funcCall: EdgeQLAST.FunctionCall
  ): SQL.RawSQLExpression;

  protected compileExpression(expr: EdgeQLAST.Expression): SQL.SQLExpression {
    switch (expr.kind) {
      case "Literal":
        return this.compileLiteral(expr);
      case "Identifier":
        return this.compileIdentifier(expr);
      case "BinaryOp":
        return this.compileBinaryOp(expr);
      case "UnaryOp":
        return this.compileUnaryOp(expr);
      case "FunctionCall":
        return this.compileFunctionCall(expr);
      case "WindowFunctionCall":
        return this.compileWindowFunctionCall(expr);
      case "Parameter":
        return this.compileParameter(expr);
      case "TypeCast":
        return this.compileTypeCast(expr);
      case "Path":
        return this.compilePathInExpression(expr);
      case "TypeName":
        return this.compileTypeName(expr);
      case "SetExpr":
        return this.compileSetExpr(expr);
      case "Subquery":
        return this.compileSubqueryExpression(expr);
      case "IfElse":
        return this.compileIfElse(expr as EdgeQLAST.IfElse);
      case "CaseExpression":
        return this.compileCaseExpression(
          expr as EdgeQLAST.CaseExpression
        );
      case "ArrayExpr":
        return this.compileArrayExpr(expr as EdgeQLAST.ArrayExpr);
      case "TupleExpr":
        return this.compileTupleExpr(expr as EdgeQLAST.TupleExpr);
      case "NamedTuple":
        return this.compileNamedTuple(expr as EdgeQLAST.NamedTuple);
      case "TupleAccessExpr":
        return this.compileTupleAccess(expr as EdgeQLAST.TupleAccessExpr);
      case "Detached":
        return this.compileDetached(expr as EdgeQLAST.Detached);
      case "Introspection":
        return this.compileIntrospection(expr as EdgeQLAST.Introspection);
      case "IndexExpression":
        return this.compileIndexExpression(
          expr as EdgeQLAST.IndexExpression
        );
      case "SliceExpression":
        return this.compileSliceExpression(
          expr as EdgeQLAST.SliceExpression
        );
      case "GlobalRef":
        return this.compileGlobalRef(expr as EdgeQLAST.GlobalRef);
      default:
        throw new CompilationError(`Unsupported expression: ${expr.kind}`);
    }
  }

  private compileLiteral(literal: EdgeQLAST.Literal): SQL.LiteralExpression {
    let sqlType: "string" | "number" | "boolean" | "null";

    switch (literal.type) {
      case "string":
        sqlType = "string";
        break;
      case "integer":
      case "float":
        sqlType = "number";
        break;
      case "boolean":
        sqlType = "boolean";
        break;
      case "empty":
        sqlType = "null";
        break;
      default:
        throw new CompilationError(`Unsupported literal type: ${literal.type}`);
    }

    return SQL.createLiteral(sqlType, literal.value);
  }

  private compileIdentifier(
    identifier: EdgeQLAST.Identifier
  ): SQL.SQLExpression {
    // Check scope variables first (e.g., FOR loop variable)
    const varDef = this.ctx.currentScope.variables.get(identifier.name);
    if (varDef) {
      if (varDef.sqlOverride) {
        return varDef.sqlOverride;
      }
      return this.compileExpression(varDef.expression);
    }

    // Check parent scopes
    for (let i = this.ctx.scopes.length - 1; i >= 0; i--) {
      const parentVar = this.ctx.scopes[i].variables.get(identifier.name);
      if (parentVar) {
        if (parentVar.sqlOverride) {
          return parentVar.sqlOverride;
        }
        return this.compileExpression(parentVar.expression);
      }
    }

    throw new CompilationError(
      `Standalone identifier '${identifier.name}' cannot be resolved`
    );
  }

  private compileBinaryOp(binOp: EdgeQLAST.BinaryOp): SQL.SQLExpression {
    // Handle IS / IS NOT for polymorphic type checking
    if (binOp.op === "IS" || binOp.op === "IS NOT") {
      return this.compileIsTypeCheck(binOp);
    }

    // Multi-cardinality 2-step path on the LHS: rewrite the entire
    // comparison to EXISTS over the target table. EdgeQL set-comparison
    // semantics say `set OP scalar` is true if any element matches; SQL
    // EXISTS captures that without needing a "set" type.
    //
    // This MUST run before the array-membership lowering below: that lowering
    // compiles the LHS as a path, which a multi-link path like `.tags.id`
    // can't satisfy (it's not single-cardinality). `compileMultiLinkComparison`
    // handles the `IN array_unpack(...)` RHS itself, inside the EXISTS.
    if (this.isMultiLinkPath(binOp.left) && this.isComparisonOp(binOp.op)) {
      const rewritten = this.compileMultiLinkComparison(
        binOp.left as EdgeQLAST.Path,
        binOp.op,
        binOp.right
      );
      if (rewritten) {
        return rewritten;
      }
    }

    // Multi-link chain on the LHS, e.g. `.channels.videos.isDraft` or the
    // deeper `.channels.videos.tags.name`: the SDK filter API emits this for a
    // nested `{ channels: { videos: { … } } }` filter. Rewrite to nested
    // EXISTS — each multi hop matches a linked row that itself has a linked row
    // satisfying the inner predicate, to any depth. Runs before the generic
    // path compilation (`compileLinkChain`), which only walks single-
    // cardinality chains and would reject a multi hop.
    if (this.isMultiHopLinkPath(binOp.left) && this.isComparisonOp(binOp.op)) {
      const rewritten = this.compileMultiHopComparison(
        binOp.left as EdgeQLAST.Path,
        binOp.op,
        binOp.right
      );
      if (rewritten) {
        return rewritten;
      }
    }

    // Set-membership over an unpacked array: `x in array_unpack(<array<T>>$p)`
    // maps to `array_unpack` → SQL `UNNEST`, but `x IN UNNEST(...)` is invalid
    // Postgres. Lower it to `x = ANY(arr)` (and `x <> ALL(arr)` for `NOT IN`).
    if (binOp.op === "IN" || binOp.op === "NOT IN") {
      const arrayMembership = this.compileArrayMembership(binOp);
      if (arrayMembership) {
        return arrayMembership;
      }
    }

    const left = this.compileExpression(binOp.left);
    const right = this.compileExpression(binOp.right);

    // Map EdgeQL operators to SQL operators
    let sqlOp: string = binOp.op;
    switch (binOp.op) {
      case "++":
        sqlOp = "||"; // String concatenation in PostgreSQL
        break;
      case "LIKE":
      case "ILIKE":
        sqlOp = binOp.op;
        break;
      // Range operators — same syntax in PG
      case "@>":
      case "<@":
      case "&&":
      case "-|-":
        sqlOp = binOp.op;
        break;
      // Bitwise operators — same syntax in PG
      case "&":
      case "|":
      case "<<":
      case ">>":
        sqlOp = binOp.op;
        break;
      case "^":
        sqlOp = "#"; // PG uses # for bitwise XOR
        break;
      // Regex operators — same syntax in PG
      case "~":
      case "!~":
      case "~*":
      case "!~*":
        sqlOp = binOp.op;
        break;
    }

    return SQL.createBinaryExpression(sqlOp, left, right);
  }

  /**
   * Lower `<scalar> IN array_unpack(<array<T>>$p)` (and the `NOT IN` form) to a
   * valid Postgres array comparison. `array_unpack` maps to SQL `UNNEST`, but
   * `<x> IN UNNEST(...)` is not valid syntax — the correct lowering is:
   *
   *   x IN array_unpack(arr)      → x = ANY(<compiled arr>)
   *   x NOT IN array_unpack(arr)  → x <> ALL(<compiled arr>)
   *
   * The array argument is compiled directly (so `<array<uuid>>$ids` becomes
   * `CAST($1 AS uuid[])`) and spliced as the operand of `ANY(...)` / `ALL(...)`.
   *
   * Returns `null` to fall through to the generic binary-op compilation when
   * the RHS is not a single-argument `array_unpack(...)` call — leaving
   * set-literal (`in {a, b}`) and subquery (`in (select ...)`) membership
   * unchanged.
   */
  private compileArrayMembership(
    binOp: EdgeQLAST.BinaryOp
  ): SQL.SQLExpression | null {
    const right = binOp.right;
    if (right.kind !== "FunctionCall") {
      return null;
    }
    if (right.name.parts.join("_") !== "array_unpack") {
      return null;
    }
    if (right.args.length !== 1) {
      return null;
    }

    const left = this.renderSqlExpr(this.compileExpression(binOp.left));
    const arr = this.renderSqlExpr(
      this.compileExpression(right.args[0].value)
    );
    const sql = binOp.op === "NOT IN" ?
      `${left} <> ALL(${arr})` :
      `${left} = ANY(${arr})`;
    return { kind: "RawSQLExpression" as const, sql };
  }

  /**
   * Compile IS / IS NOT type checks into discriminator column checks.
   *
   * `expr IS Type` where Type has subtypes ->
   *   __type__ IN ('Type', 'Sub1', 'Sub2', ...)
   *
   * `expr IS Type` where Type is a leaf ->
   *   __type__ = 'Type'
   *
   * `expr IS NOT Type` -> negated versions of the above
   */
  private compileIsTypeCheck(binOp: EdgeQLAST.BinaryOp): SQL.SQLExpression {
    const isNot = binOp.op === "IS NOT";

    // The right side should be a TypeName or Identifier referring to a type
    let typeName: string;
    if (binOp.right.kind === "TypeName") {
      typeName = binOp.right.name.parts.join("::");
    } else if (binOp.right.kind === "Identifier") {
      typeName = binOp.right.name;
    } else {
      // Fallback: compile as generic IS / IS NOT (e.g., IS NULL)
      const left = this.compileExpression(binOp.left);
      const right = this.compileExpression(binOp.right);
      return SQL.createBinaryExpression(binOp.op, left, right);
    }

    // Resolve the type in the schema
    const typeDef = Context.resolveTypeName(this.ctx, typeName);
    if (!typeDef) {
      throw new CompilationError(
        `Type '${typeName}' not found in schema for IS check`
      );
    }

    // Build the list of matching type names (type + all transitive subtypes)
    const allTypes = [
      typeDef.name,
      ...Context.getAllSubtypes(this.ctx.schema, typeDef.name)
    ];

    // Compile the left side (the expression being checked)
    // For paths like `.prop IS Type`, the left side resolves to a table alias
    // The discriminator column is always "__type__" on whatever table context
    // we're currently in.
    // For a simple pattern like `Shape IS Circle`, the left side is the type
    // reference itself. We need the table alias to reference __type__.
    const discriminatorCol = SQL.createColumnReference("__type__");

    if (allTypes.length === 1) {
      // Leaf type: simple equality check
      const op = isNot ? "!=" : "=";
      return SQL.createBinaryExpression(
        op,
        discriminatorCol,
        SQL.createLiteral("string", allTypes[0])
      );
    }

    // Multiple types: IN / NOT IN expression
    const typeList = allTypes.map(t => `'${t}'`).join(", ");
    const inOp = isNot ? "NOT IN" : "IN";

    return {
      kind: "RawSQLExpression" as const,
      sql: `__type__ ${inOp} (${typeList})`
    };
  }

  /**
   * Compile a BinaryOp representing a set operation (UNION, INTERSECT, EXCEPT)
   * into a SQL UnionAllStatement with the appropriate operator.
   */
  protected compileSetOperation(
    binOp: EdgeQLAST.BinaryOp
  ): SQL.UnionAllStatement {
    // Map EdgeQL set operator to SQL set operator
    let sqlOp: SQL.SetOperator;
    switch (binOp.op) {
      case "UNION":
        sqlOp = "UNION ALL";
        break;
      case "INTERSECT":
        sqlOp = "INTERSECT";
        break;
      case "EXCEPT":
        sqlOp = "EXCEPT";
        break;
      default:
        throw new CompilationError(`Unsupported set operator: ${binOp.op}`);
    }

    // Compile left and right operands as queries
    const leftStmt = this.compileSetOperand(binOp.left);
    const rightStmt = this.compileSetOperand(binOp.right);

    return SQL.setOperation(sqlOp, [leftStmt, rightStmt]);
  }

  /**
   * Compile a set operation operand. The operand is typically a Subquery
   * wrapping a SelectQuery, but could be another BinaryOp for chained
   * set operations.
   */
  private compileSetOperand(expr: EdgeQLAST.Expression): SQL.SQLStatement {
    if (expr.kind === "Subquery") {
      return this.compileQuery(expr.query);
    }
    if (expr.kind === "BinaryOp" && this.isSetOperator(expr.op)) {
      return this.compileSetOperation(expr);
    }
    // Fallback: wrap expression in a SELECT
    const compiled = this.compileExpression(expr);
    return SQL.createSelectStatement({
      select: SQL.createSelectClause([SQL.createSelectItem(compiled)])
    });
  }

  private compileUnaryOp(unaryOp: EdgeQLAST.UnaryOp): SQL.UnaryExpression {
    return {
      kind: "UnaryExpression",
      operator: unaryOp.op,
      operand: this.compileExpression(unaryOp.operand)
    };
  }

  private compileFunctionCall(
    funcCall: EdgeQLAST.FunctionCall
  ): SQL.SQLExpression {
    const functionName = funcCall.name.parts.join("_");
    const qualifiedName = funcCall.name.parts.join("::");

    // Check for schema:: / cfg:: introspection functions
    if (
      qualifiedName.startsWith("schema::") ||
      qualifiedName.startsWith("cfg::")
    ) {
      return this.compileIntrospectionFunction(qualifiedName, funcCall);
    }

    // Set-aggregates (`count`/`sum`/…) over a link-set path must become a
    // correlated subquery — a forward multi-link / backlink is a *set* with
    // no scalar column to wrap. Returns null (fall through) for ordinary
    // scalar arguments.
    if (funcCall.args.length === 1) {
      const aggregated = this.compileAggregateOverLinkPath(
        functionName,
        funcCall.args[0].value
      );
      if (aggregated) {
        return aggregated;
      }
    }

    const args = funcCall.args.map(arg => this.compileExpression(arg.value));

    // Special compilation for functions that aren't simple 1:1 mappings
    switch (functionName) {
      case "contains": {
        // Overloaded: string contains vs range contains
        // String: contains(str, sub) → STRPOS(str, sub) > 0
        // Range: contains(range, elem) → range @> elem
        if (args.length !== 2) {
          throw new CompilationError("contains() requires exactly 2 arguments");
        }
        const containsFirstArg = funcCall.args[0].value;
        const isContainsRangeArg = containsFirstArg.kind === "FunctionCall" &&
          containsFirstArg.name.parts.join("_") === "range";
        if (isContainsRangeArg) {
          return SQL.createBinaryExpression("@>", args[0], args[1]);
        }
        return SQL.createBinaryExpression(
          ">",
          SQL.createFunctionCall("STRPOS", args),
          SQL.createLiteral("number", 0)
        );
      }

      case "find":
        // find(str, sub) → STRPOS(str, sub) - 1
        // PG STRPOS is 1-indexed (0 = not found), EdgeQL find is 0-indexed (-1 = not found)
        if (args.length !== 2) {
          throw new CompilationError("find() requires exactly 2 arguments");
        }
        return SQL.createBinaryExpression(
          "-",
          SQL.createFunctionCall("STRPOS", args),
          SQL.createLiteral("number", 1)
        );

      case "to_str":
        if (args.length !== 1) {
          throw new CompilationError("to_str() requires exactly 1 argument");
        }
        return SQL.createCastExpression(args[0], "text");

      case "to_int64":
        if (args.length !== 1) {
          throw new CompilationError("to_int64() requires exactly 1 argument");
        }
        return SQL.createCastExpression(args[0], "bigint");

      case "to_float64":
        if (args.length !== 1) {
          throw new CompilationError(
            "to_float64() requires exactly 1 argument"
          );
        }
        return SQL.createCastExpression(args[0], "double precision");

      // Additional type cast functions
      case "to_int16":
        if (args.length !== 1) {
          throw new CompilationError("to_int16() requires exactly 1 argument");
        }
        return SQL.createCastExpression(args[0], "smallint");

      case "to_int32":
        if (args.length !== 1) {
          throw new CompilationError("to_int32() requires exactly 1 argument");
        }
        return SQL.createCastExpression(args[0], "integer");

      case "to_float32":
        if (args.length !== 1) {
          throw new CompilationError(
            "to_float32() requires exactly 1 argument"
          );
        }
        return SQL.createCastExpression(args[0], "real");

      case "to_bigint":
        if (args.length !== 1) {
          throw new CompilationError(
            "to_bigint() requires exactly 1 argument"
          );
        }
        return SQL.createCastExpression(args[0], "numeric");

      case "to_decimal":
        if (args.length !== 1) {
          throw new CompilationError(
            "to_decimal() requires exactly 1 argument"
          );
        }
        return SQL.createCastExpression(args[0], "numeric");

      case "to_bool":
        if (args.length !== 1) {
          throw new CompilationError("to_bool() requires exactly 1 argument");
        }
        return SQL.createCastExpression(args[0], "boolean");

      case "to_uuid":
        if (args.length !== 1) {
          throw new CompilationError("to_uuid() requires exactly 1 argument");
        }
        return SQL.createCastExpression(args[0], "uuid");

      case "to_datetime":
        if (args.length !== 1) {
          throw new CompilationError(
            "to_datetime() requires exactly 1 argument"
          );
        }
        return SQL.createCastExpression(
          args[0],
          "timestamp with time zone"
        );

      case "to_duration":
        if (args.length !== 1) {
          throw new CompilationError(
            "to_duration() requires exactly 1 argument"
          );
        }
        return SQL.createCastExpression(args[0], "interval");

      // Calendar conversion functions → CAST
      case "cal_to_local_date":
        if (args.length !== 1) {
          throw new CompilationError(
            "cal::to_local_date() requires exactly 1 argument"
          );
        }
        return SQL.createCastExpression(args[0], "date");

      case "cal_to_local_time":
        if (args.length !== 1) {
          throw new CompilationError(
            "cal::to_local_time() requires exactly 1 argument"
          );
        }
        return SQL.createCastExpression(
          args[0],
          "time without time zone"
        );

      case "cal_to_local_datetime":
        if (args.length !== 1) {
          throw new CompilationError(
            "cal::to_local_datetime() requires exactly 1 argument"
          );
        }
        return SQL.createCastExpression(
          args[0],
          "timestamp without time zone"
        );

      // String functions with special compilation
      case "str_starts_with":
        // str_starts_with(s, prefix) → STARTS_WITH(s, prefix) (PG 15+)
        if (args.length !== 2) {
          throw new CompilationError(
            "str_starts_with() requires exactly 2 arguments"
          );
        }
        return SQL.createFunctionCall("STARTS_WITH", args);

      case "str_ends_with":
        // str_ends_with(s, suffix) → RIGHT(s, LENGTH(suffix)) = suffix
        if (args.length !== 2) {
          throw new CompilationError(
            "str_ends_with() requires exactly 2 arguments"
          );
        }
        return SQL.createBinaryExpression(
          "=",
          SQL.createFunctionCall("RIGHT", [
            args[0],
            SQL.createFunctionCall("LENGTH", [args[1]])
          ]),
          args[1]
        );

      // Math special compilation
      case "math_e":
        // math::e() → EXP(1)
        return SQL.createFunctionCall("EXP", [
          SQL.createLiteral("number", 1)
        ]);

      case "math_log10":
        // math::log10(val) → LOG(10, val) — PG LOG(b, x) is base-b logarithm
        if (args.length !== 1) {
          throw new CompilationError(
            "math_log10() requires exactly 1 argument"
          );
        }
        return SQL.createFunctionCall("LOG", [
          SQL.createLiteral("number", 10),
          args[0]
        ]);

      case "math_log2":
        // math::log2(val) → LOG(2, val) — PG LOG(b, x) is base-b logarithm
        if (args.length !== 1) {
          throw new CompilationError(
            "math_log2() requires exactly 1 argument"
          );
        }
        return SQL.createFunctionCall("LOG", [
          SQL.createLiteral("number", 2),
          args[0]
        ]);

      // Regex functions with special compilation
      case "re_match":
        // re_match(pattern, str) → REGEXP_MATCH(str, pattern) — swap args
        if (args.length !== 2) {
          throw new CompilationError(
            "re_match() requires exactly 2 arguments"
          );
        }
        return SQL.createFunctionCall("REGEXP_MATCH", [args[1], args[0]]);

      case "re_match_all":
        // re_match_all(pattern, str) → REGEXP_MATCHES(str, pattern, 'g')
        if (args.length !== 2) {
          throw new CompilationError(
            "re_match_all() requires exactly 2 arguments"
          );
        }
        return SQL.createFunctionCall("REGEXP_MATCHES", [
          args[1],
          args[0],
          SQL.createLiteral("string", "g")
        ]);

      case "re_replace":
        // re_replace(pattern, sub, str) → REGEXP_REPLACE(str, pattern, sub)
        if (args.length !== 3) {
          throw new CompilationError(
            "re_replace() requires exactly 3 arguments"
          );
        }
        return SQL.createFunctionCall("REGEXP_REPLACE", [
          args[2],
          args[0],
          args[1]
        ]);

      case "re_test":
        // re_test(pattern, str) → str ~ pattern
        if (args.length !== 2) {
          throw new CompilationError(
            "re_test() requires exactly 2 arguments"
          );
        }
        return SQL.createBinaryExpression("~", args[1], args[0]);

      // Datetime special compilation
      case "datetime_get": {
        // datetime_get(val, field) → EXTRACT(field FROM val)
        if (args.length !== 2) {
          throw new CompilationError(
            "datetime_get() requires exactly 2 arguments"
          );
        }
        const getFieldArg = funcCall.args[1].value;
        const getField = getFieldArg.kind === "Literal" &&
            typeof getFieldArg.value === "string" ?
          getFieldArg.value :
          "epoch";
        return {
          kind: "RawSQLExpression" as const,
          sql: `EXTRACT(${getField} FROM ${this.renderSqlExpr(args[0])})`
        };
      }

      case "datetime_truncate": {
        // datetime_truncate(val, field) → DATE_TRUNC(field, val)
        if (args.length !== 2) {
          throw new CompilationError(
            "datetime_truncate() requires exactly 2 arguments"
          );
        }
        return SQL.createFunctionCall("DATE_TRUNC", [args[1], args[0]]);
      }

      // JSON special compilation
      case "json_get":
        // json_get(val, key) → val -> key
        if (args.length !== 2) {
          throw new CompilationError(
            "json_get() requires exactly 2 arguments"
          );
        }
        return SQL.createJsonbAccess(args[0], "->", args[1]);

      // Array special compilation
      case "array_get":
        // array_get(arr, n) → arr[n + 1] (PG is 1-indexed)
        if (args.length !== 2) {
          throw new CompilationError(
            "array_get() requires exactly 2 arguments"
          );
        }
        return {
          kind: "RawSQLExpression" as const,
          sql: `(${this.renderSqlExpr(args[0])})[${this.renderSqlExpr(args[1])} + 1]`
        };

      // Set functions with special compilation
      case "enumerate":
        // enumerate(val) → ROW_NUMBER() OVER () paired with val as jsonb array
        if (args.length !== 1) {
          throw new CompilationError(
            "enumerate() requires exactly 1 argument"
          );
        }
        return {
          kind: "RawSQLExpression" as const,
          sql: `jsonb_build_array(ROW_NUMBER() OVER () - 1, ${this.renderSqlExpr(args[0])})`
        };

      case "distinct":
        // distinct(expr) → wraps expression with DISTINCT keyword
        if (args.length !== 1) {
          throw new CompilationError(
            "distinct() requires exactly 1 argument"
          );
        }
        return {
          kind: "RawSQLExpression" as const,
          sql: `DISTINCT ${this.renderSqlExpr(args[0])}`
        };

      case "exists":
        // exists(expr) → EXISTS (subquery) or (expr IS NOT NULL)
        if (args.length !== 1) {
          throw new CompilationError(
            "exists() requires exactly 1 argument"
          );
        }
        return SQL.createBinaryExpression(
          "IS NOT",
          args[0],
          SQL.createLiteral("null", null)
        );

      // Sequence functions
      case "sequence_next":
        // sequence_next(name) → NEXTVAL(name)
        if (args.length !== 1) {
          throw new CompilationError(
            "sequence_next() requires exactly 1 argument"
          );
        }
        return SQL.createFunctionCall("NEXTVAL", args);

      case "sequence_reset":
        // sequence_reset(name, val) → SETVAL(name, val)
        if (args.length !== 2) {
          throw new CompilationError(
            "sequence_reset() requires exactly 2 arguments"
          );
        }
        return SQL.createFunctionCall("SETVAL", args);

      // Range & Multirange functions
      case "range": {
        // range(lower, upper) → type-dependent PG range constructor
        // Detect type from literal args: integer → int4range, float → numrange
        if (args.length !== 2) {
          throw new CompilationError(
            "range() requires exactly 2 arguments"
          );
        }
        let rangeConstructor = "int4range"; // default
        if (funcCall.args.length >= 1) {
          const firstArg = funcCall.args[0].value;
          if (firstArg.kind === "Literal") {
            if (firstArg.type === "float") {
              rangeConstructor = "numrange";
            }
            // integer → int4range (default), string literal could be date/timestamp
          }
        }
        return SQL.createFunctionCall(rangeConstructor, args);
      }

      case "multirange": {
        // multirange(r) → type-dependent PG multirange constructor
        // Default to int4multirange; enhanced type inference can be added later
        if (args.length !== 1) {
          throw new CompilationError(
            "multirange() requires exactly 1 argument"
          );
        }
        return SQL.createFunctionCall("int4multirange", args);
      }

      case "overlaps":
        // overlaps(r1, r2) → r1 && r2
        if (args.length !== 2) {
          throw new CompilationError(
            "overlaps() requires exactly 2 arguments"
          );
        }
        return SQL.createBinaryExpression("&&", args[0], args[1]);

      // Full-text search functions (ext::fts)
      case "fts_search":
        // fts::search(query) → fts_vector @@ plainto_tsquery('english', query)
        if (args.length !== 1) {
          throw new CompilationError(
            "fts::search() requires exactly 1 argument"
          );
        }
        return {
          kind: "RawSQLExpression" as const,
          sql: `fts_vector @@ plainto_tsquery('english', ${this.renderSqlExpr(args[0])})`
        };

      case "fts_rank":
        // fts::rank(query) → ts_rank(fts_vector, plainto_tsquery('english', query))
        if (args.length !== 1) {
          throw new CompilationError(
            "fts::rank() requires exactly 1 argument"
          );
        }
        return {
          kind: "RawSQLExpression" as const,
          sql: `ts_rank(fts_vector, plainto_tsquery('english', ${this.renderSqlExpr(args[0])}))`
        };
    }

    // Standard 1:1 function name mapping. The registry is keyed by the
    // underscore-joined form (`std_md5`); fall back to the qualified
    // form (`std::md5`) for entries that prefer the user-facing key.
    let sqlName = functionName;
    const funcDef = this.ctx.schema.functions.get(functionName) ??
      this.ctx.schema.functions.get(qualifiedName);
    if (funcDef?.windowOnly) {
      throw new CompilationError(
        `Function '${functionName}' requires an OVER clause`
      );
    }
    if (funcDef?.sqlName) {
      sqlName = funcDef.sqlName;
    }

    return SQL.createFunctionCall(sqlName, args);
  }

  private compileWindowFunctionCall(
    wfc: EdgeQLAST.WindowFunctionCall
  ): SQL.WindowFunctionExpression {
    const functionName = wfc.name.parts.join("_");
    const args = wfc.args.map(arg => this.compileExpression(arg.value));

    // Map function name to SQL
    let sqlName = functionName;
    const funcDef = this.ctx.schema.functions.get(functionName);
    if (!funcDef?.windowOnly && !funcDef?.windowCompatible) {
      throw new CompilationError(
        `Function '${functionName}' cannot be used with an OVER clause`
      );
    }
    if (funcDef?.sqlName) {
      sqlName = funcDef.sqlName;
    }

    // Compile the OVER clause
    const over = this.compileWindowOverClause(wfc.over);

    return SQL.windowFunction(sqlName, args, over);
  }

  private compileWindowOverClause(
    over: EdgeQLAST.WindowOverClause
  ): SQL.WindowClause {
    // Compile PARTITION BY
    let partitionBy: SQL.SQLExpression[] | undefined;
    if (over.partitionBy && over.partitionBy.length > 0) {
      partitionBy = over.partitionBy.map(expr => this.compileExpression(expr));
    }

    // Compile ORDER BY
    let orderBy: SQL.OrderByItem[] | undefined;
    if (over.orderBy && over.orderBy.length > 0) {
      orderBy = over.orderBy.map(item => ({
        kind: "OrderByItem" as const,
        expression: this.compileExpression(item.expr),
        direction: item.direction || "ASC" as "ASC" | "DESC"
      }));
    }

    // Compile frame spec
    let frame: SQL.WindowFrame | undefined;
    if (over.frame) {
      const start = this.compileFrameBound(over.frame.start);
      const end = over.frame.end ?
        this.compileFrameBound(over.frame.end) :
        start;

      frame = {
        kind: "WindowFrame",
        mode: over.frame.mode,
        start,
        end,
        exclude: over.frame.exclude
      };
    }

    return {
      kind: "WindowClause",
      partitionBy,
      orderBy,
      frame
    };
  }

  private compileFrameBound(bound: EdgeQLAST.FrameBound): string {
    switch (bound.type) {
      case "UNBOUNDED PRECEDING":
        return "UNBOUNDED PRECEDING";
      case "CURRENT ROW":
        return "CURRENT ROW";
      case "UNBOUNDED FOLLOWING":
        return "UNBOUNDED FOLLOWING";
      case "OFFSET PRECEDING": {
        // Extract literal value for the offset
        if (bound.offset && bound.offset.kind === "Literal") {
          return `${bound.offset.value} PRECEDING`;
        }
        return "0 PRECEDING";
      }
      case "OFFSET FOLLOWING": {
        if (bound.offset && bound.offset.kind === "Literal") {
          return `${bound.offset.value} FOLLOWING`;
        }
        return "0 FOLLOWING";
      }
      default:
        return bound.type;
    }
  }

  private compileParameter(param: EdgeQLAST.Parameter): SQL.SQLExpression {
    // The lexer keeps the leading `$` on the name. Strip it so callers can
    // key the parameter map by the bare identifier (matches the wire-level
    // `kwargs` shape both upstream Gel clients use).
    const bare = param.name.startsWith("$") ? param.name.slice(1) : param.name;

    // Numeric positional parameters (`$0`, `$1`, ...) keep their literal
    // index. Without this, parseInt fails for purely-numeric names that
    // happen to also exist in `parameterIndex` and we'd shift positions.
    const numeric = parseInt(bare, 10);
    if (!Number.isNaN(numeric)) {
      // EdgeQL `$0` is the first positional argument; PG `$1` is the first
      // bind value. Bump by 1 to keep the two coordinate systems aligned.
      return SQL.createParameterReference(numeric + 1);
    }

    const idx = this.parameterIndex.get(bare);
    if (idx !== undefined) {
      return SQL.createParameterReference(idx);
    }

    // No map entry — fall back to length+1 so successive unmapped names get
    // distinct indices instead of all collapsing onto $1 (the prior bug).
    const next = this.parameterIndex.size + 1;
    this.parameterIndex.set(bare, next);
    return SQL.createParameterReference(next);
  }

  private compileTypeCast(cast: EdgeQLAST.TypeCast): SQL.SQLExpression {
    const expr = this.compileExpression(cast.expr);
    const typeName = renderEdgeQLTypeName(cast.type);

    // User-declared enum scalars don't appear in the static built-in map.
    // Resolve them through the schema so casts like `<LogLevel>$level`
    // emit `::disc_enum_loglevel` instead of being passed through verbatim
    // (which PG would silently lowercase to `loglevel` — a type that
    // doesn't exist).
    const resolved = Context.resolveTypeName(this.ctx, typeName);
    if (
      resolved && Array.isArray(resolved.enumValues) &&
      resolved.enumValues.length > 0
    ) {
      return SQL.createCastExpression(expr, Context.getEnumSqlType(typeName));
    }

    const pgType = edgeqlTypeToPgType(typeName);
    return SQL.createCastExpression(expr, pgType);
  }

  /**
   * True iff `expr` is a 2-step Path whose first step resolves to a
   * multi-cardinality link on any active alias's type. Used to detect
   * the `.multi_link.field` pattern at the binary-op compile point so
   * we can rewrite it to EXISTS rather than try to compile the path
   * as a scalar value.
   */
  /**
   * EdgeQL → SQL name for set-aggregate functions that, when applied to a
   * link-set path, must be lowered to a correlated subquery.
   */
  private static readonly SET_AGGREGATES = new Map<string, string>([
    ["count", "COUNT"],
    ["sum", "SUM"],
    ["min", "MIN"],
    ["max", "MAX"],
    ["avg", "AVG"]
  ]);

  /**
   * Compile a set-aggregate applied to a link-set path into a correlated
   * scalar subquery, e.g. inside a computed property:
   *
   *   count(.subscribers)            → (SELECT COUNT(*) FROM <junction>
   *                                       WHERE <junction>.<src> = parent.id)
   *   count(.<channel[is Video])     → (SELECT COUNT(*) FROM video
   *                                       WHERE video.channel_id = parent.id)
   *   sum(.<creator[is Video].size)  → (SELECT COALESCE(SUM(video.size), 0)
   *                                       FROM video
   *                                       WHERE video.creator_id = parent.id)
   *
   * Returns null — fall through to the generic 1:1 function mapping — when the
   * argument isn't a link-set path this rule understands (ordinary scalar
   * arguments, unknown links, unsupported shapes).
   */
  private compileAggregateOverLinkPath(
    funcName: string,
    arg: EdgeQLAST.Expression
  ): SQL.SQLExpression | null {
    const sqlAgg = ExpressionCompilerLayer.SET_AGGREGATES.get(funcName);
    if (!sqlAgg || arg.kind !== "Path") {
      return null;
    }
    const steps = arg.steps;
    if (steps.length === 0 || steps.length > 2) {
      return null;
    }

    // Correlate against the current (outer) row's alias.
    let parent: { alias: string; type: string; } | undefined;
    for (const ta of this.ctx.currentScope.aliases.values()) {
      parent = ta;
      break;
    }
    if (!parent) {
      return null;
    }
    const parentType = Context.resolveTypeName(this.ctx, parent.type);
    if (!parentType) {
      return null;
    }

    // Forward multi-link: count the linked set. Only `count` is meaningful
    // without a trailing scalar property. A multi-link is stored either as a
    // junction table or, when the FK lives on the target, as a backlink.
    const first = steps[0];
    if (steps.length === 1 && first.type === "property") {
      const link = parentType.links.get(first.name);
      if (!link?.multi || funcName !== "count") {
        return null;
      }
      if (link.junctionTable) {
        const srcCol = link.junctionSourceColumn ?? "source_id";
        const sql = `(SELECT COUNT(*) FROM "${link.junctionTable}" ` +
          `WHERE "${link.junctionTable}"."${srcCol}" = "${parent.alias}"."id")`;
        return { kind: "RawSQLExpression", sql };
      }
      if (link.backlink) {
        // FK on the target table; `backlink` names the forward link there.
        const targetTd = Context.resolveTypeName(this.ctx, link.target);
        const fkCol = targetTd?.links.get(link.backlink)?.columnName;
        if (!targetTd || !fkCol) {
          return null;
        }
        const sql = `(SELECT COUNT(*) FROM "${targetTd.tableName}" ` +
          `WHERE "${targetTd.tableName}"."${fkCol}" = "${parent.alias}"."id")`;
        return { kind: "RawSQLExpression", sql };
      }
      return null;
    }

    // Backlink, optionally with a trailing scalar property:
    //   .<creator[is Video]        → count rows of Video by FK
    //   .<creator[is Video].size   → aggregate Video.size over those rows
    if (first.type !== "backlink") {
      return null;
    }
    const intersection = backlinkIntersectionName(first.filter);
    if (!intersection) {
      return null;
    }
    const targetType = Context.resolveTypeName(this.ctx, intersection);
    if (!targetType) {
      return null;
    }
    const fwd = targetType.links.get(first.name);
    if (!fwd) {
      return null;
    }

    // Build the FROM + correlation for "target rows that link back to parent".
    let fromSql: string;
    let correlation: string;
    if (fwd.columnName && !fwd.junctionTable) {
      fromSql = `"${targetType.tableName}"`;
      correlation = `"${targetType.tableName}"."${fwd.columnName}" = "${parent.alias}"."id"`;
    } else if (fwd.junctionTable) {
      const srcCol = fwd.junctionSourceColumn ?? "source_id";
      const tgtCol = fwd.junctionTargetColumn ?? "target_id";
      fromSql = `"${targetType.tableName}" ` +
        `JOIN "${fwd.junctionTable}" ON "${fwd.junctionTable}"."${srcCol}" = ` +
        `"${targetType.tableName}"."id"`;
      correlation = `"${fwd.junctionTable}"."${tgtCol}" = "${parent.alias}"."id"`;
    } else {
      return null;
    }

    // Determine the aggregated expression.
    let aggExpr: string;
    if (steps.length === 2) {
      const second = steps[1];
      if (second.type !== "property") {
        return null;
      }
      const prop = targetType.properties.get(second.name);
      if (!prop?.columnName) {
        return null;
      }
      const col = `"${targetType.tableName}"."${prop.columnName}"`;
      // `sum` of an empty set is 0 in EdgeQL; SQL SUM() yields NULL, so
      // coalesce. min/max/avg/count over an empty set stay NULL/0 as-is.
      aggExpr = funcName === "sum" ?
        `COALESCE(SUM(${col}), 0)` :
        `${sqlAgg}(${col})`;
    } else {
      // Bare backlink with no scalar property — only count(*) is valid.
      if (funcName !== "count") {
        return null;
      }
      aggExpr = "COUNT(*)";
    }

    return {
      kind: "RawSQLExpression",
      sql: `(SELECT ${aggExpr} FROM ${fromSql} WHERE ${correlation})`
    };
  }

  private isMultiLinkPath(expr: EdgeQLAST.Expression): boolean {
    if (expr.kind !== "Path" || expr.steps.length !== 2) {
      return false;
    }
    const [first] = expr.steps;
    if (first.type !== "property") {
      return false;
    }
    for (const ta of this.ctx.currentScope.aliases.values()) {
      const td = Context.resolveTypeName(this.ctx, ta.type);
      const link = td?.links.get(first.name);
      if (link?.multi) {
        return true;
      }
    }
    return false;
  }

  /**
   * Rewrite `.multi_link.field <op> rhs` into:
   *
   *   EXISTS (
   *     SELECT 1 FROM "<target_table>" "<sub_alias>"
   *     WHERE "<sub_alias>"."<fk_col>" = "<src_alias>"."id"
   *       AND "<sub_alias>"."<target_col>" <op> <rhs>
   *   )
   *
   * Currently handles backlink-style multi links (FK lives on the
   * target table). Junction-table multi links are a future-work case
   * that would emit a 3-table EXISTS. Returns `null` to fall through
   * to the default binary-op compilation if anything doesn't resolve.
   */
  private compileMultiLinkComparison(
    path: EdgeQLAST.Path,
    op: string,
    rhsExpr: EdgeQLAST.Expression
  ): SQL.SQLExpression | null {
    const [firstStep, secondStep] = path.steps;
    if (firstStep.type !== "property" || secondStep.type !== "property") {
      return null;
    }

    for (const ta of this.ctx.currentScope.aliases.values()) {
      const td = Context.resolveTypeName(this.ctx, ta.type);
      const link = td?.links.get(firstStep.name);
      if (!link?.multi) {
        continue;
      }

      const targetType = Context.resolveTypeName(this.ctx, link.target);
      if (!targetType) {
        return null;
      }

      // Junction-table multi link (many-to-many): EXISTS over the
      // junction with an INNER JOIN to the target. When the terminal
      // step is `id`, the junction's target column already holds the
      // target id, so the JOIN can be elided.
      if (link.junctionTable) {
        const sourceCol = link.junctionSourceColumn ?? "source_id";
        const targetCol = link.junctionTargetColumn ?? "target_id";
        const jAlias = `__j_${firstStep.name}`;

        if (secondStep.name === "id") {
          const sql = `EXISTS (SELECT 1 FROM "${link.junctionTable}" "${jAlias}" ` +
            `WHERE "${jAlias}"."${sourceCol}" = "${ta.alias}"."id" ` +
            `AND ${this.renderInnerPredicate(`"${jAlias}"."${targetCol}"`, op, rhsExpr)})`;
          return { kind: "RawSQLExpression", sql };
        }

        const tAlias = `__t_${firstStep.name}`;
        const prop = targetType.properties.get(secondStep.name);
        if (!prop?.columnName) {
          return null;
        }

        const sql = `EXISTS (SELECT 1 FROM "${link.junctionTable}" "${jAlias}" ` +
          `INNER JOIN "${targetType.tableName}" "${tAlias}" ` +
          `ON "${tAlias}"."id" = "${jAlias}"."${targetCol}" ` +
          `WHERE "${jAlias}"."${sourceCol}" = "${ta.alias}"."id" ` +
          `AND ${this.renderInnerPredicate(`"${tAlias}"."${prop.columnName}"`, op, rhsExpr)})`;
        return { kind: "RawSQLExpression", sql };
      }

      // Backlink-style multi link (one-to-many): EXISTS on the target
      // table where its FK back to the source matches.
      let fkColumn: string | undefined;
      if (link.backlink) {
        const backLink = targetType.links.get(link.backlink);
        fkColumn = backLink?.columnName;
      }
      if (!fkColumn) {
        return null;
      }

      let targetColName: string;
      if (secondStep.name === "id") {
        targetColName = "id";
      } else {
        const prop = targetType.properties.get(secondStep.name);
        if (!prop?.columnName) {
          return null;
        }
        targetColName = prop.columnName;
      }

      const subAlias = `__sub_${firstStep.name}`;
      const sql = `EXISTS (SELECT 1 FROM "${targetType.tableName}" "${subAlias}" ` +
        `WHERE "${subAlias}"."${fkColumn}" = "${ta.alias}"."id" ` +
        `AND ${this.renderInnerPredicate(`"${subAlias}"."${targetColName}"`, op, rhsExpr)})`;
      return { kind: "RawSQLExpression", sql };
    }
    return null;
  }

  /**
   * True iff `expr` is a Path of 3+ steps whose first step resolves to a
   * multi-cardinality link on any active alias's type — the `.multi....field`
   * shape produced by a nested filter object two or more levels deep. The
   * first hop being multi is what distinguishes this from a pure single-link
   * chain (handled by `compileLinkChain`); `buildHopChainExists` walks the
   * rest, descending through both further multi links and single-FK hops to
   * any depth.
   */
  private isMultiHopLinkPath(expr: EdgeQLAST.Expression): boolean {
    if (expr.kind !== "Path" || expr.steps.length < 3) {
      return false;
    }
    if (!expr.steps.every(s => s.type === "property")) {
      return false;
    }
    const first = expr.steps[0];
    for (const ta of this.ctx.currentScope.aliases.values()) {
      const td = Context.resolveTypeName(this.ctx, ta.type);
      const link = td?.links.get(first.name);
      if (link?.multi) {
        return true;
      }
    }
    return false;
  }

  /**
   * Rewrite `.linkA.linkB.field <op> rhs` (two multi-link hops) into nested
   * EXISTS:
   *
   *   EXISTS (SELECT 1 FROM <A_rows> WHERE <correlate A to outer>
   *     AND EXISTS (SELECT 1 FROM <B_rows> WHERE <correlate B to A>
   *       AND "<B>"."<col>" <op> <rhs>))
   *
   * Each hop may be a junction-table multi link or a backlink-style multi
   * link; `buildHopChainExists` handles both. Returns `null` (fall through to
   * the generic path compilation, which then errors) when any link in the
   * chain isn't a resolvable multi link — e.g. a single-cardinality hop, which
   * `compileLinkChain` already covers.
   */
  private compileMultiHopComparison(
    path: EdgeQLAST.Path,
    op: string,
    rhsExpr: EdgeQLAST.Expression
  ): SQL.SQLExpression | null {
    const names = path.steps.map(s => (s as { name: string; }).name);
    for (const ta of this.ctx.currentScope.aliases.values()) {
      const startType = Context.resolveTypeName(this.ctx, ta.type);
      if (!startType?.links.get(names[0])) {
        continue;
      }
      const sql = this.buildHopChainExists(
        `"${ta.alias}"`,
        startType,
        names,
        op,
        rhsExpr,
        0
      );
      if (sql) {
        return { kind: "RawSQLExpression", sql };
      }
    }
    return null;
  }

  /**
   * Recursively build the nested-EXISTS body for a link chain whose first hop
   * is multi-cardinality.
   *
   * `names` is `[linkName, …intermediate links…, terminalProp]`. The head is
   * the link to descend; `parentRef` is the already-quoted alias of the row
   * this hop correlates against (e.g. `"u"` or `"__h0_channels"`), so the
   * correlation can read either `.id` (multi backlink / junction) or the FK
   * column (single forward link) off it. When only `[linkName, terminalProp]`
   * remains, the recursion bottoms out into a scalar predicate on the target
   * column (via `renderInnerPredicate`, so `id`-shortcut and `array_unpack`
   * membership are handled uniformly).
   *
   * Each hop may be a junction-table multi link, a backlink-style multi link,
   * or a single forward-FK link — mixing freely along the chain. Returns
   * `null` if a hop can't be resolved as one of those, so the caller can fall
   * through to the generic path compiler.
   */
  private buildHopChainExists(
    parentRef: string,
    parentType: { links: Map<string, unknown>; },
    names: string[],
    op: string,
    rhsExpr: EdgeQLAST.Expression,
    depth: number
  ): string | null {
    const linkName = names[0];
    const link = (parentType.links as Map<string, {
      target: string;
      multi?: boolean;
      backlink?: string;
      columnName?: string;
      junctionTable?: string;
      junctionSourceColumn?: string;
      junctionTargetColumn?: string;
    }>)
      .get(linkName);
    if (!link) {
      return null;
    }
    const targetType = Context.resolveTypeName(this.ctx, link.target);
    if (!targetType) {
      return null;
    }

    const tAlias = `__h${depth}_${linkName}`;
    let fromSql: string;
    let correlation: string;

    if (link.junctionTable) {
      // Junction-table multi link: correlate the junction's source side to the
      // parent row's id, joining the target so its columns are addressable.
      const srcCol = link.junctionSourceColumn ?? "source_id";
      const tgtCol = link.junctionTargetColumn ?? "target_id";
      const jAlias = `__hj${depth}_${linkName}`;
      fromSql = `"${targetType.tableName}" "${tAlias}" ` +
        `INNER JOIN "${link.junctionTable}" "${jAlias}" ` +
        `ON "${jAlias}"."${tgtCol}" = "${tAlias}"."id"`;
      correlation = `"${jAlias}"."${srcCol}" = ${parentRef}."id"`;
    } else if (link.multi && link.backlink) {
      // Backlink-style multi link: the FK lives on the target, pointing back
      // at the parent row's id.
      const fkCol = (targetType.links.get(link.backlink) as
        | { columnName?: string; }
        | undefined)
        ?.columnName;
      if (!fkCol) {
        return null;
      }
      fromSql = `"${targetType.tableName}" "${tAlias}"`;
      correlation = `"${tAlias}"."${fkCol}" = ${parentRef}."id"`;
    } else if (!link.multi && link.columnName) {
      // Single forward link: the FK lives on the parent row; the target is the
      // row whose id it points at.
      fromSql = `"${targetType.tableName}" "${tAlias}"`;
      correlation = `"${tAlias}"."id" = ${parentRef}."${link.columnName}"`;
    } else {
      return null;
    }

    const rest = names.slice(1);
    let inner: string;
    if (rest.length === 1) {
      // Terminal scalar predicate on the target column.
      const terminal = rest[0];
      let colName: string;
      if (terminal === "id") {
        colName = "id";
      } else {
        const prop = targetType.properties.get(terminal);
        if (!prop?.columnName) {
          return null;
        }
        colName = prop.columnName;
      }
      inner = this.renderInnerPredicate(
        `"${tAlias}"."${colName}"`,
        op,
        rhsExpr
      );
    } else {
      // Descend one more hop, correlating it to this hop's target row.
      const nested = this.buildHopChainExists(
        `"${tAlias}"`,
        targetType,
        rest,
        op,
        rhsExpr,
        depth + 1
      );
      if (!nested) {
        return null;
      }
      inner = nested;
    }

    return `EXISTS (SELECT 1 FROM ${fromSql} WHERE ${correlation} AND ${inner})`;
  }

  /**
   * Render the inner `<column> <op> <rhs>` predicate spliced into a multi-link
   * EXISTS body. `<column>` is already-quoted SQL for the target column.
   *
   * `IN array_unpack(<array<T>>$p)` must lower to `<col> = ANY(arr)` (and
   * `NOT IN` to `<> ALL(arr)`) — same reason as the top-level array-membership
   * lowering: `<col> IN UNNEST(...)` is invalid Postgres. Everything else
   * (scalar `=`, `<`, set-literal `IN {a, b}`, …) splices `<op> <rhs>` directly.
   */
  private renderInnerPredicate(
    columnSql: string,
    op: string,
    rhsExpr: EdgeQLAST.Expression
  ): string {
    if (op === "IN" || op === "NOT IN") {
      const r = rhsExpr;
      if (
        r.kind === "FunctionCall" &&
        r.name.parts.join("_") === "array_unpack" &&
        r.args.length === 1
      ) {
        const arr = this.renderSqlExpr(
          this.compileExpression(r.args[0].value)
        );
        return op === "NOT IN" ?
          `${columnSql} <> ALL(${arr})` :
          `${columnSql} = ANY(${arr})`;
      }
    }
    const rhsSql = this.renderSqlExpr(this.compileExpression(rhsExpr));
    return `${columnSql} ${op} ${rhsSql}`;
  }

  private compileSetExpr(setExpr: EdgeQLAST.SetExpr): SQL.SQLExpression {
    // Compile set expression {val1, val2, ...} into a SQL tuple (val1, val2, ...)
    // This is used in expressions like FILTER .role IN {"admin", "moderator"}
    // The empty set `{}` is the EdgeQL "no value" sentinel; in scalar/assignment
    // context (e.g. `update T set { col := {} }`) it must become SQL NULL, not
    // `()` — bare `()` is invalid Postgres syntax.
    if (setExpr.elements.length === 0)
      return { kind: "RawSQLExpression" as const, sql: "NULL" };

    const elements = setExpr.elements.map(elem => this.compileExpression(elem));

    // Build a raw SQL expression for the tuple representation
    const parts = elements.map(elem => {
      if (elem.kind === "LiteralExpression") {
        if (elem.type === "string") {
          return "'" + String(elem.value).replace(/'/g, "''") + "'";
        }
        if (elem.type === "number") {
          return String(elem.value);
        }
        if (elem.type === "boolean") {
          return elem.value ? "TRUE" : "FALSE";
        }
        if (elem.type === "null") {
          return "NULL";
        }
      }
      // For non-literal expressions, fall back to a placeholder
      return "?";
    });

    return {
      kind: "RawSQLExpression" as const,
      sql: "(" + parts.join(", ") + ")"
    };
  }

  private compileSubqueryExpression(
    subquery: EdgeQLAST.Subquery
  ): SQL.SQLExpression {
    const compiled = this.compileQuery(subquery.query);

    // compileQuery returns a SQLStatement which could be any statement type.
    // For SubqueryExpression we need a SelectStatement. If it's already one,
    // use it directly. Otherwise wrap in a simple SELECT that references it.
    if (compiled.kind === "SelectStatement") {
      return SQL.createSubqueryExpression(compiled);
    }

    // For CTEStatement, UnionAllStatement, etc. — wrap inside a derived select
    // by placing the statement as a subquery in FROM and selecting *.
    const wrapper: SQL.SelectStatement = SQL.createSelectStatement({
      select: SQL.createSelectClause([
        SQL.createSelectItem(SQL.createColumnReference("*"))
      ]),
      from: SQL.createFromClause([{
        kind: "TableReference",
        name: "",
        subquery: compiled,
        alias: "subq"
      }])
    });

    return SQL.createSubqueryExpression(wrapper);
  }

  private compileIfElse(ifElse: EdgeQLAST.IfElse): SQL.CaseExpression {
    const condition = this.compileExpression(ifElse.condition);
    const thenExpr = this.compileExpression(ifElse.then);
    const elseExpr = this.compileExpression(ifElse.else);

    return SQL.createCaseExpression(
      [SQL.createWhenClause(condition, thenExpr)],
      elseExpr
    );
  }

  /**
   * Compile a multi-branch CASE expression (P1-05). Maps 1:1 to SQL CASE.
   */
  private compileCaseExpression(
    caseExpr: EdgeQLAST.CaseExpression
  ): SQL.CaseExpression {
    const whens = caseExpr.whenClauses.map(clause =>
      SQL.createWhenClause(
        this.compileExpression(clause.condition),
        this.compileExpression(clause.result)
      )
    );
    const elseExpr = caseExpr.elseResult ?
      this.compileExpression(caseExpr.elseResult) :
      undefined;
    return SQL.createCaseExpression(whens, elseExpr);
  }

  private compileArrayExpr(arrayExpr: EdgeQLAST.ArrayExpr): SQL.SQLExpression {
    // P1-07: validate that all literal elements share the same JS type.
    // `[1, 'two']` used to compile to `ARRAY[1, 'two']` which PostgreSQL
    // then rejected at runtime with a cryptic coercion error. Catching the
    // homogeneity violation at compile time points the user at the right
    // source line.
    const literalKinds = new Set<string>();
    for (const el of arrayExpr.elements) {
      if (el.kind === "Literal") {
        literalKinds.add(typeof (el as { value: unknown; }).value);
      }
    }
    if (literalKinds.size > 1) {
      throw new CompilationError(
        `Array literal has mixed element types: ${[...literalKinds].sort().join(", ")}. Arrays must be homogeneous.`
      );
    }
    const elements = arrayExpr.elements.map(el => this.compileExpression(el));
    return SQL.createFunctionCall("ARRAY", elements);
  }

  private compileTupleExpr(tupleExpr: EdgeQLAST.TupleExpr): SQL.SQLExpression {
    const elements = tupleExpr.elements.map(el => this.compileExpression(el));
    return SQL.createFunctionCall("jsonb_build_array", elements);
  }

  private compileTupleAccess(
    access: EdgeQLAST.TupleAccessExpr
  ): SQL.SQLExpression {
    const tupleExpr = this.compileExpression(access.tuple);

    if (access.accessType === "index" && access.index !== undefined) {
      // Numeric index access: tuple_expr -> N
      return SQL.createJsonbAccess(
        tupleExpr,
        "->",
        SQL.createLiteral("number", access.index)
      );
    } else if (access.accessType === "name" && access.fieldName) {
      // Named field access: tuple_expr ->> 'name'
      return SQL.createJsonbAccess(
        tupleExpr,
        "->>",
        SQL.createLiteral("string", access.fieldName)
      );
    }

    throw new CompilationError("Invalid tuple access expression");
  }

  private compileNamedTuple(
    namedTuple: EdgeQLAST.NamedTuple
  ): SQL.SQLExpression {
    const fields = namedTuple.elements.map(el => SQL.createJsonField(el.name, this.compileExpression(el.value)));
    return SQL.createJsonBuildObject(fields);
  }

  private compileDetached(detached: EdgeQLAST.Detached): SQL.SQLExpression {
    // DETACHED strips scope context — compile inner expression without
    // scope resolution (the expression runs in a fresh scope context)
    Context.pushScope(this.ctx);
    try {
      return this.compileExpression(detached.expr);
    } finally {
      Context.popScope(this.ctx);
    }
  }

  /**
   * Compile DESCRIBE TYPE <typeName> into a SELECT statement returning the
   * type description as a JSON literal. The introspection is resolved at
   * compile time from the in-memory schema, then embedded as a SQL string
   * literal so the result passes through PG normally.
   */
  protected compileDescribeType(
    query: EdgeQLAST.DescribeTypeQuery
  ): SQL.SelectStatement {
    const description = describeType(this.ctx.schema, query.typeName);
    const json = JSON.stringify(description);

    // SELECT '<json>'::jsonb
    const rawExpr: SQL.RawSQLExpression = {
      kind: "RawSQLExpression",
      sql: `'${json.replace(/'/g, "''")}'::jsonb`
    };

    return SQL.createSelectStatement({
      select: SQL.createSelectClause([SQL.createSelectItem(rawExpr)])
    });
  }

  /**
   * Compile DESCRIBE SCHEMA into a SELECT statement returning the full schema
   * description as a JSON literal.
   */
  protected compileDescribeSchema(): SQL.SelectStatement {
    const description = describeSchema(this.ctx.schema);
    const json = JSON.stringify(description);

    // SELECT '<json>'::jsonb
    const rawExpr: SQL.RawSQLExpression = {
      kind: "RawSQLExpression",
      sql: `'${json.replace(/'/g, "''")}'::jsonb`
    };

    return SQL.createSelectStatement({
      select: SQL.createSelectClause([SQL.createSelectItem(rawExpr)])
    });
  }

  private compileIntrospection(
    introspection: EdgeQLAST.Introspection
  ): SQL.SQLExpression {
    const typeName = introspection.type.name.parts.join("::");
    throw new CompilationError(
      `Introspection queries (INTROSPECT ${typeName}) are not yet supported. ` +
        `Schema metadata queries require the schema reflection catalog.`
    );
  }

  private compileIndexExpression(
    indexExpr: EdgeQLAST.IndexExpression
  ): SQL.SQLExpression {
    const base = this.compileExpression(indexExpr.expr);
    const idx = this.compileExpression(indexExpr.index);

    // String key access → jsonb -> 'key'
    if (
      indexExpr.index.kind === "Literal" &&
      indexExpr.index.type === "string"
    ) {
      return SQL.createJsonbAccess(base, "->", idx);
    }

    // JSON type cast base → jsonb -> index
    if (
      indexExpr.expr.kind === "TypeCast" &&
      indexExpr.expr.type.name.parts.some((p: string) => p === "json" || p === "jsonb")
    ) {
      return SQL.createJsonbAccess(base, "->", idx);
    }

    // Default: array indexing with negative index support
    // EdgeQL uses 0-based indexing; PG uses 1-based
    // Negative indices count from end: -1 = last element
    const baseStr = this.renderSqlExpr(base);
    const idxStr = this.renderSqlExpr(idx);
    return {
      kind: "RawSQLExpression" as const,
      sql: `(${baseStr})[CASE WHEN ${idxStr} < 0 THEN CARDINALITY(${baseStr}) + ${idxStr} + 1 ELSE ${idxStr} + 1 END]`
    };
  }

  private compileSliceExpression(
    sliceExpr: EdgeQLAST.SliceExpression
  ): SQL.SQLExpression {
    const base = this.compileExpression(sliceExpr.expr);
    const baseStr = this.renderSqlExpr(base);

    const hasStart = sliceExpr.start !== undefined;
    const hasEnd = sliceExpr.end !== undefined;

    if (!hasStart && !hasEnd) {
      // [:] — identity
      return base;
    }

    if (hasStart && hasEnd) {
      // [a:b] → SUBSTRING(expr FROM a+1 FOR b-a)
      const startStr = this.renderSqlExpr(
        this.compileExpression(sliceExpr.start!)
      );
      const endStr = this.renderSqlExpr(
        this.compileExpression(sliceExpr.end!)
      );
      return {
        kind: "RawSQLExpression" as const,
        sql: `SUBSTRING(${baseStr} FROM ${startStr} + 1 FOR ${endStr} - ${startStr})`
      };
    }

    if (hasStart) {
      // [a:] → SUBSTRING(expr FROM a+1)
      const startStr = this.renderSqlExpr(
        this.compileExpression(sliceExpr.start!)
      );
      return {
        kind: "RawSQLExpression" as const,
        sql: `SUBSTRING(${baseStr} FROM ${startStr} + 1)`
      };
    }

    // [:b] → SUBSTRING(expr FROM 1 FOR b)
    const endStr = this.renderSqlExpr(
      this.compileExpression(sliceExpr.end!)
    );
    return {
      kind: "RawSQLExpression" as const,
      sql: `SUBSTRING(${baseStr} FROM 1 FOR ${endStr})`
    };
  }
}
