/**
 * Test Database Implementation for Auth Tests
 */

import { DatabaseInterface, QueryResult } from "./database-interface.ts";

export class TestDatabase implements DatabaseInterface {
  private tables: Map<string, any[]> = new Map();
  private connected = false;

  async connect(): Promise<void> {
    this.connected = true;
  }

  async close(): Promise<void> {
    this.connected = false;
    this.tables.clear();
  }

  isConnected(): boolean {
    return this.connected;
  }

  async execute(sql: string, params: any[] = []): Promise<void> {
    await this.query(sql, params);
  }

  async query(sql: string, params: any[] = []): Promise<QueryResult> {
    // Simple SQL parser for testing
    const normalizedSQL = sql.toLowerCase().trim();
    
    if (normalizedSQL.includes("create table")) {
      this.handleCreateTable(sql);
      return { rows: [], rowCount: 0 };
    } else if (normalizedSQL.includes("create index")) {
      return { rows: [], rowCount: 0 };
    } else if (normalizedSQL.startsWith("insert")) {
      return this.handleInsert(sql, params);
    } else if (normalizedSQL.startsWith("select")) {
      return this.handleSelect(sql, params);
    } else if (normalizedSQL.startsWith("update")) {
      return this.handleUpdate(sql, params);
    } else if (normalizedSQL.startsWith("delete")) {
      return this.handleDelete(sql, params);
    }

    return { rows: [], rowCount: 0 };
  }

  async transaction<T>(fn: (db: TestDatabase) => Promise<T>): Promise<T> {
    // Simple transaction simulation - just run the function
    return await fn(this);
  }

  private handleCreateTable(sql: string): void {
    const tableNameMatch = sql.match(/create table if not exists (\w+)/i);
    if (tableNameMatch) {
      const tableName = tableNameMatch[1];
      if (!this.tables.has(tableName)) {
        this.tables.set(tableName, []);
      }
    }
  }

  private handleInsert(sql: string, params: any[]): QueryResult {
    const tableNameMatch = sql.match(/insert into (\w+)/i);
    if (!tableNameMatch) {
      throw new Error("Invalid INSERT statement");
    }

    const tableName = tableNameMatch[1];
    const table = this.tables.get(tableName) || [];
    
    // Simple parameter replacement
    let paramIndex = 0;
    const row: any = {};
    
    // Extract column names and values
    const columnsMatch = sql.match(/\(([^)]+)\)\s*values\s*\(([^)]+)\)/i);
    if (columnsMatch) {
      const columns = columnsMatch[1].split(",").map(c => c.trim());
      const values = columnsMatch[2].split(",");
      
      columns.forEach((col, index) => {
        if (values[index] && values[index].trim() === "?") {
          row[col] = params[paramIndex++];
        } else if (values[index] && values[index].toLowerCase().includes("current_timestamp")) {
          row[col] = new Date().toISOString();
        } else if (values[index] && values[index] !== "null") {
          row[col] = values[index].replace(/'/g, "");
        } else {
          row[col] = null;
        }
      });
    }

    table.push(row);
    this.tables.set(tableName, table);
    
    return { rows: [row], rowCount: 1 };
  }

  private handleSelect(sql: string, params: any[]): QueryResult {
    const tableNameMatch = sql.match(/from (\w+)/i);
    if (!tableNameMatch) {
      return { rows: [], rowCount: 0 };
    }

    const tableName = tableNameMatch[1];
    let table = this.tables.get(tableName) || [];
    
    // Handle WHERE clauses
    if (sql.toLowerCase().includes("where")) {
      table = this.applyWhereClause(table, sql, params);
    }

    // Handle JOINs (simplified)
    if (sql.toLowerCase().includes("join")) {
      const joinMatch = sql.match(/join (\w+) \w+ on [^=]*=\s*[^.]*\.(\w+)/i);
      if (joinMatch) {
        const joinTable = joinMatch[1];
        const joinColumn = joinMatch[2];
        const joinData = this.tables.get(joinTable) || [];
        
        table = table.map(row => {
          const joinRow = joinData.find(jr => jr[joinColumn] === row[joinColumn]);
          return joinRow ? { ...row, ...joinRow } : row;
        });
      }
    }

    return { rows: table, rowCount: table.length };
  }

  private handleUpdate(sql: string, params: any[]): QueryResult {
    const tableNameMatch = sql.match(/update (\w+)/i);
    if (!tableNameMatch) {
      throw new Error("Invalid UPDATE statement");
    }

    const tableName = tableNameMatch[1];
    let table = this.tables.get(tableName) || [];
    
    // Apply WHERE clause to find rows to update
    const rowsToUpdate = this.applyWhereClause(table, sql, params);
    
    // Extract SET clause
    const setMatch = sql.match(/set (.+?) where/i) || sql.match(/set (.+)$/i);
    if (setMatch) {
      const setClause = setMatch[1];
      const assignments = setClause.split(",");
      
      rowsToUpdate.forEach(row => {
        assignments.forEach(assignment => {
          const [column, value] = assignment.split("=").map(s => s.trim());
          if (value === "?") {
            // Use next parameter
            row[column] = params.shift();
          } else if (value.toLowerCase().includes("current_timestamp")) {
            row[column] = new Date().toISOString();
          } else if (value === "null") {
            row[column] = null;
          } else if (value.toLowerCase() === "true") {
            row[column] = true;
          } else if (value.toLowerCase() === "false") {
            row[column] = false;
          } else {
            row[column] = value.replace(/'/g, "");
          }
        });
      });
    }

    this.tables.set(tableName, table);
    
    return { rows: rowsToUpdate, rowCount: rowsToUpdate.length };
  }

  private handleDelete(sql: string, params: any[]): QueryResult {
    const tableNameMatch = sql.match(/delete from (\w+)/i);
    if (!tableNameMatch) {
      throw new Error("Invalid DELETE statement");
    }

    const tableName = tableNameMatch[1];
    const table = this.tables.get(tableName) || [];
    
    // Apply WHERE clause to find rows to delete
    const rowsToDelete = this.applyWhereClause(table, sql, params);
    const remainingRows = table.filter(row => !rowsToDelete.includes(row));
    
    this.tables.set(tableName, remainingRows);
    
    return { rows: rowsToDelete, rowCount: rowsToDelete.length };
  }

  private applyWhereClause(table: any[], sql: string, params: any[]): any[] {
    const whereMatch = sql.match(/where (.+?)(?:group by|order by|limit|$)/i);
    if (!whereMatch) {
      return table;
    }

    const whereClause = whereMatch[1].trim();
    let paramIndex = 0;
    
    return table.filter(row => {
      // Simple WHERE clause parser
      if (whereClause.includes(" and ")) {
        return whereClause.split(" and ").every(condition => 
          this.evaluateCondition(row, condition.trim(), params, paramIndex)
        );
      } else if (whereClause.includes(" or ")) {
        return whereClause.split(" or ").some(condition => 
          this.evaluateCondition(row, condition.trim(), params, paramIndex)
        );
      } else {
        return this.evaluateCondition(row, whereClause, params, paramIndex);
      }
    });
  }

  private evaluateCondition(row: any, condition: string, params: any[], paramIndex: number): boolean {
    if (condition.includes("=")) {
      const [column, value] = condition.split("=").map(s => s.trim());
      const actualValue = value === "?" ? params[paramIndex++] : value.replace(/'/g, "");
      return row[column] == actualValue;
    } else if (condition.includes(">")) {
      const [column, value] = condition.split(">").map(s => s.trim());
      const actualValue = value === "?" ? params[paramIndex++] : value.replace(/'/g, "");
      return new Date(row[column]) > new Date(actualValue);
    } else if (condition.includes("<")) {
      const [column, value] = condition.split("<").map(s => s.trim());
      const actualValue = value === "?" ? params[paramIndex++] : value.replace(/'/g, "");
      return new Date(row[column]) < new Date(actualValue);
    }
    
    return false;
  }
}