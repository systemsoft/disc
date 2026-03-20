/**
 * GraphQL extension types for Disc database
 */

import type { Schema } from "../compiler/context.ts";

export interface GraphQLConfig {
  schema: Schema;
  enableIntrospection?: boolean;
  enableMutations?: boolean;
  maxDepth?: number;
}

export interface GraphQLField {
  name: string;
  type: string;
  required: boolean;
  isList: boolean;
  description?: string;
}

export interface GraphQLType {
  name: string;
  fields: GraphQLField[];
  description?: string;
}

export interface GraphQLQuery {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

export interface GraphQLResponse {
  data?: Record<string, unknown>;
  errors?: GraphQLError[];
}

export interface GraphQLError {
  message: string;
  locations?: { line: number; column: number }[];
  path?: (string | number)[];
  extensions?: Record<string, unknown>;
}
