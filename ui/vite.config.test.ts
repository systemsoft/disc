/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vitest/config";

// Vitest config for component-level unit tests. Excludes `tests/e2e/`
// because those are Playwright specs that crash if loaded into vitest's
// runner.
export default defineConfig({
  plugins: [sveltekit()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.{test,spec}.{js,ts}"],
    exclude: ["tests/e2e/**", "node_modules/**", ".svelte-kit/**", "build/**"]
  }
});
