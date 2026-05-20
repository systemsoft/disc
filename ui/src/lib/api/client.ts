/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

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

/*** EXPORT ------------------------------------------- ***/

export interface ConfigKeyDef {
  defaultScope: "database" | "instance" | "session" | "system";
  defaultValue?: boolean | number | string;
  description?: string;
  edgeqlType: "bool" | "duration" | "float" | "int" | "memory" | "str";
  name: string;
  pgName: string;
  /** When true, the UI must mask the current value (`••••••`) and refuse to display it. */
  secret: boolean;
}

export interface ConfigResponse {
  keys: ConfigKeyDef[];
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

export interface SchemaFunctionDescription {
  name: string;
  params: string[];
  returnType: string;
}

export interface SchemaIndexDescription {
  /** Optional named index — e.g., `index name_idx on (.name)`. */
  name?: string;
  /**
   * Columns covered by the index. Single-column indexes have one entry;
   * composite indexes expose each column as a separate entry.
   */
  columns: string[];
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

export interface SchemaTypeDescription {
  abstract: boolean;
  accessPolicies: string[];
  annotations: Record<string, string>;
  enumValues?: string[];
  indexes: SchemaIndexDescription[];
  kind: "object" | "scalar" | "enum";
  links: SchemaLinkDescription[];
  module: string;
  name: string;
  parentTypes: string[];
  properties: SchemaPropertyDescription[];
  secret: boolean;
}

export interface SchemaDescription {
  functions: SchemaFunctionDescription[];
  modules: string[];
  types: SchemaTypeDescription[];
}

export interface ServerHealth {
  connections?: any;
  extensions?: Record<string, { details?: string; healthy: boolean; }>;
  memory?: any;
  status: string;
  timestamp: string;
  uptimeMs: number;
}

export interface ServerStats {
  /** Database resolved for this request — the one the UI is viewing. */
  database?: string;
  /** All databases registered with the server. */
  databases?: string[];
  connections: any;
  memoryUsage?: any;
  queries: {
    avgDurationMs: number;
    failed: number;
    successful: number;
    total: number;
  };
  transactions: any;
  uptimeMs: number;
}

export class DiscAPIClient {
  private authToken: string | null = null;
  private baseUrl: string;
  private readonly TOKEN_STORAGE_KEY = "disc.auth.token";

  constructor(baseUrl = "/api") {
    this.baseUrl = baseUrl;
    /*** Hydrate token from localStorage so a refresh doesn’t sign the user out. Browser-only —
         server-side SvelteKit guards with `typeof localStorage`. ***/
    if (typeof localStorage !== "undefined")
      this.authToken = localStorage.getItem(this.TOKEN_STORAGE_KEY);
  }

  /** Execute an EdgeQL query. Wraps the raw QueryResponse into a UI-shaped result. */
  async executeQuery(query: string, variables?: Record<string, any>): Promise<QueryResult> {
    const startedAt = performance.now();

    try {
      const response = await fetch(`${this.baseUrl}/query`, {
        body: JSON.stringify({ query, variables }),
        headers: this.headers,
        method: "POST"
      });

      const body = await response.json() as QueryResponse;
      const durationMs = performance.now() - startedAt;

      if (!response.ok || (body.errors && body.errors.length > 0)) {
        const message = body.errors?.[0]?.message ?? response.statusText ?? `Query failed (HTTP ${response.status})`;
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

  /** Get current auth token (null if not authenticated). */
  getAuthToken(): string | null {
    return this.authToken;
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

  isAuthenticated(): boolean {
    return this.authToken !== null;
  }

  /** POST /auth/login — exchange credentials for a JWT and persist it. */
  async login(email: string, password: string): Promise<{ refreshToken?: string; token: string; } | null> {
    try {
      const res = await fetch(`${this.baseUrl}/auth/login`, {
        body: JSON.stringify({ email, password }),
        headers: { "Content-Type": "application/json" },
        method: "POST"
      });

      if (!res.ok)
        return null;

      const body = await res.json() as {
        refreshToken?: string;
        token: string;
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

  /**
   * Set the JWT auth token. Persisted to localStorage so it survives
   * page reloads; pass `null` to clear (on logout).
   */
  setAuthToken(token: string | null): void {
    this.authToken = token;

    if (typeof localStorage !== "undefined") {
      if (token)
        localStorage.setItem(this.TOKEN_STORAGE_KEY, token);
      else
        localStorage.removeItem(this.TOKEN_STORAGE_KEY);
    }
  }

  /*** PRIVATE ------------------------------------------ ***/

  /** Build request headers, injecting Authorization when a token is set. */
  private get headers(): HeadersInit {
    const h: Record<string, string> = {
      "Content-Type": "application/json"
    };

    if (this.authToken)
      h["Authorization"] = `Bearer ${this.authToken}`;

    return h;
  }
}

export const discAPI = new DiscAPIClient();
