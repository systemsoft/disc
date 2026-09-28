/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

import { assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import { objectTypeId, uuidV5 } from "./type-ids.ts";

Deno.test("uuidV5 is RFC 9562's name-based UUID", () => {
  // Python: uuid.uuid5(uuid.NAMESPACE_DNS, "python.org")
  assertEquals(uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "python.org"), "886313e1-3b8a-5372-9b90-0c9aee199e5d");
});

Deno.test("an object type's id is a version 5 UUID of its qualified name, the same every time", () => {
  const id = objectTypeId("default::Author");
  assertMatch(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assertEquals(objectTypeId("default::Author"), id);
  assertNotEquals(objectTypeId("default::Book"), id);
  assertNotEquals(objectTypeId("shop::Author"), id);
});
