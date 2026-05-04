import { expect, test } from "@playwright/test";
import { clearItems, insertItem, itemCount, runQuery } from "./helpers";

test.describe("Data viewer — read", () => {
  test.beforeEach(async () => {
    await clearItems();
    await insertItem("Disc identity disc", 1);
    await insertItem("Light cycle", 2);
    await insertItem("Recognizer", 3);
  });

  test("renders type list and rows for default::Item", async ({ page }) => {
    await page.goto("/ui/data");

    // Type list shows the seeded type.
    await expect(page.getByRole("button", { name: "default::Item" })).toBeVisible();

    // Three rows appear in the table.
    const rows = page.locator("tbody tr");
    await expect(rows).toHaveCount(3);
    await expect(page.getByRole("cell", { name: "Light cycle" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Recognizer" })).toBeVisible();
  });

  test("sorts by clicking a property column header", async ({ page }) => {
    await page.goto("/ui/data");
    await expect(page.locator("tbody tr")).toHaveCount(3);

    // Click the count column header → asc → first row should be count=1.
    await page.getByRole("columnheader", { name: /^count/ }).click();
    await expect(page.locator("tbody tr").first()).toContainText("Disc identity disc");

    // Click again → desc → first row should be count=3.
    await page.getByRole("columnheader", { name: /^count/ }).click();
    await expect(page.locator("tbody tr").first()).toContainText("Recognizer");
  });

  test("filters by string column with ilike substring match", async ({ page }) => {
    await page.goto("/ui/data");
    await expect(page.locator("tbody tr")).toHaveCount(3);

    const filterRow = page.locator("tr.filter-row");
    const nameFilter = filterRow.locator('input[placeholder="contains…"]').first();
    await nameFilter.fill("cycle");
    await nameFilter.press("Enter");

    await expect(page.locator("tbody tr")).toHaveCount(1);
    await expect(page.getByRole("cell", { name: "Light cycle" })).toBeVisible();
  });

  test("filters numeric column with range syntax (>=N, a..b)", async ({ page }) => {
    await page.goto("/ui/data");
    await expect(page.locator("tbody tr")).toHaveCount(3);

    // The count column has placeholder ">=10, <5, 10..20".
    const countFilter = page
      .locator('tr.filter-row input[placeholder*=".."]')
      .first();

    await countFilter.fill(">=2");
    await countFilter.press("Enter");
    // Light cycle (2) and Recognizer (3) match — Disc identity disc (1) does not.
    await expect(page.locator("tbody tr")).toHaveCount(2);

    await countFilter.fill("2..3");
    await countFilter.press("Enter");
    await expect(page.locator("tbody tr")).toHaveCount(2);

    await countFilter.fill(">10");
    await countFilter.press("Enter");
    await expect(page.locator("tbody tr")).toHaveCount(1);
    // The lone row in this scenario is the empty-state placeholder.
    await expect(page.getByText("No rows match")).toBeVisible();
  });

  test("Clear button resets filters and reloads", async ({ page }) => {
    await page.goto("/ui/data");
    const filterRow = page.locator("tr.filter-row");
    const nameFilter = filterRow.locator('input[placeholder="contains…"]').first();
    await nameFilter.fill("cycle");
    await nameFilter.press("Enter");
    await expect(page.locator("tbody tr")).toHaveCount(1);

    await page.getByRole("button", { name: "Clear" }).click();
    await expect(page.locator("tbody tr")).toHaveCount(3);
  });
});

test.describe("Data viewer — CRUD", () => {
  test.beforeEach(async () => {
    await clearItems();
  });

  test("inserts a new row through the New form", async ({ page }) => {
    await page.goto("/ui/data");
    await expect(page.locator("tbody tr")).toHaveCount(1); // empty-row placeholder

    await page.getByRole("button", { name: "+ New" }).click();
    await page.getByLabel(/^name/).fill("Tron");
    await page.getByLabel(/^count/).fill("7");
    await page.getByRole("button", { name: "Save" }).click();

    // After insert the form closes and the row appears.
    await expect(page.getByRole("cell", { name: "Tron" })).toBeVisible();
    expect(await itemCount()).toBe(1);
  });

  test("edits an existing row", async ({ page }) => {
    await insertItem("Sark", 4);
    await page.goto("/ui/data");

    await page.getByRole("button", { name: "Edit" }).click();

    // Editable columns in order: count, createdAt, name (id is read-only).
    // Target the name input (index 2) explicitly — `first()` would hit count.
    const editingInputs = page.locator('tr.editing input[type="text"]');
    await editingInputs.nth(2).fill("Sark v2");
    await page.getByRole("button", { name: "Save" }).click();

    await expect(page.getByRole("cell", { name: "Sark v2" })).toBeVisible();

    const rows = await runQuery(
      "select default::Item { name } filter .name = 'Sark v2';",
    );
    expect(Array.isArray(rows.data) ? rows.data.length : 0).toBe(1);
  });

  test("deletes a row after confirmation", async ({ page }) => {
    await insertItem("CLU", 9);
    await page.goto("/ui/data");

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete" }).click();

    // Row gone from UI and DB.
    await expect(page.getByRole("cell", { name: "CLU" })).toHaveCount(0);
    expect(await itemCount()).toBe(0);
  });
});
