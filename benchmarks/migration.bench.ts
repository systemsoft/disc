/**
 * SchemaDiffer Benchmarks
 *
 * Benchmarks schema diffing for various migration scenarios.
 */

import { SchemaDiffer } from "../migration/differ.ts";
import type { Identifier, LinkDeclaration, PropertyDeclaration, TypeDeclaration, TypeRef } from "../schema/ast.ts";
import type { Module } from "../schema/converter.ts";

// Helper to create AST nodes used by the SchemaDiffer
function ident(value: string): Identifier {
  return { kind: "Identifier", value };
}

function typeRef(name: string): TypeRef {
  return { kind: "TypeRef", name: { kind: "QualifiedName", parts: [name] } };
}

function prop(
  name: string,
  type: string,
  options?: { required?: boolean; multi?: boolean; }
): PropertyDeclaration {
  return {
    kind: "PropertyDeclaration",
    name: ident(name),
    type: typeRef(type),
    required: options?.required,
    multi: options?.multi,
    constraints: [],
    annotations: []
  };
}

function link(
  name: string,
  target: string,
  options?: { required?: boolean; multi?: boolean; }
): LinkDeclaration {
  return {
    kind: "LinkDeclaration",
    name: ident(name),
    target: typeRef(target),
    required: options?.required,
    multi: options?.multi,
    constraints: [],
    annotations: []
  };
}

function typeDef(
  name: string,
  members: (PropertyDeclaration | LinkDeclaration)[]
): TypeDeclaration {
  return {
    kind: "TypeDeclaration",
    name: ident(name),
    members
  };
}

function mod(name: string, items: TypeDeclaration[]): Module {
  return { name, items };
}

// Schema fixtures
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
