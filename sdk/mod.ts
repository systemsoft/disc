/**
 * Disc SDK — TypeScript client for Disc database
 *
 * @module
 */

// Core client
export { createClient, DiscClient } from "./client.ts";

// Wire-format codecs (P1-29)
export {
  encodeBytes,
  parseBytes,
  parseDateTime,
  parseInt64,
  reviveResponse,
} from "./codecs.ts";
export type { ReviveOptions } from "./codecs.ts";

// Authentication
export { AuthManager } from "./auth.ts";

// Transactions
export { Transaction } from "./transaction.ts";

// Subscriptions
export {
  createSubscriptionClient,
  SubscriptionClient,
} from "./subscription.ts";

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
