/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/*** NATIVE ------------------------------------------- ***/

import { assertEquals } from "@std/assert";

/*** UTILITY ------------------------------------------ ***/

import {
  coerceCell,
  parsePgArray,
  parsePgComposite,
  type EdgeQLTypeInfo
} from "./import-coerce.ts";

/*** RUNTIME ------------------------------------------ ***/

/*** --- parsePgComposite (state machine) --- ***/

Deno.test("parsePgComposite - quoted-then-unquoted tuple value", () => {
  assertEquals(
    parsePgComposite("(\"Example Source\",https://example.test)"),
    ["Example Source", "https://example.test"]
  );
});

Deno.test("parsePgComposite - unquoted elements", () => {
  assertEquals(parsePgComposite("(a,b,c)"), ["a", "b", "c"]);
});

Deno.test("parsePgComposite - quoted element with embedded comma", () => {
  assertEquals(parsePgComposite("(\"a, b\",c)"), ["a, b", "c"]);
});

Deno.test("parsePgComposite - doubled-quote escaping", () => {
  assertEquals(parsePgComposite("(\"say \"\"hi\"\"\",x)"), ["say \"hi\"", "x"]);
});

Deno.test("parsePgComposite - backslash escaping inside quotes", () => {
  /*** PG doubles literal backslashes inside quoted composite fields. ***/
  assertEquals(parsePgComposite("(\"a\\\\b\",c)"), ["a\\b", "c"]);
});

Deno.test("parsePgComposite - NULL element (empty unquoted) vs empty string", () => {
  /*** First element empty/unquoted => NULL; second is quoted empty string. ***/
  assertEquals(parsePgComposite("(,\"\")"), [null, ""]);
});

Deno.test("parsePgComposite - quoted element with parens", () => {
  assertEquals(parsePgComposite("(\"a (b) c\",d)"), ["a (b) c", "d"]);
});

Deno.test("parsePgComposite - single element", () => {
  assertEquals(parsePgComposite("(x)"), ["x"]);
});

/*** --- parsePgArray (state machine) --- ***/

Deno.test("parsePgArray - unquoted elements", () => {
  assertEquals(parsePgArray("{a,b,c}"), ["a", "b", "c"]);
});

Deno.test("parsePgArray - quoted spaces and embedded commas", () => {
  assertEquals(parsePgArray("{a,\"b c\",\"d,e\"}"), ["a", "b c", "d,e"]);
});

Deno.test("parsePgArray - empty array", () => {
  assertEquals(parsePgArray("{}"), []);
});

Deno.test("parsePgArray - unquoted NULL is null element", () => {
  assertEquals(parsePgArray("{a,NULL,c}"), ["a", null, "c"]);
});

Deno.test("parsePgArray - quoted NULL is the literal string", () => {
  assertEquals(parsePgArray("{\"NULL\",b}"), ["NULL", "b"]);
});

Deno.test("parsePgArray - doubled-quote escaping", () => {
  assertEquals(parsePgArray("{\"say \"\"hi\"\"\"}"), ["say \"hi\""]);
});

Deno.test("parsePgArray - array of composite literals", () => {
  assertEquals(parsePgArray("{\"(1,a)\",\"(2,b)\"}"), ["(1,a)", "(2,b)"]);
});

/*** --- coerceCell: empty cell handling --- ***/

Deno.test("coerceCell - empty optional str => null", () => {
  const t: EdgeQLTypeInfo = { hasDefault: false, required: false, type: "str" };
  assertEquals(coerceCell("", t), null);
});

Deno.test("coerceCell - empty required str with no default => empty string", () => {
  const t: EdgeQLTypeInfo = { hasDefault: false, required: true, type: "str" };
  assertEquals(coerceCell("", t), "");
});

Deno.test("coerceCell - empty required str WITH default => null", () => {
  const t: EdgeQLTypeInfo = { hasDefault: true, required: true, type: "str" };
  assertEquals(coerceCell("", t), null);
});

Deno.test("coerceCell - empty int => null", () => {
  const t: EdgeQLTypeInfo = { hasDefault: false, required: true, type: "int64" };
  assertEquals(coerceCell("", t), null);
});

Deno.test("coerceCell - empty datetime => null", () => {
  const t: EdgeQLTypeInfo = { hasDefault: false, required: true, type: "datetime" };
  assertEquals(coerceCell("", t), null);
});

Deno.test("coerceCell - empty array<str> => null", () => {
  const t: EdgeQLTypeInfo = { hasDefault: false, required: false, type: "array<str>" };
  assertEquals(coerceCell("", t), null);
});

Deno.test("coerceCell - empty tuple => null", () => {
  const t: EdgeQLTypeInfo = {
    hasDefault: false,
    required: false,
    tupleFields: ["name", "url"],
    type: "tuple<name: str, url: str>"
  };

  assertEquals(coerceCell("", t), null);
});

/*** --- coerceCell: scalar passthrough --- ***/

Deno.test("coerceCell - str passthrough", () => {
  const t: EdgeQLTypeInfo = { hasDefault: false, required: false, type: "str" };
  assertEquals(coerceCell("hello world", t), "hello world");
});

Deno.test("coerceCell - uuid passthrough", () => {
  const t: EdgeQLTypeInfo = { hasDefault: false, required: true, type: "uuid" };
  const id = "550e8400-e29b-41d4-a716-446655440000";
  assertEquals(coerceCell(id, t), id);
});

Deno.test("coerceCell - enum passthrough", () => {
  const t: EdgeQLTypeInfo = {
    hasDefault: false,
    isEnum: true,
    required: true,
    type: "Visibility"
  };

  assertEquals(coerceCell("public", t), "public");
});

Deno.test("coerceCell - datetime passthrough", () => {
  const t: EdgeQLTypeInfo = { hasDefault: false, required: true, type: "datetime" };
  const v = "2025-12-14 21:50:49.119571+00";
  assertEquals(coerceCell(v, t), v);
});

/*** --- coerceCell: numeric --- ***/

Deno.test("coerceCell - int64 => number", () => {
  const t: EdgeQLTypeInfo = { hasDefault: false, required: true, type: "int64" };
  assertEquals(coerceCell("17335929", t), 17335929);
});

Deno.test("coerceCell - bool-as-int64 stays integer, not boolean", () => {
  const t: EdgeQLTypeInfo = { hasDefault: false, required: true, type: "int64" };
  assertEquals(coerceCell("0", t), 0);
});

Deno.test("coerceCell - float64 => number", () => {
  const t: EdgeQLTypeInfo = { hasDefault: false, required: true, type: "float64" };
  assertEquals(coerceCell("8.976667", t), 8.976667);
});

Deno.test("coerceCell - decimal => number", () => {
  const t: EdgeQLTypeInfo = { hasDefault: false, required: true, type: "decimal" };
  assertEquals(coerceCell("3.14", t), 3.14);
});

/*** --- coerceCell: array<scalar> --- ***/

Deno.test("coerceCell - array<str> => JS array", () => {
  const t: EdgeQLTypeInfo = { hasDefault: false, required: false, type: "array<str>" };
  assertEquals(coerceCell("{a,\"b c\",\"d,e\"}", t), ["a", "b c", "d,e"]);
});

Deno.test("coerceCell - array<uuid> => JS array", () => {
  const t: EdgeQLTypeInfo = { hasDefault: false, required: false, type: "array<uuid>" };
  const a = "11111111-1111-1111-1111-111111111111";
  const b = "22222222-2222-2222-2222-222222222222";

  assertEquals(coerceCell(`{${a},${b}}`, t), [a, b]);
});

Deno.test("coerceCell - array<str> with NULL element", () => {
  const t: EdgeQLTypeInfo = { hasDefault: false, required: false, type: "array<str>" };
  assertEquals(coerceCell("{a,NULL,c}", t), ["a", null, "c"]);
});

/*** --- coerceCell: tuple => JSONB string --- ***/

Deno.test("coerceCell - tuple => JSON string keyed by field names", () => {
  const t: EdgeQLTypeInfo = {
    hasDefault: false,
    required: true,
    tupleFields: ["name", "url"],
    type: "tuple<name: str, url: str>"
  };

  const result = coerceCell("(\"Example Source\",https://example.test)", t);
  assertEquals(result, JSON.stringify({ name: "Example Source", url: "https://example.test" }));
});

Deno.test("coerceCell - tuple with NULL element => null value in object", () => {
  const t: EdgeQLTypeInfo = {
    hasDefault: false,
    required: true,
    tupleFields: ["name", "url"],
    type: "tuple<name: str, url: str>"
  };

  const result = coerceCell("(,\"x\")", t);
  assertEquals(result, JSON.stringify({ name: null, url: "x" }));
});

/*** --- coerceCell: array<tuple<...>> => JSONB string --- ***/

Deno.test("coerceCell - array<tuple<...>> => JSON array of objects", () => {
  const t: EdgeQLTypeInfo = {
    hasDefault: false,
    required: false,
    tupleFields: ["id", "label"],
    type: "array<tuple<id: str, label: str>>"
  };

  const result = coerceCell("{\"(1,a)\",\"(2,b)\"}", t);

  assertEquals(
    result,
    JSON.stringify([
      { id: "1", label: "a" },
      { id: "2", label: "b" }
    ])
  );
});

Deno.test("coerceCell - array<tuple<...>> with embedded comma in element", () => {
  const t: EdgeQLTypeInfo = {
    hasDefault: false,
    required: false,
    tupleFields: ["name", "url"],
    type: "array<tuple<name: str, url: str>>"
  };

  /*** Inner composite has a quoted comma; the whole composite is quoted as an array element, so its
       inner quotes are doubled at the array level. ***/
  const result = coerceCell("{\"(\"\"a, b\"\",c)\"}", t);
  assertEquals(result, JSON.stringify([{ name: "a, b", url: "c" }]));
});
