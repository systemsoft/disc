/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/*** IMPORT ------------------------------------------- ***/

import { readFileSync } from "node:fs";
import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/*** UTILITY ------------------------------------------ ***/

/**
 * SvelteKit defaults `version.name` to `Date.now()`, which lands in
 * `_app/version.json` AND gets inlined into the entry chunks — so every
 * build produced new content hashes for files whose source never changed.
 * That churn makes `server/ui-asset-manifest.ts` (checked in, derived from
 * these filenames) impossible to keep in sync. Pinning the stamp to the
 * Disc release version makes the build reproducible and still gives
 * SvelteKit a value that changes when a release does.
 */
const version = readFileSync(new URL("../version.txt", import.meta.url), "utf8").trim();

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    /*** Build as static site to be bundled with Disc server ***/
    adapter: adapter({
      assets: "build",
      fallback: "index.html",
      pages: "build",
      precompress: false,
      strict: true
    }),
    paths: {
      base: "/ui"
    },
    version: {
      name: version
    }
  },
  preprocess: vitePreprocess()
};

/*** EXPORT ------------------------------------------- ***/

export default config;
