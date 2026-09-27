/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Which PostgreSQL version an on-disk instance runs.
 *
 * A data directory only records its major version (`PG_VERSION`, e.g. `16`),
 * and it can only be started by binaries of that major. The exact version the
 * instance was initialized (or last upgraded) with is recorded in
 * `<instanceDir>/version.json`. Instances created before that file existed
 * fall back to the newest cached binaries of the data dir's major, then to the
 * newest downloadable version of it.
 */

/*** NATIVE ------------------------------------------- ***/

import { join } from "@std/path";

/*** PROGRAM ------------------------------------------ ***/

export const INSTANCE_VERSION_FILE = "version.json";

export interface InstanceVersionInfo {
  /**
   * Binaries the instance was created with, when they came from outside
   * Disc's download cache (an embedded extraction, a caller-supplied
   * `pgBinDir`). Recovery reuses them while they exist.
   */
  binDir?: string;
  /** Version before the last `disc pg upgrade`. */
  previousVersion?: string;
  /** ISO timestamp of the last `disc pg upgrade`. */
  upgradedAt?: string;
  /** Exact PostgreSQL version the data directory was initialized/upgraded with, e.g. `"16.4"`. */
  version: string;
}

/*** EXPORT ------------------------------------------- ***/

/** Major version of a PostgreSQL ≥ 10 version string: `"16.4"` → `"16"`. */
export function pgMajor(version: string): string {
  return version.split(".")[0];
}

/**
 * Compare two dotted version strings numerically. Returns -1 if a < b, 0 if
 * equal, 1 if a > b; missing components count as 0 (`"16"` < `"16.4"`).
 */
export function compareVersions(a: string, b: string): number {
  const aParts = a.split(".").map(Number);
  const bParts = b.split(".").map(Number);

  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const x = aParts[i] || 0;
    const y = bParts[i] || 0;

    if (x !== y)
      return x < y ? -1 : 1;
  }

  return 0;
}

/** Parse `postgres --version` output (`"postgres (PostgreSQL) 16.4"`) to `"16.4"`. */
export function parsePostgresVersion(output: string): string | null {
  return output.match(/\(PostgreSQL\)\s+(\d+(?:\.\d+)?)/)?.[1] ?? null;
}

/** Read `<instanceDir>/version.json`, or null when absent. */
export async function readInstanceVersionFile(instanceDir: string): Promise<InstanceVersionInfo | null> {
  let text: string;

  try {
    text = await Deno.readTextFile(join(instanceDir, INSTANCE_VERSION_FILE));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound)
      return null;

    throw err;
  }

  const parsed = JSON.parse(text) as Partial<InstanceVersionInfo>;

  if (typeof parsed.version !== "string")
    throw new Error(`${join(instanceDir, INSTANCE_VERSION_FILE)} has no "version"`);

  return parsed as InstanceVersionInfo;
}

/** Write `<instanceDir>/version.json` atomically (temp file + rename). */
export async function writeInstanceVersionFile(instanceDir: string, info: InstanceVersionInfo): Promise<void> {
  const path = join(instanceDir, INSTANCE_VERSION_FILE);
  const tmp = `${path}.tmp`;

  await Deno.writeTextFile(tmp, `${JSON.stringify(info, null, 2)}\n`);
  await Deno.rename(tmp, path);
}

/**
 * Pick the version to run a data directory of major `dataDirMajor` with:
 * the recorded version when its major matches (a data dir restored or
 * swapped by hand can disagree with `version.json` — the data dir wins),
 * else the newest cached version of that major, else the newest supported
 * (downloadable) one. Null when nothing of that major is known.
 */
export function resolveInstanceVersion(options: {
  cached: readonly string[];
  dataDirMajor: string;
  recorded: string | null;
  supported: readonly string[];
}): string | null {
  const { cached, dataDirMajor, recorded, supported } = options;

  if (recorded !== null && pgMajor(recorded) === dataDirMajor)
    return recorded;

  const newestOfMajor = (versions: readonly string[]): string | null =>
    versions
      .filter(v => pgMajor(v) === dataDirMajor)
      .sort(compareVersions)
      .at(-1) ?? null;

  return newestOfMajor(cached) ?? newestOfMajor(supported);
}
