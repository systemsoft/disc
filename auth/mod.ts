/**
 * Authentication Module
 *
 * This module provides comprehensive authentication and authorization
 * capabilities for Disc, including user management, session handling,
 * JWT token management, and HTTP middleware.
 */

export * from "./integration.ts";
export * from "./middleware.ts";
export * from "./pg-database-adapter.ts";
export * from "./provider.ts";
export * from "./types.ts";

// Re-export for convenience
export { AuthRoutes } from "./integration.ts";
export { AuthMiddleware, createAuthMiddleware } from "./middleware.ts";
export type { AuthContext, CORSOptions } from "./middleware.ts";
export { PgDatabaseAdapter } from "./pg-database-adapter.ts";
export { AuthProvider } from "./provider.ts";
