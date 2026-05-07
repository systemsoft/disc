/**
 * Full-text search extension for Disc database
 */

export { FtsExtension } from "./extension.ts";
export { DEFAULT_LANGUAGE, FTS_VECTOR_COLUMN, generateDropFtsIndex, generateFtsColumn, generateFtsIndex, validateFtsConfig } from "./index-builder.ts";
export type { FtsIndexConfig, FtsSearchOptions, FtsWeight } from "./types.ts";
