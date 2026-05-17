/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Custom functions extension for Disc database
 */

export type {
  CustomFunctionArg,
  CustomFunctionDef,
  CustomFunctionsConfig,
  FunctionImplementation,
  FunctionVolatility
} from "./types.ts";

export {
  generateCreateFunction,
  generateDropFunction,
  mapEdgeqlTypeToPg
} from "./ddl.ts";
export { CustomFunctionsExtension } from "./extension.ts";
