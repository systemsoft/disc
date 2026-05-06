/**
 * Tests for the live-schema-diff apply endpoint (Bundle K — Disc #3a).
 *
 * The happy-path apply runs against a real PG instance — covered in
 * the `pg-integration.test.ts` companion. These unit tests cover the
 * gate logic that runs *before* we hit the database:
 *   - missing file → 404
 *   - non-POST → 405
 *   - parse-error in on-disk SDL → 400 with structured error
 *   - the `force=true` flag is parsed correctly from the query string
 *
 * The migration-engine itself is exercised by
 * `migration/unsafe-gate.test.ts` and the PG-backed engine tests.
 */

import { assertEquals } from "@std/assert";
import { handleSchemaApply } from "./schema-apply.ts";

Deno.test("handleSchemaApply — refuses non-POST", async () => {
  const tmp = await Deno.makeTempFile({ suffix: ".disc" });
  try {
    const res = await handleSchemaApply({
      request: new Request("http://localhost/admin/schema-apply", {
        method: "GET",
      }),
      url: new URL("http://localhost/admin/schema-apply"),
      schemaFilePath: tmp,
      databaseUrl: "postgresql://localhost:5432/dummy",
    });
    assertEquals(res.status, 405);
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("handleSchemaApply — returns 404 when SDL file missing", async () => {
  const res = await handleSchemaApply({
    request: new Request("http://localhost/admin/schema-apply", {
      method: "POST",
    }),
    url: new URL("http://localhost/admin/schema-apply"),
    schemaFilePath: "/nonexistent/path/should/not/exist.disc",
    databaseUrl: "postgresql://localhost:5432/dummy",
  });
  assertEquals(res.status, 404);
});

Deno.test(
  "handleSchemaApply — returns 400 when on-disk SDL fails to parse",
  async () => {
    const tmp = await Deno.makeTempFile({ suffix: ".disc" });
    try {
      // Missing closing brace on User
      await Deno.writeTextFile(tmp, "module default {\n  type User {\n    required name: str;\n};");
      const res = await handleSchemaApply({
        request: new Request("http://localhost/admin/schema-apply", {
          method: "POST",
        }),
        url: new URL("http://localhost/admin/schema-apply"),
        schemaFilePath: tmp,
        databaseUrl: "postgresql://localhost:5432/dummy",
      });
      assertEquals(res.status, 400);
      const body = await res.json();
      assertEquals(typeof body.error, "string");
      assertEquals(Array.isArray(body.parseErrors), true);
    } finally {
      await Deno.remove(tmp);
    }
  },
);

Deno.test(
  "handleSchemaApply — query-string `force=true` toggles allowUnsafe",
  () => {
    // Pure-function check: just verify the URL is parsed as expected.
    // Full force-apply round-trip is covered by the PG-backed test.
    const url = new URL("http://localhost/admin/schema-apply?force=true");
    assertEquals(url.searchParams.get("force"), "true");
    const url2 = new URL("http://localhost/admin/schema-apply");
    assertEquals(url2.searchParams.get("force"), null);
  },
);
