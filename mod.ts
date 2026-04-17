/**
 * Disc Database - A TypeScript-native database built on Deno
 *
 * Schema-first database with EdgeQL query language,
 * reimplementing Gel (EdgeDB) in TypeScript while
 * preserving PostgreSQL as the storage engine.
 */

export * as Schema from "./schema/mod.ts";
export * as EdgeQL from "./edgeql/mod.ts";
export * from "./compiler/mod.ts";
export * from "./lib/mod.ts";

/**
 * Disc version, read from version.txt at module-load time (P1-48).
 *
 * version.txt is the single source of truth and is bumped by the
 * `just version` ChronVer task; deno.json / disc.toml version fields now
 * describe their own scope (package metadata, project scaffold) rather
 * than attempting to track the runtime version.
 *
 * Falls back to "0.0.0-dev" if the file can't be read (e.g. the binary
 * was `deno compile`d without `--include=version.txt` — the justfile
 * targets all pass that flag, so this only matters for ad-hoc usage).
 */
export const VERSION = (() => {
  try {
    const url = new URL("./version.txt", import.meta.url);
    const raw = Deno.readTextFileSync(url);
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : "0.0.0-dev";
  } catch {
    return "0.0.0-dev";
  }
})();
