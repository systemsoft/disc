/**
 * Complex Query Compiler
 * Advanced EdgeQL to SQL compilation with optimization
 */

import * as EdgeQLAST from "../edgeql/ast.ts";
import * as SQL from "./sql.ts";
import * as Context from "./context.ts";
import { Result, Ok, Err } from "../lib/result.ts";
import { CompilationError } from "../lib/errors.ts";
import { EdgeQLCompiler } from "./compiler.ts";

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
  compile(query: EdgeQLAST.Query): Result<SQL.SQLStatement, CompilationError> {
    try {
      // Analyze complexity first
      const complexity = this.analyzeComplexity(query);

      if (complexity.score > 100) {
        console.warn("Query complexity score:", complexity.score);
        complexity.warnings.forEach(w => console.warn(w));
      }

      // Rewrite query for optimization
      const optimizedQuery = this.optimizeQuery(query);

      // Compile with CTEs if present
      if (query.with && query.with.length > 0) {
        return Ok(this.compileWithCTEs(optimizedQuery));
      }

      // Standard compilation
      return super.compile(optimizedQuery);
    } catch (error) {
      return Err(new CompilationError(`Complex query compilation failed: ${error}`));
    }
  }

  /**
   * Compile query with CTEs (Common Table Expressions)
   */
  private compileWithCTEs(query: EdgeQLAST.Query): SQL.SQLStatement {
    const ctes: SQL.CTE[] = [];

    // Compile each CTE
    for (const cte of query.with || []) {
      const cteSQL = this.compileCTE(cte);
      ctes.push(cteSQL);
    }

    // Compile main query
    const mainQuery = this.compileQuery(query);

    // Combine CTEs with main query
    return SQL.withCTEs(ctes, mainQuery);
  }

  /**
   * Compile a single CTE
   */
  private compileCTE(cte: any): SQL.CTE {
    const query = this.compileQuery(cte.query);

    return {
      name: cte.name,
      recursive: cte.recursive || false,
      columns: cte.columns || [],
      query: query
    };
  }

  /**
   * Compile subquery with optimization
   */
  compileSubquery(subquery: any, depth: number = 0): SQL.SQLStatement {
    if (depth > this.maxSubqueryDepth) {
      throw new CompilationError(`Subquery depth exceeds maximum of ${this.maxSubqueryDepth}`);
    }

    // Check if subquery can be converted to JOIN
    if (this.canConvertToJoin(subquery)) {
      return this.convertSubqueryToJoin(subquery);
    }

    // Check if subquery is correlated
    if (this.isCorrelatedSubquery(subquery)) {
      return this.optimizeCorrelatedSubquery(subquery, depth);
    }

    // Standard subquery compilation
    return this.compileQuery(subquery.query);
  }

  /**
   * Optimize correlated subquery using LATERAL JOIN
   */
  private optimizeCorrelatedSubquery(subquery: any, depth: number): SQL.SQLStatement {
    // Convert correlated subquery to LATERAL JOIN for better performance
    const lateral = SQL.lateral(this.compileQuery(subquery.query));

    return SQL.select({
      from: lateral,
      selections: subquery.selections || ["*"]
    });
  }

  /**
   * Check if subquery can be converted to JOIN
   */
  private canConvertToJoin(subquery: any): boolean {
    // Simple IN/EXISTS subqueries can often be converted to JOINs
    if (!subquery.query) return false;

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
    if (!subquery.query) return false;

    // Check for outer references
    return this.hasOuterReferences(subquery.query);
  }

  /**
   * Check if query has outer references
   */
  private hasOuterReferences(query: any): boolean {
    // Recursively check for OuterRef nodes
    const checkNode = (node: any): boolean => {
      if (!node) return false;

      if (node.kind === "OuterRef") {
        return true;
      }

      // Check all properties recursively
      for (const key in node) {
        const value = node[key];
        if (typeof value === "object") {
          if (Array.isArray(value)) {
            if (value.some(checkNode)) return true;
          } else {
            if (checkNode(value)) return true;
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
      if (!node) return false;

      if (node.kind === "Aggregate") {
        return true;
      }

      for (const key in node) {
        const value = node[key];
        if (typeof value === "object") {
          if (Array.isArray(value)) {
            if (value.some(checkNode)) return true;
          } else {
            if (checkNode(value)) return true;
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
  compileWindowFunction(windowFunc: any): SQL.SQLStatement {
    const func = windowFunc.function;
    const args = windowFunc.args || [];

    // Build OVER clause
    const overClause: any = {};

    if (windowFunc.partitionBy) {
      overClause.partitionBy = windowFunc.partitionBy.map((expr: any) =>
        this.compileExpression(expr)
      );
    }

    if (windowFunc.orderBy) {
      overClause.orderBy = windowFunc.orderBy.map((item: any) => ({
        expression: this.compileExpression(item.expression),
        direction: item.direction || "ASC"
      }));
    }

    if (windowFunc.frame) {
      overClause.frame = this.compileWindowFrame(windowFunc.frame);
    }

    return SQL.windowFunction(func, args, overClause);
  }

  /**
   * Compile window frame specification
   */
  private compileWindowFrame(frame: any): any {
    return {
      mode: frame.mode || "RANGE",
      start: frame.start || "UNBOUNDED PRECEDING",
      end: frame.end || "CURRENT ROW",
      exclude: frame.exclude
    };
  }

  /**
   * Compile aggregate function with FILTER clause
   */
  compileAggregate(aggregate: any): SQL.SQLStatement {
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
    let optimized = { ...query };

    if (this.optimizationLevel >= 1) {
      // Basic optimizations
      optimized = this.pushDownPredicates(optimized);
      optimized = this.eliminateRedundantJoins(optimized);
      optimized = this.simplifyExpressions(optimized);
    }

    if (this.optimizationLevel >= 2) {
      // Aggressive optimizations
      optimized = this.reorderJoins(optimized);
      optimized = this.materializeCommonSubexpressions(optimized);
      optimized = this.partitionAggregates(optimized);
    }

    return optimized;
  }

  /**
   * Push predicates down to reduce data early
   */
  private pushDownPredicates(query: EdgeQLAST.Query): EdgeQLAST.Query {
    // Move WHERE conditions closer to table scans
    if (!query.filter || !query.joins) return query;

    const optimized = { ...query };
    const predicates = this.extractPredicates(query.filter);

    // Analyze which predicates can be pushed to which tables
    for (const join of query.joins || []) {
      const relevantPredicates = predicates.filter(p =>
        this.predicateReferencesTable(p, join.target)
      );

      if (relevantPredicates.length > 0) {
        // Add predicates to join condition
        join.on = this.combinePredicates([join.on, ...relevantPredicates]);
      }
    }

    return optimized;
  }

  /**
   * Eliminate redundant joins
   */
  private eliminateRedundantJoins(query: EdgeQLAST.Query): EdgeQLAST.Query {
    if (!query.joins) return query;

    const optimized = { ...query };
    const usedTables = this.findReferencedTables(query);

    // Remove joins that aren't referenced
    optimized.joins = query.joins.filter(join =>
      usedTables.has(this.getTableName(join.target))
    );

    return optimized;
  }

  /**
   * Simplify expressions
   */
  private simplifyExpressions(query: EdgeQLAST.Query): EdgeQLAST.Query {
    // Simplify boolean expressions, constant folding, etc.
    const optimized = { ...query };

    if (query.filter) {
      optimized.filter = this.simplifyExpression(query.filter);
    }

    return optimized;
  }

  /**
   * Reorder joins for optimal execution
   */
  private reorderJoins(query: EdgeQLAST.Query): EdgeQLAST.Query {
    if (!query.joins || query.joins.length < 2) return query;

    // Use statistics and cardinality estimates to reorder
    const optimized = { ...query };
    const joinOrder = this.calculateOptimalJoinOrder(query.joins);

    optimized.joins = joinOrder;

    return optimized;
  }

  /**
   * Calculate optimal join order based on estimated cardinality
   */
  private calculateOptimalJoinOrder(joins: any[]): any[] {
    // Simple heuristic: put smaller tables first
    // In practice, this would use table statistics
    return [...joins].sort((a, b) => {
      const sizeA = this.estimateTableSize(a.target);
      const sizeB = this.estimateTableSize(b.target);
      return sizeA - sizeB;
    });
  }

  /**
   * Materialize common subexpressions
   */
  private materializeCommonSubexpressions(query: EdgeQLAST.Query): EdgeQLAST.Query {
    // Find expressions that appear multiple times
    const expressions = this.findAllExpressions(query);
    const counts = new Map<string, number>();

    for (const expr of expressions) {
      const key = this.serializeExpression(expr);
      counts.set(key, (counts.get(key) || 0) + 1);
    }

    // Expressions used more than twice could be materialized
    const toMaterialize = Array.from(counts.entries())
      .filter(([_, count]) => count > 2)
      .map(([key, _]) => key);

    if (toMaterialize.length === 0) return query;

    // Create CTEs for common expressions
    const optimized = { ...query };
    optimized.with = optimized.with || [];

    // Add CTEs for materialized expressions
    // (simplified implementation)

    return optimized;
  }

  /**
   * Partition aggregates for parallel execution
   */
  private partitionAggregates(query: EdgeQLAST.Query): EdgeQLAST.Query {
    // Split aggregates that can be computed in parallel
    if (!this.hasAggregates(query)) return query;

    // Implementation would partition by grouping keys
    return query;
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

    // Count CTEs
    complexity.cteCount = (query.with || []).length;
    complexity.score += complexity.cteCount * 5;

    // Count joins
    complexity.joinCount = (query.joins || []).length;
    complexity.score += complexity.joinCount * 3;

    // Count subqueries, aggregates, and window functions
    this.analyzeNode(query, complexity);

    // Estimate cost
    complexity.estimatedCost = this.estimateCost(query);

    // Add warnings
    if (complexity.cteCount > this.maxCTECount) {
      complexity.warnings.push(`CTE count (${complexity.cteCount}) exceeds recommended maximum (${this.maxCTECount})`);
    }

    if (complexity.subqueryCount > 10) {
      complexity.warnings.push(`High subquery count (${complexity.subqueryCount}) may impact performance`);
    }

    if (complexity.score > 50) {
      complexity.warnings.push("Query complexity is high, consider breaking into smaller queries");
    }

    return complexity;
  }

  /**
   * Recursively analyze AST node for complexity
   */
  private analyzeNode(node: any, complexity: QueryComplexity): void {
    if (!node) return;

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

    // Add cost for joins
    cost += (query.joins || []).length * 1000;

    // Add cost for sorting
    if (query.orderBy) {
      cost += 500;
    }

    // Add cost for grouping
    if (query.groupBy) {
      cost += 750;
    }

    // Add cost for CTEs
    cost += (query.with || []).length * 500;

    return cost;
  }

  // Helper methods

  private extractPredicates(filter: any): any[] {
    if (!filter) return [];

    if (filter.kind === "LogicalOp" && filter.op === "AND") {
      return filter.operands;
    }

    return [filter];
  }

  private predicateReferencesTable(predicate: any, table: any): boolean {
    // Check if predicate references the given table
    const tableName = this.getTableName(table);
    return this.serializeExpression(predicate).includes(tableName);
  }

  private combinePredicates(predicates: any[]): any {
    const filtered = predicates.filter(p => p);
    if (filtered.length === 0) return null;
    if (filtered.length === 1) return filtered[0];

    return {
      kind: "LogicalOp",
      op: "AND",
      operands: filtered
    };
  }

  private findReferencedTables(query: any): Set<string> {
    const tables = new Set<string>();

    const findInNode = (node: any) => {
      if (!node) return;

      if (node.kind === "Path" && node.steps.length > 1) {
        tables.add(node.steps[0]);
      }

      for (const key in node) {
        const value = node[key];
        if (typeof value === "object") {
          if (Array.isArray(value)) {
            value.forEach(findInNode);
          } else {
            findInNode(value);
          }
        }
      }
    };

    findInNode(query);
    return tables;
  }

  private getTableName(tableRef: any): string {
    if (tableRef.alias) return tableRef.alias;
    if (tableRef.name) return tableRef.name;
    return "";
  }

  private estimateTableSize(table: any): number {
    // In practice, this would use table statistics
    // For now, use simple heuristics
    const name = this.getTableName(table).toLowerCase();

    if (name.includes("user")) return 1000;
    if (name.includes("post")) return 10000;
    if (name.includes("comment")) return 100000;

    return 5000; // Default
  }

  private findAllExpressions(query: any): any[] {
    const expressions: any[] = [];

    const collectExpressions = (node: any) => {
      if (!node) return;

      if (node.kind === "BinaryOp" || node.kind === "UnaryOp" || node.kind === "Function") {
        expressions.push(node);
      }

      for (const key in node) {
        const value = node[key];
        if (typeof value === "object") {
          if (Array.isArray(value)) {
            value.forEach(collectExpressions);
          } else {
            collectExpressions(value);
          }
        }
      }
    };

    collectExpressions(query);
    return expressions;
  }

  private serializeExpression(expr: any): string {
    return JSON.stringify(expr);
  }

  private simplifyExpression(expr: any): any {
    // Simplify boolean expressions
    if (expr.kind === "LogicalOp") {
      // Remove duplicate conditions
      const seen = new Set<string>();
      const unique = expr.operands.filter((op: any) => {
        const key = this.serializeExpression(op);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      if (unique.length === 1) return unique[0];

      return { ...expr, operands: unique };
    }

    // Constant folding
    if (expr.kind === "BinaryOp") {
      if (expr.left.kind === "Literal" && expr.right.kind === "Literal") {
        // Evaluate constant expression
        return this.evaluateConstant(expr);
      }
    }

    return expr;
  }

  private evaluateConstant(expr: any): any {
    const left = expr.left.value;
    const right = expr.right.value;

    switch (expr.op) {
      case "+": return { kind: "Literal", value: left + right };
      case "-": return { kind: "Literal", value: left - right };
      case "*": return { kind: "Literal", value: left * right };
      case "/": return { kind: "Literal", value: left / right };
      case "=": return { kind: "Literal", value: left === right };
      case "!=": return { kind: "Literal", value: left !== right };
      case "<": return { kind: "Literal", value: left < right };
      case ">": return { kind: "Literal", value: left > right };
      case "<=": return { kind: "Literal", value: left <= right };
      case ">=": return { kind: "Literal", value: left >= right };
      default: return expr;
    }
  }
}
