/**
 * Authentication Module
 * 
 * This module provides comprehensive authentication and authorization
 * capabilities for Disc, including user management, session handling,
 * JWT token management, and HTTP middleware.
 */

export * from "./types.ts";
export * from "./provider.ts";
export * from "./middleware.ts";

// Re-export for convenience
export { AuthProvider } from "./provider.ts";
export { AuthMiddleware, createAuthMiddleware } from "./middleware.ts";
export type { AuthContext, CORSOptions } from "./middleware.ts";