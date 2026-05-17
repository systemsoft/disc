/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Custom functions extension for Disc database
 */

import type { FunctionDef } from "../compiler/context.ts";
import { BaseExtension } from "../extensions/base-extension.ts";
import { ExtensionConfigError } from "../extensions/errors.ts";
import type {
  ExtensionContext,
  ExtensionDatabaseSetup,
  ExtensionMetadata
} from "../extensions/types.ts";
import { generateCreateFunction, generateDropFunction } from "./ddl.ts";
import type { CustomFunctionDef, CustomFunctionsConfig } from "./types.ts";

export class CustomFunctionsExtension extends BaseExtension {
  readonly metadata: ExtensionMetadata = {
    name: "custom-functions",
    version: "1.0.0",
    description: "User-defined EdgeQL-to-SQL function mappings"
  };

  private config: CustomFunctionsConfig;

  constructor(config: CustomFunctionsConfig) {
    super();
    if (!config.functions || !Array.isArray(config.functions)) {
      throw new ExtensionConfigError(
        "custom-functions",
        "functions array is required"
      );
    }
    this.config = config;
  }

  override async initialize(context: ExtensionContext): Promise<void> {
    this.setState("initializing");
    context.logger.info("Custom functions extension initializing", {
      count: this.config.functions.length
    });

    // Run CREATE FUNCTION for PL/pgSQL definitions
    if (context.pool) {
      const setup = this.getDatabaseSetup();
      for (const sql of setup.setupSql) {
        await context.pool.query(sql);
      }
    }

    this.setState("ready");
  }

  override getFunctions(): FunctionDef[] {
    return this.config.functions.map(def => this.toFunctionDef(def));
  }

  override getDatabaseSetup(): ExtensionDatabaseSetup {
    const setupSql: string[] = [];
    const teardownSql: string[] = [];

    for (const def of this.config.functions) {
      const createSql = generateCreateFunction(def);
      if (createSql) {
        setupSql.push(createSql);
      }
      teardownSql.push(generateDropFunction(def));
    }

    return { setupSql, teardownSql };
  }

  private toFunctionDef(def: CustomFunctionDef): FunctionDef {
    let sqlName: string | undefined;

    switch (def.implementation.kind) {
      case "sql_name":
        sqlName = def.implementation.sqlName;
        break;
      case "sql_expression":
        sqlName = def.implementation.expression;
        break;
      case "plpgsql":
        sqlName = def.name; // PL/pgSQL functions use their own name in SQL
        break;
    }

    return {
      name: def.name,
      args: def.args.map(a => ({
        name: a.name,
        type: a.type,
        required: a.required ?? true
      })),
      returnType: def.returnType,
      sqlName
    };
  }
}
