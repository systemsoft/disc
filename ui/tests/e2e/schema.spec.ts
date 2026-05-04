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

  test("shows constraints inline under each property", async ({ page }) => {
    await page.goto("/ui/schema");

    // The fixture's Item.name has `constraint exclusive` + `max_len_value(100)`,
    // and Item.count has `min_value(0)` — assert all three are surfaced.
    await expect(page.getByText("exclusive")).toBeVisible();
    await expect(page.getByText("max_len_value(100)")).toBeVisible();
    await expect(page.getByText("min_value(0)")).toBeVisible();
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
});
