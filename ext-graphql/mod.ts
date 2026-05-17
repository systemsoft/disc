/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * GraphQL extension for Disc database
 */

export { GraphQLExtension } from "./extension.ts";
export { parseGraphQLQuery, translateToEdgeQL } from "./query-translator.ts";
export type {
  GraphQLSelection,
  ParsedGraphQLQuery,
  TranslationResult
} from "./query-translator.ts";
export {
  generateGraphQLSchema,
  generateGraphQLTypes,
  getObjectTypeNames,
  mapEdgeQLTypeToGraphQL,
  SCALAR_TYPE_MAP
} from "./schema-generator.ts";
export type {
  GraphQLConfig,
  GraphQLError,
  GraphQLField,
  GraphQLQuery,
  GraphQLResponse,
  GraphQLType
} from "./types.ts";
