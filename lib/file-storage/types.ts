/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * File-storage types.
 * (gh/geldata#3567)
 */

export interface FileMetadata {
  /** Stable id (UUID v4). */
  id: string;
  /** User id of the uploader. Owner-only access for now. */
  ownerUserId: string;
  /** Original filename, as provided by the caller. Optional. */
  name: string | null;
  contentType: string;
  /** Size in bytes. */
  size: number;
  /** Hex-encoded SHA-256 of the content. Used for deduplication. */
  sha256: string;
  /** Backend-specific storage key (e.g. relative path under the data dir). */
  storageKey: string;
  /** Free-form, JSON-serializable. */
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Input shape for `FileManager.upload`. The body is the raw bytes; the
 * manager hashes them, allocates an id + storage key, and writes via
 * the configured backend before persisting metadata.
 */
export interface FileUpload {
  ownerUserId: string;
  name?: string;
  contentType?: string;
  body: Uint8Array;
  metadata?: Record<string, unknown>;
}

/**
 * Backend interface — anything that can `put`/`get`/`delete`/`head` a
 * blob keyed by an opaque string. The local filesystem is the only
 * implementation in this iteration; an S3-compatible backend is the
 * obvious follow-up.
 */
export interface FileStorageBackend {
  /**
   * Write `body` under `key`. Implementations must be atomic — partial
   * writes from interrupted operations must not be visible to a
   * subsequent `get`.
   */
  put(key: string, body: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<{ size: number; } | null>;
}
