/**
 * Disc Database - A TypeScript-native database built on Deno
 *
 * Schema-first database with EdgeQL query language,
 * reimplementing Gel (EdgeDB) in TypeScript while
 * preserving PostgreSQL as the storage engine.
 */

export * as Schema from "./schema/mod.ts";
export * as EdgeQL from "./edgeql/mod.ts";
export * from "./compiler/mod.ts";
export * from "./lib/mod.ts";

export const VERSION = "0.1.0";
