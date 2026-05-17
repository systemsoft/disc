/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

// deno-lint-ignore-file no-console
/**
 * Complex Query Compiler
 * Advanced EdgeQL to SQL compilation with optimization
 */

import * as EdgeQLAST from "../edgeql/ast.ts";
import { CompilationError } from "../lib/errors.ts";
import { Err, Ok, Result } from "../lib/result.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import * as Context from "./context.ts";
import * as SQL from "./sql.ts";

export interface QueryComplexity {
  score: number;
  cteCount: number;
  joinCount: number;
  subqueryCount: number;
  aggregateCount: number;
  windowFunctionCount: number;
  estimatedCost: number;
  warnings: string[];
}

export interface OptimizationHints {
  useIndexes: string[];
  suggestedIndexes: string[];
  rewriteSuggestions: string[];
  performanceWarnings: string[];
}

export class ComplexQueryCompiler extends EdgeQLCompiler {
  private optimizationLevel: number = 2; // 0 = none, 1 = basic, 2 = aggressive
  private maxSubqueryDepth: number = 5;
  private maxCTECount: number = 10;

  constructor(schema: Context.Schema, options?: any) {
    super(schema, options);
  }

  /**
   * Compile query with advanced optimization
   */
  override compile(
    query: EdgeQLAST.Query
  ): Result<SQL.SQLStatement, CompilationError> {
    try {
      // Analyze complexity first
      const complexity = this.analyzeComplexity(query);

      if (complexity.score > 100) {
        console.warn("Query complexity score:", complexity.score);
        complexity.warnings.forEach(w => console.warn(w));
      }

      // Rewrite query for optimization
      const optimizedQuery = this.optimizeQuery(query);

      // Compile with CTEs if present (WithBlock query type)
      if (optimizedQuery.kind === "WithBlock") {
        return Ok(this.compileWithCTEs(optimizedQuery));
      }

      // Standard compilation
      return super.compile(optimizedQuery);
    } catch (error) {
      return Err(
        new CompilationError(`Complex query compilation failed: ${error}`)
      );
    }
  }

  /**
   * Compile query with CTEs (Common Table Expressions)
   */
  private compileWithCTEs(query: EdgeQLAST.WithBlock): SQL.SQLStatement {
    const ctes: SQL.CTE[] = [];

    // Compile each CTE from bindings
    for (const binding of query.bindings) {
      const cteSQL = this.compileCTE(binding);
      ctes.push(cteSQL);
    }

    // Compile main query
    const mainQuery = this.compileQuery(query.body);

    // Combine CTEs with main query
    return SQL.withCTEs(ctes, mainQuery);
  }

  /**
   * Compile a single CTE from a WithBinding
   */
  private compileCTE(binding: any): SQL.CTE {
    // A WithBinding has: name (Identifier), value (Expression, usually Subquery)
    let query: SQL.SQLStatement;
    if (binding.value && binding.value.kind === "Subquery") {
      query = this.compileQuery(binding.value.query);
    } else if (binding.value) {
      // Direct expression - wrap in a SELECT
      const expr = this.compileExpression(binding.value);
      query = SQL.createSelectStatement({
        select: SQL.createSelectClause([SQL.createSelectItem(expr)])
      });
    } else if (binding.query) {
      // Fallback: direct query property
      query = this.compileQuery(binding.query);
    } else {
      throw new CompilationError("CTE binding has no value or query");
    }

    const name = typeof binding.name === "string" ?
      binding.name :
      binding.name?.name || "cte";

    return {
      kind: "CTE",
      name: name,
      recursive: binding.recursive || false,
      columns: binding.columns || [],
      query: query
    };
  }

  /**
   * Compile subquery with optimization
   */
  compileSubquery(subquery: any, depth: number = 0): SQL.SQLStatement {
    if (depth > this.maxSubqueryDepth) {
      throw new CompilationError(
        `Subquery depth exceeds maximum of ${this.maxSubqueryDepth}`
      );
    }

    // Check if subquery can be converted to JOIN
    if (this.canConvertToJoin(subquery)) {
      return this.convertSubqueryToJoin(subquery);
    }

    // Check if subquery is correlated
    if (this.isCorrelatedSubquery(subquery)) {
      return this.optimizeCorrelatedSubquery(subquery);
    }

    // Standard subquery compilation
    return this.compileQuery(subquery.query);
  }

  /**
   * Optimize correlated subquery using LATERAL JOIN
   */
  private optimizeCorrelatedSubquery(subquery: any): SQL.SQLStatement {
    // Convert correlated subquery to LATERAL JOIN for better performance
    return SQL.select({
      from: this.compileQuery(subquery.query),
      selections: subquery.selections || ["*"]
    });
  }

  /**
   * Check if subquery can be converted to JOIN
   */
  private canConvertToJoin(subquery: any): boolean {
    // Simple IN/EXISTS subqueries can often be converted to JOINs
    if (!subquery.query) {
      return false;
    }

    const query = subquery.query;

    // Check for simple IN clause pattern
    if (subquery.operator === "IN" && !this.hasAggregates(query)) {
      return true;
    }

    // Check for EXISTS pattern
    if (subquery.operator === "EXISTS" && !this.hasAggregates(query)) {
      return true;
    }

    return false;
  }

  /**
   * Convert subquery to JOIN
   */
  private convertSubqueryToJoin(subquery: any): SQL.SQLStatement {
    const query = subquery.query;

    if (subquery.operator === "IN") {
      // Convert IN subquery to INNER JOIN
      return SQL.innerJoin({
        left: subquery.left,
        right: this.compileQuery(query),
        on: SQL.eq(subquery.correlationField, query.selections[0])
      });
    }

    if (subquery.operator === "EXISTS") {
      // Convert EXISTS to LEFT JOIN with IS NOT NULL check
      return SQL.leftJoin({
        left: subquery.left,
        right: this.compileQuery(query),
        on: subquery.correlationCondition,
        where: SQL.isNotNull(query.selections[0])
      });
    }

    return this.compileQuery(query);
  }

  /**
   * Check if subquery is correlated
   */
  private isCorrelatedSubquery(subquery: any): boolean {
    if (!subquery.query) {
      return false;
    }

    // Check for outer references
    return this.hasOuterReferences(subquery.query);
  }

  /**
   * Check if query has outer references
   */
  private hasOuterReferences(query: any): boolean {
    // Recursively check for OuterRef nodes
    const checkNode = (node: any): boolean => {
      if (!node) {
        return false;
      }

      if (node.kind === "OuterRef") {
        return true;
      }

      // Check all properties recursively
      for (const key in node) {
        const value = node[key];
        if (typeof value === "object") {
          if (Array.isArray(value)) {
            if (value.some(checkNode)) {
              return true;
            }
          } else {
            if (checkNode(value)) {
              return true;
            }
          }
        }
      }

      return false;
    };

    return checkNode(query);
  }

  /**
   * Check if query has aggregates
   */
  private hasAggregates(query: any): boolean {
    const checkNode = (node: any): boolean => {
      if (!node) {
        return false;
      }

      if (node.kind === "Aggregate") {
        return true;
      }

      for (const key in node) {
        const value = node[key];
        if (typeof value === "object") {
          if (Array.isArray(value)) {
            if (value.some(checkNode)) {
              return true;
            }
          } else {
            if (checkNode(value)) {
              return true;
            }
          }
        }
      }

      return false;
    };

    return checkNode(query);
  }

  /**
   * Compile window function
   */
  compileWindowFunction(windowFunc: any): SQL.WindowFunctionExpression {
    const func = windowFunc.function;
    const args = (windowFunc.args || []).map((arg: any) => this.compileExpression(arg));

    // Build OVER clause
    const overClause: SQL.WindowClause = {
      kind: "WindowClause",
      partitionBy: windowFunc.partitionBy?.map((expr: any) => this.compileExpression(expr)),
      orderBy: windowFunc.orderBy?.map((item: any) => ({
        kind: "OrderByItem" as const,
        expression: this.compileExpression(item.expression),
        direction: (item.direction || "ASC") as "ASC" | "DESC"
      })),
      frame: windowFunc.frame ?
        this.compileWindowFrame(windowFunc.frame) :
        undefined
    };

    return SQL.windowFunction(func, args, overClause);
  }

  /**
   * Compile window frame specification
   */
  private compileWindowFrame(frame: any): SQL.WindowFrame {
    return {
      kind: "WindowFrame",
      mode: frame.mode || "RANGE",
      start: frame.start || "UNBOUNDED PRECEDING",
      end: frame.end || "CURRENT ROW",
      exclude: frame.exclude
    };
  }

  /**
   * Compile aggregate function with FILTER clause
   */
  compileAggregate(aggregate: any): SQL.AggregateExpression {
    const func = aggregate.function;
    const expr = aggregate.expression ?
      this.compileExpression(aggregate.expression) :
      SQL.star();

    let result = SQL.aggregate(func, expr);

    // Add FILTER clause if present
    if (aggregate.filter) {
      const filterExpr = this.compileExpression(aggregate.filter);
      result = SQL.aggregateWithFilter(result, filterExpr);
    }

    // Add DISTINCT if specified
    if (aggregate.distinct) {
      result = SQL.distinct(result);
    }

    return result;
  }

  /**
   * Optimize query using various techniques
   */
  private optimizeQuery(query: EdgeQLAST.Query): EdgeQLAST.Query {
    let optimized = query;

    if (this.optimizationLevel >= 1) {
      // Basic optimizations
      optimized = this.pushDownPredicates(optimized);
      optimized = this.simplifyExpressions(optimized);
    }

    return optimized;
  }

  /**
   * Push predicates down to reduce data early
   */
  private pushDownPredicates(query: EdgeQLAST.Query): EdgeQLAST.Query {
    // Only applicable to SELECT queries with filters
    if (query.kind !== "SelectQuery" || !query.filter) {
      return query;
    }

    // In a full implementation, this would move WHERE conditions
    // closer to table scans in join-heavy queries
    return query;
  }

  /**
   * Simplify expressions
   */
  private simplifyExpressions(query: EdgeQLAST.Query): EdgeQLAST.Query {
    // Only applicable to queries with filters
    if (query.kind !== "SelectQuery" || !query.filter) {
      return query;
    }

    const optimized = { ...query };
    optimized.filter = this.simplifyExpression(query.filter);
    return optimized;
  }

  /**
   * Analyze query complexity
   */
  analyzeComplexity(query: EdgeQLAST.Query): QueryComplexity {
    const complexity: QueryComplexity = {
      score: 0,
      cteCount: 0,
      joinCount: 0,
      subqueryCount: 0,
      aggregateCount: 0,
      windowFunctionCount: 0,
      estimatedCost: 0,
      warnings: []
    };

    // Count CTEs (WithBlock has bindings)
    if (query.kind === "WithBlock") {
      complexity.cteCount = query.bindings.length;
      complexity.score += complexity.cteCount * 5;
    }

    // Count subqueries, aggregates, and window functions
    this.analyzeNode(query, complexity);

    // Estimate cost
    complexity.estimatedCost = this.estimateCost(query);

    // Add warnings
    if (complexity.cteCount > this.maxCTECount) {
      complexity.warnings.push(
        `CTE count (${complexity.cteCount}) exceeds recommended maximum (${this.maxCTECount})`
      );
    }

    if (complexity.subqueryCount > 10) {
      complexity.warnings.push(
        `High subquery count (${complexity.subqueryCount}) may impact performance`
      );
    }

    if (complexity.score > 50) {
      complexity.warnings.push(
        "Query complexity is high, consider breaking into smaller queries"
      );
    }

    return complexity;
  }

  /**
   * Recursively analyze AST node for complexity
   */
  private analyzeNode(node: any, complexity: QueryComplexity): void {
    if (!node) {
      return;
    }

    if (node.kind === "Subquery") {
      complexity.subqueryCount++;
      complexity.score += 5;
      this.analyzeNode(node.query, complexity);
    } else if (node.kind === "Aggregate") {
      complexity.aggregateCount++;
      complexity.score += 2;
    } else if (node.kind === "WindowFunction") {
      complexity.windowFunctionCount++;
      complexity.score += 4;
    }

    // Recursively analyze all properties
    for (const key in node) {
      const value = node[key];
      if (typeof value === "object") {
        if (Array.isArray(value)) {
          value.forEach(item => this.analyzeNode(item, complexity));
        } else {
          this.analyzeNode(value, complexity);
        }
      }
    }
  }

  /**
   * Estimate query cost
   */
  private estimateCost(query: EdgeQLAST.Query): number {
    let cost = 100; // Base cost

    // Add cost for sorting
    if (query.kind === "SelectQuery" && query.orderBy) {
      cost += 500;
    }

    // Add cost for CTEs
    if (query.kind === "WithBlock") {
      cost += query.bindings.length * 500;
    }

    return cost;
  }

  // Helper methods

  private simplifyExpression(expr: any): any {
    // Simplify boolean expressions
    if (expr.kind === "LogicalOp") {
      // Remove duplicate conditions
      const seen = new Set<string>();
      const unique = expr.operands.filter((op: any) => {
        const key = JSON.stringify(op);
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });

      if (unique.length === 1) {
        return unique[0];
      }

      return { ...expr, operands: unique };
    }

    // Constant folding
    if (expr.kind === "BinaryOp") {
      if (expr.left.kind === "Literal" && expr.right.kind === "Literal") {
        return this.evaluateConstant(expr);
      }
    }

    return expr;
  }

  private evaluateConstant(expr: any): any {
    const left = expr.left.value;
    const right = expr.right.value;

    switch (expr.op) {
      case "+":
        return { kind: "Literal", value: left + right };
      case "-":
        return { kind: "Literal", value: left - right };
      case "*":
        return { kind: "Literal", value: left * right };
      case "/":
        return { kind: "Literal", value: left / right };
      case "=":
        return { kind: "Literal", value: left === right };
      case "!=":
        return { kind: "Literal", value: left !== right };
      case "<":
        return { kind: "Literal", value: left < right };
      case ">":
        return { kind: "Literal", value: left > right };
      case "<=":
        return { kind: "Literal", value: left <= right };
      case ">=":
        return { kind: "Literal", value: left >= right };
      default:
        return expr;
    }
  }
}
