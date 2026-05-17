/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Extension context factory for Disc database
 */

import type { Schema } from "../compiler/context.ts";
import type { ConnectionPool } from "../lib/connection-pool.ts";
import { getLogger } from "../lib/logger.ts";
import type { Logger } from "../lib/logger.ts";
import type { ServerConfig } from "../server/types.ts";
import type { ExtensionContext } from "./types.ts";

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
    logger: options.logger || getLogger("extensions")
  };
}
