/**
 * Extension context factory for Disc database
 */

import type { ExtensionContext } from "./types.ts";
import type { ConnectionPool } from "../lib/connection-pool.ts";
import type { Schema } from "../compiler/context.ts";
import type { ServerConfig } from "../server/types.ts";
import { getLogger } from "../lib/logger.ts";
import type { Logger } from "../lib/logger.ts";

export function createExtensionContext(options: {
  pool?: ConnectionPool;
  schema: Schema;
  config: ServerConfig;
  logger?: Logger;
}): ExtensionContext {
  return {
    pool: options.pool,
    schema: options.schema,
    config: options.config,
    logger: options.logger || getLogger("extensions"),
  };
}
