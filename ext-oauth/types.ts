/**
 * OAuth extension types for Disc database
 */

export interface OAuthProviderConfig {
  name: string;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scopes: string[];
  redirectUri?: string;
}

export interface OAuthConfig {
  providers: OAuthProviderConfig[];
  stateExpiryMs?: number; // default: 600000 (10 minutes)
  defaultRedirectUri?: string;
}

export interface OAuthUserInfo {
  id: string;
  email?: string;
  name?: string;
  avatarUrl?: string;
  raw: Record<string, unknown>;
}

export interface OAuthState {
  state: string;
  provider: string;
  redirectUri: string;
  createdAt: number;
  expiresAt: number;
}
