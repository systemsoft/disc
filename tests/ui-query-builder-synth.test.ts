/**
 * Tests for the visual query builder's EdgeQL synthesizer (#3b).
 *
 * Lives in `tests/` rather than next to the source file in `ui/` so it
 * runs under the project's `deno test` slice. The pure synth module
 * has no DOM/Svelte deps so it imports straight into Deno without a
 * Vite pipeline.
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  coerceValue,
  type QuerySpec,
  synthesize,
} from "../ui/src/lib/query-builder-synth.ts";

function spec(overrides: Partial<QuerySpec>): QuerySpec {
  return {
    type: "User",
    shape: { fields: [], links: {} },
    filters: [],
    ...overrides,
  };
}

Deno.test("synthesize emits bare select with no shape when no fields are picked", () => {
  const out = synthesize(spec({}));
  assertEquals(out.query, "select User");
  assertEquals(out.variables, {});
});

Deno.test("synthesize compiles flat scalar fields", () => {
  const out = synthesize(
    spec({ shape: { fields: ["name", "email"], links: {} } }),
  );
  assertEquals(out.query, "select User { name, email }");
});

Deno.test("synthesize compiles one-level link expansion", () => {
  const out = synthesize(
    spec({
      type: "User",
      shape: {
        fields: ["name"],
        links: { posts: { fields: ["title", "body"] } },
      },
    }),
  );
  assertEquals(out.query, "select User { name, posts: { title, body } }");
});

Deno.test("single filter parameterizes the value with the chosen cast", () => {
  const out = synthesize(
    spec({
      shape: { fields: ["email"], links: {} },
      filters: [{ field: "email", op: "=", value: "a@b.c", cast: "str" }],
    }),
  );
  assertEquals(out.query, "select User { email } filter .email = <str>$p0");
  assertEquals(out.variables, { p0: "a@b.c" });
});

Deno.test("multiple filters AND with parens", () => {
  const out = synthesize(
    spec({
      type: "Post",
      shape: { fields: ["id"], links: {} },
      filters: [
        { field: "score", op: ">", value: "10", cast: "int64" },
        { field: "title", op: "=", value: "hello", cast: "str" },
      ],
    }),
  );
  assertEquals(
    out.query,
    "select Post { id } filter (.score > <int64>$p0) and (.title = <str>$p1)",
  );
  assertEquals(out.variables, { p0: 10, p1: "hello" });
});

Deno.test("order asc default; desc explicit", () => {
  const asc = synthesize(
    spec({
      shape: { fields: ["id"], links: {} },
      order: { field: "name", direction: "asc" },
    }),
  );
  assertEquals(asc.query, "select User { id } order by .name");

  const desc = synthesize(
    spec({
      shape: { fields: ["id"], links: {} },
      order: { field: "name", direction: "desc" },
    }),
  );
  assertEquals(desc.query, "select User { id } order by .name desc");
});

Deno.test("limit and offset emit literal integers in fixed order", () => {
  const out = synthesize(
    spec({
      shape: { fields: ["id"], links: {} },
      filters: [{ field: "active", op: "=", value: "true", cast: "bool" }],
      order: { field: "name", direction: "asc" },
      limit: 10,
      offset: 5,
    }),
  );
  assertEquals(
    out.query,
    "select User { id } filter .active = <bool>$p0 order by .name limit 10 offset 5",
  );
  assertEquals(out.variables, { p0: true });
});

Deno.test("limit and offset reject non-integers / negatives", () => {
  assertThrows(
    () => synthesize(spec({ limit: 1.5 })),
    Error,
    "non-negative integer",
  );
  assertThrows(
    () => synthesize(spec({ offset: -1 })),
    Error,
    "non-negative integer",
  );
});

Deno.test("identifier safety — type, field, link, and order names are all checked", () => {
  assertThrows(() => synthesize(spec({ type: "User; drop" })), Error);
  assertThrows(
    () =>
      synthesize(
        spec({ shape: { fields: ["name; drop"], links: {} } }),
      ),
    Error,
  );
  assertThrows(
    () =>
      synthesize(
        spec({
          shape: { fields: [], links: { "p; drop": { fields: ["title"] } } },
        }),
      ),
    Error,
  );
  assertThrows(
    () =>
      synthesize(
        spec({
          shape: { fields: ["id"], links: {} },
          filters: [{ field: "id; drop", op: "=", value: "x", cast: "str" }],
        }),
      ),
    Error,
  );
  assertThrows(
    () =>
      synthesize(
        spec({
          shape: { fields: ["id"], links: {} },
          order: { field: "name; drop", direction: "asc" },
        }),
      ),
    Error,
  );
});

Deno.test("coerceValue: str / uuid / datetime pass through unchanged", () => {
  assertEquals(coerceValue("hello", "str", "x"), "hello");
  assertEquals(
    coerceValue("d3a8b2e6-...", "uuid", "x"),
    "d3a8b2e6-...",
  );
  assertEquals(
    coerceValue("2026-01-15T00:00:00Z", "datetime", "x"),
    "2026-01-15T00:00:00Z",
  );
});

Deno.test("coerceValue: bool accepts true/false/1/0 (case-insensitive)", () => {
  assertEquals(coerceValue("true", "bool", "x"), true);
  assertEquals(coerceValue("TRUE", "bool", "x"), true);
  assertEquals(coerceValue("1", "bool", "x"), true);
  assertEquals(coerceValue("false", "bool", "x"), false);
  assertEquals(coerceValue("0", "bool", "x"), false);
  assertThrows(() => coerceValue("yes", "bool", "x"), Error, "boolean");
});

Deno.test("coerceValue: int casts reject non-integers and trailing chars", () => {
  assertEquals(coerceValue("42", "int64", "x"), 42);
  assertThrows(() => coerceValue("3.14", "int64", "x"), Error, "int64");
  assertThrows(() => coerceValue("42abc", "int64", "x"), Error, "int64");
  assertThrows(() => coerceValue("", "int32", "x"), Error, "int32");
});

Deno.test("coerceValue: float casts accept decimals and integers", () => {
  assertEquals(coerceValue("3.14", "float64", "x"), 3.14);
  assertEquals(coerceValue("42", "float64", "x"), 42);
  assertThrows(() => coerceValue("nope", "float32", "x"), Error, "float32");
});

Deno.test("coerceValue error message names the field for UI surfacing", () => {
  assertThrows(
    () => coerceValue("nope", "int64", "score"),
    Error,
    "score: expected int64",
  );
});
