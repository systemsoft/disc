/**
 * OAuth extension for Disc database
 */

export type {
  OAuthConfig,
  OAuthProviderConfig,
  OAuthState,
  OAuthUserInfo,
} from "./types.ts";

export { OAuthExtension } from "./extension.ts";
export { OAuthStateManager } from "./state-manager.ts";
export { appleProvider, githubProvider, googleProvider } from "./providers.ts";
export { exchangeCodeForToken, fetchUserInfo } from "./token-exchange.ts";
