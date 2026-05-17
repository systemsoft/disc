/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Test Database Implementation for Auth Tests
 * In-memory SQL simulation for unit testing without PostgreSQL.
 */

/*** UTILITY ------------------------------------------ ***/

import { DatabaseInterface, QueryResult } from "./database-interface.ts";

/*** EXPORT ------------------------------------------- ***/

export class TestDatabase implements DatabaseInterface {
  private connected = false;
  private tables: Map<string, any[]> = new Map();

  close(): Promise<void> {
    this.connected = false;
    this.tables.clear();
    return Promise.resolve();
  }

  connect(): Promise<void> {
    this.connected = true;
    return Promise.resolve();
  }

  async execute(sql: string, params: any[] = []): Promise<void> {
    await this.query(sql, params);
  }

  isConnected(): boolean {
    return this.connected;
  }

  query(sql: string, params: any[] = []): Promise<QueryResult> {
    const normalizedSQL = sql.replace(/\s+/g, " ").trim().toLowerCase();

    if (normalizedSQL.includes("create table")) {
      this.handleCreateTable(sql);
      return Promise.resolve({ rowCount: 0, rows: [] });
    } else if (normalizedSQL.includes("create index")) {
      return Promise.resolve({ rowCount: 0, rows: [] });
    } else if (normalizedSQL.startsWith("insert")) {
      return Promise.resolve(this.handleInsert(sql, params));
    } else if (normalizedSQL.startsWith("select")) {
      return Promise.resolve(this.handleSelect(sql, params));
    } else if (normalizedSQL.startsWith("update")) {
      return Promise.resolve(this.handleUpdate(sql, [...params]));
    } else if (normalizedSQL.startsWith("delete")) {
      return Promise.resolve(this.handleDelete(sql, params));
    }

    return Promise.resolve({ rowCount: 0, rows: [] });
  }

  async transaction<T>(fn: (db: TestDatabase) => Promise<T>): Promise<T> {
    return await fn(this);
  }

  /*** PRIVATE ------------------------------------------ ***/

  private applyWhereClause(table: any[], sql: string, params: any[]): any[] {
    const whereMatch = sql.match(/where\s+(.+?)(?:\s+group by|\s+order by|\s+limit|$)/is);

    if (!whereMatch)
      return table;

    /*** Collapse all whitespace runs to single spaces. Without this, multi-line WHERE clauses like
         `\n  AND col = ?` don’t match the " and " keyword in splitByKeyword (which expects
         space-padded boolean operators), and the entire WHERE is evaluated as a single condition —
         so the filter quietly returns nothing. ***/
    const whereClause = whereMatch[1].replace(/\s+/g, " ").trim();

    /*** Track parameter index as a mutable reference ***/
    const paramRef = { index: 0 };

    return table.filter(row => {
      /*** Reset param index for each row evaluation ***/
      const savedIndex = paramRef.index;
      paramRef.index = 0;

      const result = this.evaluateWhereExpression(row, whereClause, params, paramRef);

      /*** After first row, keep the param count we discovered ***/
      if (savedIndex === 0) {
        /*** First row establishes param count ***/
      }

      paramRef.index = 0; /*** Reset for next row ***/
      return result;
    });
  }

  private evaluateSingleCondition(row: any, condition: string, params: any[], paramRef: { index: number; }): boolean {
    const trimmed = condition.trim();
    const lower = trimmed.toLowerCase();

    /*** Handle "column IS NOT NULL" ***/
    if (lower.includes(" is not null")) {
      const col = trimmed.split(/\s+is\s+not\s+null/i)[0].trim();
      return row[col] !== null && row[col] !== undefined;
    }

    /*** Handle "column IS NULL" ***/
    if (lower.includes(" is null")) {
      const col = trimmed.split(/\s+is\s+null/i)[0].trim();
      return row[col] === null || row[col] === undefined;
    }

    /*** Handle "column > CURRENT_TIMESTAMP" or "column > value" ***/
    if (trimmed.includes(">")) {
      const parts = trimmed.split(">").map(s => s.trim());

      if (parts.length === 2) {
        const col = parts[0].trim();
        const valuePart = parts[1].trim();
        let compareValue: string;

        if (valuePart.toLowerCase().includes("current_timestamp"))
          compareValue = new Date().toISOString();
        else if (valuePart === "?")
          compareValue = String(params[paramRef.index++]);
        else
          compareValue = valuePart.replace(/'/g, "");

        const rowVal = row[col];

        if (rowVal === null || rowVal === undefined)
          return false;

        return new Date(rowVal) > new Date(compareValue);
      }
    }

    /*** Handle "column < value" ***/
    if (trimmed.includes("<") && !trimmed.includes("<=") && !trimmed.includes("<>")) {
      const parts = trimmed.split("<").map(s => s.trim());

      if (parts.length === 2) {
        const col = parts[0].trim();
        const valuePart = parts[1].trim();
        let compareValue: string;

        if (valuePart.toLowerCase().includes("current_timestamp"))
          compareValue = new Date().toISOString();
        else if (valuePart === "?")
          compareValue = String(params[paramRef.index++]);
        else
          compareValue = valuePart.replace(/'/g, "");

        const rowVal = row[col];

        if (rowVal === null || rowVal === undefined)
          return false;

        return new Date(rowVal) < new Date(compareValue);
      }
    }

    /*** Handle equality: "column = value" ***/
    if (trimmed.includes("=")) {
      const eqPos = trimmed.indexOf("=");
      const col = trimmed.substring(0, eqPos).trim();
      const valuePart = trimmed.substring(eqPos + 1).trim();
      let expectedValue: any;

      if (valuePart === "?") {
        expectedValue = params[paramRef.index++];
      } else if (
        valuePart.toLowerCase() === "true" ||
        valuePart.toLowerCase() === "false"
      ) {
        expectedValue = valuePart.toLowerCase() === "true";
      } else if (valuePart.toLowerCase() === "null") {
        return row[col] === null || row[col] === undefined;
      } else {
        expectedValue = valuePart.replace(/'/g, "").trim();
      }

      const rowVal = row[col];

      if (typeof expectedValue === "boolean")
        return Boolean(rowVal) === expectedValue;

      /*** Loose equality for string/number coercion ***/
      // deno-lint-ignore eqeqeq
      return rowVal == expectedValue;
    }

    /*** Unknown condition - return true (permissive) ***/
    return true;
  }

  private evaluateWhereExpression(row: any, expr: string, params: any[], paramRef: { index: number; }): boolean {
    const trimmed = expr.trim();
    /*** Handle parenthesized sub-expressions like (...) AND/OR (...) ***/
    /*** But first try splitting by AND/OR at the top level (not inside parens) ***/
    const andParts = this.splitByKeyword(trimmed, " and ");

    if (andParts.length > 1)
      return andParts.every(part => this.evaluateWhereExpression(row, part, params, paramRef));

    const orParts = this.splitByKeyword(trimmed, " or ");

    if (orParts.length > 1)
      return orParts.some(part => this.evaluateWhereExpression(row, part, params, paramRef));

    /*** Strip outer parens ***/
    if (trimmed.startsWith("(") && trimmed.endsWith(")"))
      return this.evaluateWhereExpression(row, trimmed.slice(1, -1), params, paramRef);

    /*** Handle individual conditions ***/
    return this.evaluateSingleCondition(row, trimmed, params, paramRef);
  }

  private handleCreateTable(sql: string): void {
    const tableNameMatch = sql.match(/create table if not exists (\w+)/i);

    if (tableNameMatch) {
      const tableName = tableNameMatch[1];

      if (!this.tables.has(tableName))
        this.tables.set(tableName, []);
    }
  }

  private handleDelete(sql: string, params: any[]): QueryResult {
    const tableNameMatch = sql.match(/delete from (\w+)/i);

    if (!tableNameMatch)
      throw new Error("Invalid DELETE statement");

    const tableName = tableNameMatch[1];
    const table = this.tables.get(tableName) || [];

    const rowsToDelete = this.applyWhereClause(table, sql, params);
    const remainingRows = table.filter(row => !rowsToDelete.includes(row));

    this.tables.set(tableName, remainingRows);

    return { rowCount: rowsToDelete.length, rows: rowsToDelete };
  }

  private handleInsert(sql: string, params: any[]): QueryResult {
    const tableNameMatch = sql.match(/insert into (\w+)/i);

    if (!tableNameMatch)
      throw new Error("Invalid INSERT statement");

    const row: any = {};
    const tableName = tableNameMatch[1];
    const table = this.tables.get(tableName) || [];
    let paramIndex = 0;

    /*** Extract column names and values from INSERT ... (...) VALUES (...) ***/
    const columnsMatch = sql.match(/\(([^)]+)\)\s*values\s*\(([^)]+)\)/i);

    if (columnsMatch) {
      const columns = columnsMatch[1].split(",").map(c => c.trim());
      const values = columnsMatch[2].split(",").map(v => v.trim());

      columns.forEach((col, index) => {
        const val = values[index] ? values[index].trim() : "null";

        if (val === "?")
          row[col] = params[paramIndex++];
        else if (val.toLowerCase().includes("current_timestamp"))
          row[col] = new Date().toISOString();
        else if (val.toLowerCase() === "null")
          row[col] = null;
        else
          row[col] = val.replace(/'/g, "");
      });
    }

    /*** Apply default values for columns not in INSERT ***/
    if (tableName === "users") {
      if (!("active" in row))
        row.active = true;

      if (!("email_verified" in row))
        row.email_verified = false;

      if (!("created_at" in row))
        row.created_at = new Date().toISOString();

      if (!("updated_at" in row))
        row.updated_at = new Date().toISOString();
    }

    if (tableName === "sessions") {
      if (!("revoked" in row))
        row.revoked = false;

      if (!("created_at" in row))
        row.created_at = new Date().toISOString();
    }

    table.push(row);
    this.tables.set(tableName, table);

    return { rowCount: 1, rows: [row] };
  }

  private handleSelect(sql: string, params: any[]): QueryResult {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();

    /*** Detect JOIN queries ***/
    if (normalized.includes(" join "))
      return this.handleSelectWithJoin(sql, params);

    const tableNameMatch = sql.match(/from (\w+)/i);

    if (!tableNameMatch)
      return { rowCount: 0, rows: [] };

    const tableName = tableNameMatch[1];
    let table = [...(this.tables.get(tableName) || [])];

    /*** Handle WHERE clauses ***/
    if (normalized.includes("where"))
      table = this.applyWhereClause(table, sql, params);

    return { rowCount: table.length, rows: table };
  }

  private handleSelectWithJoin(sql: string, params: any[]): QueryResult {
    /*** Parse: SELECT ... FROM sessions s JOIN users u ON s.userId = u.id WHERE ... ***/
    const fromMatch = sql.match(/from\s+(\w+)\s+(\w+)\s+join\s+(\w+)\s+(\w+)\s+on\s+(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)/i);

    if (!fromMatch)
      return { rowCount: 0, rows: [] };

    const leftTable = fromMatch[1];
    const leftAlias = fromMatch[2];
    const rightTable = fromMatch[3];
    const rightAlias = fromMatch[4];
    const joinLeftAlias = fromMatch[5];
    const joinLeftCol = fromMatch[6];
    const joinRightCol = fromMatch[8];

    const leftRows = this.tables.get(leftTable) || [];
    const rightRows = this.tables.get(rightTable) || [];

    /*** Determine which alias maps to which column ***/
    let joinedRows: any[] = [];

    for (const leftRow of leftRows) {
      for (const rightRow of rightRows) {
        let leftVal: any;
        let rightVal: any;

        if (joinLeftAlias === leftAlias) {
          leftVal = leftRow[joinLeftCol];
          rightVal = rightRow[joinRightCol];
        } else {
          leftVal = rightRow[joinLeftCol];
          rightVal = leftRow[joinRightCol];
        }

        if (leftVal === rightVal)
          joinedRows.push({ ...rightRow, ...leftRow });
      }
    }

    /*** Apply WHERE clause to joined rows ***/
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();

    if (normalized.includes("where")) {
      /*** Strip alias prefixes from WHERE clause for matching against row keys ***/
      let whereSQL = sql.replace(new RegExp(`\\b${leftAlias}\\.`, "gi"), "");
      whereSQL = whereSQL.replace(new RegExp(`\\b${rightAlias}\\.`, "gi"), "");
      joinedRows = this.applyWhereClause(joinedRows, whereSQL, params);
    }

    return { rowCount: joinedRows.length, rows: joinedRows };
  }

  private handleUpdate(sql: string, params: any[]): QueryResult {
    const tableNameMatch = sql.match(/update (\w+)/i);

    if (!tableNameMatch)
      throw new Error("Invalid UPDATE statement");

    const tableName = tableNameMatch[1];
    const table = this.tables.get(tableName) || [];

    /*** Separate SET params from WHERE params ***/
    /*** Count ? placeholders in SET clause to know which params go where ***/
    const normalized = sql.replace(/\s+/g, " ").trim();
    const setMatch = normalized.match(/set (.+?) where/i) ||
      normalized.match(/set (.+)$/i);
    let setParamCount = 0;

    if (setMatch) {
      const setClause = setMatch[1];
      setParamCount = (setClause.match(/\?/g) || []).length;
    }

    const setParams = params.slice(0, setParamCount);
    const whereParams = params.slice(setParamCount);

    /*** Apply WHERE clause to find rows to update ***/
    const rowsToUpdate = this.applyWhereClause(table, sql, whereParams);

    /*** Apply SET clause ***/
    if (setMatch) {
      const setClause = setMatch[1];
      /*** Split on comma but not inside parentheses ***/
      const assignments = this.splitSetClause(setClause);
      const setIdx = 0;

      rowsToUpdate.forEach(row => {
        let localSetIdx = setIdx;

        assignments.forEach(assignment => {
          const eqPos = assignment.indexOf("=");

          if (eqPos === -1)
            return;

          const column = assignment.substring(0, eqPos).trim();
          const value = assignment.substring(eqPos + 1).trim();

          if (value === "?")
            row[column] = setParams[localSetIdx++];
          else if (value.toLowerCase().includes("current_timestamp"))
            row[column] = new Date().toISOString();
          else if (value.toLowerCase() === "null")
            row[column] = null;
          else if (value.toLowerCase() === "true")
            row[column] = true;
          else if (value.toLowerCase() === "false")
            row[column] = false;
          else
            row[column] = value.replace(/'/g, "");
        });
      });
    }

    this.tables.set(tableName, table);

    return { rowCount: rowsToUpdate.length, rows: rowsToUpdate };
  }

  private splitByKeyword(expr: string, keyword: string): string[] {
    /*** Split expression by keyword at the top level (not inside parentheses) ***/
    const lowerExpr = expr.toLowerCase();
    const lowerKeyword = keyword.toLowerCase();
    const parts: string[] = [];
    let current = "";
    let depth = 0;
    let i = 0;

    while (i < expr.length) {
      if (expr[i] === "(")
        depth++;
      else if (expr[i] === ")")
        depth--;

      if (depth === 0 && lowerExpr.substring(i, i + lowerKeyword.length) === lowerKeyword) {
        parts.push(current.trim());
        current = "";
        i += lowerKeyword.length;

        continue;
      }

      current += expr[i];
      i++;
    }

    if (current.trim())
      parts.push(current.trim());

    return parts;
  }

  private splitSetClause(setClause: string): string[] {
    /*** Split SET clause by commas, but handle nested expressions ***/
    const parts: string[] = [];
    let current = "";
    let depth = 0;

    for (const char of setClause) {
      if (char === "(" || char === "{") {
        depth++;
      } else if (char === ")" || char === "}") {
        depth--;
      } else if (char === "," && depth === 0) {
        parts.push(current.trim());
        current = "";

        continue;
      }

      current += char;
    }

    if (current.trim())
      parts.push(current.trim());

    return parts;
  }
}
