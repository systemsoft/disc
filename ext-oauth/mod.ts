/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * OAuth extension for Disc database
 */

export type {
  OAuthConfig,
  OAuthProviderConfig,
  OAuthState,
  OAuthUserInfo
} from "./types.ts";

export {
  buildDiscoveryUrl,
  fetchOidcDiscovery,
  type OidcDiscoveryDoc
} from "./discovery.ts";
export { OAuthExtension } from "./extension.ts";
export {
  appleProvider,
  createOidcProvider,
  genericOidcProvider,
  githubProvider,
  googleProvider
} from "./providers.ts";
export type { OidcProviderOptions } from "./providers.ts";
export { OAuthStateManager } from "./state-manager.ts";
export { exchangeCodeForToken, fetchUserInfo } from "./token-exchange.ts";
