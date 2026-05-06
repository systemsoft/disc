/**
 * OAuth extension for Disc database
 */

import { BaseExtension } from "../extensions/base-extension.ts";
import type {
  ExtensionContext,
  ExtensionDatabaseSetup,
  ExtensionMetadata,
  ExtensionRoute,
} from "../extensions/types.ts";
import { ExtensionConfigError } from "../extensions/errors.ts";
import type {
  OAuthConfig,
  OAuthErrorResponse,
  OAuthProviderConfig,
} from "./types.ts";
import { OAuthStateManager } from "./state-manager.ts";
import { normalizePkceParam } from "./pkce.ts";
import { matchRedirectUri } from "./redirect-matcher.ts";
import { exchangeCodeForToken, fetchUserInfo } from "./token-exchange.ts";

const MAX_METADATA_BYTES = 2048;

const RESERVED_AUTHORIZE_PARAMS = new Set([
  "client_id",
  "redirect_uri",
  "response_type",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
]);

function validateExtraAuthorizeParams(provider: OAuthProviderConfig): void {
  const extras = provider.extraAuthorizeParams;
  if (!extras) return;
  for (const key of Object.keys(extras)) {
    if (RESERVED_AUTHORIZE_PARAMS.has(key)) {
      throw new ExtensionConfigError(
        "oauth",
        `provider "${provider.name}" extraAuthorizeParams cannot override reserved param "${key}"`,
      );
    }
  }
}

function jsonError(
  code: OAuthErrorResponse["error"]["code"],
  message: string,
  status: number,
  details?: string,
): Response {
  const body: OAuthErrorResponse = {
    error: { code, message, ...(details ? { details } : {}) },
  };
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

export class OAuthExtension extends BaseExtension {
  readonly metadata: ExtensionMetadata = {
    dependencies: [],
    description: "OAuth 2.0 provider integration",
    name: "oauth",
    version: "1.0.0",
  };

  private config: OAuthConfig;
  private providers: Map<string, OAuthProviderConfig> = new Map();
  private stateManager: OAuthStateManager;

  constructor(config: OAuthConfig) {
    super();
    if (!config.providers || config.providers.length === 0) {
      throw new ExtensionConfigError(
        "oauth",
        "At least one provider is required",
      );
    }
    this.config = config;
    this.stateManager = new OAuthStateManager(config.stateExpiryMs);

    for (const provider of config.providers) {
      validateExtraAuthorizeParams(provider);
      this.providers.set(provider.name, provider);
    }
  }

  override async initialize(context: ExtensionContext): Promise<void> {
    this.setState("initializing");
    context.logger.info("OAuth extension initializing", {
      providers: Array.from(this.providers.keys()),
    });
    await super.initialize(context);
  }

  override getRoutes(): ExtensionRoute[] {
    const routes: ExtensionRoute[] = [
      {
        handler: (_request: Request): Promise<Response> => {
          const providers = Array.from(this.providers.keys());
          return Promise.resolve(
            new Response(JSON.stringify({ providers }), {
              headers: { "Content-Type": "application/json" },
            }),
          );
        },
        method: "GET",
        path: "/providers",
      },
    ];

    // Add per-provider authorize and callback routes
    for (const [name, provider] of this.providers) {
      routes.push({
        handler: (request: Request): Promise<Response> => {
          return this.handleAuthorize(request, provider);
        },
        method: "GET",
        path: `/authorize/${name}`,
      });

      routes.push({
        handler: (request: Request): Promise<Response> => {
          return this.handleCallback(request, provider);
        },
        method: "GET",
        path: `/callback/${name}`,
      });
    }

    return routes;
  }

  override getDatabaseSetup(): ExtensionDatabaseSetup {
    return {
      setupSql: [
        `CREATE TABLE IF NOT EXISTS disc_oauth_states (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);`,
        `CREATE TABLE IF NOT EXISTS disc_oauth_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  email TEXT,
  name TEXT,
  avatar_url TEXT,
  access_token TEXT,
  refresh_token TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(provider, provider_user_id)
);`,
      ],
      teardownSql: [
        "DROP TABLE IF EXISTS disc_oauth_identities;",
        "DROP TABLE IF EXISTS disc_oauth_states;",
      ],
    };
  }

  getStateManager(): OAuthStateManager {
    return this.stateManager;
  }

  getProvider(name: string): OAuthProviderConfig | undefined {
    return this.providers.get(name);
  }

  private async handleAuthorize(
    request: Request,
    provider: OAuthProviderConfig,
  ): Promise<Response> {
    // gh/geldata#7468: when `allowedRedirectUris` is configured, accept a
    // caller-supplied `?redirect_uri=…` query param after validating it
    // against the allowlist. Without an allowlist, callers can't override
    // the configured fixed URI — preserves the prior behavior and keeps
    // single-tenant deployments simple.
    const url = new URL(request.url);
    const callerSuppliedUri = url.searchParams.get("redirect_uri");
    const allowlist = provider.allowedRedirectUris ?? [];

    let redirectUri: string;
    if (callerSuppliedUri && allowlist.length > 0) {
      if (!matchRedirectUri(callerSuppliedUri, allowlist)) {
        return jsonError(
          "redirect_uri_not_allowed",
          "redirect_uri not in allowlist",
          400,
        );
      }
      redirectUri = callerSuppliedUri;
    } else if (callerSuppliedUri && allowlist.length === 0) {
      // Allowlist not configured — refuse caller-supplied URIs outright
      // rather than silently ignoring them and using the fixed URI
      // (silent fallback would mask a misconfiguration).
      return jsonError(
        "redirect_uri_override_disabled",
        "redirect_uri override not permitted — provider has no allowedRedirectUris",
        400,
      );
    } else {
      redirectUri = provider.redirectUri ??
        this.config.defaultRedirectUri ??
        "";
    }

    // gh/geldata#8841: caller-supplied opaque metadata carried through
    // the OAuth handshake. Used by the calling app for things like
    // post-login redirects (`{"next": "/dashboard"}`) without inventing
    // a separate session store.
    const metadataParam = url.searchParams.get("metadata");
    let metadata: Record<string, unknown> | undefined;
    if (metadataParam) {
      if (metadataParam.length > MAX_METADATA_BYTES) {
        return jsonError(
          "metadata_too_large",
          `metadata exceeds ${MAX_METADATA_BYTES}-byte cap`,
          400,
        );
      }
      try {
        const parsed = JSON.parse(metadataParam);
        if (
          typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
        ) {
          throw new Error("metadata must be a JSON object");
        }
        metadata = parsed as Record<string, unknown>;
      } catch (error) {
        return jsonError(
          "metadata_invalid",
          "metadata must be a JSON-encoded object",
          400,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    const oauthState = await this.stateManager.createState(
      provider.name,
      redirectUri,
      metadata,
    );

    const params = new URLSearchParams({
      client_id: provider.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: provider.scopes.join(" "),
      state: oauthState.state,
    });

    // P1-41: include PKCE challenge in the authorize redirect. Providers
    // that support S256 (Google, GitHub, Apple, all modern OAuth 2.1
    // providers) will require the matching code_verifier at token
    // exchange. Fallback silently if state-manager didn't populate them.
    if (oauthState.codeChallenge) {
      // gh/geldata#7596: strip RFC 7636-disallowed trailing `=`
      // padding before sending the challenge upstream. The
      // state-manager already produces unpadded output, so this is
      // belt-and-suspenders against future code paths that might
      // hand us a padded challenge.
      params.set(
        "code_challenge",
        normalizePkceParam(oauthState.codeChallenge),
      );
      params.set("code_challenge_method", "S256");
    }

    // gh/geldata#7752: provider-specific authorize knobs (e.g. Google's
    // access_type=offline + prompt=consent for refresh tokens). Reserved
    // names were rejected at construction; what's left is safe to append.
    if (provider.extraAuthorizeParams) {
      for (const [key, value] of Object.entries(provider.extraAuthorizeParams)) {
        params.set(key, value);
      }
    }

    const authorizeUrl = `${provider.authorizeUrl}?${params.toString()}`;

    return Promise.resolve(
      new Response(
        JSON.stringify({ state: oauthState.state, url: authorizeUrl }),
        {
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
  }

  private async handleCallback(
    request: Request,
    provider: OAuthProviderConfig,
  ): Promise<Response> {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const stateParam = url.searchParams.get("state");
    const providerError = url.searchParams.get("error");

    // Provider-side rejection (user denied, invalid request, etc.) —
    // forward the upstream error code so calling apps can branch on it.
    if (providerError) {
      return jsonError(
        "oauth_provider_error",
        "The OAuth provider returned an error",
        400,
        providerError,
      );
    }

    if (!code || !stateParam) {
      return jsonError(
        "missing_parameter",
        "Missing required `code` or `state` parameter",
        400,
      );
    }

    const storedState = this.stateManager.validateState(stateParam);
    if (!storedState) {
      return jsonError(
        "invalid_state",
        "OAuth session expired or already used — please retry login",
        400,
      );
    }

    // gh/geldata#7557: actually run the token exchange + userinfo fetch
    // so calling apps get the user's profile data (name, email, avatar)
    // back from the callback. Replaces the prior stub that just echoed
    // the auth code.
    let tokenResp;
    try {
      tokenResp = await exchangeCodeForToken(
        provider,
        code,
        storedState.redirectUri,
        storedState.codeVerifier,
      );
    } catch (error) {
      return jsonError(
        "token_exchange_failed",
        "Could not complete OAuth token exchange",
        502,
        error instanceof Error ? error.message : String(error),
      );
    }

    let userInfo;
    try {
      userInfo = await fetchUserInfo(provider, tokenResp.accessToken);
    } catch (error) {
      return jsonError(
        "userinfo_failed",
        "Could not fetch user profile from OAuth provider",
        502,
        error instanceof Error ? error.message : String(error),
      );
    }

    return new Response(
      JSON.stringify({
        provider: storedState.provider,
        token: tokenResp,
        user: userInfo,
        // gh/geldata#8841: round-trip the caller-supplied metadata.
        // Calling app uses this for post-login redirects, etc.
        metadata: storedState.metadata,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }
}
