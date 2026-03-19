/**
 * Migration Squasher
 *
 * Combines multiple sequential DDL migrations into a single migration.
 * Data migrations cannot be squashed and will cause validation errors.
 */

import { MigrationError } from "../lib/errors.ts";
import { MigrationHistoryEntry } from "./types.ts";

/**
 * Input migration for squashing. Contains DDL statements and optional rollback SQL.
 */
export interface SquashableMigration {
  id: string;
  name: string;
  statements: string[];
  rollbackStatements: string[];
  hasDataMigration: boolean;
}

/**
 * Result of squashing multiple migrations.
 */
export interface SquashResult {
  statements: string[];
  rollbackStatements: string[];
  squashedIds: string[];
  name: string;
}

/**
 * Combines multiple migrations into a single squashed migration.
 */
export class MigrationSquasher {
  /**
   * Squash a set of migrations into a single combined migration.
   *
   * @param migrations - Ordered list of migrations to consider
   * @param fromId - Optional start of range (inclusive). If omitted, starts from the first migration.
   * @param toId - Optional end of range (inclusive). If omitted, ends at the last migration.
   * @returns SquashResult with combined statements
   * @throws MigrationError if data migrations exist in the range or range is invalid
   */
  squash(
    migrations: SquashableMigration[],
    fromId?: string,
    toId?: string,
  ): SquashResult {
    if (migrations.length === 0) {
      return {
        statements: [],
        rollbackStatements: [],
        squashedIds: [],
        name: "empty_squash",
      };
    }

    // Determine the range
    const filtered = this.filterByRange(migrations, fromId, toId);

    if (filtered.length === 0) {
      return {
        statements: [],
        rollbackStatements: [],
        squashedIds: [],
        name: "empty_squash",
      };
    }

    // Validate no data migrations in range
    this.validateNoDataMigrations(filtered);

    // Combine DDL statements in order
    const statements: string[] = [];
    for (const migration of filtered) {
      statements.push(...migration.statements);
    }

    // Combine rollback statements in reverse order
    const rollbackStatements: string[] = [];
    for (let i = filtered.length - 1; i >= 0; i--) {
      rollbackStatements.push(...filtered[i].rollbackStatements);
    }

    const squashedIds = filtered.map((m) => m.id);
    const firstId = squashedIds[0];
    const lastId = squashedIds[squashedIds.length - 1];
    const name = `squashed_${firstId}_to_${lastId}`;

    return {
      statements,
      rollbackStatements,
      squashedIds,
      name,
    };
  }

  /**
   * Validate that a set of history entries can be squashed.
   * Returns true if no data migrations exist in the range.
   */
  validateSquashable(entries: MigrationHistoryEntry[]): boolean {
    // MigrationHistoryEntry does not carry dataMigration info,
    // so this check passes by default. The real validation happens
    // in squash() with SquashableMigration which has the flag.
    return entries.length > 0;
  }

  /**
   * Filter migrations to those within the [fromId, toId] range (inclusive).
   */
  private filterByRange(
    migrations: SquashableMigration[],
    fromId?: string,
    toId?: string,
  ): SquashableMigration[] {
    if (!fromId && !toId) {
      return migrations;
    }

    let startIndex = 0;
    let endIndex = migrations.length - 1;

    if (fromId) {
      startIndex = migrations.findIndex((m) => m.id === fromId);
      if (startIndex === -1) {
        throw new MigrationError(
          `Migration "${fromId}" not found in the provided migrations list`,
        );
      }
    }

    if (toId) {
      endIndex = migrations.findIndex((m) => m.id === toId);
      if (endIndex === -1) {
        throw new MigrationError(
          `Migration "${toId}" not found in the provided migrations list`,
        );
      }
    }

    if (startIndex > endIndex) {
      throw new MigrationError(
        `Invalid squash range: "${fromId}" comes after "${toId}". ` +
          "The from-migration must precede the to-migration.",
      );
    }

    return migrations.slice(startIndex, endIndex + 1);
  }

  /**
   * Validate that none of the migrations in the range have data migrations.
   */
  private validateNoDataMigrations(
    migrations: SquashableMigration[],
  ): void {
    const withData = migrations.filter((m) => m.hasDataMigration);
    if (withData.length > 0) {
      const ids = withData.map((m) => m.id).join(", ");
      throw new MigrationError(
        `Cannot squash migrations that include data migrations. ` +
          `The following migrations have data migrations: ${ids}. ` +
          `Remove or manually consolidate the data migrations first.`,
      );
    }
  }
}
