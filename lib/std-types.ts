/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Gel's `std` module is the default module: `std::int64` and `int64` name the
 * same type. Disc keys every type map by the bare name, so the SDL and EdgeQL
 * parsers read a `std::` type name as its bare name and nothing downstream
 * sees the qualified spelling. Only the standard scalar and range types are
 * unqualified; `std::BaseObject`, `std::Object` and anything unknown keep
 * their names.
 */
const STD_TYPE_NAMES = new Set([
  "bigint",
  "bool",
  "bytes",
  "datetime",
  "decimal",
  "duration",
  "float32",
  "float64",
  "int16",
  "int32",
  "int64",
  "json",
  "multirange",
  "range",
  "sequence",
  "str",
  "uuid"
]);

/*** The parts of a type name without a `std::` qualifier on a standard type: `["std", "int64"]` → `["int64"]`. ***/
export function stripStdModule(parts: string[]): string[] {
  return parts.length === 2 && parts[0] === "std" && STD_TYPE_NAMES.has(parts[1]) ? [parts[1]] : parts;
}

/*** A rendered type name without `std::` qualifiers on standard types: `array<std::str>` → `array<str>`. ***/
export function normalizeStdTypeName(name: string): string {
  return name.replace(/\bstd::(\w+)/g, (qualified, bare: string) => STD_TYPE_NAMES.has(bare) ? bare : qualified);
}
