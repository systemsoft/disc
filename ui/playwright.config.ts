/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

// deno-lint-ignore-file no-process-global

// Playwright runs this config in Node, not Deno — `process.env` is
// the canonical way to read CI env there. The lint rule still scans
// every TS file in the repo, so silence it for this one.

/*** IMPORT ------------------------------------------- ***/

import { defineConfig, devices } from "@playwright/test";

/*** EXPORT ------------------------------------------- ***/

/**
 * Playwright config for Disc UI end-to-end tests.
 *
 * Boots both the Disc server (`disc serve` against the fixture project
 * in tests/e2e/fixture/) and the Vite dev server, then drives the SvelteKit
 * UI through a real browser. The fixture’s `managed = true` instance is
 * idempotent: first run creates `~/.disc/instances/disc-ui-e2e/` and
 * auto-applies the schema; subsequent runs reuse it.
 *
 * Tests should reset row state in beforeEach (via the data viewer or
 * direct EdgeQL) — they are NOT isolated by Postgres, so don’t rely on
 * a virgin DB unless you delete all rows yourself.
 */
export default defineConfig({
  fullyParallel: false, // shared DB → run tests serially to avoid races
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ],
  reporter: "list",
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure"
  },
  webServer: [
    {
      /*** Disc HTTP server — auto-migrates the fixture schema on first run. Path is relative to the
           fixture cwd (4 dirs up to repo root, then cli/main.ts). Resolved by Deno after Playwright
           sets cwd. ***/
      command: "deno run --allow-all ../../../../cli/main.ts serve",
      cwd: "./tests/e2e/fixture",
      reuseExistingServer: !process.env.CI,
      stderr: "pipe",
      stdout: "pipe",
      timeout: 60_000,
      url: "http://localhost:5656/health"
    },
    {
      command: "bun run dev",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      url: "http://localhost:5173/ui"
    }
  ],
  workers: 1
});
