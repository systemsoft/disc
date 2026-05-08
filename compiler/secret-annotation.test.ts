/**
 * Secret-annotation introspection (#5988 + #6444 — Phase 1)
 *
 * The `secret` annotation marks properties, links, or types as carrying
 * sensitive data. It is recognized as a built-in annotation (no
 * `abstract annotation` declaration needed) and is promoted from the
 * generic annotations map to a first-class boolean on the introspection
 * descriptions, so SDK and UI consumers can mask values without
 * string-matching annotation keys.
 *
 * Phase 2 (next session) will add the config-variable registry and
 * mask values returned by introspection. This phase only exposes the
 * marker.
 */

import { assertEquals } from "@std/assert";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SDLParser } from "../schema/parser.ts";
import { SchemaValidator } from "../schema/validator.ts";
import { getBuiltinFunctions } from "./builtin-functions.ts";
import type { LinkDef, PropertyDef, Schema, TypeDef } from "./context.ts";
import { describeType } from "./introspection.ts";

function makeSchema(types: TypeDef[]): Schema {
  const typeMap = new Map<string, TypeDef>();
  for (const t of types)
    typeMap.set(t.name, t);
  return { types: typeMap, functions: getBuiltinFunctions() };
}

function makeType(
  name: string,
  opts?: {
    annotations?: Record<string, string>;
    properties?: Map<string, PropertyDef>;
    links?: Map<string, LinkDef>;
  }
): TypeDef {
  return {
    name,
    kind: "object",
    tableName: name.toLowerCase(),
    properties: opts?.properties ?? new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid"
      }]
    ]),
    links: opts?.links ?? new Map(),
    annotations: opts?.annotations
  };
}

// =========================================================================
// Introspection — first-class `secret` field
// =========================================================================

Deno.test("secret-annotation - property without secret annotation has secret: false", () => {
  const properties = new Map<string, PropertyDef>([
    ["email", {
      name: "email",
      type: "text",
      required: true,
      multi: false,
      columnName: "email",
      edgeqlType: "str"
    }]
  ]);

  const schema = makeSchema([makeType("User", { properties })]);
  const desc = describeType(schema, "User");
  const emailProp = desc.properties.find(p => p.name === "email");
  assertEquals(emailProp!.secret, false);
});

Deno.test("secret-annotation - property with @secret := true has secret: true", () => {
  const properties = new Map<string, PropertyDef>([
    ["password_hash", {
      name: "password_hash",
      type: "text",
      required: true,
      multi: false,
      columnName: "password_hash",
      edgeqlType: "str",
      annotations: { secret: "true" }
    }]
  ]);

  const schema = makeSchema([makeType("User", { properties })]);
  const desc = describeType(schema, "User");
  const pw = desc.properties.find(p => p.name === "password_hash");
  assertEquals(pw!.secret, true);
});

Deno.test("secret-annotation - property with @secret := false has secret: false", () => {
  const properties = new Map<string, PropertyDef>([
    ["public_id", {
      name: "public_id",
      type: "text",
      required: true,
      multi: false,
      columnName: "public_id",
      edgeqlType: "str",
      annotations: { secret: "false" }
    }]
  ]);

  const schema = makeSchema([makeType("User", { properties })]);
  const desc = describeType(schema, "User");
  const p = desc.properties.find(p => p.name === "public_id");
  assertEquals(p!.secret, false);
});

Deno.test("secret-annotation - qualified std::secret annotation also recognized", () => {
  const properties = new Map<string, PropertyDef>([
    ["api_key", {
      name: "api_key",
      type: "text",
      required: true,
      multi: false,
      columnName: "api_key",
      edgeqlType: "str",
      annotations: { "std::secret": "true" }
    }]
  ]);

  const schema = makeSchema([makeType("Token", { properties })]);
  const desc = describeType(schema, "Token");
  const ak = desc.properties.find(p => p.name === "api_key");
  assertEquals(ak!.secret, true);
});

Deno.test("secret-annotation - link with @secret := true has secret: true", () => {
  const links = new Map<string, LinkDef>([
    ["recoveryContact", {
      name: "recoveryContact",
      target: "User",
      required: false,
      multi: false,
      annotations: { secret: "true" }
    }]
  ]);

  const schema = makeSchema([makeType("Account", { links })]);
  const desc = describeType(schema, "Account");
  const link = desc.links.find(l => l.name === "recoveryContact");
  assertEquals(link!.secret, true);
});

Deno.test("secret-annotation - type-level @secret := true has secret: true", () => {
  const schema = makeSchema([
    makeType("Credential", { annotations: { secret: "true" } })
  ]);

  const desc = describeType(schema, "Credential");
  assertEquals(desc.secret, true);
});

Deno.test("secret-annotation - generic annotation other than secret does not flip secret flag", () => {
  const properties = new Map<string, PropertyDef>([
    ["email", {
      name: "email",
      type: "text",
      required: true,
      multi: false,
      columnName: "email",
      edgeqlType: "str",
      annotations: { description: "secret email", title: "Email" }
    }]
  ]);

  const schema = makeSchema([makeType("User", { properties })]);
  const desc = describeType(schema, "User");
  const p = desc.properties.find(p => p.name === "email");
  assertEquals(p!.secret, false);
});

// =========================================================================
// Validator — `secret` is a built-in annotation
// =========================================================================

Deno.test("secret-annotation - validator: @secret usage requires no abstract declaration", () => {
  const sdl = `
    module default {
      type User {
        required password: str {
          annotation secret := 'true';
        };
      };
    }
  `;

  const parser = new SDLParser(sdl);
  const doc = parser.parse();
  const validator = new SchemaValidator();
  const result = validator.validate(doc);

  assertEquals(result.ok, true);
});

Deno.test("secret-annotation - validator: qualified std::secret usage requires no abstract declaration", () => {
  const sdl = `
    module default {
      type Token {
        required api_key: str {
          annotation std::secret := 'true';
        };
      };
    }
  `;

  const parser = new SDLParser(sdl);
  const doc = parser.parse();
  const validator = new SchemaValidator();
  const result = validator.validate(doc);

  assertEquals(result.ok, true);
});

// =========================================================================
// End-to-end: SDL -> SchemaManager -> describeType
// =========================================================================

Deno.test("secret-annotation - end-to-end: SDL @secret := true round-trips through SchemaManager", () => {
  const sdl = `
    module default {
      type User {
        required name: str;
        required password_hash: str {
          annotation secret := 'true';
        };
      };
    }
  `;

  const manager = new SchemaManager({ dryRun: true });
  const parseResult = manager.parseSDL(sdl);
  assertEquals(parseResult.ok, true);

  if (!parseResult.ok)
    throw parseResult.error;
  const schema = manager.modulesToSchema(parseResult.value);
  const desc = describeType(schema, "User");
  const pw = desc.properties.find(p => p.name === "password_hash");
  assertEquals(pw!.secret, true);

  const name = desc.properties.find(p => p.name === "name");
  assertEquals(name!.secret, false);
});
