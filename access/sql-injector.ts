/**
 * SQL Injector for Access Policies
 *
 * Injects access control conditions into SQL queries
 */

import { AccessContext, AccessDecision } from "./types.ts";
import { AccessEvaluator } from "./evaluator.ts";

export interface SQLQuery {
  params: any[];
  text: string;
}

export class AccessSQLInjector {
  private evaluator: AccessEvaluator;

  constructor(evaluator: AccessEvaluator) {
    this.evaluator = evaluator;
  }

  /**
   * Inject access conditions into a SELECT query
   */
  injectSelect(
    query: SQLQuery,
    tableName: string,
    objectType: string,
    context: AccessContext
  ): SQLQuery {
    const decision = this.evaluator.evaluate(objectType, "select", context);

    if (!decision.allowed) {
      // Return a query that returns no results
      return {
        params: [],
        text: `SELECT * FROM ${tableName} WHERE FALSE`
      };
    }

    if (!decision.sqlConditions || decision.sqlConditions.length === 0) {
      // No conditions to inject
      return query;
    }

    // Inject WHERE conditions
    return this.injectWhereConditions(query, decision.sqlConditions);
  }

  /**
   * Inject access conditions into an INSERT query
   */
  injectInsert(
    query: SQLQuery,
    tableName: string,
    objectType: string,
    context: AccessContext
  ): SQLQuery {
    const decision = this.evaluator.evaluate(objectType, "insert", context);

    if (!decision.allowed)
      throw new Error(`INSERT not allowed on ${objectType}: ${decision.reason}`);

    // For INSERT, we might add WITH CHECK conditions
    // This would be implemented as a CHECK constraint or trigger
    return query;
  }

  /**
   * Inject access conditions into an UPDATE query
   */
  injectUpdate(
    query: SQLQuery,
    tableName: string,
    objectType: string,
    context: AccessContext,
    columns?: string[]
  ): SQLQuery {
    const decision = this.evaluator.evaluate(objectType, "update", context);

    if (!decision.allowed)
      throw new Error(`UPDATE not allowed on ${objectType}: ${decision.reason}`);

    if (!decision.sqlConditions || decision.sqlConditions.length === 0)
      return query;

    // Inject WHERE conditions to restrict which rows can be updated
    return this.injectWhereConditions(query, decision.sqlConditions);
  }

  /**
   * Inject access conditions into a DELETE query
   */
  injectDelete(
    query: SQLQuery,
    tableName: string,
    objectType: string,
    context: AccessContext
  ): SQLQuery {
    const decision = this.evaluator.evaluate(objectType, "delete", context);

    if (!decision.allowed)
      throw new Error(`DELETE not allowed on ${objectType}: ${decision.reason}`);

    if (!decision.sqlConditions || decision.sqlConditions.length === 0)
      return query;

    // Inject WHERE conditions to restrict which rows can be deleted
    return this.injectWhereConditions(query, decision.sqlConditions);
  }

  /**
   * Inject WHERE conditions into a query
   */
  private injectWhereConditions(
    query: SQLQuery,
    conditions: string[]
  ): SQLQuery {
    const { text, params } = query;

    // Combine all conditions with AND
    const conditionSQL = conditions.map(c => `(${c})`).join(" AND ");

    // Check if query already has WHERE clause
    const whereMatch = text.match(/\bWHERE\b/i);
    let newText: string;

    if (whereMatch) {
      // Add conditions to existing WHERE clause
      const whereIndex = whereMatch.index!;
      const beforeWhere = text.substring(0, whereIndex + 5);
      const afterWhere = text.substring(whereIndex + 5);
      newText = `${beforeWhere} (${conditionSQL}) AND ${afterWhere}`;
    } else {
      // Add WHERE clause
      const fromMatch = text.match(/\bFROM\s+(\w+)/i);

      if (fromMatch) {
        const afterFrom = fromMatch.index! + fromMatch[0].length;
        const beforeFrom = text.substring(0, afterFrom);
        const afterFromText = text.substring(afterFrom);
        // Check for JOIN, GROUP BY, ORDER BY, etc.
        const clauseMatch = afterFromText.match(/\b(JOIN|GROUP\s+BY|ORDER\s+BY|LIMIT|OFFSET)\b/i);

        if (clauseMatch) {
          const clauseIndex = clauseMatch.index!;
          newText = `${beforeFrom}${afterFromText.substring(0, clauseIndex)} WHERE ${conditionSQL} ${afterFromText.substring(clauseIndex)}`;
        } else {
          newText = `${text} WHERE ${conditionSQL}`;
        }
      } else {
        // Couldn't parse query structure, append WHERE
        newText = `${text} WHERE ${conditionSQL}`;
      }
    }

    return {
      params,
      text: newText
    };
  }

  /**
   * Create row-level security policies for PostgreSQL
   */
  generateRLSPolicies(tableName: string, objectType: string): string[] {
    const policies = this.evaluator.getPolicies(objectType);
    const statements: string[] = [];

    // Enable RLS on the table
    statements.push(`ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY;`);

    for (const policy of policies) {
      const policyName = `${tableName}_${policy.name}`.toLowerCase();

      // Drop existing policy
      statements.push(`DROP POLICY IF EXISTS ${policyName} ON ${tableName};`);

      // Build policy operations
      const operations: string[] = [];

      for (const action of policy.actions) {
        if (action.allow) {
          for (const op of action.operations) {
            if (op === "all") {
              operations.push("ALL");
              break;
            } else if (op === "select") {
              operations.push("SELECT");
            } else if (op === "insert") {
              operations.push("INSERT");
            } else if (op === "update") {
              operations.push("UPDATE");
            } else if (op === "delete") {
              operations.push("DELETE");
            }
          }
        }
      }

      if (operations.length === 0)
        continue;

      // Create policy statement
      let policySQL = `CREATE POLICY ${policyName} ON ${tableName}\n`;

      policySQL += `  FOR ${operations.join(", ")}\n`;
      policySQL += `  TO PUBLIC\n`; // Or specific roles

      if (policy.using) {
        // This would need to convert the expression to SQL
        policySQL += `  USING (/* TODO: Convert policy.using to SQL */)`;
      } else {
        policySQL += `  USING (TRUE)`; // Allow all rows by default
      }

      if (policy.withCheck)
        policySQL += `\n  WITH CHECK (/* TODO: Convert policy.withCheck to SQL */)`;

      policySQL += ";";
      statements.push(policySQL);
    }

    return statements;
  }

  /**
   * Check if a query needs access control injection
   */
  needsInjection(
    operation: "select" | "insert" | "update" | "delete",
    objectType: string
  ): boolean {
    const policies = this.evaluator.getPolicies(objectType);
    const globalPolicies = this.evaluator.getPolicies();

    return policies.length > 0 || globalPolicies.length > 0;
  }
}
