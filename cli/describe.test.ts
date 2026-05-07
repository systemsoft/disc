/**
 * Tests for the `\d` REPL describer (gh/geldata#1218).
 *
 * Each fixture here exercises a specific metadata field and asserts the
 * describer surfaces it. Run via `deno test --allow-all --no-check cli/`.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { AccessPolicy } from "../access/types.ts";
import type { IndexDef, LinkDef, PropertyDef, Schema, TypeDef } from "../compiler/context.ts";
import { describeAllTypes, describeType } from "./describe.ts";

function buildSchema(types: TypeDef[]): Schema {
  return {
    types: new Map(types.map((t) => [t.name, t])),
    functions: new Map(),
  };
}

function makeProperty(p: Partial<PropertyDef> & { name: string; }): PropertyDef {
  // Build defaults explicitly then merge overrides on top so the spread
  // can never appear after a key it would shadow (TS2783/TS2785).
  const defaults: PropertyDef = {
    columnName: p.name,
    edgeqlType: "str",
    multi: false,
    name: p.name,
    required: false,
    type: "str",
  };
  return { ...defaults, ...p };
}

function makeLink(l: Partial<LinkDef> & { name: string; target: string; }): LinkDef {
  const defaults: LinkDef = {
    multi: false,
    name: l.name,
    required: false,
    target: l.target,
  };
  return { ...defaults, ...l };
}

// ---------------------------------------------------------------------------
// describeAllTypes — list view
// ---------------------------------------------------------------------------

Deno.test("describeAllTypes - groups by module with default first", () => {
  const schema = buildSchema([
    {
      name: "User",
      kind: "object",
      tableName: "users",
      properties: new Map(),
      links: new Map(),
      module: "default",
    },
    {
      name: "payment::Payment",
      kind: "object",
      tableName: "payments",
      properties: new Map(),
      links: new Map(),
      module: "payment",
    },
    {
      name: "api::Key",
      kind: "object",
      tableName: "keys",
      properties: new Map(),
      links: new Map(),
      module: "api",
    },
  ]);

  const out = describeAllTypes(schema);
  // default appears before alphabetical "api" and "payment"
  const defaultIdx = out.indexOf("module default");
  const apiIdx = out.indexOf("module api");
  const paymentIdx = out.indexOf("module payment");
  assert(defaultIdx >= 0 && apiIdx >= 0 && paymentIdx >= 0, out);
  assert(defaultIdx < apiIdx, "default before api");
  assert(apiIdx < paymentIdx, "api before payment");

  assertStringIncludes(out, "User");
  assertStringIncludes(out, "Payment");
  assertStringIncludes(out, "Key");
});

Deno.test("describeAllTypes - empty schema reports no types", () => {
  const out = describeAllTypes({ types: new Map(), functions: new Map() });
  assertEquals(out, "No types defined in schema.");
});

Deno.test("describeAllTypes - distinguishes abstract and enum kinds", () => {
  const schema = buildSchema([
    {
      name: "Shape",
      kind: "object",
      tableName: "shapes",
      properties: new Map(),
      links: new Map(),
      abstract: true,
    },
    {
      name: "Status",
      kind: "enum",
      tableName: "status",
      properties: new Map(),
      links: new Map(),
      enumValues: ["active", "inactive"],
    },
  ]);
  const out = describeAllTypes(schema);
  assertStringIncludes(out, "Shape");
  assertStringIncludes(out, "(abstract)");
  assertStringIncludes(out, "Status");
  assertStringIncludes(out, "(enum)");
});

// ---------------------------------------------------------------------------
// describeType — single-type detail view
// ---------------------------------------------------------------------------

Deno.test("describeType - returns null for unknown type", () => {
  const schema = buildSchema([]);
  assertEquals(describeType(schema, "Nope"), null);
});

Deno.test("describeType - resolves bare name in default module", () => {
  const schema = buildSchema([
    {
      name: "default::User",
      kind: "object",
      tableName: "users",
      module: "default",
      properties: new Map([["name", makeProperty({ name: "name", required: true })]]),
      links: new Map(),
    },
  ]);
  const out = describeType(schema, "User");
  assert(out !== null);
  assertStringIncludes(out, "Type: type User");
  assertStringIncludes(out, "Module: default");
});

Deno.test("describeType - emits full property metadata", () => {
  const schema = buildSchema([
    {
      name: "User",
      kind: "object",
      tableName: "users",
      properties: new Map([
        [
          "email",
          makeProperty({
            name: "email",
            required: true,
            edgeqlType: "str",
            constraints: [{ name: "exclusive" }, { name: "max_length", args: ["255"] }],
            annotations: { description: "Login email" },
          }),
        ],
        ["name", makeProperty({ name: "name", required: true })],
        [
          "createdAt",
          makeProperty({
            name: "createdAt",
            edgeqlType: "datetime",
            readonly: true,
            hasDefault: true,
          }),
        ],
        [
          "postCount",
          makeProperty({
            name: "postCount",
            edgeqlType: "int32",
            computed: true,
          }),
        ],
      ]),
      links: new Map(),
    },
  ]);

  const out = describeType(schema, "User")!;
  // Required + multi flags
  assertStringIncludes(out, "email: str [required]");
  // Constraint args + bare constraint
  assertStringIncludes(out, "constraint exclusive");
  assertStringIncludes(out, "constraint max_length(255)");
  // Annotation
  assertStringIncludes(out, "annotation description := 'Login email'");
  // Readonly + default flags
  assertStringIncludes(out, "createdAt: datetime [readonly, default]");
  // Computed flag
  assertStringIncludes(out, "postCount: int32 [computed]");
});

Deno.test("describeType - emits link cardinality and target", () => {
  const schema = buildSchema([
    {
      name: "User",
      kind: "object",
      tableName: "users",
      properties: new Map(),
      links: new Map([
        [
          "posts",
          makeLink({
            name: "posts",
            target: "Post",
            multi: true,
            backlink: "author",
          }),
        ],
      ]),
    },
    {
      name: "Post",
      kind: "object",
      tableName: "posts",
      properties: new Map(),
      links: new Map([
        [
          "author",
          makeLink({
            name: "author",
            target: "User",
            required: true,
          }),
        ],
      ]),
    },
  ]);

  const userOut = describeType(schema, "User")!;
  assertStringIncludes(userOut, "posts -> Post [multi]");
  assertStringIncludes(userOut, "backlink: author");

  const postOut = describeType(schema, "Post")!;
  assertStringIncludes(postOut, "author -> User [required, single]");
});

Deno.test("describeType - emits indexes", () => {
  const indexes: IndexDef[] = [
    { name: "users_email_idx", expression: ".email" },
    { expression: "(.firstName, .lastName)" },
  ];
  const schema = buildSchema([
    {
      name: "User",
      kind: "object",
      tableName: "users",
      properties: new Map(),
      links: new Map(),
      indexes,
    },
  ]);
  const out = describeType(schema, "User")!;
  assertStringIncludes(out, "Indexes:");
  assertStringIncludes(out, "users_email_idx on .email");
  assertStringIncludes(out, "on (.firstName, .lastName)");
});

Deno.test("describeType - emits access policies", () => {
  const policies: AccessPolicy[] = [
    {
      name: "owners_only",
      objectType: "Note",
      actions: [
        { allow: true, operations: ["select", "update"] },
      ],
    },
    {
      name: "block_delete",
      objectType: "Note",
      actions: [{ allow: false, operations: ["delete"] }],
    },
  ];
  const schema = buildSchema([
    {
      name: "Note",
      kind: "object",
      tableName: "notes",
      properties: new Map(),
      links: new Map(),
      accessPolicies: policies,
    },
  ]);
  const out = describeType(schema, "Note")!;
  assertStringIncludes(out, "Access policies:");
  assertStringIncludes(out, "policy owners_only");
  assertStringIncludes(out, "allow select, update");
  assertStringIncludes(out, "policy block_delete");
  assertStringIncludes(out, "deny delete");
});

Deno.test("describeType - reports abstract, parent, subtypes, discriminator", () => {
  const schema = buildSchema([
    {
      name: "Shape",
      kind: "object",
      tableName: "shapes",
      abstract: true,
      subtypes: ["Circle", "Square"],
      discriminatorColumn: "__type__",
      properties: new Map(),
      links: new Map(),
    },
    {
      name: "Circle",
      kind: "object",
      tableName: "circles",
      parentTypes: ["Shape"],
      properties: new Map(),
      links: new Map(),
    },
  ]);
  const shape = describeType(schema, "Shape")!;
  assertStringIncludes(shape, "Type: abstract type Shape");
  assertStringIncludes(shape, "Subtypes: Circle, Square");
  assertStringIncludes(shape, "Discriminator: __type__");

  const circle = describeType(schema, "Circle")!;
  assertStringIncludes(circle, "Extends: Shape");
});

Deno.test("describeType - emits enum values for scalar enum types", () => {
  const schema = buildSchema([
    {
      name: "Status",
      kind: "enum",
      tableName: "status",
      properties: new Map(),
      links: new Map(),
      enumValues: ["active", "inactive", "pending"],
    },
  ]);
  const out = describeType(schema, "Status")!;
  assertStringIncludes(out, "Type: enum Status");
  assertStringIncludes(out, "Values: active, inactive, pending");
});

Deno.test("describeType - omits implicit `id` property", () => {
  const schema = buildSchema([
    {
      name: "User",
      kind: "object",
      tableName: "users",
      properties: new Map([
        ["id", makeProperty({ name: "id", edgeqlType: "uuid", required: true })],
        ["name", makeProperty({ name: "name", required: true })],
      ]),
      links: new Map(),
    },
  ]);
  const out = describeType(schema, "User")!;
  // `id` is implicit in Disc/Gel SDL — describer must not show it.
  // Search for the property listing only, not the type header.
  const propsIdx = out.indexOf("Properties:");
  assert(propsIdx >= 0);
  const propsBlock = out.slice(propsIdx);
  assertEquals(propsBlock.includes(" id:"), false, propsBlock);
  assertStringIncludes(propsBlock, "name: str [required]");
});

Deno.test("describeType - emits triggers when present", () => {
  const schema = buildSchema([
    {
      name: "Post",
      kind: "object",
      tableName: "posts",
      properties: new Map(),
      links: new Map(),
      triggers: [
        {
          name: "audit_insert",
          timing: "after",
          events: ["insert"],
          scope: "each",
          body: "...",
        },
      ],
    },
  ]);
  const out = describeType(schema, "Post")!;
  assertStringIncludes(out, "Triggers:");
  assertStringIncludes(out, "audit_insert after insert (each)");
});
