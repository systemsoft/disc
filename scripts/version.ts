/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Stamp the current ChronVer version across the repo.
 *
 * ChronVer is `YYYY.MM.DD[.CHANGESET][-FEATURE|-break]` (chronver.org). The
 * date is the version; CHANGESET separates several releases cut on the same
 * date. This script writes today's date, and when today's date is already
 * the current version it increments the changeset instead of writing a
 * duplicate.
 */

/*** EXPORT ------------------------------------------- ***/

/** Format a date as the ChronVer `YYYY.MM.DD` stamp, zero-padded. */
export function dateStamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}.${month}.${day}`;
}

/**
 * Work out the version to stamp, given whatever `version.txt` currently
 * holds and today's date stamp.
 *
 * - A different date (or no readable version) → today's bare date.
 * - Today's date already → the next changeset: `2026.09.16` becomes
 *   `2026.09.16.1`, and `2026.09.16.1` becomes `2026.09.16.2`.
 *
 * A same-day `-FEATURE` label is dropped rather than carried forward: it
 * described the release that already shipped, and nothing here can name the
 * new one. Set a label by hand afterwards if the new release needs one.
 *
 * An unparseable current version falls back to today's bare date — a
 * malformed file should not block a release, and that is what this script
 * wrote unconditionally before it read anything.
 */
export function nextVersion(current: string | null, today: string): string {
  if (current === null) {
    return today;
  }

  const match = /^(\d{4}\.\d{2}\.\d{2})(?:\.(\d+))?(?:-[0-9A-Za-z.-]+)?$/
    .exec(current.trim());

  if (!match || match[1] !== today) {
    return today;
  }

  const changeset = match[2] === undefined ? 0 : Number(match[2]);

  return `${today}.${changeset + 1}`;
}

/*** PROGRAM ------------------------------------------ ***/

if (import.meta.main) {
  /*** version.txt — read first so a same-day rebump increments rather than
       rewriting the same version. Absent or unreadable is not fatal. ***/
  let current: string | null = null;

  try {
    current = await Deno.readTextFile("version.txt");
  } catch {
    /*** First stamp in a fresh checkout, or no read permission for it —
         either way, today's bare date is the right answer. ***/
  }

  const version = nextVersion(current, dateStamp(new Date()));

  await Deno.writeTextFile("version.txt", version);

  /*** deno.json ***/
  const denoJsonPath = "deno.json";
  const denoJson = await Deno.readTextFile(denoJsonPath);

  // Anchor to the top-level key (2-space indent) so task names containing
  // "version" are never rewritten.
  await Deno.writeTextFile(
    denoJsonPath,
    denoJson.replace(/^( {2}"version"\s*:\s*)"[^"]*"/m, `$1"${version}"`)
  );

  /*** lib/version.ts ***/
  const versionTsPath = "lib/version.ts";
  const versionFile = await Deno.readTextFile(versionTsPath);

  await Deno.writeTextFile(
    versionTsPath,
    versionFile.replace(/(export const DISC_VERSION =\s*)"[^"]*";/, `$1"${version}";`)
  );

  /*** deploy/helm/disc/Chart.yaml ***/
  const chartYamlPath = "deploy/helm/disc/Chart.yaml";
  const chartYaml = await Deno.readTextFile(chartYamlPath);

  await Deno.writeTextFile(
    chartYamlPath,
    chartYaml.replace(/(appVersion:\s*)"[^"]*"/, `$1"${version}"`)
  );
}
