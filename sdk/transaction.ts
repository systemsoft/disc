/**
 * Transaction — Execute multiple queries atomically
 */

import type { QueryOptions, QueryResponse, QueryValidator, TransactionState } from "./types.ts";
import { DiscQueryError, DiscTransactionError } from "./errors.ts";
import { applyValidator } from "./validation.ts";
import { reviveResponse } from "./codecs.ts";

import type { DiscClient } from "./client.ts";

export class Transaction {
  private id: string;
  private client: DiscClient;
  private state: TransactionState = "active";

  constructor(id: string, client: DiscClient) {
    this.id = id;
    this.client = client;
  }

  /**
   * Execute a query within this transaction.
   * Returns the data directly, throws on errors.
   *
   * Pass `options.validate` for runtime shape checking — see
   * `DiscClient.query` for the full validator contract (P1-28).
   */
  async query<T = unknown>(
    query: string,
    variables?: Record<string, unknown>,
    options?: QueryOptions<T>,
  ): Promise<T> {
    this.assertActive();

    const body = JSON.stringify(
      variables ? { query, variables } : { query },
    );

    const response = await this.client.fetch("/query", {
      method: "POST",
      body,
      headers: { "X-Transaction-ID": this.id },
    });

    const result = await response.json() as QueryResponse<T>;

    if (result.errors && result.errors.length > 0) {
      throw new DiscQueryError(result.errors);
    }

    let data: unknown = result.data;
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

  /** Commit the transaction */
  async commit(): Promise<void> {
    this.assertActive();

    await this.client.fetch(`/transaction/${this.id}/commit`, {
      method: "POST",
    });

    this.state = "committed";
  }

  /** Rollback the transaction */
  async rollback(): Promise<void> {
    this.assertActive();

    await this.client.fetch(`/transaction/${this.id}/rollback`, {
      method: "POST",
    });

    this.state = "rolled_back";
  }

  /** Get the current transaction state */
  getState(): TransactionState {
    return this.state;
  }

  /** Get the transaction ID */
  getId(): string {
    return this.id;
  }

  private assertActive(): void {
    if (this.state !== "active") {
      throw new DiscTransactionError(
        `Transaction is ${this.state}, cannot execute operations`,
      );
    }
  }
}
