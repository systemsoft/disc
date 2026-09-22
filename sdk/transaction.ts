/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Transaction — Execute multiple queries atomically
 */

import { jsonReplacer, reviveResponse } from "./codecs.ts";
import { createQueryError, DiscTransactionError } from "./errors.ts";
import type {
  QueryOptions,
  QueryResponse,
  QueryValidator,
  TransactionState
} from "./types.ts";
import { applyValidator } from "./validation.ts";

import type { DiscClient } from "./client.ts";

export class Transaction {
  private id: string;
  private client: DiscClient;
  private state: TransactionState = "active";
  /** What failed the transaction, when `state` is `failed`. */
  private failure?: unknown;

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
    options?: QueryOptions<T>
  ): Promise<T> {
    this.assertActive();

    const body = JSON.stringify(
      variables ? { query, variables } : { query },
      jsonReplacer
    );

    let result: QueryResponse<T>;

    // A statement that fails poisons the transaction, as in PostgreSQL: it
    // can only be rolled back. So does one whose outcome is unknown (the
    // request never got an answer). Catching the error in user code does
    // not un-poison it — `commit()` refuses, and `DiscClient.transaction()`
    // rolls back.
    try {
      const response = await this.client.fetch("/query", {
        method: "POST",
        body,
        headers: { "X-Transaction-ID": this.id }
      });

      result = await response.json() as QueryResponse<T>;

      if (result.errors && result.errors.length > 0) {
        throw createQueryError(result.errors);
      }
    } catch (error) {
      this.state = "failed";
      this.failure = error;
      throw error;
    }

    let data: unknown = result.data;
    if (options?.revive) {
      const reviveOpts = options.revive === true ? undefined : options.revive;
      data = reviveResponse(data, reviveOpts);
    }

    if (options?.validate) {
      return await applyValidator(
        options.validate as QueryValidator<T>,
        data
      );
    }

    return data as T;
  }

  /**
   * Commit the transaction. A rejected commit (the server no longer knows
   * the transaction, it was aborted, or COMMIT itself failed) throws and
   * leaves the transaction `failed`: it is over on the server either way,
   * and a COMMIT is never re-sent.
   */
  async commit(): Promise<void> {
    this.assertActive();

    // The id is a bearer capability: it authorizes anything done to this
    // transaction. Send it as a header rather than in the path so it stays
    // out of access logs, proxy logs, and Referer headers.
    try {
      await this.client.fetch("/transaction/commit", {
        headers: { "X-Transaction-ID": this.id },
        method: "POST"
      });
    } catch (error) {
      this.state = "failed";
      this.failure = error;
      throw error;
    }

    this.state = "committed";
  }

  /** Rollback the transaction. Allowed while active, and after a statement has failed. */
  async rollback(): Promise<void> {
    if (this.state !== "failed") {
      this.assertActive();
    }

    await this.client.fetch("/transaction/rollback", {
      headers: { "X-Transaction-ID": this.id },
      method: "POST"
    });

    this.state = "rolled_back";
  }

  /** Get the current transaction state */
  getState(): TransactionState {
    return this.state;
  }

  /** The error that put the transaction in the `failed` state; undefined otherwise. */
  getFailure(): unknown {
    return this.failure;
  }

  /** Get the transaction ID */
  getId(): string {
    return this.id;
  }

  private assertActive(): void {
    if (this.state !== "active") {
      throw new DiscTransactionError(
        `Transaction is ${this.state}, cannot execute operations`,
        this.failure
      );
    }
  }
}
