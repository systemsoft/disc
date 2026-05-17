/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * EdgeQL scalar metadata used by the language server's hover and
 * completion providers (#7411 + #655 — Phase 2).
 *
 * One-line descriptions for each built-in scalar. Kept in a flat
 * record so completion enumerates them and hover looks them up.
 */

export const SCALAR_TYPES: ReadonlyArray<
  { name: string; description: string; }
> = [
  {
    name: "str",
    description: "Variable-length text. Maps to PostgreSQL `text`."
  },
  { name: "int16", description: "16-bit signed integer (-32 768 .. 32 767)." },
  {
    name: "int32",
    description: "32-bit signed integer (-2 147 483 648 .. 2 147 483 647)."
  },
  { name: "int64", description: "64-bit signed integer." },
  { name: "float32", description: "Single-precision IEEE 754 floating point." },
  { name: "float64", description: "Double-precision IEEE 754 floating point." },
  {
    name: "decimal",
    description: "Arbitrary-precision decimal. Use for money."
  },
  { name: "bool", description: "Boolean (`true` / `false`)." },
  { name: "uuid", description: "128-bit UUID. Default `id` type for objects." },
  {
    name: "datetime",
    description: "Timezone-aware timestamp. Stored as PostgreSQL `timestamptz`."
  },
  { name: "local_datetime", description: "Naïve timestamp without timezone." },
  { name: "local_date", description: "Calendar date without time." },
  { name: "local_time", description: "Time-of-day without date." },
  { name: "duration", description: "Interval / span between two datetimes." },
  { name: "bytes", description: "Raw binary blob." },
  { name: "json", description: "JSON value (object/array/scalar)." }
];

const BY_NAME = new Map(SCALAR_TYPES.map(s => [s.name, s]));

export function lookupScalar(
  name: string
): { name: string; description: string; } | undefined {
  return BY_NAME.get(name);
}
