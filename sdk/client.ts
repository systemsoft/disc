/**
 * DiscClient — Core HTTP client for Disc database
 */

import type { DiscClientConfig, HealthStatus, QueryOptions, QueryResponse, QueryValidator, ServerStats } from "./types.ts";
import { DiscAuthError, DiscConnectionError, DiscNetworkError, DiscProtocolError, DiscQueryError, DiscServerError, DiscTimeoutError } from "./errors.ts";
import { applyValidator } from "./validation.ts";
import { reviveResponse } from "./codecs.ts";
import { Transaction } from "./transaction.ts";

const DEFAULT_BASE_URL = "http://localhost:5656";
const DEFAULT_TIMEOUT = 30000;

export class DiscClient {
  private baseUrl: string;
  private timeout: number;
  private customHeaders: Record<string, string>;
  private retries: number;
  private retryDelay: number;
  private authToken?: string;
  private logger?: DiscClientConfig["logger"];

  constructor(config?: DiscClientConfig) {
    this.baseUrl = (config?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeout = config?.timeout ?? DEFAULT_TIMEOUT;
    this.customHeaders = config?.headers ?? {};
    this.retries = config?.retries ?? 0;
    this.retryDelay = config?.retryDelay ?? 1000;
    this.logger = config?.logger;
  }

  /**
   * Execute an EdgeQL query. Returns the data directly.
   * Throws `DiscQueryError` if the server returns query errors, or
   * `DiscValidationError` when an `options.validate` validator rejects
   * the response.
   *
   * **Type safety (P1-28)**: by default the generic `T` is an *unchecked cast*.
   * Pass `options.validate` to enforce the shape at runtime — either a plain
   * `(data) => T` function or any Standard Schema (Zod 3.24+, Valibot,
   * ArkType, Effect Schema, …):
   *
   * ```ts
   * import { z } from "zod";
   * const User = z.object({ name: z.string() });
   * const u = await client.query("select User { name } limit 1",
   *   undefined,
   *   { validate: User });
   * ```
   *
   * Without a validator, the cast survives so existing callers keep working
   * — but typos in your query or upstream schema drift will surface as
   * runtime surprises rather than compile-time errors. For codegen-driven
   * type safety, run `disc codegen`.
   *
   * **Serialization (P1-29)**: server responses come back as JSON, so
   * `datetime` arrives as ISO-8601 strings, `int64` / `bigint` as numeric
   * strings, and `bytes` as base64. Pass `{ revive: true }` to auto-convert
   * `Date` and `bigint` (conservative — only ISO-8601 with a time component
   * and numbers outside `Number.MAX_SAFE_INTEGER`), or import per-field
   * helpers from `disc/sdk/codecs.ts` (`parseDateTime`, `parseInt64`,
   * `parseBytes`). Validators see revived values when both options are set.
   */
  async query<T = unknown>(
    query: string,
    variables?: Record<string, unknown>,
    options?: QueryOptions<T>,
  ): Promise<T> {
    const response = await this.queryRaw<T>(query, variables);

    if (response.errors && response.errors.length > 0) {
      throw new DiscQueryError(response.errors);
    }

    let data: unknown = response.data;
    if (options?.revive) {
      const reviveOpts = options.revive === true ? undefined : options.revive;
      data = reviveResponse(data, reviveOpts);
    }

    if (options?.validate) {
      return await applyValidator(
        options.validate as QueryValidator<T>,
        data,
      );
    }

    return data as T;
  }

  /**
   * Execute an EdgeQL query. Returns the full response envelope
   * including data, errors, and extensions.
   */
  async queryRaw<T = unknown>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<QueryResponse<T>> {
    const body = JSON.stringify(
      variables ? { query, variables } : { query },
    );

    const response = await this.fetch("/query", {
      method: "POST",
      body,
    });

    return await response.json() as QueryResponse<T>;
  }

  /** Check server health status */
  async health(): Promise<HealthStatus> {
    const response = await this.fetch("/health");
    return await response.json() as HealthStatus;
  }

  /** Returns true if the server is alive (liveness probe) */
  async isAlive(): Promise<boolean> {
    try {
      const response = await this.fetch("/health/live");
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Returns true if the server is ready to accept queries */
  async isReady(): Promise<boolean> {
    try {
      const response = await this.fetch("/health/ready");
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Get server statistics */
  async stats(): Promise<ServerStats> {
    const response = await this.fetch("/stats");
    return await response.json() as ServerStats;
  }

  /** Set the JWT auth token for subsequent requests */
  setAuthToken(token: string): void {
    this.authToken = token;
  }

  /** Clear the auth token */
  clearAuthToken(): void {
    this.authToken = undefined;
  }

  /** Get the current auth token (if set) */
  getAuthToken(): string | undefined {
    return this.authToken;
  }

  /**
   * Execute a callback within a transaction.
   * Automatically commits on success and rolls back on error.
   */
  async transaction<T>(
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    // Begin transaction
    const beginResponse = await this.fetch("/transaction/begin", {
      method: "POST",
    });
    const { transactionId } = await beginResponse.json() as {
      transactionId: string;
    };

    const tx = new Transaction(transactionId, this);

    try {
      const result = await fn(tx);

      if (tx.getState() === "active") {
        await tx.commit();
      }

      return result;
    } catch (error) {
      if (tx.getState() === "active") {
        try {
          await tx.rollback();
        } catch {
          // Rollback failure is secondary to the original error
        }
      }
      throw error;
    }
  }

  /** Get the configured base URL */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Internal fetch wrapper used by Transaction and AuthManager.
   * Handles timeout, retries, auth headers, and error classification.
   * @internal
   */
  async fetch(
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers = new Headers({
      "Content-Type": "application/json",
      ...this.customHeaders,
    });

    if (this.authToken) {
      headers.set("Authorization", `Bearer ${this.authToken}`);
    }

    // Merge any extra headers from init
    if (init?.headers) {
      const extra = new Headers(init.headers);
      extra.forEach((value, key) => headers.set(key, value));
    }

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const response = await fetch(url, {
          ...init,
          headers,
          signal: init?.signal ?? AbortSignal.timeout(this.timeout),
        });

        // Classify HTTP errors
        if (response.status === 401 || response.status === 403) {
          const body = await response.text();
          throw new DiscAuthError(
            body || response.statusText,
            response.status,
          );
        }

        if (response.status >= 500) {
          const body = await response.text();
          throw new DiscServerError(
            body || response.statusText,
            response.status,
          );
        }

        return response;
      } catch (error) {
        // Don't retry auth, query, protocol, or server errors
        if (
          error instanceof DiscAuthError ||
          error instanceof DiscQueryError ||
          error instanceof DiscProtocolError
        ) {
          throw error;
        }

        // Server errors get retried
        if (error instanceof DiscServerError) {
          lastError = error;
          if (attempt < this.retries) {
            this.logger?.warn?.("retrying after server error", {
              attempt: attempt + 1,
              max: this.retries,
              status: (error as { statusCode?: number }).statusCode,
            });
            await this.delay(this.backoffDelay(attempt));
            continue;
          }
          this.logger?.error?.("server error exhausted retries", {
            status: error.statusCode,
          });
          throw error;
        }

        // Timeout
        if (error instanceof DOMException && error.name === "TimeoutError") {
          throw new DiscTimeoutError(this.timeout);
        }

        // AbortError from manual abort
        if (error instanceof DOMException && error.name === "AbortError") {
          throw new DiscTimeoutError(this.timeout);
        }

        // Network errors get retried
        if (error instanceof TypeError) {
          lastError = new DiscConnectionError(
            `Connection failed: ${error.message}`,
            error,
          );
          if (attempt < this.retries) {
            await this.delay(this.backoffDelay(attempt));
            continue;
          }
          throw lastError;
        }

        // Unknown error
        lastError = error instanceof Error ? new DiscNetworkError(error.message, error) : new DiscNetworkError(String(error));

        if (attempt < this.retries) {
          await this.delay(this.retryDelay * (attempt + 1));
          continue;
        }

        throw lastError;
      }
    }

    // Should not reach here, but satisfy TypeScript
    throw lastError ?? new DiscNetworkError("Request failed after retries");
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Exponential backoff with ±25% jitter. Prevents thundering herd when
   * many clients retry in lockstep after a shared outage. (P1-30)
   *
   *   attempt=0 → ~retryDelay * 2^0 = retryDelay
   *   attempt=1 → ~retryDelay * 2^1
   *   attempt=2 → ~retryDelay * 2^2
   *
   * Each result is multiplied by a random factor in [0.75, 1.25].
   */
  private backoffDelay(attempt: number): number {
    const base = this.retryDelay * Math.pow(2, attempt);
    const jitter = 0.75 + Math.random() * 0.5;
    return Math.round(base * jitter);
  }
}

/** Create a DiscClient with the given configuration */
export function createClient(config?: DiscClientConfig): DiscClient {
  return new DiscClient(config);
}
