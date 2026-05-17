/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Authentication Module
 *
 * This module provides comprehensive authentication and authorization
 * capabilities for Disc, including user management, session handling,
 * JWT token management, and HTTP middleware.
 */

/*** EXPORT ------------------------------------------- ***/

export * from "./integration.ts";
export * from "./middleware.ts";
export * from "./pg-database-adapter.ts";
export * from "./provider.ts";
export * from "./types.ts";

export { AuthMiddleware, createAuthMiddleware } from "./middleware.ts";
export { AuthProvider } from "./provider.ts";
export { AuthRoutes } from "./integration.ts";
export { PgDatabaseAdapter } from "./pg-database-adapter.ts";
export type { AuthContext, CORSOptions } from "./middleware.ts";
