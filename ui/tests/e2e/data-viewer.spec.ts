/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/*** IMPORT ------------------------------------------- ***/

import { expect, test } from "@playwright/test";

/*** UTILITY ------------------------------------------ ***/

import { clearItems, insertItem, itemCount, runQuery } from "./helpers";

/*** RUNTIME ------------------------------------------ ***/

/*** The data viewer renders each row as a `.data` card inside `.data-wrap`, not a `<table>`. Cell
     values live in readonly `<input value="…">` elements, so assert on display value rather than
     `getByRole("cell")`. ***/
const rows = (page: import("@playwright/test").Page) => page.locator(".data-wrap .data");

test.describe("Data viewer — read", () => {
  test.beforeEach(async () => {
    await clearItems();
    await insertItem("Disc identity disc", 1);
    await insertItem("Light cycle", 2);
    await insertItem("Recognizer", 3);
  });

  /*** Each test starts with a hard reload via about:blank → target URL so tests don’t inherit
       filter/sort state from a previous test (Vite HMR preserves Svelte component instances across
       same-URL navigations, which would otherwise carry stale filter values into the next test). ***/
  async function gotoData(page: import("@playwright/test").Page) {
    await page.goto("about:blank");
    await page.goto("/ui/data");
  }

  test("renders type list and rows for default::Item", async ({ page }) => {
    await gotoData(page);
    /*** Type list shows the seeded type (the sidebar button is the bare type name). ***/
    await expect(page.getByRole("button", { name: "Item", exact: true })).toBeVisible();

    /*** Three row cards appear. ***/
    await expect(rows(page)).toHaveCount(3);
    await expect(page.getByDisplayValue("Light cycle")).toBeVisible();
    await expect(page.getByDisplayValue("Recognizer")).toBeVisible();
  });

  test("sorts by clicking a property column header", async ({ page }) => {
    await gotoData(page);
    await expect(rows(page)).toHaveCount(3);
    /*** The count column’s sort toggle is a button labelled "count" in the filter aside. First click
         → asc → first row should be count=1. ***/
    await page.getByRole("button", { name: /^count/ }).click();
    await expect(rows(page).first().getByDisplayValue("Disc identity disc")).toBeVisible();
    /*** Click again → desc → first row should be count=3. ***/
    await page.getByRole("button", { name: /^count/ }).click();
    await expect(rows(page).first().getByDisplayValue("Recognizer")).toBeVisible();
  });

  test("filters by string column with ilike substring match", async ({ page }) => {
    await gotoData(page);
    await expect(rows(page)).toHaveCount(3);

    const nameFilter = page.locator("input[name=\"filter-name\"]");
    await nameFilter.fill("cycle");
    await nameFilter.press("Enter");
    await expect(rows(page)).toHaveCount(1);
    await expect(page.getByDisplayValue("Light cycle")).toBeVisible();
  });

  test("filters numeric column with range syntax (>=N, a..b)", async ({ page }) => {
    await gotoData(page);
    await expect(rows(page)).toHaveCount(3);

    /*** The count column input carries placeholder ">=10, <5, 10..20". ***/
    const countFilter = page.locator("input[name=\"filter-count\"]");
    await countFilter.fill(">=2");
    await countFilter.press("Enter");
    /*** Light cycle (2) and Recognizer (3) match — Disc identity disc (1) does not. ***/
    await expect(rows(page)).toHaveCount(2);
    await countFilter.fill("2..3");
    await countFilter.press("Enter");
    await expect(rows(page)).toHaveCount(2);
    await countFilter.fill(">10");
    await countFilter.press("Enter");
    /*** Nothing matches — the card list empties and the empty-state placeholder appears. ***/
    await expect(rows(page)).toHaveCount(0);
    await expect(page.getByText("No matches")).toBeVisible();
  });

  test("datetime exact-match filter expands a bare YYYY-MM-DD to a one-day range", async ({ page }) => {
    await gotoData(page);
    await expect(rows(page)).toHaveCount(3);

    /*** The createdAt column input carries placeholder ">=2026-01-01". ***/
    const dtFilter = page.locator("input[name=\"filter-createdAt\"]");
    /*** Today’s seed rows are timestamped "now"; a bare YYYY-MM-DD for today should match all 3,
         NOT zero (which is what `.col = <datetime>"today"` would have given since exact equality
         requires full timestamp). ***/
    const today = new Date().toISOString().slice(0, 10);
    await dtFilter.fill(today);
    await dtFilter.press("Enter");
    await expect(rows(page)).toHaveCount(3);
  });

  test("Clear Filters button resets filters and reloads", async ({ page }) => {
    await gotoData(page);
    /*** Sanity: beforeEach inserted 3 rows, the page should show all of them before we touch the
         filter. If a prior test leaked filter state across the page navigation this catches it
         cleanly with a 3 vs N message. ***/
    await expect(rows(page)).toHaveCount(3);

    const nameFilter = page.locator("input[name=\"filter-name\"]");
    await nameFilter.fill("cycle");
    await nameFilter.press("Enter");
    await expect(rows(page)).toHaveCount(1);
    await page.getByRole("button", { name: "Clear Filters" }).click();
    await expect(rows(page)).toHaveCount(3);
  });
});

test.describe("Data viewer — CRUD", () => {
  test.beforeEach(async () => {
    await clearItems();
  });

  test("inserts a new row through the Add Object form", async ({ page }) => {
    await page.goto("/ui/data");
    await expect(rows(page)).toHaveCount(0); /*** empty — placeholder card shown instead ***/
    await page.getByRole("button", { name: "+ Add Object" }).click();
    await page.getByLabel(/^name/).fill("Tron");
    await page.getByLabel(/^count/).fill("7");
    await page.getByRole("button", { name: "Save" }).click();
    /*** After insert the form closes and the row appears. ***/
    await expect(page.getByDisplayValue("Tron")).toBeVisible();
    expect(await itemCount()).toBe(1);
  });

  test("edits an existing row", async ({ page }) => {
    await insertItem("Sark", 4);
    await page.goto("/ui/data");
    await page.getByRole("button", { name: "Edit" }).click();

    /*** Editable inputs in the editing card, in column order: count, createdAt, name (id is the
         read-only header). Target the name input (index 2) explicitly — `first()` would hit
         count. ***/
    const editingInputs = page.locator(".data.editing input[type=\"text\"]");
    await editingInputs.nth(2).fill("Sark v2");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByDisplayValue("Sark v2")).toBeVisible();

    const result = await runQuery(`select default::Item { name } filter .name = "Sark v2";`);
    expect(Array.isArray(result.data) ? result.data.length : 0).toBe(1);
  });

  test("deletes a row after confirmation", async ({ page }) => {
    await insertItem("CLU", 9);
    await page.goto("/ui/data");

    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "Delete" }).click();

    /*** Row gone from UI and DB. ***/
    await expect(page.getByDisplayValue("CLU")).toHaveCount(0);
    expect(await itemCount()).toBe(0);
  });
});
