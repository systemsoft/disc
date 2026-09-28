/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Gel 7.1 takes arrays of arrays in a query (`[[1, 2], [3]]`) but not in a
 * schema type: a property, a tuple element or a scalar's base of type
 * `array<array<…>>` is "UnsupportedFeatureError: nested arrays are not
 * supported". An array of tuples of arrays (`array<tuple<array<int64>>>`) is
 * fine. Disc accepted them and made a PostgreSQL array column, which holds
 * no arrays of different lengths.
 */

import { assertEquals } from "@std/assert";
import { SDLParser } from "./parser.ts";
import { SchemaValidator } from "./validator.ts";

function validate(source: string): string[] {
  const result = new SchemaValidator().validate(new SDLParser(source).parse());
  return (result.errors ?? []).map(error => error.message);
}

Deno.test("nested arrays: a property, a tuple element or a scalar base of an array of arrays is rejected, as Gel does", () => {
  for (
    const source of [
      "module default { type T { a: array<array<int64>>; }; };",
      "module default { type T { a: tuple<array<array<int64>>>; }; };",
      "module default { scalar type Grid extending array<array<int64>>; };"
    ]
  ) {
    assertEquals(validate(source), ["nested arrays are not supported"], source);
  }
});

Deno.test("nested arrays: an array of tuples of arrays is a schema type", () => {
  assertEquals(validate("module default { type T { a: array<tuple<array<int64>>>; }; };"), []);
});
