/**
 * Test helpers for Disc UI E2E suite.
 *
 * Each spec runs against the same shared `disc-ui-e2e` Postgres
 * instance, so we reset row state via the EdgeQL endpoint at the
 * start of every test that mutates data.
 */

const API_BASE = "http://localhost:5173/api";

/** Issue a raw EdgeQL query through the same `/query` route the UI uses. */
export async function runQuery(query: string): Promise<{
  data?: unknown;
  errors?: Array<{ message: string }>;
}> {
  const res = await fetch(`${API_BASE}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  return res.json();
}

/** Delete every row of the named type so a test starts from a known state. */
export async function clearItems(): Promise<void> {
  await runQuery("delete default::Item;");
}

/** Insert a row directly via EdgeQL (useful for seeding fixtures). */
export async function insertItem(name: string, count: number): Promise<string> {
  const result = await runQuery(
    `insert default::Item { name := '${name.replace(/'/g, "\\'")}', count := ${count} };`,
  );
  if (result.errors) {
    throw new Error(`insertItem failed: ${result.errors[0].message}`);
  }
  return (result.data as { id: string }).id;
}

/** Count rows for the named type. */
export async function itemCount(): Promise<number> {
  const result = await runQuery("select default::Item { id } limit 1000;");
  if (result.errors) {
    throw new Error(`count failed: ${result.errors[0].message}`);
  }
  return Array.isArray(result.data) ? result.data.length : 0;
}
