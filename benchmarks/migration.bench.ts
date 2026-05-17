/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * SchemaDiffer Benchmarks
 *
 * Benchmarks schema diffing for various migration scenarios.
 */

/*** UTILITY ------------------------------------------ ***/

import { SchemaDiffer } from "../migration/differ.ts";
import type { Module } from "../schema/converter.ts";

import type {
  Identifier,
  LinkDeclaration,
  PropertyDeclaration,
  TypeDeclaration,
  TypeRef
} from "../schema/ast.ts";

const emptySchema: Module[] = [];

const simpleSchema: Module[] = [
  mod("default", [
    typeDef("User", [
      prop("name", "str", { required: true }),
      prop("email", "str", { required: true })
    ])
  ])
];

const modifiedSchema: Module[] = [
  mod("default", [
    typeDef("User", [
      prop("name", "str", { required: true }),
      prop("email", "str", { required: true }),
      prop("age", "int32")
    ])
  ])
];

const multiTypeSchema: Module[] = [
  mod("default", [
    typeDef("User", [
      prop("name", "str", { required: true }),
      prop("email", "str", { required: true })
    ]),
    typeDef("Post", [
      prop("title", "str", { required: true }),
      prop("body", "str", { required: true }),
      link("author", "User", { required: true })
    ]),
    typeDef("Comment", [
      prop("body", "str", { required: true }),
      link("author", "User", { required: true }),
      link("post", "Post", { required: true })
    ])
  ])
];

const largeSchema: Module[] = [
  mod(
    "default",
    Array.from({ length: 20 }, (_, i) =>
      typeDef(`Type${i}`, [
        prop("id", "uuid", { required: true }),
        prop("name", "str", { required: true }),
        prop("description", "str"),
        prop("createdAt", "datetime", { required: true }),
        prop("updatedAt", "datetime")
      ]))
  )
];

const differ = new SchemaDiffer();

/*** RUNTIME ------------------------------------------ ***/

Deno.bench("differ: empty to simple", () => {
  differ.diff(emptySchema, simpleSchema);
});

Deno.bench("differ: simple to modified (add property)", () => {
  differ.diff(simpleSchema, modifiedSchema);
});

Deno.bench("differ: add types (empty to multi-type)", () => {
  differ.diff(emptySchema, multiTypeSchema);
});

Deno.bench("differ: remove types (multi-type to empty)", () => {
  differ.diff(multiTypeSchema, emptySchema);
});

Deno.bench("differ: no changes (identical schemas)", () => {
  differ.diff(simpleSchema, simpleSchema);
});

Deno.bench("differ: large schema (20 types, no changes)", () => {
  differ.diff(largeSchema, largeSchema);
});

Deno.bench("differ: large schema add all types", () => {
  differ.diff(emptySchema, largeSchema);
});

/*** HELPER ------------------------------------------- ***/

function ident(value: string): Identifier {
  return { kind: "Identifier", value };
}

function link(name: string, target: string, options?: { multi?: boolean; required?: boolean; }): LinkDeclaration {
  return {
    annotations: [],
    constraints: [],
    kind: "LinkDeclaration",
    multi: options?.multi,
    name: ident(name),
    required: options?.required,
    target: typeRef(target)
  };
}

function mod(name: string, items: TypeDeclaration[]): Module {
  return { items, name };
}

function prop(name: string, type: string, options?: { multi?: boolean; required?: boolean; }): PropertyDeclaration {
  return {
    annotations: [],
    constraints: [],
    kind: "PropertyDeclaration",
    multi: options?.multi,
    name: ident(name),
    required: options?.required,
    type: typeRef(type)
  };
}

function typeDef(name: string, members: (PropertyDeclaration | LinkDeclaration)[]): TypeDeclaration {
  return {
    kind: "TypeDeclaration",
    members,
    name: ident(name)
  };
}

function typeRef(name: string): TypeRef {
  return { kind: "TypeRef", name: { kind: "QualifiedName", parts: [name] } };
}
