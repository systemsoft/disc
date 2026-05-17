/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Full-text search extension for Disc database
 */

export { FtsExtension } from "./extension.ts";
export {
  DEFAULT_LANGUAGE,
  FTS_VECTOR_COLUMN,
  generateDropFtsIndex,
  generateFtsColumn,
  generateFtsIndex,
  validateFtsConfig
} from "./index-builder.ts";
export type { FtsIndexConfig, FtsSearchOptions, FtsWeight } from "./types.ts";
