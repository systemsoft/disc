/**
 * Custom functions extension for Disc database
 */

export type { CustomFunctionArg, CustomFunctionDef, CustomFunctionsConfig, FunctionImplementation, FunctionVolatility } from "./types.ts";

export { generateCreateFunction, generateDropFunction, mapEdgeqlTypeToPg } from "./ddl.ts";
export { CustomFunctionsExtension } from "./extension.ts";
