/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

// deno-lint-ignore-file no-console
/**
 * CLI DbCommand Implementation - Database management functionality
 *
 * Provides create, list, drop, wipe, dump, and restore operations for
 * Disc-managed databases. Each database is created as a PostgreSQL database
 * with a `disc_` prefix to avoid collisions with system databases.
 */

/*** NATIVE ------------------------------------------- ***/

import { join } from "@std/path";

/*** UTILITY ------------------------------------------ ***/

import { createDatabase, DatabaseConnection, dropDatabase } from "../lib/database.ts";
import { PostgresBinaryDownloader, PostgresManager } from "../postgres/mod.ts";
import { resolveProjectContext } from "../lib/project-context.ts";

/** Prefix applied to all Disc-managed PG database names. */
const DATABASE_PREFIX = "disc_";
/** The default database name that cannot be dropped. */
const DEFAULT_DATABASE_NAME = "disc";
/** Regex for valid database names: starts with letter, lowercase alphanumeric + underscore. */
const VALID_NAME_RE = /^[a-z][a-z0-9_]*$/;

/*** EXPORT ------------------------------------------- ***/

export interface DbCreateOptions {
  databaseUrl: string;
  name: string;
}

export interface DbDropOptions {
  databaseUrl: string;
  force: boolean;
  name: string;
}

export interface DbDumpOptions {
  databaseUrl: string;
  /**
   * Plain SQL ("plain") or PostgreSQL custom format ("custom").
   * Default "plain" — works with `psql` for restore.
   * Custom format is smaller and supports parallel restore but requires
   * `pg_restore`.
   */
  format?: "plain" | "custom";
  name: string;
  /** Output file path. If omitted (or "-"), dump to stdout. */
  output?: string;
  /** pg_dump binary directory (resolves automatically if omitted). */
  pgBinDir?: string;
  /** PG socket directory (resolves automatically from project context). */
  socketDir?: string;
}

export interface DbListOptions {
  databaseUrl: string;
}

export interface DbRestoreOptions {
  /** Wipe target db before restore. Default false — fail if non-empty. */
  clean?: boolean;
  databaseUrl: string;
  /** Input file path. If omitted (or "-"), read from stdin. */
  input?: string;
  name: string;
  pgBinDir?: string;
  socketDir?: string;
}

export interface DbWipeOptions {
  databaseUrl: string;
  force: boolean;
  name: string;
}

export class DbCommand {
  /**
   * Create a new Disc-managed database.
   *
   * Validates the name format, then creates a PostgreSQL database
   * named `disc_<name>` via an admin connection.
   */
  async create(options: DbCreateOptions): Promise<void> {
    const { name, databaseUrl } = options;
    const validationError = this.validateName(name);

    if (validationError)
      throw new Error(validationError);

    const pgDatabaseName = `${DATABASE_PREFIX}${name}`;
    console.log(`Creating database "${name}" (PG: ${pgDatabaseName})…`);

    await createDatabase(databaseUrl, pgDatabaseName);
    console.log(`Database "${name}" created successfully.`);
  }

  /**
   * Drop a Disc-managed database.
   *
   * Requires the `--force` flag. Prevents dropping the default "disc"
   * database. Drops the PostgreSQL database named `disc_<name>`.
   */
  async drop(options: DbDropOptions): Promise<void> {
    const { name, databaseUrl, force } = options;

    if (!force)
      throw new Error("Dropping a database requires the --force flag. This action is irreversible.");

    if (name === DEFAULT_DATABASE_NAME)
      throw new Error(`Cannot drop the default "disc" database.`);

    const pgDatabaseName = `${DATABASE_PREFIX}${name}`;
    console.log(`Dropping database "${name}" (PG: ${pgDatabaseName})…`);

    await dropDatabase(databaseUrl, pgDatabaseName);
    console.log(`Database "${name}" dropped successfully.`);
  }

  /**
   * Dump a Disc-managed database to stdout (default) or a file using the
   * bundled pg_dump. Streams output so dumps don’t OOM in memory.
   *
   * Closes gh/geldata#1485, #1002, #720.
   */
  async dump(options: DbDumpOptions): Promise<void> {
    const { databaseUrl, format, name, output } = options;
    const validationError = this.validateName(name);

    if (validationError)
      throw new Error(validationError);

    const resolved = await this.resolvePgPaths({
      databaseUrl,
      pgBinDir: options.pgBinDir,
      socketDir: options.socketDir
    });

    const pgDatabaseName = `${DATABASE_PREFIX}${name}`;
    const fmt: "plain" | "custom" = format ?? "plain";
    const args = buildPgDumpArgs(resolved.socketDir, pgDatabaseName, fmt);

    /*** stderr → terminal so the user sees pg_dump progress/errors directly. ***/
    const child = new Deno.Command(join(resolved.pgBinDir, "pg_dump"), {
      args,
      stderr: "inherit",
      stdin: "null",
      stdout: "piped"
    })
      .spawn();

    /*** Stream stdout to either a file or process stdout. For files we let pipeTo close the file
         when the stream ends. For process stdout we set preventClose so we don’t close the parent
         process’s stdout when pg_dump finishes. ***/
    if (output && output !== "-") {
      const file = await Deno.open(output, {
        create: true,
        truncate: true,
        write: true
      });

      await child.stdout.pipeTo(file.writable);
    } else {
      await child.stdout.pipeTo(Deno.stdout.writable, { preventClose: true });
    }

    const status = await child.status;

    if (!status.success)
      throw new Error(`pg_dump failed with exit code ${status.code}`);
  }

  /**
   * List all Disc-managed databases.
   *
   * Queries `pg_database` for databases with the `disc_` prefix
   * and displays them with the prefix stripped.
   */
  async list(options: DbListOptions): Promise<void> {
    const { databaseUrl } = options;
    /*** Connect to the postgres maintenance database to query pg_database ***/
    const conn = new DatabaseConnection(databaseUrl);

    try {
      await conn.connect();
      const result = await conn.query(`SELECT datname FROM pg_database WHERE datname LIKE 'disc\\_%' ORDER BY datname`);

      if (result.rows.length === 0) {
        console.log("No Disc-managed databases found.");
        return;
      }

      console.log("Disc-managed databases:\n");
      console.log("  NAME");
      console.log("  " + "-".repeat(30));

      for (const row of result.rows) {
        const pgName = row.datname as string;
        const displayName = pgName.replace(/^disc_/, "");
        console.log(`  ${displayName}`);
      }

      console.log(`\n  ${result.rows.length} database${result.rows.length === 1 ? "" : "s"} total.`);
    } finally {
      await conn.close();
    }
  }

  /**
   * Restore a Disc-managed database from stdin (default) or a file.
   *
   * Auto-detects format: plain SQL is restored via psql; custom-format
   * dumps (whose first 5 bytes are "PGDMP") are restored via pg_restore.
   * With --clean, drops + recreates the target db first.
   */
  async restore(options: DbRestoreOptions): Promise<void> {
    const { clean, databaseUrl, input, name } = options;
    const validationError = this.validateName(name);

    if (validationError)
      throw new Error(validationError);

    const resolved = await this.resolvePgPaths({
      databaseUrl,
      pgBinDir: options.pgBinDir,
      socketDir: options.socketDir
    });

    if (clean)
      await this.wipe({ databaseUrl, force: true, name });

    const pgDatabaseName = `${DATABASE_PREFIX}${name}`;

    /*** Open input source (file or stdin) and peek the first 5 bytes to detect custom-format dumps.
         We then re-stitch the peeked bytes onto the front of the remaining stream when piping into
         the child process. ***/
    let source: ReadableStream<Uint8Array>;

    if (input && input !== "-") {
      const inputFile = await Deno.open(input, { read: true });
      source = inputFile.readable;
    } else {
      source = Deno.stdin.readable;
    }

    const { peek, rest } = await peekBytes(source, 5);
    const isCustom = isCustomFormatDump(peek);
    const binary = isCustom ? "pg_restore" : "psql";

    const args = isCustom ?
      buildPgRestoreArgs(resolved.socketDir, pgDatabaseName) :
      buildPsqlArgs(resolved.socketDir, pgDatabaseName);

    const child = new Deno.Command(join(resolved.pgBinDir, binary), {
      args,
      stderr: "piped",
      stdin: "piped",
      stdout: "inherit"
    })
      .spawn();

    /*** Drain stderr concurrently so the child doesn’t block on a full pipe; collect into a buffer
         so we can include the message on failure. ***/
    const stderrChunks: Uint8Array[] = [];

    const stderrPromise = (async () => {
      const reader = child.stderr.getReader();

      while (true) {
        const { done, value } = await reader.read();

        if (done)
          break;

        stderrChunks.push(value);
      }
    })();

    /*** Build a single stream that emits the peeked bytes followed by the rest and pipe it into the
         child’s stdin. ***/
    const recombined = prependBytes(peek, rest);
    let pipeError: Error | undefined;

    try {
      await recombined.pipeTo(child.stdin);
    } catch (err) {
      pipeError = err as Error;
    }

    const status = await child.status;
    await stderrPromise;
    const stderr = new TextDecoder().decode(concatChunks(stderrChunks));

    if (pipeError || !status.success) {
      const prefix = pipeError ? "Restore stream failed" : `${binary} failed`;
      throw new Error(`${prefix} (exit ${status.code})${stderr ? `: ${stderr}` : ""}`);
    }

    console.log(`Database "${name}" restored successfully (${isCustom ? "custom" : "plain"} format).`);
  }

  /**
   * Validate a database name against the naming rules.
   * Returns an error message string if invalid, or null if valid.
   */
  validateName(name: string): string | null {
    if (!VALID_NAME_RE.test(name))
      return `Invalid database name "${name}": must start with a lowercase letter and contain only lowercase letters, digits, and underscores`;

    return null;
  }

  /**
   * Drop and recreate the named database. Requires --force.
   *
   * Cannot wipe the default "disc" database. The cleanest way to bring a
   * database to a known-empty state without confusing PostgreSQL into
   * thinking the in-flight catalog is the source of truth.
   *
   * Closes gh/geldata#1486.
   */
  async wipe(options: DbWipeOptions): Promise<void> {
    const { databaseUrl, force, name } = options;
    const validationError = this.validateName(name);

    if (validationError)
      throw new Error(validationError);

    if (!force)
      throw new Error("Wiping a database requires the --force flag. This action is irreversible.");

    if (name === DEFAULT_DATABASE_NAME)
      throw new Error(`Cannot wipe the default "disc" database.`);

    const pgDatabaseName = `${DATABASE_PREFIX}${name}`;
    console.log(`Wiping database "${name}" (PG: ${pgDatabaseName})…`);

    await dropDatabase(databaseUrl, pgDatabaseName);
    await createDatabase(databaseUrl, pgDatabaseName);

    console.log(`Database "${name}" wiped successfully.`);
  }

  /*** PRIVATE ------------------------------------------ ***/

  /**
   * Resolve the PostgreSQL bin directory and socket directory for the
   * managed instance. Looks them up via project context + manager
   * discovery when not provided directly.
   */
  private async resolvePgPaths(
    opts: { databaseUrl: string; pgBinDir?: string; socketDir?: string; }
  ): Promise<{ pgBinDir: string; socketDir: string; }> {
    if (opts.pgBinDir && opts.socketDir)
      return { pgBinDir: opts.pgBinDir, socketDir: opts.socketDir };

    const ctx = resolveProjectContext();

    if (!ctx)
      throw new Error("Could not resolve project context. Run from a Disc project directory or pass --pg-bin-dir + --socket-dir explicitly.");

    const socketDir = opts.socketDir ?? ctx.socketDir;
    let pgBinDir = opts.pgBinDir;

    if (!pgBinDir) {
      const manager = new PostgresManager();
      await manager.discoverInstances();
      const instance = manager.getInstance(ctx.instanceName);

      if (!instance)
        throw new Error(`No PostgreSQL instance found for project "${ctx.instanceName}". Run "disc init" first.`);

      const status = await instance.status();
      const downloader = new PostgresBinaryDownloader();
      const pgDir = await downloader.ensurePostgres(status.version);
      pgBinDir = join(pgDir, "bin");
    }

    return { pgBinDir, socketDir };
  }
}

export const dbCommand = new DbCommand();

/**
 * Build the pg_dump argument list for a Disc-managed database.
 * Exposed for unit-testing arg construction without spawning a child.
 */
export function buildPgDumpArgs(socketDir: string, pgDatabaseName: string, format: "custom" | "plain"): string[] {
  return [
    "--host",
    socketDir,
    "--username",
    "disc",
    "--no-owner",
    "--no-acl",
    `--format=${format}`,
    pgDatabaseName
  ];
}

/** Build the pg_restore argument list. */
export function buildPgRestoreArgs(socketDir: string, pgDatabaseName: string): string[] {
  return [
    "--host",
    socketDir,
    "--username",
    "disc",
    "--dbname",
    pgDatabaseName,
    "--no-owner",
    "--no-acl"
  ];
}

/** Build the psql restore argument list. */
export function buildPsqlArgs(socketDir: string, pgDatabaseName: string): string[] {
  return [
    "--host",
    socketDir,
    "--username",
    "disc",
    "--dbname",
    pgDatabaseName,
    "--quiet"
  ];
}

/**
 * Detect whether the given (>=5-byte) buffer is the start of a PostgreSQL
 * custom-format dump. The custom format always begins with the ASCII magic
 * "PGDMP".
 */
export function isCustomFormatDump(buf: Uint8Array): boolean {
  if (buf.length < 5)
    return false;

  /*** "PGDMP" ***/
  return buf[0] === 0x50 &&
    buf[1] === 0x47 &&
    buf[2] === 0x44 &&
    buf[3] === 0x4d &&
    buf[4] === 0x50;
}

/*** HELPER ------------------------------------------- ***/

/** Concatenate multiple Uint8Array chunks into a single contiguous buffer. */
function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;

  for (const chunk of chunks) {
    total += chunk.byteLength;
  }

  const out = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return out;
}

/**
 * Read up to `n` bytes from the front of the stream and return them
 * together with a stream that yields the remaining bytes. The returned
 * `rest` stream MUST be consumed (or cancelled) — it owns the original
 * reader lock until then.
 */
async function peekBytes(source: ReadableStream<Uint8Array>, n: number): Promise<{ peek: Uint8Array; rest: ReadableStream<Uint8Array>; }> {
  const reader = source.getReader();
  const collected: Uint8Array[] = [];
  let total = 0;

  while (total < n) {
    const { done, value } = await reader.read();

    if (done)
      break;

    collected.push(value);
    total += value.byteLength;
  }

  /*** Concatenate the collected chunks into a contiguous buffer so we can split it cleanly at
       byte n. ***/
  const head = new Uint8Array(total);

  {
    let offset = 0;

    for (const chunk of collected) {
      head.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }

  const peek = head.slice(0, Math.min(n, head.byteLength));
  const overflow = head.slice(Math.min(n, head.byteLength));

  /*** Build a stream that emits any leftover bytes from the prefix read, then continues pulling
       from the original reader. ***/
  let overflowSent = false;

  const rest = new ReadableStream<Uint8Array>({
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
    async pull(controller) {
      if (!overflowSent) {
        overflowSent = true;

        if (overflow.byteLength > 0) {
          controller.enqueue(overflow);
          return;
        }
      }

      try {
        const { done, value } = await reader.read();

        if (done) {
          controller.close();
          return;
        }

        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    }
  });

  return { peek, rest };
}

/**
 * Build a stream whose first chunk is `prefix` and whose subsequent chunks
 * come from `tail`. Used to re-stitch the peeked bytes back onto the front
 * of the remaining input before piping into a child process.
 */
function prependBytes(prefix: Uint8Array, tail: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = tail.getReader();
  let prefixSent = false;

  return new ReadableStream<Uint8Array>({
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
    async pull(controller) {
      if (!prefixSent) {
        prefixSent = true;

        if (prefix.byteLength > 0) {
          controller.enqueue(prefix);
          return;
        }
      }

      const { done, value } = await reader.read();

      if (done) {
        controller.close();
        return;
      }

      controller.enqueue(value);
    }
  });
}
