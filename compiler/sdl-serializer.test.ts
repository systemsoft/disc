/**
 * SDL serializer (#702 + #7469 — Phase 1)
 *
 * Tests that Schema → SDL text → Schema round-trips for representative
 * cases. Focus is correctness of the output, not exact byte-for-byte
 * formatting (the parser normalizes whitespace).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { serializeSchema, serializeType } from "./sdl-serializer.ts";
import type { LinkDef, PropertyDef, Schema, TypeDef } from "./context.ts";
import { createTestSchema } from "./context.ts";
import { getBuiltinFunctions } from "./builtin-functions.ts";
import { SchemaManager } from "../migration/schema-manager.ts";

// Helpers ------------------------------------------------------------------

function makeSchema(types: TypeDef[]): Schema {
  const m = new Map<string, TypeDef>();
  for (const t of types) m.set(t.name, t);
  return { types: m, functions: getBuiltinFunctions() };
}

/** Parse the SDL text back into a Schema via SchemaManager. */
function reparse(sdl: string): Schema {
  const mgr = new SchemaManager({ dryRun: true });
  const r = mgr.parseSDL(sdl);
  if (!r.ok) {
    throw new Error(`re-parse failed: ${JSON.stringify(r.error)}`);
  }
  return mgr.modulesToSchema(r.value);
}

// =========================================================================
// Single-type rendering — simple cases
// =========================================================================

Deno.test("sdl-serializer - object type with required scalar properties", () => {
  const t: TypeDef = {
    name: "User",
    kind: "object",
    tableName: "users",
    properties: new Map([
      ["name", {
        name: "name",
        type: "str",
        required: true,
        multi: false,
        columnName: "name",
        edgeqlType: "str",
      }],
      ["email", {
        name: "email",
        type: "str",
        required: true,
        multi: false,
        columnName: "email",
        edgeqlType: "str",
      }],
    ]),
    links: new Map(),
  };
  const sdl = serializeType(t);
  assertStringIncludes(sdl, "type User");
  assertStringIncludes(sdl, "required name: str;");
  assertStringIncludes(sdl, "required email: str;");
});

Deno.test("sdl-serializer - optional scalar property omits 'required'", () => {
  const t: TypeDef = {
    name: "User",
    kind: "object",
    tableName: "users",
    properties: new Map([
      ["nickname", {
        name: "nickname",
        type: "str",
        required: false,
        multi: false,
        columnName: "nickname",
        edgeqlType: "str",
      }],
    ]),
    links: new Map(),
  };
  const sdl = serializeType(t);
  assertStringIncludes(sdl, "nickname: str;");
  // The exact text "required nickname" must NOT appear
  assertEquals(sdl.includes("required nickname"), false);
});

Deno.test("sdl-serializer - multi link renders 'multi'", () => {
  const t: TypeDef = {
    name: "User",
    kind: "object",
    tableName: "users",
    properties: new Map(),
    links: new Map([
      ["posts", {
        name: "posts",
        target: "Post",
        required: false,
        multi: true,
      }],
    ]),
  };
  const sdl = serializeType(t);
  assertStringIncludes(sdl, "multi link posts -> Post;");
});

Deno.test("sdl-serializer - abstract object type renders 'abstract'", () => {
  const t: TypeDef = {
    name: "Timestamped",
    kind: "object",
    tableName: "timestamped",
    abstract: true,
    properties: new Map([
      ["createdAt", {
        name: "createdAt",
        type: "datetime",
        required: true,
        multi: false,
        columnName: "created_at",
        edgeqlType: "datetime",
      }],
    ]),
    links: new Map(),
  };
  const sdl = serializeType(t);
  assertStringIncludes(sdl, "abstract type Timestamped");
});

Deno.test("sdl-serializer - extending parents renders extending clause", () => {
  const t: TypeDef = {
    name: "User",
    kind: "object",
    tableName: "users",
    parentTypes: ["Timestamped", "Authored"],
    properties: new Map(),
    links: new Map(),
  };
  const sdl = serializeType(t);
  assertStringIncludes(sdl, "type User extending Timestamped, Authored");
});

Deno.test("sdl-serializer - enum scalar renders extending enum<...>", () => {
  const t: TypeDef = {
    name: "Status",
    kind: "enum",
    tableName: "status",
    properties: new Map(),
    links: new Map(),
    enumValues: ["active", "inactive", "pending"],
  };
  const sdl = serializeType(t);
  assertStringIncludes(sdl, "scalar type Status extending enum<active, inactive, pending>;");
});

// =========================================================================
// Property body — constraints, defaults, annotations, readonly
// =========================================================================

Deno.test("sdl-serializer - property with exclusive constraint", () => {
  const t: TypeDef = {
    name: "User",
    kind: "object",
    tableName: "users",
    properties: new Map([
      ["email", {
        name: "email",
        type: "str",
        required: true,
        multi: false,
        columnName: "email",
        edgeqlType: "str",
        constraints: [{ name: "exclusive" }],
      }],
    ]),
    links: new Map(),
  };
  const sdl = serializeType(t);
  assertStringIncludes(sdl, "required email: str {");
  assertStringIncludes(sdl, "constraint exclusive;");
});

Deno.test("sdl-serializer - property with parameterised constraint", () => {
  const t: TypeDef = {
    name: "User",
    kind: "object",
    tableName: "users",
    properties: new Map([
      ["name", {
        name: "name",
        type: "str",
        required: true,
        multi: false,
        columnName: "name",
        edgeqlType: "str",
        constraints: [{ name: "max_length", args: ["255"] }],
      }],
    ]),
    links: new Map(),
  };
  const sdl = serializeType(t);
  assertStringIncludes(sdl, "constraint max_length(255);");
});

Deno.test("sdl-serializer - readonly property emits 'readonly := true'", () => {
  const t: TypeDef = {
    name: "User",
    kind: "object",
    tableName: "users",
    properties: new Map([
      ["createdAt", {
        name: "createdAt",
        type: "datetime",
        required: true,
        multi: false,
        columnName: "created_at",
        edgeqlType: "datetime",
        readonly: true,
      }],
    ]),
    links: new Map(),
  };
  const sdl = serializeType(t);
  assertStringIncludes(sdl, "readonly := true;");
});

Deno.test("sdl-serializer - property with annotation renders annotation block", () => {
  const t: TypeDef = {
    name: "User",
    kind: "object",
    tableName: "users",
    properties: new Map([
      ["password", {
        name: "password",
        type: "str",
        required: true,
        multi: false,
        columnName: "password",
        edgeqlType: "str",
        annotations: { secret: "true" },
      }],
    ]),
    links: new Map(),
  };
  const sdl = serializeType(t);
  // SDL annotation values are string literals; the value `"true"` becomes `'true'`.
  assertStringIncludes(sdl, "annotation secret := 'true';");
});

Deno.test("sdl-serializer - type-level annotation rendered before properties", () => {
  const t: TypeDef = {
    name: "User",
    kind: "object",
    tableName: "users",
    annotations: { description: "A user account" },
    properties: new Map(),
    links: new Map(),
  };
  const sdl = serializeType(t);
  assertStringIncludes(sdl, "annotation description := 'A user account';");
});

// =========================================================================
// Module grouping
// =========================================================================

Deno.test("sdl-serializer - groups types into module blocks", () => {
  const a: TypeDef = {
    name: "default::A",
    kind: "object",
    tableName: "a",
    module: "default",
    properties: new Map(),
    links: new Map(),
  };
  const b: TypeDef = {
    name: "billing::Invoice",
    kind: "object",
    tableName: "invoice",
    module: "billing",
    properties: new Map(),
    links: new Map(),
  };
  const sdl = serializeSchema(makeSchema([a, b]));
  assertStringIncludes(sdl, "module default {");
  assertStringIncludes(sdl, "module billing {");
});

Deno.test("sdl-serializer - types without explicit module land in 'default'", () => {
  const t: TypeDef = {
    name: "User",
    kind: "object",
    tableName: "users",
    properties: new Map(),
    links: new Map(),
  };
  const sdl = serializeSchema(makeSchema([t]));
  assertStringIncludes(sdl, "module default {");
  assertStringIncludes(sdl, "type User");
});

// =========================================================================
// Round-trip — serialize(testSchema) → re-parse → equivalent
// =========================================================================

Deno.test("sdl-serializer - round-trips createTestSchema's User type", () => {
  const original = createTestSchema();
  const sdl = serializeSchema(original);
  const reparsed = reparse(sdl);

  const origUser = original.types.get("User")!;
  const newUser = reparsed.types.get("User") ?? reparsed.types.get("default::User");
  assertEquals(newUser !== undefined, true, "User type missing after re-parse");
  assertEquals(
    newUser!.properties.has("email"),
    true,
    "email property missing after re-parse",
  );
  // exclusive constraint preserved
  const newEmail = newUser!.properties.get("email") as PropertyDef;
  assertEquals(
    newEmail.constraints?.some((c) => c.name === "exclusive"),
    true,
  );
  // multi posts link preserved
  const newPosts = newUser!.links.get("posts") as LinkDef;
  assertEquals(newPosts !== undefined, true);
  assertEquals(newPosts.multi, true);
  // required-ness preserved on a sample property
  const newName = newUser!.properties.get("name") as PropertyDef;
  assertEquals(newName.required, true);
  // verify the original still has what we're comparing against
  assertEquals(origUser.properties.get("email")?.required, true);
});

Deno.test("sdl-serializer - round-trips enum scalar Status", () => {
  const original = createTestSchema();
  const sdl = serializeSchema(original);
  // Verify the enum-values list made it into the SDL text — the
  // SchemaManager re-parser doesn't currently extract enum values from
  // `extending enum<...>` (separate gap, see schema-manager.ts:432
  // hard-coding `enumValues: []`), so kind=enum is what we can assert
  // post-reparse.
  assertStringIncludes(
    sdl,
    "scalar type Status extending enum<active, inactive, pending>;",
  );
  const reparsed = reparse(sdl);
  const status = reparsed.types.get("Status") ??
    reparsed.types.get("default::Status");
  assertEquals(status !== undefined, true);
  assertEquals(status!.kind, "enum");
});
