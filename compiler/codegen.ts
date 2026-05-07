/**
 * SQL Code Generator
 * Converts SQL AST to PostgreSQL string representation
 */

import * as SQL from "./sql.ts";

export class SQLCodeGenerator {
  private static readonly RESERVED_KEYWORDS = new Set([
    "SELECT",
    "FROM",
    "WHERE",
    "INSERT",
    "UPDATE",
    "DELETE",
    "JOIN",
    "INNER",
    "LEFT",
    "RIGHT",
    "FULL",
    "ON",
    "AS",
    "AND",
    "OR",
    "NOT",
    "ORDER",
    "BY",
    "GROUP",
    "HAVING",
    "LIMIT",
    "OFFSET",
    "DISTINCT",
    "CASE",
    "WHEN",
    "THEN",
    "ELSE",
    "END",
    "NULL",
    "TRUE",
    "FALSE",
  ]);

  private indentLevel = 0;
  private readonly indentSize = 2;

  generate(statement: SQL.SQLStatement): string {
    return this.generateStatement(statement);
  }

  private generateStatement(stmt: SQL.SQLStatement): string {
    switch (stmt.kind) {
      case "SelectStatement":
        return this.generateSelectStatement(stmt);
      case "InsertStatement":
        return this.generateInsertStatement(stmt);
      case "UpdateStatement":
        return this.generateUpdateStatement(stmt);
      case "DeleteStatement":
        return this.generateDeleteStatement(stmt);
      case "CTEStatement":
        return this.generateCTEStatement(stmt);
      case "UnionAllStatement":
        return this.generateUnionAllStatement(stmt);
      case "RawSQLStatement":
        return stmt.sql;
      default:
        throw new Error(
          `Unsupported statement type: ${(stmt as never as { kind: string; }).kind}`,
        );
    }
  }

  private generateSelectStatement(stmt: SQL.SelectStatement): string {
    const parts: string[] = [];

    // SELECT + DISTINCT
    if (stmt.select.distinct) {
      parts.push("SELECT DISTINCT");
    } else {
      parts.push("SELECT");
    }

    // SELECT clause
    parts.push("\n" + this.indent() + this.generateSelectClause(stmt.select));

    // FROM clause
    if (stmt.from && stmt.from.tables.length > 0) {
      parts.push(
        "\nFROM\n" + this.indent() + this.generateFromClause(stmt.from),
      );
    }

    // WHERE clause
    if (stmt.where) {
      parts.push(
        "\nWHERE\n" + this.indent()
          + this.generateExpression(stmt.where.condition),
      );
    }

    // GROUP BY clause
    if (stmt.groupBy) {
      parts.push(
        "\nGROUP BY\n" + this.indent()
          + this.generateGroupByClause(stmt.groupBy),
      );
    }

    // HAVING clause
    if (stmt.having) {
      parts.push(
        "\nHAVING\n" + this.indent()
          + this.generateExpression(stmt.having.condition),
      );
    }

    // ORDER BY clause
    if (stmt.orderBy) {
      parts.push(
        "\nORDER BY\n" + this.indent()
          + this.generateOrderByClause(stmt.orderBy),
      );
    }

    // LIMIT clause
    if (stmt.limit) {
      parts.push("\nLIMIT " + this.generateExpression(stmt.limit.count));
    }

    // OFFSET clause
    if (stmt.offset) {
      parts.push("\nOFFSET " + this.generateExpression(stmt.offset.count));
    }

    return parts.join("");
  }

  private generateSelectClause(select: SQL.SelectClause): string {
    return select.columns.map((col) => this.generateSelectItem(col)).join(
      ",\n" + this.indent(),
    );
  }

  private generateSelectItem(item: SQL.SelectItem): string {
    let sql = this.generateExpression(item.expression);
    if (item.alias) {
      sql += " AS " + this.escapeIdentifier(item.alias);
    }
    return sql;
  }

  private generateFromClause(from: SQL.FromClause): string {
    return from.tables.map((table) => this.generateTableReference(table)).join(
      ",\n" + this.indent(),
    );
  }

  private generateTableReference(table: SQL.TableReference): string {
    const parts: string[] = [];

    if (table.subquery) {
      const lateral = table.lateral ? "LATERAL " : "";
      this.indentLevel++;
      const subSql = this.generateStatement(table.subquery);
      this.indentLevel--;
      parts.push(
        `${lateral}(\n${this.indent()}  ${subSql}\n${this.indent()})`,
      );
    } else {
      parts.push(this.escapeIdentifier(table.name));
    }

    if (table.alias) {
      parts.push(" AS " + this.escapeIdentifier(table.alias));
      if (table.columnAliases && table.columnAliases.length > 0) {
        parts.push(
          "("
            + table.columnAliases.map((c) => this.escapeIdentifier(c)).join(
              ", ",
            )
            + ")",
        );
      }
    }

    if (table.joins) {
      for (const join of table.joins) {
        parts.push("\n" + this.generateJoinClause(join));
      }
    }

    return parts.join("");
  }

  private generateJoinClause(join: SQL.JoinClause): string {
    let sql = join.type + " JOIN " + this.generateTableReference(join.table);
    sql += " ON " + this.generateExpression(join.condition);
    return sql;
  }

  private generateGroupByClause(groupBy: SQL.GroupByClause): string {
    return groupBy.expressions.map((expr) => this.generateExpression(expr))
      .join(", ");
  }

  private generateOrderByClause(orderBy: SQL.OrderByClause): string {
    return orderBy.items.map((item) => {
      return this.generateExpression(item.expression) + " " + item.direction;
    }).join(", ");
  }

  private generateInsertStatement(stmt: SQL.InsertStatement): string {
    const parts: string[] = [];

    parts.push("INSERT INTO " + this.escapeIdentifier(stmt.table));

    if (stmt.columns.length > 0) {
      parts.push(
        " (" + stmt.columns.map((col) => this.escapeIdentifier(col)).join(", ")
          + ")",
      );
    }

    parts.push("\nVALUES");

    for (let i = 0; i < stmt.values.length; i++) {
      if (i > 0) parts.push(",");
      parts.push(
        "\n" + this.indent() + "(" + stmt.values[i].map((expr) => this.generateExpression(expr)).join(", ")
          + ")",
      );
    }

    if (stmt.onConflict) {
      parts.push("\n" + this.generateOnConflictClause(stmt.onConflict));
    }

    if (stmt.returning) {
      parts.push(
        "\nRETURNING "
          + stmt.returning.map((item) => this.generateSelectItem(item)).join(
            ", ",
          ),
      );
    }

    return parts.join("");
  }

  private generateOnConflictClause(onConflict: SQL.OnConflictClause): string {
    let sql = "ON CONFLICT";

    if (onConflict.target && onConflict.target.length > 0) {
      sql += " (" + onConflict.target.map((col) => this.escapeIdentifier(col)).join(", ")
        + ")";
    }

    if (onConflict.action === "DO NOTHING") {
      sql += " DO NOTHING";
    } else if (onConflict.action.kind === "UpdateAction") {
      sql += " DO UPDATE SET "
        + onConflict.action.set.map((set) => this.generateSetClause(set)).join(
          ", ",
        );
    }

    return sql;
  }

  private generateUpdateStatement(stmt: SQL.UpdateStatement): string {
    let sql = "UPDATE " + this.escapeIdentifier(stmt.table);
    sql += "\nSET "
      + stmt.set.map((set) => this.generateSetClause(set)).join(", ");

    if (stmt.where) {
      sql += "\nWHERE " + this.generateExpression(stmt.where.condition);
    }

    if (stmt.returning) {
      sql += "\nRETURNING "
        + stmt.returning.map((item) => this.generateSelectItem(item)).join(", ");
    }

    return sql;
  }

  private generateSetClause(set: SQL.SetClause): string {
    return this.escapeIdentifier(set.column) + " = "
      + this.generateExpression(set.value);
  }

  private generateDeleteStatement(stmt: SQL.DeleteStatement): string {
    let sql = "DELETE FROM " + this.escapeIdentifier(stmt.table);

    if (stmt.where) {
      sql += "\nWHERE " + this.generateExpression(stmt.where.condition);
    }

    if (stmt.returning) {
      sql += "\nRETURNING "
        + stmt.returning.map((item) => this.generateSelectItem(item)).join(", ");
    }

    return sql;
  }

  generateExpression(expr: SQL.SQLExpression): string {
    switch (expr.kind) {
      case "ColumnReference":
        return this.generateColumnReference(expr);
      case "LiteralExpression":
        return this.generateLiteral(expr);
      case "BinaryExpression":
        return this.generateBinaryExpression(expr);
      case "UnaryExpression":
        return this.generateUnaryExpression(expr);
      case "FunctionCall":
        return this.generateFunctionCall(expr);
      case "SubqueryExpression":
        return this.generateSubqueryExpression(expr);
      case "CaseExpression":
        return this.generateCaseExpression(expr);
      case "JsonBuildObject":
        return this.generateJsonBuildObject(expr);
      case "JsonAgg":
        return this.generateJsonAgg(expr);
      case "ParameterReference":
        return this.generateParameterReference(expr);
      case "RawSQLExpression":
        return this.generateRawSQLExpression(expr);
      case "AggregateExpression":
        return this.generateAggregateExpression(expr);
      case "WindowFunctionExpression":
        return this.generateWindowFunctionExpression(expr);
      case "CastExpression":
        return this.generateCastExpression(expr);
      case "JsonbAccessExpression":
        return this.generateJsonbAccessExpression(expr);
      default:
        throw new Error(
          `Unsupported expression type: ${(expr as never as { kind: string; }).kind}`,
        );
    }
  }

  private generateColumnReference(expr: SQL.ColumnReference): string {
    if (expr.table) {
      return this.escapeIdentifier(expr.table) + "."
        + this.escapeIdentifier(expr.column);
    }
    return this.escapeIdentifier(expr.column);
  }

  private generateLiteral(expr: SQL.LiteralExpression): string {
    switch (expr.type) {
      case "string":
        return "'" + this.escapeString(expr.value) + "'";
      case "number":
        return String(expr.value);
      case "boolean":
        return expr.value ? "TRUE" : "FALSE";
      case "null":
        return "NULL";
      default:
        throw new Error(`Unsupported literal type: ${expr.type}`);
    }
  }

  private generateBinaryExpression(expr: SQL.BinaryExpression): string {
    const left = this.generateExpression(expr.left);
    const right = this.generateExpression(expr.right);

    // Add parentheses for complex expressions
    if (this.needsParentheses(expr.left) || this.needsParentheses(expr.right)) {
      return `(${left}) ${expr.operator} (${right})`;
    }

    return `${left} ${expr.operator} ${right}`;
  }

  private generateUnaryExpression(expr: SQL.UnaryExpression): string {
    const operand = this.generateExpression(expr.operand);

    if (expr.operator === "NOT") {
      return `NOT ${operand}`;
    }

    return `${expr.operator}${operand}`;
  }

  private generateFunctionCall(expr: SQL.FunctionCall): string {
    const args = expr.args.map((arg) => this.generateExpression(arg)).join(
      ", ",
    );
    // Special case: ARRAY uses bracket syntax in PostgreSQL
    if (expr.name === "ARRAY") {
      return `ARRAY[${args}]`;
    }
    return `${expr.name}(${args})`;
  }

  private generateSubqueryExpression(expr: SQL.SubqueryExpression): string {
    this.indentLevel++;
    const subquery = this.generateSelectStatement(expr.query);
    this.indentLevel--;
    return `(\n${this.indent()}${subquery}\n${this.indent()})`;
  }

  private generateCaseExpression(expr: SQL.CaseExpression): string {
    const parts: string[] = [];

    parts.push("CASE");

    for (const whenClause of expr.when) {
      parts.push(
        "\n" + this.indent() + "WHEN "
          + this.generateExpression(whenClause.condition),
      );
      parts.push(" THEN " + this.generateExpression(whenClause.then));
    }

    if (expr.else) {
      parts.push(
        "\n" + this.indent() + "ELSE "
          + this.generateExpression(expr.else),
      );
    }

    parts.push("\n" + this.indent() + "END");
    return parts.join("");
  }

  private generateJsonBuildObject(expr: SQL.JsonBuildObject): string {
    const fields = expr.fields.map((field) => {
      const key = "'" + this.escapeString(field.key) + "'";
      const value = this.generateExpression(field.value);
      return `${key}, ${value}`;
    }).join(", ");

    return `jsonb_build_object(${fields})`;
  }

  private generateJsonAgg(expr: SQL.JsonAgg): string {
    return `jsonb_agg(${this.generateExpression(expr.expression)})`;
  }

  private generateParameterReference(expr: SQL.ParameterReference): string {
    return `$${expr.index}`;
  }

  private generateRawSQLExpression(expr: SQL.RawSQLExpression): string {
    // Raw SQL is injected as-is (be careful with this!)
    return expr.sql;
  }

  private generateCTEStatement(stmt: SQL.CTEStatement): string {
    const ctes = stmt.ctes.map((cte) => {
      const recursive = cte.recursive ? "RECURSIVE " : "";
      const cols = cte.columns.length > 0 ? ` (${cte.columns.join(", ")})` : "";
      const query = this.generateStatement(cte.query);
      return `${recursive}${this.escapeIdentifier(cte.name)}${cols} AS (\n${this.indent()}  ${query}\n${this.indent()})`;
    }).join(",\n" + this.indent());

    const main = this.generateStatement(stmt.query);
    return `WITH ${ctes}\n${main}`;
  }

  private generateUnionAllStatement(stmt: SQL.UnionAllStatement): string {
    const op = stmt.operator ?? "UNION ALL";
    return stmt.queries.map((q) => this.generateStatement(q)).join(
      `\n${op}\n`,
    );
  }

  private generateAggregateExpression(expr: SQL.AggregateExpression): string {
    const distinct = expr.distinct ? "DISTINCT " : "";
    const inner = this.generateExpression(expr.expression);
    let sql = `${expr.function}(${distinct}${inner})`;
    if (expr.filter) {
      sql += ` FILTER (WHERE ${this.generateExpression(expr.filter)})`;
    }
    return sql;
  }

  private generateWindowFunctionExpression(
    expr: SQL.WindowFunctionExpression,
  ): string {
    const args = expr.args.map((a) => this.generateExpression(a)).join(", ");
    const overParts: string[] = [];

    if (expr.over.partitionBy && expr.over.partitionBy.length > 0) {
      overParts.push(
        "PARTITION BY "
          + expr.over.partitionBy.map((e) => this.generateExpression(e)).join(
            ", ",
          ),
      );
    }

    if (expr.over.orderBy && expr.over.orderBy.length > 0) {
      overParts.push(
        "ORDER BY "
          + expr.over.orderBy.map((item) => `${this.generateExpression(item.expression)} ${item.direction}`).join(", "),
      );
    }

    if (expr.over.frame) {
      let frameSql = `${expr.over.frame.mode} BETWEEN ${expr.over.frame.start} AND ${expr.over.frame.end}`;
      if (expr.over.frame.exclude) {
        frameSql += ` EXCLUDE ${expr.over.frame.exclude}`;
      }
      overParts.push(frameSql);
    }

    return `${expr.function}(${args}) OVER (${overParts.join(" ")})`;
  }

  private generateCastExpression(expr: SQL.CastExpression): string {
    return `CAST(${this.generateExpression(expr.expression)} AS ${expr.targetType})`;
  }

  private generateJsonbAccessExpression(
    expr: SQL.JsonbAccessExpression,
  ): string {
    const base = this.generateExpression(expr.expression);
    const accessor = this.generateExpression(expr.accessor);
    // Wrap complex base expressions in parentheses for correct precedence
    if (
      this.needsParentheses(expr.expression) || this.isComplex(expr.expression)
    ) {
      return `(${base}) ${expr.operator} ${accessor}`;
    }
    return `${base} ${expr.operator} ${accessor}`;
  }

  private isComplex(expr: SQL.SQLExpression): boolean {
    return expr.kind === "FunctionCall" || expr.kind === "JsonBuildObject"
      || expr.kind === "SubqueryExpression" || expr.kind === "CaseExpression"
      || expr.kind === "JsonbAccessExpression";
  }

  private needsParentheses(expr: SQL.SQLExpression): boolean {
    return expr.kind === "BinaryExpression" || expr.kind === "UnaryExpression";
  }

  private escapeIdentifier(identifier: string): string {
    // Wildcard should not be escaped
    if (identifier === "*") {
      return "*";
    }
    // Simple identifier escaping - in production, this should be more robust
    if (
      /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)
      && !this.isReservedKeyword(identifier)
    ) {
      return identifier;
    }
    return "\"" + identifier.replace(/"/g, "\"\"") + "\"";
  }

  private escapeString(str: string): string {
    return str.replace(/'/g, "''");
  }

  private isReservedKeyword(word: string): boolean {
    return SQLCodeGenerator.RESERVED_KEYWORDS.has(word.toUpperCase());
  }

  private indent(): string {
    return " ".repeat(this.indentLevel * this.indentSize);
  }
}
