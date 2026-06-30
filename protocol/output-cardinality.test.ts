/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests that the binary protocol output type descriptor emits the TRUE
 * per-field cardinality derived from the schema, rather than hard-coding
 * every shape element to ONE (0x41).
 *
 * Mapping under test (matches `protocol/typedesc.ts` buildResultDescriptors):
 *   required + single → ONE          (0x41)
 *   optional + single → AT_MOST_ONE  (0x6f)
 *   required + multi  → AT_LEAST_ONE (0x4d)
 *   optional + multi  → MANY         (0x6d)
 */

import { assertEquals } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import {
  buildOutputDescriptor,
  inferOutputShape
} from "./binary-server.ts";
import { BufferReader } from "./buffer.ts";
import { Cardinality } from "./enums.ts";

// Minimal structural schema covering all four cardinality cases.
const schema = {
  types: new Map([
    ["Thing", {
      properties: new Map([
        ["title", {
          edgeqlType: "str",
          type: "str",
          required: true,
          multi: false
        }],
        ["nickname", {
          edgeqlType: "str",
          type: "str",
          required: false,
          multi: false
        }]
      ]),
      links: new Map([
        ["tags", { required: true, multi: true }],
        ["notes", { required: false, multi: true }]
      ])
    }]
  ])
};

/** Split a packed typedesc block into its length-prefixed descriptors. */
function splitDescriptors(block: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  const view = new DataView(block.buffer, block.byteOffset);
  let off = 0;
  while (off < block.length) {
    const len = view.getUint32(off, false);
    off += 4;
    out.push(block.slice(off, off + len));
    off += len;
  }
  return out;
}

/**
 * Decode the CTYPE_SHAPE descriptor (tag 0x01) and return a map of
 * field name → cardinality byte.
 */
function shapeCardinalities(block: Uint8Array): Map<string, number> {
  const shapeDesc = splitDescriptors(block).find(d => d[0] === 0x01);
  if (!shapeDesc) {
    throw new Error("no CTYPE_SHAPE descriptor in output block");
  }
  const r = new BufferReader(shapeDesc);
  r.readUInt8(); // tag = 1
  r.readUUID(); // tid
  r.readUInt8(); // is_compound
  r.readUInt16(); // ephemeral_free_objects
  const els = r.readUInt16();
  const out = new Map<string, number>();
  for (let i = 0; i < els; i++) {
    r.readUInt32(); // flags
    const cardinality = r.readUInt8();
    const name = r.readString();
    r.readUInt16(); // pos
    r.readUInt16(); // source_type_pos
    out.set(name, cardinality);
  }
  return out;
}

Deno.test("output descriptor emits true per-field cardinality", () => {
  const parser = new EdgeQLParser(
    "select Thing { title, nickname, tags, notes }"
  );
  const query = parser.parse();
  const shape = inferOutputShape(query, schema);
  const desc = buildOutputDescriptor(shape);
  const cards = shapeCardinalities(desc.data);

  assertEquals(cards.get("title"), Cardinality.ONE); // required scalar
  assertEquals(cards.get("nickname"), Cardinality.AT_MOST_ONE); // optional scalar
  assertEquals(cards.get("tags"), Cardinality.AT_LEAST_ONE); // required multi link
  assertEquals(cards.get("notes"), Cardinality.MANY); // optional multi link

  // Guard against regression to the old hard-coded all-ONE behavior.
  const distinct = new Set(cards.values());
  assertEquals(distinct.size > 1, true);
});
