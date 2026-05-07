/**
 * Tests for Global (Session Variable) support — Phase 1: Context + Schema Extraction
 *
 * Validates that GlobalDef is correctly integrated into the compiler context
 * and that the SchemaManager extracts globals from SDL. Covers:
 * - SchemaManager extraction of GlobalDef from SDL with GlobalDeclaration
 * - resolveGlobal with exact qualified name
 * - resolveGlobal with module scope resolution
 * - resolveGlobal with "default" fallback
 * - resolveGlobal returns undefined for unknown global
 * - createTestSchema includes globals map
 */

import { assertEquals } from "@std/assert";
import { createTestSchema, GlobalDef, resolveGlobal, Schema } from "./context.ts";
import { SchemaManager } from "../migration/schema-manager.ts";

// ---------------------------------------------------------------------------
// Tests: SchemaManager extracts globals from SDL
// ---------------------------------------------------------------------------

Deno.test("Globals - SchemaManager extracts GlobalDef from SDL", () => {
  const sdl = `
    module default {
      type User {
        required name: str;
        required email: str;
      }

      global current_user_id: uuid;
    }
  `;

  const manager = new SchemaManager({ dryRun: true });
  const parseResult = manager.parseSDL(sdl);
  if (!parseResult.ok) {
    throw parseResult.error;
  }

  const schema = manager.modulesToSchema(parseResult.value);

  // The schema should contain the global
  assertEquals(schema.globals !== undefined, true);
  assertEquals(schema.globals!.has("default::current_user_id"), true);

  const globalDef = schema.globals!.get("default::current_user_id")!;
  assertEquals(globalDef.name, "current_user_id");
  assertEquals(globalDef.module, "default");
  assertEquals(globalDef.type, "uuid");
  assertEquals(globalDef.pgType, "uuid");
  assertEquals(globalDef.required, false);
  assertEquals(globalDef.multi, false);
  assertEquals(globalDef.readonly, false);
  assertEquals(globalDef.pgSettingName, "disc.global_default__current_user_id");
  assertEquals(globalDef.default, undefined);
});

Deno.test("Globals - SchemaManager extracts global with required, default, and readonly", () => {
  const sdl = `
    module default {
      type User {
        required name: str;
      }

      global required current_user_id: uuid {
        default := '00000000-0000-0000-0000-000000000000';
        readonly := true;
      };
    }
  `;

  const manager = new SchemaManager({ dryRun: true });
  const parseResult = manager.parseSDL(sdl);
  if (!parseResult.ok) {
    throw parseResult.error;
  }

  const schema = manager.modulesToSchema(parseResult.value);

  assertEquals(schema.globals !== undefined, true);
  const globalDef = schema.globals!.get("default::current_user_id")!;
  assertEquals(globalDef.required, true);
  assertEquals(globalDef.readonly, true);
  assertEquals(globalDef.default !== undefined, true);
});

// ---------------------------------------------------------------------------
// Tests: resolveGlobal with exact qualified name
// ---------------------------------------------------------------------------

Deno.test("Globals - resolveGlobal with exact qualified name", () => {
  const globals = new Map<string, GlobalDef>([
    ["default::current_user_id", {
      name: "current_user_id",
      module: "default",
      type: "uuid",
      pgType: "uuid",
      required: false,
      multi: false,
      readonly: false,
      pgSettingName: "disc.global_default__current_user_id",
    }],
  ]);

  const schema: Schema = {
    ...createTestSchema(),
    globals,
  };

  const result = resolveGlobal(schema, "default::current_user_id");
  assertEquals(result !== undefined, true);
  assertEquals(result!.name, "current_user_id");
  assertEquals(result!.module, "default");
  assertEquals(result!.pgSettingName, "disc.global_default__current_user_id");
});

// ---------------------------------------------------------------------------
// Tests: resolveGlobal with module scope resolution
// ---------------------------------------------------------------------------

Deno.test("Globals - resolveGlobal with module scope resolution", () => {
  const globals = new Map<string, GlobalDef>([
    ["auth::current_user_id", {
      name: "current_user_id",
      module: "auth",
      type: "uuid",
      pgType: "uuid",
      required: false,
      multi: false,
      readonly: false,
      pgSettingName: "disc.global_auth__current_user_id",
    }],
  ]);

  const schema: Schema = {
    ...createTestSchema(),
    globals,
  };

  // Unqualified name resolves via moduleScope
  const result = resolveGlobal(schema, "current_user_id", "auth");
  assertEquals(result !== undefined, true);
  assertEquals(result!.name, "current_user_id");
  assertEquals(result!.module, "auth");
});

// ---------------------------------------------------------------------------
// Tests: resolveGlobal with "default" fallback
// ---------------------------------------------------------------------------

Deno.test("Globals - resolveGlobal with default fallback", () => {
  const globals = new Map<string, GlobalDef>([
    ["default::current_user_id", {
      name: "current_user_id",
      module: "default",
      type: "uuid",
      pgType: "uuid",
      required: false,
      multi: false,
      readonly: false,
      pgSettingName: "disc.global_default__current_user_id",
    }],
  ]);

  const schema: Schema = {
    ...createTestSchema(),
    globals,
  };

  // Unqualified name falls back to "default::" prefix
  const result = resolveGlobal(schema, "current_user_id");
  assertEquals(result !== undefined, true);
  assertEquals(result!.name, "current_user_id");
  assertEquals(result!.module, "default");
});

// ---------------------------------------------------------------------------
// Tests: resolveGlobal returns undefined for unknown global
// ---------------------------------------------------------------------------

Deno.test("Globals - resolveGlobal returns undefined for unknown global", () => {
  const globals = new Map<string, GlobalDef>([
    ["default::current_user_id", {
      name: "current_user_id",
      module: "default",
      type: "uuid",
      pgType: "uuid",
      required: false,
      multi: false,
      readonly: false,
      pgSettingName: "disc.global_default__current_user_id",
    }],
  ]);

  const schema: Schema = {
    ...createTestSchema(),
    globals,
  };

  const result = resolveGlobal(schema, "nonexistent_global");
  assertEquals(result, undefined);

  // Also test with qualified name that does not exist
  const result2 = resolveGlobal(schema, "other::current_user_id");
  assertEquals(result2, undefined);
});

// ---------------------------------------------------------------------------
// Tests: createTestSchema includes globals map
// ---------------------------------------------------------------------------

Deno.test("Globals - createTestSchema includes globals map", () => {
  const schema = createTestSchema();

  assertEquals(schema.globals !== undefined, true);
  assertEquals(schema.globals instanceof Map, true);
  assertEquals(schema.globals!.size > 0, true);

  // Verify the test global is present
  assertEquals(schema.globals!.has("default::current_user_id"), true);

  const globalDef = schema.globals!.get("default::current_user_id")!;
  assertEquals(globalDef.name, "current_user_id");
  assertEquals(globalDef.module, "default");
  assertEquals(globalDef.type, "uuid");
  assertEquals(globalDef.pgType, "uuid");
  assertEquals(globalDef.required, false);
  assertEquals(globalDef.multi, false);
  assertEquals(globalDef.readonly, false);
  assertEquals(globalDef.pgSettingName, "disc.global_default__current_user_id");
});
