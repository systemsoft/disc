import { expect, test } from "@playwright/test";

test.describe("Schema page", () => {
  test("renders the type list and selects the first type by default", async ({
    page,
  }) => {
    await page.goto("/ui/schema");

    // Sidebar lists Item.
    await expect(
      page.getByRole("button", { name: /Item/ }).first(),
    ).toBeVisible();

    // Default selection populates the right pane heading.
    await expect(page.getByRole("heading", { name: "Item" })).toBeVisible();
  });

  test("shows the meta tags (module, abstract, extends) where applicable", async ({
    page,
  }) => {
    await page.goto("/ui/schema");

    // The fixture's Item type lives in the default module.
    await expect(page.getByText(/module: default/)).toBeVisible();
  });

  test("Properties heading lists every property name", async ({ page }) => {
    await page.goto("/ui/schema");

    await expect(page.getByRole("heading", { name: "Properties" }))
      .toBeVisible();
    for (const name of ["id", "name", "count", "createdAt"]) {
      await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
    }
  });

  test("'default' flag appears on properties with a default expression", async ({
    page,
  }) => {
    await page.goto("/ui/schema");
    // Item.createdAt has `default := datetime_current()` in the fixture.
    await expect(page.getByText("default", { exact: true }).first()).toBeVisible();
  });

  test("Indexes section renders index expressions", async ({ page }) => {
    await page.goto("/ui/schema");
    // Fixture has `index on (.name)` — surface in the new Indexes section.
    await expect(page.getByRole("heading", { name: "Indexes" })).toBeVisible();
    await expect(page.getByText(".name", { exact: true })).toBeVisible();
  });
});
