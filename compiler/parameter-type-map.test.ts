/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Unit tests for buildParameterTypeMap — maps each parameter's 1-indexed
 * position to the PG type it is cast to, so the binding layer knows which
 * params (jsonb) need JSON serialization.
 */

import { assertEquals } from "@std/assert";
import { buildParameterTypeMap } from "./compiler-base.ts";
import {
  createCastExpression,
  createParameterReference,
  createSelectClause,
  createSelectItem,
  createSelectStatement
} from "./sql.ts";

Deno.test("buildParameterTypeMap - collects param index -> cast target type", () => {
  // SELECT CAST($1 AS jsonb), CAST($2 AS text[]), CAST($3 AS jsonb)
  const stmt = createSelectStatement({
    select: createSelectClause([
      createSelectItem(createCastExpression(createParameterReference(1), "jsonb")),
      createSelectItem(createCastExpression(createParameterReference(2), "text[]")),
      createSelectItem(createCastExpression(createParameterReference(3), "jsonb"))
    ])
  });

  const map = buildParameterTypeMap(stmt);
  assertEquals(map.get(1), "jsonb");
  assertEquals(map.get(2), "text[]");
  assertEquals(map.get(3), "jsonb");
  assertEquals(map.size, 3);
});

Deno.test("buildParameterTypeMap - empty when no parameter casts present", () => {
  const stmt = createSelectStatement({
    select: createSelectClause([
      createSelectItem(createCastExpression(createParameterReference(1), "jsonb"))
    ])
  });

  assertEquals(buildParameterTypeMap(stmt).get(1), "jsonb");
  assertEquals(buildParameterTypeMap(null).size, 0);
  assertEquals(buildParameterTypeMap({ kind: "Whatever" }).size, 0);
});
