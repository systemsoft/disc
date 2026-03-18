/**
 * SQL Code Generator
 * Converts SQL AST to PostgreSQL string representation
 */

import * as SQL from "./sql.ts";

export class SQLCodeGenerator {
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
      default:
        throw new Error(
          `Unsupported statement type: ${
            (stmt as never as { kind: string }).kind
          }`,
        );
    }
  }

  private generateSelectStatement(stmt: SQL.SelectStatement): string {
    let sql = "SELECT";

    // DISTINCT
    if (stmt.select.distinct) {
      sql += " DISTINCT";
    }

    // SELECT clause
    sql += "\n" + this.indent() + this.generateSelectClause(stmt.select);

    // FROM clause
    if (stmt.from && stmt.from.tables.length > 0) {
      sql += "\nFROM\n" + this.indent() + this.generateFromClause(stmt.from);
    }

    // WHERE clause
    if (stmt.where) {
      sql += "\nWHERE\n" + this.indent() +
        this.generateExpression(stmt.where.condition);
    }

    // GROUP BY clause
    if (stmt.groupBy) {
      sql += "\nGROUP BY\n" + this.indent() +
        this.generateGroupByClause(stmt.groupBy);
    }

    // HAVING clause
    if (stmt.having) {
      sql += "\nHAVING\n" + this.indent() +
        this.generateExpression(stmt.having.condition);
    }

    // ORDER BY clause
    if (stmt.orderBy) {
      sql += "\nORDER BY\n" + this.indent() +
        this.generateOrderByClause(stmt.orderBy);
    }

    // LIMIT clause
    if (stmt.limit) {
      sql += "\nLIMIT " + this.generateExpression(stmt.limit.count);
    }

    // OFFSET clause
    if (stmt.offset) {
      sql += "\nOFFSET " + this.generateExpression(stmt.offset.count);
    }

    return sql;
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
    let sql: string;

    if (table.subquery) {
      const lateral = table.lateral ? "LATERAL " : "";
      this.indentLevel++;
      const subSql = this.generateStatement(table.subquery);
      this.indentLevel--;
      sql = `${lateral}(\n${this.indent()}  ${subSql}\n${this.indent()})`;
    } else {
      sql = this.escapeIdentifier(table.name);
    }

    if (table.alias) {
      sql += " AS " + this.escapeIdentifier(table.alias);
      if (table.columnAliases && table.columnAliases.length > 0) {
        sql += "(" +
          table.columnAliases.map((c) => this.escapeIdentifier(c)).join(", ") +
          ")";
      }
    }

    if (table.joins) {
      for (const join of table.joins) {
        sql += "\n" + this.generateJoinClause(join);
      }
    }

    return sql;
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
    let sql = "INSERT INTO " + this.escapeIdentifier(stmt.table);

    if (stmt.columns.length > 0) {
      sql += " (" + stmt.columns.map((col) =>
        this.escapeIdentifier(col)
      ).join(", ") + ")";
    }

    sql += "\nVALUES";

    for (let i = 0; i < stmt.values.length; i++) {
      if (i > 0) sql += ",";
      sql += "\n" + this.indent() + "(" + stmt.values[i].map((expr) =>
        this.generateExpression(expr)
      ).join(", ") + ")";
    }

    if (stmt.onConflict) {
      sql += "\n" + this.generateOnConflictClause(stmt.onConflict);
    }

    if (stmt.returning) {
      sql += "\nRETURNING " +
        stmt.returning.map((item) => this.generateSelectItem(item)).join(", ");
    }

    return sql;
  }

  private generateOnConflictClause(onConflict: SQL.OnConflictClause): string {
    let sql = "ON CONFLICT";

    if (onConflict.target && onConflict.target.length > 0) {
      sql += " (" + onConflict.target.map((col) =>
        this.escapeIdentifier(col)
      ).join(", ") + ")";
    }

    if (onConflict.action === "DO NOTHING") {
      sql += " DO NOTHING";
    } else if (onConflict.action.kind === "UpdateAction") {
      sql += " DO UPDATE SET " +
        onConflict.action.set.map((set) => this.generateSetClause(set)).join(
          ", ",
        );
    }

    return sql;
  }

  private generateUpdateStatement(stmt: SQL.UpdateStatement): string {
    let sql = "UPDATE " + this.escapeIdentifier(stmt.table);
    sql += "\nSET " +
      stmt.set.map((set) => this.generateSetClause(set)).join(", ");

    if (stmt.where) {
      sql += "\nWHERE " + this.generateExpression(stmt.where.condition);
    }

    if (stmt.returning) {
      sql += "\nRETURNING " +
        stmt.returning.map((item) => this.generateSelectItem(item)).join(", ");
    }

    return sql;
  }

  private generateSetClause(set: SQL.SetClause): string {
    return this.escapeIdentifier(set.column) + " = " +
      this.generateExpression(set.value);
  }

  private generateDeleteStatement(stmt: SQL.DeleteStatement): string {
    let sql = "DELETE FROM " + this.escapeIdentifier(stmt.table);

    if (stmt.where) {
      sql += "\nWHERE " + this.generateExpression(stmt.where.condition);
    }

    if (stmt.returning) {
      sql += "\nRETURNING " +
        stmt.returning.map((item) => this.generateSelectItem(item)).join(", ");
    }

    return sql;
  }

  private generateExpression(expr: SQL.SQLExpression): string {
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
      default:
        throw new Error(
          `Unsupported expression type: ${
            (expr as never as { kind: string }).kind
          }`,
        );
    }
  }

  private generateColumnReference(expr: SQL.ColumnReference): string {
    if (expr.table) {
      return this.escapeIdentifier(expr.table) + "." +
        this.escapeIdentifier(expr.column);
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
    return `${expr.name}(${args})`;
  }

  private generateSubqueryExpression(expr: SQL.SubqueryExpression): string {
    this.indentLevel++;
    const subquery = this.generateSelectStatement(expr.query);
    this.indentLevel--;
    return `(\n${this.indent()}${subquery}\n${this.indent()})`;
  }

  private generateCaseExpression(expr: SQL.CaseExpression): string {
    let sql = "CASE";

    for (const whenClause of expr.when) {
      sql += "\n" + this.indent() + "WHEN " +
        this.generateExpression(whenClause.condition);
      sql += " THEN " + this.generateExpression(whenClause.then);
    }

    if (expr.else) {
      sql += "\n" + this.indent() + "ELSE " +
        this.generateExpression(expr.else);
    }

    sql += "\n" + this.indent() + "END";
    return sql;
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
      return `${recursive}${
        this.escapeIdentifier(cte.name)
      }${cols} AS (\n${this.indent()}  ${query}\n${this.indent()})`;
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
    let over = "";

    if (expr.over.partitionBy && expr.over.partitionBy.length > 0) {
      over += "PARTITION BY " +
        expr.over.partitionBy.map((e) => this.generateExpression(e)).join(", ");
    }

    if (expr.over.orderBy && expr.over.orderBy.length > 0) {
      if (over) over += " ";
      over += "ORDER BY " +
        expr.over.orderBy.map((item) =>
          `${this.generateExpression(item.expression)} ${item.direction}`
        ).join(", ");
    }

    if (expr.over.frame) {
      if (over) over += " ";
      over +=
        `${expr.over.frame.mode} BETWEEN ${expr.over.frame.start} AND ${expr.over.frame.end}`;
    }

    return `${expr.function}(${args}) OVER (${over})`;
  }

  private generateCastExpression(expr: SQL.CastExpression): string {
    return `CAST(${
      this.generateExpression(expr.expression)
    } AS ${expr.targetType})`;
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
      /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier) &&
      !this.isReservedKeyword(identifier)
    ) {
      return identifier;
    }
    return '"' + identifier.replace(/"/g, '""') + '"';
  }

  private escapeString(str: string): string {
    return str.replace(/'/g, "''");
  }

  private isReservedKeyword(word: string): boolean {
    const keywords = new Set([
      "select",
      "from",
      "where",
      "insert",
      "update",
      "delete",
      "join",
      "inner",
      "left",
      "right",
      "full",
      "on",
      "as",
      "and",
      "or",
      "not",
      "order",
      "by",
      "group",
      "having",
      "limit",
      "offset",
      "distinct",
      "case",
      "when",
      "then",
      "else",
      "end",
      "null",
      "true",
      "false",
    ]);
    return keywords.has(word.toLowerCase());
  }

  private indent(): string {
    return " ".repeat(this.indentLevel * this.indentSize);
  }
}
