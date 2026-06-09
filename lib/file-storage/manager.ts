/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * FileManager — glues the backend to a metadata table.
 *
 * Responsibilities:
 * - Owns the `files` schema (one table; no migrations across versions
 *   yet — schema additions go via `ALTER TABLE ... IF NOT EXISTS`).
 * - Hashes uploads with SHA-256 and dedupes by content hash: two
 *   different users uploading the same bytes share the underlying blob
 *   but get distinct metadata rows. Delete removes the blob only when
 *   no other metadata row references its hash.
 * - Enforces owner-only access for now. `read`/`delete` reject when
 *   `requestingUserId !== ownerUserId`. (Public/private ACLs are a
 *   follow-up.)
 *
 * (gh/geldata#3567)
 */

import type { DatabaseInterface } from "../../auth/database-interface.ts";
import { sha256Hex } from "../crypto.ts";
import { getLogger } from "../logger.ts";
import type { FileMetadata, FileStorageBackend, FileUpload } from "./types.ts";

const log = getLogger("file-storage");

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

export interface FileManagerOptions {
  backend: FileStorageBackend;
  /**
   * Cap on per-upload size. Defaults to 100 MiB. Apps with stricter
   * needs should set it lower; this is the boundary the manager
   * enforces, but the HTTP route layer likely caps body size sooner.
   */
  maxUploadBytes?: number;
}

export class FileNotFoundError extends Error {
  constructor(id: string) {
    super(`file not found: ${id}`);
    this.name = "FileNotFoundError";
  }
}

export class FileAccessDeniedError extends Error {
  constructor(id: string) {
    super(`access denied: ${id}`);
    this.name = "FileAccessDeniedError";
  }
}

export class FileTooLargeError extends Error {
  constructor(size: number, max: number) {
    super(`file too large: ${size} bytes > ${max} bytes`);
    this.name = "FileTooLargeError";
  }
}

export class FileManager {
  private backend: FileStorageBackend;
  private maxUploadBytes: number;

  constructor(
    private db: DatabaseInterface,
    options: FileManagerOptions
  ) {
    this.backend = options.backend;
    this.maxUploadBytes = options.maxUploadBytes ?? 100 * 1024 * 1024;
  }

  async initialize(): Promise<void> {
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        name TEXT,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        storage_key TEXT NOT NULL,
        metadata TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_files_owner ON files(owner_user_id)`
    );
    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_files_sha256 ON files(sha256)`
    );
  }

  async upload(input: FileUpload): Promise<FileMetadata> {
    if (input.body.length > this.maxUploadBytes) {
      throw new FileTooLargeError(input.body.length, this.maxUploadBytes);
    }
    const id = crypto.randomUUID();
    const sha256 = await sha256Hex(input.body);

    // Dedup: if any prior file has the same content hash, reuse its
    // storage key. Different metadata rows can point at the same blob
    // — `delete` is reference-counted by hash.
    const existing = await this.db.query(
      "SELECT storage_key FROM files WHERE sha256 = ? LIMIT 1",
      [sha256]
    );
    let storageKey: string;
    if (existing.rows.length > 0) {
      storageKey = existing.rows[0].storage_key;
    } else {
      storageKey = sha256; // hash-as-key keeps things content-addressed
      await this.backend.put(storageKey, input.body);
    }

    await this.db.execute(
      `INSERT INTO files (
        id, owner_user_id, name, content_type, size, sha256,
        storage_key, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.ownerUserId,
        input.name ?? null,
        input.contentType ?? DEFAULT_CONTENT_TYPE,
        input.body.length,
        sha256,
        storageKey,
        input.metadata ? JSON.stringify(input.metadata) : null
      ]
    );
    log.info("file.uploaded", {
      id,
      owner: input.ownerUserId,
      size: input.body.length,
      sha256,
      reused: existing.rows.length > 0
    });
    return await this.requireRow(id);
  }

  async readMetadata(
    id: string,
    requestingUserId: string
  ): Promise<FileMetadata> {
    const row = await this.lookupRow(id);
    if (!row) {
      throw new FileNotFoundError(id);
    }
    if (row.ownerUserId !== requestingUserId) {
      throw new FileAccessDeniedError(id);
    }
    return row;
  }

  async read(id: string, requestingUserId: string): Promise<{
    metadata: FileMetadata;
    body: Uint8Array;
  }> {
    const metadata = await this.readMetadata(id, requestingUserId);
    const body = await this.backend.get(metadata.storageKey);
    return { metadata, body };
  }

  async list(ownerUserId: string): Promise<FileMetadata[]> {
    const result = await this.db.query(
      `SELECT id, owner_user_id, name, content_type, size, sha256,
              storage_key, metadata, created_at, updated_at
       FROM files
       WHERE owner_user_id = ?
       ORDER BY created_at DESC`,
      [ownerUserId]
    );
    return result.rows.map(rowToMetadata);
  }

  async delete(id: string, requestingUserId: string): Promise<void> {
    const row = await this.lookupRow(id);
    if (!row) {
      throw new FileNotFoundError(id);
    }
    if (row.ownerUserId !== requestingUserId) {
      throw new FileAccessDeniedError(id);
    }

    await this.db.execute("DELETE FROM files WHERE id = ?", [id]);

    // Dedup-aware blob cleanup: only remove the underlying blob if no
    // other metadata row still references this hash.
    const remaining = await this.db.query(
      "SELECT id FROM files WHERE sha256 = ? LIMIT 1",
      [row.sha256]
    );
    if (remaining.rows.length === 0) {
      await this.backend.delete(row.storageKey);
    }
    log.info("file.deleted", {
      id,
      owner: row.ownerUserId,
      blobRetained: remaining.rows.length > 0
    });
  }

  // ── internals ─────────────────────────────────────────────────────

  private async lookupRow(id: string): Promise<FileMetadata | null> {
    const result = await this.db.query(
      `SELECT id, owner_user_id, name, content_type, size, sha256,
              storage_key, metadata, created_at, updated_at
       FROM files WHERE id = ?`,
      [id]
    );
    if (result.rows.length === 0) {
      return null;
    }
    return rowToMetadata(result.rows[0]);
  }

  private async requireRow(id: string): Promise<FileMetadata> {
    const row = await this.lookupRow(id);
    if (!row) {
      throw new FileNotFoundError(id);
    }
    return row;
  }
}

function rowToMetadata(row: Record<string, unknown>): FileMetadata {
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    name: row.name === null || row.name === undefined ? null : String(row.name),
    contentType: String(row.content_type),
    size: Number(row.size),
    sha256: String(row.sha256),
    storageKey: String(row.storage_key),
    metadata: row.metadata ?
      JSON.parse(String(row.metadata)) as Record<string, unknown> :
      null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}
