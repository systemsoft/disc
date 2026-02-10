/**
 * Migration Engine - orchestrates schema diffing, DDL generation, and migration execution
 */

import * as SchemaAST from "../schema/ast.ts";
import * as Types from "./types.ts";
import { SchemaDiffer } from "./differ.ts";
import { DDLGenerator } from "./ddl.ts";
import { Result, Ok, Err } from "../lib/result.ts";
import { MigrationError } from "../lib/errors.ts";

export class MigrationEngine {
  private differ = new SchemaDiffer();
  private ddlGenerator = new DDLGenerator();
  private appliedMigrations = new Set<string>();

  constructor(private config: Types.MigrationConfig) {}

  /**
   * Generate a migration plan from schema changes
   */
  planMigration(
    oldSchema: SchemaAST.Module[] | null,
    newSchema: SchemaAST.Module[],
  ): Result<Types.MigrationPlan, MigrationError> {
    try {
      const operations = oldSchema 
        ? this.differ.diff(oldSchema, newSchema)
        : this.generateInitialMigration(newSchema);

      const migration: Types.Migration = {
        id: this.generateMigrationId(),
        name: this.generateMigrationName(operations),
        description: this.generateMigrationDescription(operations),
        created_at: new Date(),
        schema_hash: this.hashSchema(newSchema),
        operations,
      };

      const plan: Types.MigrationPlan = {
        migrations: [migration],
        target_schema_hash: migration.schema_hash,
        operations_count: operations.length,
        estimated_duration: this.estimateDuration(operations),
      };

      return Ok(plan);
    } catch (error) {
      return Err(new MigrationError(`Failed to plan migration: ${error.message}`));
    }
  }

  /**
   * Generate DDL statements from a migration plan
   */
  generateDDL(plan: Types.MigrationPlan): Result<string[], MigrationError> {
    try {
      const statements: string[] = [];

      for (const migration of plan.migrations) {
        statements.push(`-- Migration: ${migration.name}`);
        statements.push(`-- ID: ${migration.id}`);
        statements.push(`-- Created: ${migration.created_at.toISOString()}`);
        statements.push("");

        const ddlStatements = this.ddlGenerator.generateDDL(migration.operations);
        statements.push(...ddlStatements);
        statements.push("");
      }

      return Ok(statements);
    } catch (error) {
      return Err(new MigrationError(`Failed to generate DDL: ${error.message}`));
    }
  }

  /**
   * Execute a migration plan (placeholder - would need database connection)
   */
  async executeMigration(plan: Types.MigrationPlan): Promise<Result<Types.MigrationResult[], MigrationError>> {
    try {
      const results: Types.MigrationResult[] = [];

      for (const migration of plan.migrations) {
        const startTime = Date.now();
        
        // In a real implementation, this would execute against a database
        const ddlStatements = this.ddlGenerator.generateDDL(migration.operations);
        
        // Simulate execution
        await this.simulateExecution(ddlStatements);
        
        const endTime = Date.now();
        
        results.push({
          success: true,
          migration_id: migration.id,
          applied_at: new Date(),
          duration_ms: endTime - startTime,
        });

        this.appliedMigrations.add(migration.id);
      }

      return Ok(results);
    } catch (error) {
      return Err(new MigrationError(`Failed to execute migration: ${error.message}`));
    }
  }

  /**
   * Check if a migration has been applied
   */
  isMigrationApplied(migrationId: string): boolean {
    return this.appliedMigrations.has(migrationId);
  }

  /**
   * Get the current migration state
   */
  getMigrationState(): Types.MigrationState {
    const appliedMigrations = Array.from(this.appliedMigrations);
    
    return {
      applied_migrations: appliedMigrations,
      current_schema_hash: this.getCurrentSchemaHash(),
      last_migration_id: appliedMigrations[appliedMigrations.length - 1],
      last_applied_at: new Date(), // Would come from database in real implementation
    };
  }

  /**
   * Validate a migration plan for safety
   */
  validateMigration(plan: Types.MigrationPlan): Result<boolean, MigrationError> {
    const issues: string[] = [];

    for (const migration of plan.migrations) {
      for (const operation of migration.operations) {
        const operationIssues = this.validateOperation(operation);
        issues.push(...operationIssues);
      }
    }

    if (issues.length > 0) {
      return Err(new MigrationError(`Migration validation failed: ${issues.join(", ")}`));
    }

    return Ok(true);
  }

  private generateInitialMigration(schema: SchemaAST.Module[]): Types.MigrationOperation[] {
    const operations: Types.MigrationOperation[] = [];

    for (const module of schema) {
      for (const item of module.items) {
        if (item.kind === "TypeDef") {
          const properties = this.extractProperties(item);
          const links = this.extractLinks(item);
          
          operations.push(Types.createTypeOperation(item.name.name, properties, links));
        }
      }
    }

    return operations;
  }

  private extractProperties(typeDef: SchemaAST.TypeDef): Types.PropertyDefinition[] {
    const properties: Types.PropertyDefinition[] = [];

    for (const item of typeDef.items) {
      if (item.kind === "Property") {
        properties.push({
          name: item.name.name,
          type: this.typeToString(item.type),
          required: item.required || false,
          multi: item.multi || false,
          default: item.default ? this.extractDefaultValue(item.default) : undefined,
          constraints: item.constraints?.map(c => c.name.name) || [],
          annotations: item.annotations?.reduce((acc, ann) => {
            acc[ann.name.name] = ann.value ? this.extractDefaultValue(ann.value) : true;
            return acc;
          }, {} as Record<string, any>) || {},
        });
      }
    }

    return properties;
  }

  private extractLinks(typeDef: SchemaAST.TypeDef): Types.LinkDefinition[] {
    const links: Types.LinkDefinition[] = [];

    for (const item of typeDef.items) {
      if (item.kind === "Link") {
        links.push({
          name: item.name.name,
          target: this.typeToString(item.target),
          required: item.required || false,
          multi: item.multi || false,
          cardinality: item.cardinality,
          on_target_delete: item.on_target_delete,
          annotations: item.annotations?.reduce((acc, ann) => {
            acc[ann.name.name] = ann.value ? this.extractDefaultValue(ann.value) : true;
            return acc;
          }, {} as Record<string, any>) || {},
        });
      }
    }

    return links;
  }

  private typeToString(type: SchemaAST.TypeExpr): string {
    switch (type.kind) {
      case "NamedType":
        return type.name.name;
      case "GenericType":
        return `${type.name.name}<${type.args.map(arg => this.typeToString(arg)).join(", ")}>`;
      default:
        return "unknown";
    }
  }

  private extractDefaultValue(expr: SchemaAST.Expression): any {
    if (expr.kind === "Literal") {
      return expr.value;
    }
    return expr.kind; // Fallback for complex expressions
  }

  private generateMigrationId(): string {
    const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    return `m${timestamp}_${randomSuffix}`;
  }

  private generateMigrationName(operations: Types.MigrationOperation[]): string {
    if (operations.length === 0) {
      return "empty_migration";
    }

    if (operations.length === 1) {
      return this.getOperationName(operations[0]);
    }

    const typeCount = operations.filter(op => op.kind.includes("Type")).length;
    const tableCount = operations.filter(op => op.kind.includes("Table")).length;

    if (typeCount > 0) {
      return `schema_changes_${typeCount}_types`;
    } else if (tableCount > 0) {
      return `table_changes_${tableCount}_tables`;
    }

    return `migration_${operations.length}_operations`;
  }

  private generateMigrationDescription(operations: Types.MigrationOperation[]): string {
    const descriptions = operations.slice(0, 3).map(op => this.getOperationDescription(op));
    
    if (operations.length > 3) {
      descriptions.push(`... and ${operations.length - 3} more operations`);
    }

    return descriptions.join(", ");
  }

  private getOperationName(operation: Types.MigrationOperation): string {
    switch (operation.kind) {
      case "CreateType":
        return `create_${operation.type_name.toLowerCase()}`;
      case "DropType":
        return `drop_${operation.type_name.toLowerCase()}`;
      case "AlterType":
        return `alter_${operation.type_name.toLowerCase()}`;
      default:
        return operation.kind.toLowerCase();
    }
  }

  private getOperationDescription(operation: Types.MigrationOperation): string {
    switch (operation.kind) {
      case "CreateType":
        return `Create type ${operation.type_name}`;
      case "DropType":
        return `Drop type ${operation.type_name}`;
      case "AlterType":
        return `Alter type ${operation.type_name}`;
      default:
        return operation.kind;
    }
  }

  private hashSchema(schema: SchemaAST.Module[]): string {
    // Simple hash based on JSON stringification
    // In production, would use a more robust hashing algorithm
    const schemaString = JSON.stringify(schema, Object.keys(schema).sort());
    let hash = 0;
    for (let i = 0; i < schemaString.length; i++) {
      const char = schemaString.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36);
  }

  private getCurrentSchemaHash(): string {
    // Placeholder - would come from database or schema file
    return "current";
  }

  private estimateDuration(operations: Types.MigrationOperation[]): number {
    // Simple estimation based on operation types (in milliseconds)
    let duration = 0;

    for (const operation of operations) {
      switch (operation.kind) {
        case "CreateType":
          duration += 500; // Creating table with indexes
          break;
        case "DropType":
          duration += 200; // Dropping table
          break;
        case "AlterType":
          duration += 300; // Altering table structure
          break;
        default:
          duration += 100;
      }
    }

    return duration;
  }

  private async simulateExecution(statements: string[]): Promise<void> {
    // Simulate execution time
    await new Promise(resolve => setTimeout(resolve, 10));
    
    if (this.config.dry_run) {
      console.log("DRY RUN - Would execute:");
      statements.forEach(stmt => console.log(stmt));
    }
  }

  private validateOperation(operation: Types.MigrationOperation): string[] {
    const issues: string[] = [];

    switch (operation.kind) {
      case "DropType":
        // Check if type has dependencies
        issues.push(...this.validateDropType(operation));
        break;
      case "AlterType":
        // Check for breaking changes
        issues.push(...this.validateAlterType(operation));
        break;
    }

    return issues;
  }

  private validateDropType(operation: Types.DropTypeOperation): string[] {
    const issues: string[] = [];
    
    // In a real implementation, would check database for foreign key references
    // For now, just warn about potential data loss
    issues.push(`Dropping type ${operation.type_name} may result in data loss`);
    
    return issues;
  }

  private validateAlterType(operation: Types.AlterTypeOperation): string[] {
    const issues: string[] = [];

    for (const typeOp of operation.operations) {
      if (typeOp.kind === "DropProperty") {
        issues.push(`Dropping property ${typeOp.property_name} from ${operation.type_name} may result in data loss`);
      }
      
      if (typeOp.kind === "AlterProperty") {
        for (const change of typeOp.changes) {
          if (change.kind === "ChangeType") {
            issues.push(`Changing type of ${typeOp.property_name} may require data migration`);
          }
          if (change.kind === "ChangeRequired" && change.new_value) {
            issues.push(`Making ${typeOp.property_name} required may fail if existing NULL values exist`);
          }
        }
      }
    }

    return issues;
  }
}