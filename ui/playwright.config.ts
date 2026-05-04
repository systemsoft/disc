import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for Disc UI end-to-end tests.
 *
 * Boots both the Disc server (`disc serve` against the fixture project
 * in tests/e2e/fixture/) and the Vite dev server, then drives the SvelteKit
 * UI through a real browser. The fixture's `managed = true` instance is
 * idempotent: first run creates `~/.disc/instances/disc-ui-e2e/` and
 * auto-applies the schema; subsequent runs reuse it.
 *
 * Tests should reset row state in beforeEach (via the data viewer or
 * direct EdgeQL) — they are NOT isolated by Postgres, so don't rely on
 * a virgin DB unless you delete all rows yourself.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false, // shared DB → run tests serially to avoid races
  workers: 1,
  reporter: "list",
  timeout: 30_000,

  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: [
    {
      // Disc HTTP server — auto-migrates the fixture schema on first run.
      // Path is relative to the fixture cwd (4 dirs up to repo root, then
      // cli/main.ts). Resolved by Deno after Playwright sets cwd.
      command:
        "deno run --allow-all ../../../../cli/main.ts serve",
      cwd: "./tests/e2e/fixture",
      url: "http://localhost:5656/health",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "bun run dev",
      url: "http://localhost:5173/ui",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
