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
import type { OAuthConfig, OAuthProviderConfig } from "./types.ts";
import { OAuthStateManager } from "./state-manager.ts";

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
    _request: Request,
    provider: OAuthProviderConfig,
  ): Promise<Response> {
    const redirectUri = provider.redirectUri ??
      this.config.defaultRedirectUri ??
      "";

    const oauthState = await this.stateManager.createState(
      provider.name,
      redirectUri,
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
      params.set("code_challenge", oauthState.codeChallenge);
      params.set("code_challenge_method", "S256");
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

  private handleCallback(
    request: Request,
    _provider: OAuthProviderConfig,
  ): Promise<Response> {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const stateParam = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ error: `OAuth error: ${error}` }),
          {
            headers: { "Content-Type": "application/json" },
            status: 400,
          },
        ),
      );
    }

    if (!code || !stateParam) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ error: "Missing code or state parameter" }),
          {
            headers: { "Content-Type": "application/json" },
            status: 400,
          },
        ),
      );
    }

    const storedState = this.stateManager.validateState(stateParam);
    if (!storedState) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ error: "Invalid or expired state" }),
          {
            headers: { "Content-Type": "application/json" },
            status: 400,
          },
        ),
      );
    }

    // Token exchange would happen here with a real pool/fetch
    return Promise.resolve(
      new Response(
        JSON.stringify({
          code,
          message: "OAuth callback received",
          provider: storedState.provider,
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
  }
}
