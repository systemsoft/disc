/**
 * Full-text search extension for Disc database
 *
 * Provides FTS capabilities using PostgreSQL's built-in tsvector/tsquery
 * infrastructure. Unlike the vector extension, no PostgreSQL extension needs
 * to be installed -- tsvector and tsquery are part of core PostgreSQL.
 *
 * Registers two EdgeQL functions:
 *   - fts::search(query) -- filter predicate (tsvector @@ tsquery)
 *   - fts::rank(query)   -- ranking score (ts_rank)
 */

import type { FunctionDef } from "../compiler/context.ts";
import { BaseExtension } from "../extensions/base-extension.ts";
import type { CompilerHook, ExtensionContext, ExtensionDatabaseSetup, ExtensionMetadata, ExtensionRoute } from "../extensions/types.ts";
import { DEFAULT_LANGUAGE, FTS_VECTOR_COLUMN } from "./index-builder.ts";

export class FtsExtension extends BaseExtension {
  readonly metadata: ExtensionMetadata = {
    description: "Full-text search using PostgreSQL tsvector/tsquery",
    name: "fts",
    version: "1.0.0",
  };

  private language: string;

  constructor(language?: string) {
    super();
    this.language = language ?? DEFAULT_LANGUAGE;
  }

  override initialize(context: ExtensionContext): Promise<void> {
    this.setState("initializing");
    context.logger.info("FTS extension initializing", {
      language: this.language,
    });
    this.setState("ready");
    return Promise.resolve();
  }

  override getFunctions(): FunctionDef[] {
    return [
      {
        name: "fts::search",
        args: [{ name: "query", type: "str", required: true }],
        returnType: "bool",
        sqlName: "fts__search",
      },
      {
        name: "fts::rank",
        args: [{ name: "query", type: "str", required: true }],
        returnType: "float64",
        sqlName: "fts__rank",
      },
    ];
  }

  override getDatabaseSetup(): ExtensionDatabaseSetup {
    // tsvector/tsquery are built into PostgreSQL -- no extension to create.
    return { setupSql: [] };
  }

  override getCompilerHooks(): CompilerHook[] {
    const language = this.language;
    return [
      {
        name: "fts-functions",
        transformFunctionCall: (
          funcName: string,
          args: string[],
        ): string | undefined => {
          switch (funcName) {
            case "fts::search":
            case "fts__search":
              return `${FTS_VECTOR_COLUMN} @@ plainto_tsquery('${language}', ${args[0]})`;
            case "fts::rank":
            case "fts__rank":
              return `ts_rank(${FTS_VECTOR_COLUMN}, plainto_tsquery('${language}', ${args[0]}))`;
            default:
              return undefined;
          }
        },
      },
    ];
  }

  override getRoutes(): ExtensionRoute[] {
    return [];
  }

  override healthCheck(): Promise<{ healthy: boolean; details?: string; }> {
    return Promise.resolve({
      healthy: this.state === "ready",
      details: this.state === "ready" ? `FTS enabled (language: ${this.language})` : undefined,
    });
  }
}
