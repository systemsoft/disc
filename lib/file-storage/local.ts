/**
 * Local-filesystem file-storage backend.
 *
 * Layout: `<root>/<aa>/<bb>/<key>` — 2×1-byte sharding by the key's
 * first 4 hex chars to keep any single directory under ~256
 * subdirs even with millions of files. Atomic writes via temp-file +
 * rename within the same directory.
 *
 * Not in scope: cross-platform locking, snapshot/backup hooks, on-disk
 * encryption (operator's job — same posture as PG-at-rest).
 *
 * (gh/geldata#3567)
 */

import { dirname, join } from "https://deno.land/std@0.224.0/path/mod.ts";
import type { FileStorageBackend } from "./types.ts";

export class LocalFileStorage implements FileStorageBackend {
  constructor(private root: string) {}

  async put(key: string, body: Uint8Array): Promise<void> {
    const target = this.absolutePath(key);
    await Deno.mkdir(dirname(target), { recursive: true });
    // Atomic write: write to a temp file in the same directory, then
    // rename. Same-dir rename is atomic on every POSIX-ish FS we run on.
    const tmp = `${target}.tmp.${crypto.randomUUID()}`;
    await Deno.writeFile(tmp, body);
    try {
      await Deno.rename(tmp, target);
    } catch (err) {
      // Best-effort cleanup; keep the original error.
      try {
        await Deno.remove(tmp);
      } catch { /* ignore */ }
      throw err;
    }
  }

  async get(key: string): Promise<Uint8Array> {
    return await Deno.readFile(this.absolutePath(key));
  }

  async delete(key: string): Promise<void> {
    try {
      await Deno.remove(this.absolutePath(key));
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return;
      throw err;
    }
  }

  async head(key: string): Promise<{ size: number } | null> {
    try {
      const stat = await Deno.stat(this.absolutePath(key));
      return { size: stat.size };
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return null;
      throw err;
    }
  }

  /**
   * Translate a logical key (`abcdef...` hex) into an on-disk path
   * with 2 levels of fan-out. Keys with fewer than 4 chars are stored
   * directly under root.
   */
  private absolutePath(key: string): string {
    if (!/^[a-zA-Z0-9._-]+$/.test(key)) {
      throw new Error(`Invalid storage key: ${JSON.stringify(key)}`);
    }
    if (key.length < 4) return join(this.root, key);
    return join(this.root, key.slice(0, 2), key.slice(2, 4), key);
  }
}
