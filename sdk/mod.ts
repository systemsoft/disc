/**
 * Disc SDK — TypeScript client for Disc database
 *
 * @module
 */

// Core client
export { createClient, DiscClient } from "./client.ts";

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
