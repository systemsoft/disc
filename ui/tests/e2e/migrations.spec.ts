import { expect, test } from "@playwright/test";

test.describe("Migrations page", () => {
  test("shows the heading and a Refresh button", async ({ page }) => {
    await page.goto("/ui/migrations");
    await expect(
      page.getByRole("heading", { name: "Migration History" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Refresh|Loading/ }),
    ).toBeVisible();
  });

  test("renders the auto-applied initial migration row", async ({ page }) => {
    await page.goto("/ui/migrations");

    // The fixture project's first `disc serve` auto-applies a migration
    // creating the Item type. Wait for the table to populate.
    await expect(
      page.getByRole("cell", { name: "create_item" }),
    ).toBeVisible({ timeout: 10_000 });

    // Header row is present.
    await expect(page.getByRole("columnheader", { name: "Applied" }))
      .toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Name" }))
      .toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Schema Hash" }))
      .toBeVisible();
  });

  test("Refresh button re-fetches without a page reload", async ({ page }) => {
    await page.goto("/ui/migrations");
    await expect(page.getByRole("cell", { name: "create_item" })).toBeVisible({
      timeout: 10_000,
    });

    // Track navigations — Refresh must NOT trigger a full navigation.
    let navigated = false;
    page.on("framenavigated", () => {
      navigated = true;
    });

    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.getByRole("cell", { name: "create_item" })).toBeVisible();
    expect(navigated).toBe(false);
  });
});
