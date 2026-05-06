/**
 * Disc SDK — TypeScript client for Disc database
 *
 * @module
 */

// Core client
export { createClient, DiscClient } from "./client.ts";

// Wire-format codecs (P1-29)
export { encodeBytes, parseBytes, parseDateTime, parseInt64, reviveResponse } from "./codecs.ts";
export type { ReviveOptions } from "./codecs.ts";

// Authentication
export { AuthManager } from "./auth.ts";

// Transactions
export { Transaction } from "./transaction.ts";

// Subscriptions
export { createSubscriptionClient, SubscriptionClient } from "./subscription.ts";

// Query builder (codegen-free, runtime DSL — Phase 1)
export { and, createQueryBuilder, from, not, or, SelectChain } from "./query-builder.ts";
export type { CompiledQuery, QueryBuilder, QueryRunner, Shape, TypedFieldRef, TypedQueryBuilder, TypedRef, TypedSelectChain } from "./query-builder.ts";

// Codegen-free schema declaration (Phase 2 — drives typed builder inference)
export { defineSchema, t } from "./schema-types.ts";
export type {
  DiscSchema,
  FieldMarker,
  FieldType,
  IsLink,
  Link,
  LinkCardinality,
  LinkStub,
  LinkTarget,
  Optional,
  ResolveSelected,
  ResolveType,
  Scalar,
  SchemaSpec,
  SelectShape,
} from "./schema-types.ts";

// Error hierarchy
export {
  DiscAuthError,
  DiscClientError,
  DiscConnectionError,
  DiscErrorCode,
  DiscNetworkError,
  DiscProtocolError,
  DiscQueryError,
  DiscServerError,
  DiscTimeoutError,
  DiscTransactionError,
  DiscValidationError,
} from "./errors.ts";

// Types
export type {
  AuthManagerOptions,
  AuthResponse,
  AuthTokens,
  AuthUser,
  CacheStats,
  DiscClientConfig,
  HealthStatus,
  IsolationLevel,
  LoginCredentials,
  QueryError,
  QueryExtensions,
  QueryOptions,
  QueryRequest,
  QueryResponse,
  QueryValidator,
  RegisterData,
  ServerStats,
  StandardSchemaIssue,
  StandardSchemaResult,
  StandardSchemaV1,
  SubscriptionCallbacks,
  SubscriptionClientConfig,
  SubscriptionHandle,
  SubscriptionMessage,
  SubscriptionRequest,
  TransactionState,
} from "./types.ts";
