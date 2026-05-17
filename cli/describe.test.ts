/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for the `\d` REPL describer (gh/geldata#1218).
 *
 * Each fixture here exercises a specific metadata field and asserts the
 * describer surfaces it. Run via `deno test --allow-all --no-check cli/`.
 */

/*** NATIVE ------------------------------------------- ***/

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

/*** UTILITY ------------------------------------------ ***/

import { describeAllTypes, describeType } from "./describe.ts";
import type { AccessPolicy } from "../access/types.ts";

import type {
  IndexDef,
  LinkDef,
  PropertyDef,
  Schema,
  TypeDef
} from "../compiler/context.ts";

/*** RUNTIME ------------------------------------------ ***/

/*** --- describeAllTypes — list view --- ***/

Deno.test("describeAllTypes - groups by module with default first", () => {
  const schema = buildSchema([
    {
      kind: "object",
      links: new Map(),
      module: "default",
      name: "User",
      properties: new Map(),
      tableName: "users"
    },
    {
      kind: "object",
      links: new Map(),
      module: "payment",
      name: "payment::Payment",
      properties: new Map(),
      tableName: "payments"
    },
    {
      kind: "object",
      links: new Map(),
      module: "api",
      name: "api::Key",
      properties: new Map(),
      tableName: "keys"
    }
  ]);

  const out = describeAllTypes(schema);
  /*** default appears before alphabetical "api" and "payment" ***/
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
      abstract: true,
      kind: "object",
      links: new Map(),
      name: "Shape",
      properties: new Map(),
      tableName: "shapes"
    },
    {
      enumValues: ["active", "inactive"],
      kind: "enum",
      links: new Map(),
      name: "Status",
      properties: new Map(),
      tableName: "status"
    }
  ]);

  const out = describeAllTypes(schema);

  assertStringIncludes(out, "Shape");
  assertStringIncludes(out, "(abstract)");
  assertStringIncludes(out, "Status");
  assertStringIncludes(out, "(enum)");
});

/*** --- describeType — single-type detail view --- ***/

Deno.test("describeType - returns null for unknown type", () => {
  const schema = buildSchema([]);
  assertEquals(describeType(schema, "Nope"), null);
});

Deno.test("describeType - resolves bare name in default module", () => {
  const schema = buildSchema([
    {
      kind: "object",
      links: new Map(),
      module: "default",
      name: "default::User",
      properties: new Map([[
        "name",
        makeProperty({ name: "name", required: true })
      ]]),
      tableName: "users"
    }
  ]);

  const out = describeType(schema, "User");

  assert(out !== null);
  assertStringIncludes(out, "Type: type User");
  assertStringIncludes(out, "Module: default");
});

Deno.test("describeType - emits full property metadata", () => {
  const schema = buildSchema([
    {
      kind: "object",
      links: new Map(),
      name: "User",
      properties: new Map([
        [
          "email",
          makeProperty({
            annotations: { description: "Login email" },
            constraints: [
              { name: "exclusive" },
              { args: ["255"], name: "max_length" }
            ],
            edgeqlType: "str",
            name: "email",
            required: true
          })
        ],
        ["name", makeProperty({ name: "name", required: true })],
        [
          "createdAt",
          makeProperty({
            edgeqlType: "datetime",
            hasDefault: true,
            name: "createdAt",
            readonly: true
          })
        ],
        [
          "postCount",
          makeProperty({
            computed: true,
            edgeqlType: "int32",
            name: "postCount"
          })
        ]
      ]),
      tableName: "users"
    }
  ]);

  const out = describeType(schema, "User")!;
  /*** Required + multi flags ***/
  assertStringIncludes(out, "email: str [required]");
  /*** Constraint args + bare constraint ***/
  assertStringIncludes(out, "constraint exclusive");
  assertStringIncludes(out, "constraint max_length(255)");
  /*** Annotation ***/
  assertStringIncludes(out, `annotation description := "Login email"`);
  /*** Readonly + default flags ***/
  assertStringIncludes(out, "createdAt: datetime [readonly, default]");
  /*** Computed flag ***/
  assertStringIncludes(out, "postCount: int32 [computed]");
});

Deno.test("describeType - emits link cardinality and target", () => {
  const schema = buildSchema([
    {
      kind: "object",
      links: new Map([
        [
          "posts",
          makeLink({
            backlink: "author",
            multi: true,
            name: "posts",
            target: "Post"
          })
        ]
      ]),
      name: "User",
      properties: new Map(),
      tableName: "users"
    },
    {
      kind: "object",
      links: new Map([
        [
          "author",
          makeLink({
            name: "author",
            required: true,
            target: "User"
          })
        ]
      ]),
      name: "Post",
      properties: new Map(),
      tableName: "posts"
    }
  ]);

  const userOut = describeType(schema, "User")!;
  assertStringIncludes(userOut, "posts -> Post [multi]");
  assertStringIncludes(userOut, "backlink: author");

  const postOut = describeType(schema, "Post")!;
  assertStringIncludes(postOut, "author -> User [required, single]");
});

Deno.test("describeType - emits indexes", () => {
  const indexes: IndexDef[] = [
    { expression: ".email", name: "users_email_idx" },
    { expression: "(.firstName, .lastName)" }
  ];

  const schema = buildSchema([
    {
      indexes,
      kind: "object",
      links: new Map(),
      name: "User",
      properties: new Map(),
      tableName: "users"
    }
  ]);

  const out = describeType(schema, "User")!;

  assertStringIncludes(out, "Indexes:");
  assertStringIncludes(out, "users_email_idx on .email");
  assertStringIncludes(out, "on (.firstName, .lastName)");
});

Deno.test("describeType - emits access policies", () => {
  const policies: AccessPolicy[] = [
    {
      actions: [
        { allow: true, operations: ["select", "update"] }
      ],
      name: "owners_only",
      objectType: "Note"
    },
    {
      actions: [{ allow: false, operations: ["delete"] }],
      name: "block_delete",
      objectType: "Note"
    }
  ];

  const schema = buildSchema([
    {
      accessPolicies: policies,
      kind: "object",
      links: new Map(),
      name: "Note",
      properties: new Map(),
      tableName: "notes"
    }
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
      abstract: true,
      discriminatorColumn: "__type__",
      kind: "object",
      links: new Map(),
      name: "Shape",
      properties: new Map(),
      subtypes: ["Circle", "Square"],
      tableName: "shapes"
    },
    {
      kind: "object",
      links: new Map(),
      name: "Circle",
      parentTypes: ["Shape"],
      properties: new Map(),
      tableName: "circles"
    }
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
      enumValues: ["active", "inactive", "pending"],
      kind: "enum",
      links: new Map(),
      name: "Status",
      properties: new Map(),
      tableName: "status"
    }
  ]);

  const out = describeType(schema, "Status")!;

  assertStringIncludes(out, "Type: enum Status");
  assertStringIncludes(out, "Values: active, inactive, pending");
});

Deno.test("describeType - omits implicit `id` property", () => {
  const schema = buildSchema([
    {
      kind: "object",
      links: new Map(),
      name: "User",
      properties: new Map([
        ["id", makeProperty({ edgeqlType: "uuid", name: "id", required: true })],
        ["name", makeProperty({ name: "name", required: true })]
      ]),
      tableName: "users"
    }
  ]);

  const out = describeType(schema, "User")!;
  /*** `id` is implicit in Disc/Gel SDL — describer must not show it. Search for the property
       listing only, not the type header. ***/
  const propsIdx = out.indexOf("Properties:");
  assert(propsIdx >= 0);

  const propsBlock = out.slice(propsIdx);
  assertEquals(propsBlock.includes(" id:"), false, propsBlock);
  assertStringIncludes(propsBlock, "name: str [required]");
});

Deno.test("describeType - emits triggers when present", () => {
  const schema = buildSchema([
    {
      kind: "object",
      links: new Map(),
      name: "Post",
      properties: new Map(),
      tableName: "posts",
      triggers: [
        {
          body: "...",
          events: ["insert"],
          name: "audit_insert",
          scope: "each",
          timing: "after"
        }
      ]
    }
  ]);

  const out = describeType(schema, "Post")!;

  assertStringIncludes(out, "Triggers:");
  assertStringIncludes(out, "audit_insert after insert (each)");
});

/*** HELPER ------------------------------------------- ***/

function buildSchema(types: TypeDef[]): Schema {
  return {
    functions: new Map(),
    types: new Map(types.map(t => [t.name, t]))
  };
}

function makeLink(l: Partial<LinkDef> & { name: string; target: string; }): LinkDef {
  const defaults: LinkDef = {
    multi: false,
    name: l.name,
    required: false,
    target: l.target
  };

  return { ...defaults, ...l };
}

function makeProperty(p: Partial<PropertyDef> & { name: string; }): PropertyDef {
  /*** Build defaults explicitly then merge overrides on top so the spread can never appear after a
       key it would shadow (TS2783/TS2785). ***/
  const defaults: PropertyDef = {
    columnName: p.name,
    edgeqlType: "str",
    multi: false,
    name: p.name,
    required: false,
    type: "str"
  };

  return { ...defaults, ...p };
}
