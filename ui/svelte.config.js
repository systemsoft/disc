/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/*** IMPORT ------------------------------------------- ***/

import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/*** UTILITY ------------------------------------------ ***/

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
    }
  },
  preprocess: vitePreprocess()
};

/*** EXPORT ------------------------------------------- ***/

export default config;
