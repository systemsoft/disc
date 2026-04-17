/**
 * Vector search extension for Disc database
 */

import { BaseExtension } from "../extensions/base-extension.ts";
import type {
  CompilerHook,
  ExtensionContext,
  ExtensionDatabaseSetup,
  ExtensionMetadata,
} from "../extensions/types.ts";
import type { FunctionDef, TypeDef } from "../compiler/context.ts";
import type { VectorConfig } from "./types.ts";

export class VectorExtension extends BaseExtension {
  readonly metadata: ExtensionMetadata = {
    name: "vector",
    version: "1.0.0",
    description: "Vector similarity search via pgvector",
  };

  private config: VectorConfig;

  constructor(config?: VectorConfig) {
    super();
    const dims = config?.defaultDimensions ?? 1536;
    // P2-26: pgvector supports dims up to 16000 for hnsw/ivfflat; reject
    // out-of-range at construction time instead of at DDL apply time.
    if (!Number.isInteger(dims) || dims < 1 || dims > 16000) {
      throw new Error(
        `VectorExtension: defaultDimensions must be an integer in [1, 16000], got ${dims}`,
      );
    }
    this.config = {
      defaultDimensions: dims,
      indexType: config?.indexType ?? "hnsw",
    };
  }

  override async initialize(context: ExtensionContext): Promise<void> {
    this.setState("initializing");
    context.logger.info("Vector extension initializing", {
      dimensions: this.config.defaultDimensions,
      indexType: this.config.indexType,
    });

    // P1-40: verify pgvector actually loaded. CREATE EXTENSION IF NOT
    // EXISTS runs in getDatabaseSetup() but can silently fail if the
    // extension isn't installed on the PG server — leaving us in a state
    // where the compiler hooks emit <=> / <-> operators that PG then
    // rejects at query time. Fail fast at init instead.
    if (context.pool) {
      try {
        const result = await context.pool.query(
          "SELECT 1 FROM pg_extension WHERE extname = 'vector'",
        );
        if (!result.rows || result.rows.length === 0) {
          this.setState("failed");
          throw new Error(
            "pgvector extension is not installed on the PostgreSQL server. Install it (e.g. `apt install postgresql-16-pgvector` or `brew install pgvector`) before enabling ext-vector.",
          );
        }
      } catch (error) {
        // If the SELECT itself failed (connection issue), surface the
        // error — don't silently claim ready.
        this.setState("failed");
        throw error;
      }
    }

    this.setState("ready");
  }

  override getFunctions(): FunctionDef[] {
    return [
      {
        name: "cosine_similarity",
        args: [
          { name: "a", type: "array<float32>", required: true },
          { name: "b", type: "array<float32>", required: true },
        ],
        returnType: "float64",
        sqlName: "1 - ($1 <=> $2)",
      },
      {
        name: "l2_distance",
        args: [
          { name: "a", type: "array<float32>", required: true },
          { name: "b", type: "array<float32>", required: true },
        ],
        returnType: "float64",
        sqlName: "$1 <-> $2",
      },
      {
        name: "inner_product",
        args: [
          { name: "a", type: "array<float32>", required: true },
          { name: "b", type: "array<float32>", required: true },
        ],
        returnType: "float64",
        sqlName: "$1 <#> $2",
      },
      {
        name: "to_vector",
        args: [
          { name: "arr", type: "array<float32>", required: true },
        ],
        returnType: "vector",
        sqlName: "$1::vector",
      },
    ];
  }

  override getTypes(): TypeDef[] {
    return [
      {
        name: "vector",
        kind: "scalar",
        properties: new Map(),
        links: new Map(),
        tableName: "",
      },
    ];
  }

  override getDatabaseSetup(): ExtensionDatabaseSetup {
    return {
      setupSql: [
        "CREATE EXTENSION IF NOT EXISTS vector;",
      ],
    };
  }

  override getCompilerHooks(): CompilerHook[] {
    return [
      {
        name: "vector-operators",
        transformFunctionCall: (
          funcName: string,
          args: string[],
        ): string | undefined => {
          switch (funcName) {
            case "cosine_similarity":
              return `1 - (${args[0]} <=> ${args[1]})`;
            case "l2_distance":
              return `${args[0]} <-> ${args[1]}`;
            case "inner_product":
              return `${args[0]} <#> ${args[1]}`;
            case "to_vector":
              return `${args[0]}::vector`;
            default:
              return undefined;
          }
        },
      },
    ];
  }

  override async healthCheck(): Promise<
    { healthy: boolean; details?: string }
  > {
    return {
      healthy: this.state === "ready",
      details: this.state === "ready"
        ? `pgvector enabled (${this.config.defaultDimensions}d, ${this.config.indexType})`
        : undefined,
    };
  }
}
