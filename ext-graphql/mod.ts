/**
 * GraphQL extension for Disc database
 */

export type { GraphQLConfig, GraphQLError, GraphQLField, GraphQLQuery, GraphQLResponse, GraphQLType } from "./types.ts";
export { GraphQLExtension } from "./extension.ts";
export { generateGraphQLSchema, generateGraphQLTypes, getObjectTypeNames, mapEdgeQLTypeToGraphQL, SCALAR_TYPE_MAP } from "./schema-generator.ts";
export { parseGraphQLQuery, translateToEdgeQL } from "./query-translator.ts";
export type { GraphQLSelection, ParsedGraphQLQuery, TranslationResult } from "./query-translator.ts";
