/**
 * DDL Generator - converts migration operations to SQL DDL statements
 */

import * as Types from "./types.ts";

export class DDLGenerator {
  generateDDL(operations: Types.MigrationOperation[]): string[] {
    const statements: string[] = [];

    for (const operation of operations) {
      statements.push(...this.generateOperationDDL(operation));
    }

    return statements;
  }

  private generateOperationDDL(operation: Types.MigrationOperation): string[] {
    switch (operation.kind) {
      case "CreateType":
        return this.generateCreateType(operation);
      case "DropType":
        return this.generateDropType(operation);
      case "AlterType":
        return this.generateAlterType(operation);
      case "CreateTable":
        return this.generateCreateTable(operation);
      case "DropTable":
        return this.generateDropTable(operation);
      case "AlterTable":
        return this.generateAlterTable(operation);
      case "CreateIndex":
        return this.generateCreateIndex(operation);
      case "DropIndex":
        return this.generateDropIndex(operation);
      default:
        throw new Error(`Unsupported operation: ${operation.kind}`);
    }
  }

  private generateCreateType(operation: Types.CreateTypeOperation): string[] {
    const statements: string[] = [];
    const tableName = this.typeNameToTableName(operation.type_name);

    // Generate column definitions from properties
    const columns: Types.ColumnDefinition[] = [
      // Always add an ID column
      {
        name: "id",
        type: "UUID",
        nullable: false,
        primary_key: true,
        unique: false,
        default: "gen_random_uuid()",
      },
    ];

    // Add property columns
    for (const property of operation.properties) {
      columns.push({
        name: property.name,
        type: this.mapEdgeQLTypeToPostgreSQL(property.type),
        nullable: !property.required,
        primary_key: false,
        unique: property.constraints.includes("exclusive"),
        default: property.default ? this.formatDefaultValue(property.default, property.type) : undefined,
      });
    }

    // Add foreign key columns for links
    for (const link of operation.links) {
      if (!link.multi) {
        // Single-valued link becomes a foreign key column
        columns.push({
          name: `${link.name}_id`,
          type: "UUID",
          nullable: !link.required,
          primary_key: false,
          unique: false,
          references: {
            table: this.typeNameToTableName(link.target),
            column: "id",
            on_delete: link.on_target_delete || "RESTRICT",
          },
        });
      }
    }

    // Generate CREATE TABLE statement
    statements.push(this.generateCreateTableFromColumns(tableName, columns));

    // Generate junction tables for multi-valued links
    for (const link of operation.links) {
      if (link.multi) {
        const junctionTableName = `${tableName}_${link.name}`;
        const junctionColumns: Types.ColumnDefinition[] = [
          {
            name: "source_id",
            type: "UUID",
            nullable: false,
            primary_key: false,
            unique: false,
            references: {
              table: tableName,
              column: "id",
              on_delete: "CASCADE",
            },
          },
          {
            name: "target_id",
            type: "UUID",
            nullable: false,
            primary_key: false,
            unique: false,
            references: {
              table: this.typeNameToTableName(link.target),
              column: "id",
              on_delete: "CASCADE",
            },
          },
        ];

        statements.push(this.generateCreateTableFromColumns(junctionTableName, junctionColumns));
        
        // Add unique constraint to prevent duplicate links
        statements.push(`ALTER TABLE ${this.escapeIdentifier(junctionTableName)} ADD CONSTRAINT ${this.escapeIdentifier(`uk_${junctionTableName}_source_target`)} UNIQUE (source_id, target_id);`);
      }
    }

    // Generate indexes for foreign keys and unique constraints
    for (const column of columns) {
      if (column.references) {
        statements.push(`CREATE INDEX ${this.escapeIdentifier(`idx_${tableName}_${column.name}`)} ON ${this.escapeIdentifier(tableName)} (${this.escapeIdentifier(column.name)});`);
      }
      if (column.unique && !column.primary_key) {
        statements.push(`CREATE UNIQUE INDEX ${this.escapeIdentifier(`uk_${tableName}_${column.name}`)} ON ${this.escapeIdentifier(tableName)} (${this.escapeIdentifier(column.name)});`);
      }
    }

    return statements;
  }

  private generateDropType(operation: Types.DropTypeOperation): string[] {
    const tableName = this.typeNameToTableName(operation.type_name);
    return [`DROP TABLE IF EXISTS ${this.escapeIdentifier(tableName)} CASCADE;`];
  }

  private generateAlterType(operation: Types.AlterTypeOperation): string[] {
    const statements: string[] = [];
    const tableName = this.typeNameToTableName(operation.type_name);

    for (const typeOp of operation.operations) {
      statements.push(...this.generateTypeOperationDDL(tableName, typeOp));
    }

    return statements;
  }

  private generateTypeOperationDDL(tableName: string, operation: Types.TypeOperation): string[] {
    switch (operation.kind) {
      case "AddProperty":
        return this.generateAddProperty(tableName, operation);
      case "DropProperty":
        return this.generateDropProperty(tableName, operation);
      case "AlterProperty":
        return this.generateAlterProperty(tableName, operation);
      case "AddLink":
        return this.generateAddLink(tableName, operation);
      case "DropLink":
        return this.generateDropLink(tableName, operation);
      case "AlterLink":
        return this.generateAlterLink(tableName, operation);
      default:
        throw new Error(`Unsupported type operation: ${operation.kind}`);
    }
  }

  private generateAddProperty(tableName: string, operation: Types.AddPropertyOperation): string[] {
    const property = operation.property;
    const columnType = this.mapEdgeQLTypeToPostgreSQL(property.type);
    const nullable = property.required ? "NOT NULL" : "NULL";
    const defaultClause = property.default ? ` DEFAULT ${this.formatDefaultValue(property.default, property.type)}` : "";

    return [`ALTER TABLE ${this.escapeIdentifier(tableName)} ADD COLUMN ${this.escapeIdentifier(property.name)} ${columnType} ${nullable}${defaultClause};`];
  }

  private generateDropProperty(tableName: string, operation: Types.DropPropertyOperation): string[] {
    return [`ALTER TABLE ${this.escapeIdentifier(tableName)} DROP COLUMN IF EXISTS ${this.escapeIdentifier(operation.property_name)};`];
  }

  private generateAlterProperty(tableName: string, operation: Types.AlterPropertyOperation): string[] {
    const statements: string[] = [];
    const columnName = this.escapeIdentifier(operation.property_name);
    const tableRef = this.escapeIdentifier(tableName);

    for (const change of operation.changes) {
      switch (change.kind) {
        case "ChangeType":
          statements.push(`ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} TYPE ${this.mapEdgeQLTypeToPostgreSQL(change.new_value)};`);
          break;
        case "ChangeRequired":
          if (change.new_value) {
            statements.push(`ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} SET NOT NULL;`);
          } else {
            statements.push(`ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} DROP NOT NULL;`);
          }
          break;
        case "ChangeDefault":
          if (change.new_value !== undefined) {
            statements.push(`ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} SET DEFAULT ${this.formatDefaultValue(change.new_value, "unknown")};`);
          } else {
            statements.push(`ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} DROP DEFAULT;`);
          }
          break;
      }
    }

    return statements;
  }

  private generateAddLink(tableName: string, operation: Types.AddLinkOperation): string[] {
    const statements: string[] = [];
    const link = operation.link;

    if (link.multi) {
      // Multi-valued link - create junction table
      const junctionTableName = `${tableName}_${link.name}`;
      const junctionColumns: Types.ColumnDefinition[] = [
        {
          name: "source_id",
          type: "UUID",
          nullable: false,
          primary_key: false,
          unique: false,
          references: {
            table: tableName,
            column: "id",
            on_delete: "CASCADE",
          },
        },
        {
          name: "target_id",
          type: "UUID",
          nullable: false,
          primary_key: false,
          unique: false,
          references: {
            table: this.typeNameToTableName(link.target),
            column: "id",
            on_delete: link.on_target_delete || "CASCADE",
          },
        },
      ];

      statements.push(this.generateCreateTableFromColumns(junctionTableName, junctionColumns));
      statements.push(`ALTER TABLE ${this.escapeIdentifier(junctionTableName)} ADD CONSTRAINT ${this.escapeIdentifier(`uk_${junctionTableName}_source_target`)} UNIQUE (source_id, target_id);`);
    } else {
      // Single-valued link - add foreign key column
      const columnName = `${link.name}_id`;
      const nullable = link.required ? "NOT NULL" : "NULL";
      const targetTable = this.typeNameToTableName(link.target);

      statements.push(`ALTER TABLE ${this.escapeIdentifier(tableName)} ADD COLUMN ${this.escapeIdentifier(columnName)} UUID ${nullable};`);
      statements.push(`ALTER TABLE ${this.escapeIdentifier(tableName)} ADD CONSTRAINT ${this.escapeIdentifier(`fk_${tableName}_${columnName}`)} FOREIGN KEY (${this.escapeIdentifier(columnName)}) REFERENCES ${this.escapeIdentifier(targetTable)} (id) ON DELETE ${link.on_target_delete || "RESTRICT"};`);
      statements.push(`CREATE INDEX ${this.escapeIdentifier(`idx_${tableName}_${columnName}`)} ON ${this.escapeIdentifier(tableName)} (${this.escapeIdentifier(columnName)});`);
    }

    return statements;
  }

  private generateDropLink(tableName: string, operation: Types.DropLinkOperation): string[] {
    const statements: string[] = [];
    const linkName = operation.link_name;

    // Drop junction table if it exists
    const junctionTableName = `${tableName}_${linkName}`;
    statements.push(`DROP TABLE IF EXISTS ${this.escapeIdentifier(junctionTableName)} CASCADE;`);

    // Drop foreign key column if it exists
    const columnName = `${linkName}_id`;
    statements.push(`ALTER TABLE ${this.escapeIdentifier(tableName)} DROP COLUMN IF EXISTS ${this.escapeIdentifier(columnName)};`);

    return statements;
  }

  private generateAlterLink(tableName: string, operation: Types.AlterLinkOperation): string[] {
    // Link alteration is complex and often requires recreating the link
    // For now, return a comment indicating this needs manual handling
    return [`-- ALTER LINK ${operation.link_name}: Complex operation requiring manual handling`];
  }

  private generateCreateTable(operation: Types.CreateTableOperation): string[] {
    return [this.generateCreateTableFromColumns(operation.table_name, operation.columns)];
  }

  private generateDropTable(operation: Types.DropTableOperation): string[] {
    return [`DROP TABLE IF EXISTS ${this.escapeIdentifier(operation.table_name)} CASCADE;`];
  }

  private generateAlterTable(operation: Types.AlterTableOperation): string[] {
    const statements: string[] = [];

    for (const tableOp of operation.operations) {
      statements.push(...this.generateTableOperationDDL(operation.table_name, tableOp));
    }

    return statements;
  }

  private generateTableOperationDDL(tableName: string, operation: Types.TableOperation): string[] {
    switch (operation.kind) {
      case "AddColumn":
        return this.generateAddColumn(tableName, operation);
      case "DropColumn":
        return this.generateDropColumn(tableName, operation);
      case "AlterColumn":
        return this.generateAlterColumn(tableName, operation);
      default:
        throw new Error(`Unsupported table operation: ${operation.kind}`);
    }
  }

  private generateAddColumn(tableName: string, operation: Types.AddColumnOperation): string[] {
    const column = operation.column;
    const nullable = column.nullable ? "NULL" : "NOT NULL";
    const defaultClause = column.default ? ` DEFAULT ${column.default}` : "";
    
    return [`ALTER TABLE ${this.escapeIdentifier(tableName)} ADD COLUMN ${this.escapeIdentifier(column.name)} ${column.type} ${nullable}${defaultClause};`];
  }

  private generateDropColumn(tableName: string, operation: Types.DropColumnOperation): string[] {
    return [`ALTER TABLE ${this.escapeIdentifier(tableName)} DROP COLUMN IF EXISTS ${this.escapeIdentifier(operation.column_name)};`];
  }

  private generateAlterColumn(tableName: string, operation: Types.AlterColumnOperation): string[] {
    const statements: string[] = [];
    const columnName = this.escapeIdentifier(operation.column_name);
    const tableRef = this.escapeIdentifier(tableName);

    for (const change of operation.changes) {
      switch (change.kind) {
        case "ChangeType":
          statements.push(`ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} TYPE ${change.new_value};`);
          break;
        case "ChangeNullable":
          if (change.new_value) {
            statements.push(`ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} DROP NOT NULL;`);
          } else {
            statements.push(`ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} SET NOT NULL;`);
          }
          break;
        case "ChangeDefault":
          if (change.new_value !== undefined) {
            statements.push(`ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} SET DEFAULT ${change.new_value};`);
          } else {
            statements.push(`ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} DROP DEFAULT;`);
          }
          break;
      }
    }

    return statements;
  }

  private generateCreateIndex(operation: Types.CreateIndexOperation): string[] {
    const index = operation.index;
    const unique = index.unique ? "UNIQUE " : "";
    const method = index.method ? ` USING ${index.method.toUpperCase()}` : "";
    const partial = index.partial ? ` WHERE ${index.partial}` : "";
    const columns = index.columns.map(col => this.escapeIdentifier(col)).join(", ");

    return [`CREATE ${unique}INDEX ${this.escapeIdentifier(index.name)} ON ${this.escapeIdentifier(index.table)}${method} (${columns})${partial};`];
  }

  private generateDropIndex(operation: Types.DropIndexOperation): string[] {
    return [`DROP INDEX IF EXISTS ${this.escapeIdentifier(operation.index_name)};`];
  }

  private generateCreateTableFromColumns(tableName: string, columns: Types.ColumnDefinition[]): string {
    const columnDefs = columns.map(col => this.generateColumnDefinition(col));
    const constraints = columns
      .filter(col => col.references)
      .map(col => this.generateForeignKeyConstraint(tableName, col));

    const allDefs = [...columnDefs, ...constraints];

    return `CREATE TABLE ${this.escapeIdentifier(tableName)} (\n  ${allDefs.join(",\n  ")}\n);`;
  }

  private generateColumnDefinition(column: Types.ColumnDefinition): string {
    let def = `${this.escapeIdentifier(column.name)} ${column.type}`;
    
    if (column.primary_key) {
      def += " PRIMARY KEY";
    }
    
    if (!column.nullable) {
      def += " NOT NULL";
    }
    
    if (column.unique && !column.primary_key) {
      def += " UNIQUE";
    }
    
    if (column.default) {
      def += ` DEFAULT ${column.default}`;
    }

    return def;
  }

  private generateForeignKeyConstraint(tableName: string, column: Types.ColumnDefinition): string {
    if (!column.references) {
      throw new Error("Column does not have foreign key reference");
    }

    const constraintName = `fk_${tableName}_${column.name}`;
    const onDelete = column.references.on_delete ? ` ON DELETE ${column.references.on_delete}` : "";
    const onUpdate = column.references.on_update ? ` ON UPDATE ${column.references.on_update}` : "";

    return `CONSTRAINT ${this.escapeIdentifier(constraintName)} FOREIGN KEY (${this.escapeIdentifier(column.name)}) REFERENCES ${this.escapeIdentifier(column.references.table)} (${this.escapeIdentifier(column.references.column)})${onDelete}${onUpdate}`;
  }

  private typeNameToTableName(typeName: string): string {
    // Convert PascalCase type names to snake_case table names
    return typeName
      .replace(/([A-Z])/g, "_$1")
      .toLowerCase()
      .replace(/^_/, "");
  }

  private mapEdgeQLTypeToPostgreSQL(edgeqlType: string): string {
    const typeMap: Record<string, string> = {
      "str": "TEXT",
      "int16": "SMALLINT",
      "int32": "INTEGER",
      "int64": "BIGINT",
      "float32": "REAL",
      "float64": "DOUBLE PRECISION",
      "decimal": "DECIMAL",
      "bool": "BOOLEAN",
      "uuid": "UUID",
      "datetime": "TIMESTAMP WITH TIME ZONE",
      "duration": "INTERVAL",
      "bytes": "BYTEA",
      "json": "JSONB",
    };

    return typeMap[edgeqlType] || "TEXT";
  }

  private formatDefaultValue(value: any, type: string): string {
    if (value === null || value === undefined) {
      return "NULL";
    }

    if (typeof value === "string") {
      if (value.startsWith("datetime_current()")) {
        return "NOW()";
      }
      return `'${value.replace(/'/g, "''")}'`;
    }

    if (typeof value === "number") {
      return String(value);
    }

    if (typeof value === "boolean") {
      return value ? "TRUE" : "FALSE";
    }

    return `'${String(value).replace(/'/g, "''")}'`;
  }

  private escapeIdentifier(identifier: string): string {
    // Check if identifier is a reserved keyword
    const reservedKeywords = new Set([
      "order", "select", "from", "where", "insert", "update", "delete", "join",
      "inner", "left", "right", "full", "on", "as", "and", "or", "not",
      "group", "having", "limit", "offset", "distinct", "case", "when", "then",
      "else", "end", "null", "true", "false", "table", "column", "constraint",
      "primary", "key", "foreign", "references", "unique", "index", "create",
      "drop", "alter", "add", "default", "check", "cascade", "restrict",
    ]);

    if (reservedKeywords.has(identifier.toLowerCase())) {
      return `"${identifier.replace(/"/g, '""')}"`;
    }

    // Check if identifier needs escaping due to special characters
    if (/^[a-z][a-z0-9_]*$/.test(identifier)) {
      return identifier;
    }
    
    return `"${identifier.replace(/"/g, '""')}"`;
  }
}