/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/*** PROGRAM ------------------------------------------ ***/

const now = new Date();
const version = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}.${String(now.getDate()).padStart(2, "0")}`;

/*** version.txt ***/
await Deno.writeTextFile("version.txt", version);

/*** deno.json ***/
const denoJsonPath = "deno.json";
const denoJson = await Deno.readTextFile(denoJsonPath);

await Deno.writeTextFile(
  denoJsonPath,
  denoJson.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${version}"`)
);

/*** lib/version.ts ***/
const versionTsPath = "lib/version.ts";
const versionFile = await Deno.readTextFile(versionTsPath);

await Deno.writeTextFile(
  versionTsPath,
  versionFile.replace(/(export const DISC_VERSION =\s*)"[^"]*";/, `$1"${version}";`)
);
