/**
 * API Client for Disc Server Communication
 *
 * Targets the real Disc HTTP surface exposed by `server/http.ts`:
 *   POST /query        — execute EdgeQL
 *   GET  /schema       — full SchemaDescription
 *   GET  /schema/types — TypeDescription[]
 *   GET  /health       — server + extension health
 *   GET  /stats        — connection / query / transaction stats
 *   POST /auth/login   — JWT exchange
 *
 * The vite dev server proxies `/api/*` -> `http://localhost:5656/*`
 * (no rewrite), so the client uses the bare server paths directly.
 */
export interface SchemaPropertyDescription {
  annotations: Record<string, string>;
  computed: boolean;
  constraints: string[];
  hasDefault: boolean;
  name: string;
  readonly: boolean;
  required: boolean;
  /** Marked with `@secret := true` — UI must mask the value. */
  secret: boolean;
  type: string;
}

export interface SchemaLinkDescription {
  annotations: Record<string, string>;
  cardinality: "single" | "multi";
  name: string;
  readonly: boolean;
  required: boolean;
  secret: boolean;
  target: string;
}

export interface SchemaTypeDescription {
  abstract: boolean;
  accessPolicies: string[];
  annotations: Record<string, string>;
  indexes: string[];
  links: SchemaLinkDescription[];
  module: string;
  name: string;
  parentTypes: string[];
  properties: SchemaPropertyDescription[];
  secret: boolean;
}

export interface SchemaFunctionDescription {
  name: string;
  params: string[];
  returnType: string;
}

export interface SchemaDescription {
  functions: SchemaFunctionDescription[];
  modules: string[];
  types: SchemaTypeDescription[];
}

export interface QueryError {
  extensions?: Record<string, any>;
  locations?: Array<{ column: number; line: number; }>;
  message: string;
  path?: Array<string | number>;
}

export interface QueryResponse {
  data?: any;
  errors?: QueryError[];
  extensions?: Record<string, any>;
}

export interface QueryResult {
  data: any;
  durationMs: number;
  error?: string;
}

export interface ServerHealth {
  status: string;
  timestamp: string;
  uptimeMs: number;
  connections?: any;
  memory?: any;
  extensions?: Record<string, { details?: string; healthy: boolean; }>;
}

export interface ServerStats {
  connections: any;
  queries: { avgDurationMs: number; failed: number; successful: number; total: number; };
  transactions: any;
  uptimeMs: number;
  memoryUsage?: any;
}

export interface ConnectionInfo {
  activeConnections: number;
  connected: boolean;
  database: string;
  uptimeMs: number;
  version: string;
}

export interface MigrationHistoryEntry {
  appliedAt: string;
  createdAt: string;
  dataMigration: boolean;
  description: string;
  durationMs: number;
  id: string;
  name: string;
  schemaHash: string;
}

export interface MigrationsResponse {
  migrations: MigrationHistoryEntry[];
}

export interface ConfigKeyDef {
  defaultScope: "session" | "database" | "instance" | "system";
  defaultValue?: string | number | boolean;
  description?: string;
  edgeqlType: "str" | "int" | "bool" | "duration" | "memory" | "float";
  name: string;
  pgName: string;
  /** When true, the UI must mask the current value (`••••••`) and refuse to display it. */
  secret: boolean;
}

export interface ConfigResponse {
  keys: ConfigKeyDef[];
}

export class DiscAPIClient {
  private authToken: string | null = null;
  private baseUrl: string;
  private readonly TOKEN_STORAGE_KEY = "disc.auth.token";

  constructor(baseUrl = "/api") {
    this.baseUrl = baseUrl;
    // P1-24: hydrate token from localStorage so a refresh doesn't sign
    // the user out. Browser-only — server-side SvelteKit guards with
    // `typeof localStorage`.
    if (typeof localStorage !== "undefined") {
      this.authToken = localStorage.getItem(this.TOKEN_STORAGE_KEY);
    }
  }

  /**
   * Set the JWT auth token. Persisted to localStorage so it survives
   * page reloads; pass `null` to clear (on logout). (P1-24)
   */
  setAuthToken(token: string | null): void {
    this.authToken = token;
    if (typeof localStorage !== "undefined") {
      if (token) {
        localStorage.setItem(this.TOKEN_STORAGE_KEY, token);
      } else {
        localStorage.removeItem(this.TOKEN_STORAGE_KEY);
      }
    }
  }

  /** Get current auth token (null if not authenticated). */
  getAuthToken(): string | null {
    return this.authToken;
  }

  /** Build request headers, injecting Authorization when a token is set. */
  private get headers(): HeadersInit {
    const h: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (this.authToken) {
      h["Authorization"] = `Bearer ${this.authToken}`;
    }
    return h;
  }

  /** POST /auth/login — exchange credentials for a JWT and persist it. */
  async login(
    email: string,
    password: string
  ): Promise<{ token: string; refreshToken?: string; } | null> {
    try {
      const res = await fetch(`${this.baseUrl}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      if (!res.ok)
        return null;
      const body = await res.json() as {
        token: string;
        refreshToken?: string;
      };
      this.setAuthToken(body.token);
      return body;
    } catch {
      return null;
    }
  }

  logout(): void {
    this.setAuthToken(null);
  }

  isAuthenticated(): boolean {
    return this.authToken !== null;
  }

  /** Execute an EdgeQL query. Wraps the raw QueryResponse into a UI-shaped result. */
  async executeQuery(
    query: string,
    variables?: Record<string, any>
  ): Promise<QueryResult> {
    const startedAt = performance.now();
    try {
      const response = await fetch(`${this.baseUrl}/query`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ query, variables })
      });

      const body = await response.json() as QueryResponse;
      const durationMs = performance.now() - startedAt;

      if (!response.ok || (body.errors && body.errors.length > 0)) {
        const message = body.errors?.[0]?.message ?? response.statusText ??
          `Query failed (HTTP ${response.status})`;
        return { data: null, durationMs, error: message };
      }

      return { data: body.data, durationMs };
    } catch (error) {
      return {
        data: null,
        durationMs: performance.now() - startedAt,
        error: error instanceof Error ? error.message : "Unknown error"
      };
    }
  }

  /** GET /schema — full SchemaDescription. */
  async getSchema(): Promise<SchemaDescription> {
    const empty: SchemaDescription = { functions: [], modules: [], types: [] };
    try {
      const response = await fetch(`${this.baseUrl}/schema`, {
        headers: this.headers
      });
      if (!response.ok)
        return empty;
      return await response.json() as SchemaDescription;
    } catch (error) {
      // deno-lint-ignore no-console
      console.error("Failed to fetch schema:", error);
      return empty;
    }
  }

  /** GET /schema/types/:name — single type description. */
  async getType(typeName: string): Promise<SchemaTypeDescription | null> {
    try {
      const response = await fetch(
        `${this.baseUrl}/schema/types/${encodeURIComponent(typeName)}`,
        { headers: this.headers }
      );
      if (!response.ok)
        return null;
      return await response.json() as SchemaTypeDescription;
    } catch (error) {
      // deno-lint-ignore no-console
      console.error(`Failed to fetch type ${typeName}:`, error);
      return null;
    }
  }

  /** GET /health — used by the connection-info card and as a smoke check. */
  async getHealth(): Promise<ServerHealth | null> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        headers: this.headers
      });
      if (!response.ok)
        return null;
      return await response.json() as ServerHealth;
    } catch {
      return null;
    }
  }

  /** GET /migrations — applied migration history from disc_migrations. */
  async getMigrations(): Promise<MigrationHistoryEntry[]> {
    try {
      const response = await fetch(`${this.baseUrl}/migrations`, {
        headers: this.headers
      });
      if (!response.ok)
        return [];
      const body = await response.json() as MigrationsResponse;
      return body.migrations ?? [];
    } catch (error) {
      // deno-lint-ignore no-console
      console.error("Failed to fetch migrations:", error);
      return [];
    }
  }

  /**
   * GET /config — registry of CONFIGURE-able settings with metadata
   * including the `secret` flag. Values are not included; the UI must
   * mask any field where `secret === true` before showing a value
   * obtained elsewhere. (#5988 + #6444)
   */
  async getConfig(): Promise<ConfigKeyDef[]> {
    try {
      const response = await fetch(`${this.baseUrl}/config`, {
        headers: this.headers
      });
      if (!response.ok)
        return [];
      const body = await response.json() as ConfigResponse;
      return body.keys ?? [];
    } catch (error) {
      // deno-lint-ignore no-console
      console.error("Failed to fetch config:", error);
      return [];
    }
  }

  /** GET /stats — used by the connection-info card. */
  async getStats(): Promise<ServerStats | null> {
    try {
      const response = await fetch(`${this.baseUrl}/stats`, {
        headers: this.headers
      });
      if (!response.ok)
        return null;
      return await response.json() as ServerStats;
    } catch {
      return null;
    }
  }
}

export const discAPI = new DiscAPIClient();
