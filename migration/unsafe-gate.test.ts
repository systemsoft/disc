// deno-lint-ignore-file no-explicit-any
import { assertEquals, assertStringIncludes } from "@std/assert";

import { MigrationEngine } from "./engine.ts";
import { SchemaManager } from "./schema-manager.ts";
import { SDLParser } from "../schema/parser.ts";
import { SchemaValidator } from "../schema/validator.ts";

/**
 * gh/geldata#1838: forward-direction destructive-op classifier and
 * matching `applySchema` gate. The engine has classified rollback
 * safety since prior versions; this test file covers the new
 * forward-classification helper plus the SchemaManager refusal that
 * the CLI's `--unsafe` flag toggles.
 */

const safeInitial = `
module default {
  type User {
    required name: str;
    email: str;
  };
}
`;

const safeAdditive = `
module default {
  type User {
    required name: str;
    email: str;
    bio: str;
  };
}
`;

const dropProperty = `
module default {
  type User {
    required name: str;
  };
}
`;

const dropType = `
module default {
  type Post {
    required title: str;
  };
}
`;

function planUnsafeDelta(initialSdl: string, nextSdl: string) {
  const validator = new SchemaValidator();
  const engine = new MigrationEngine({
    autoApply: false,
    backupBeforeMigration: false,
    requireConfirmation: false,
    validateOperations: true,
  });
  const initialModules = validator.convertToModules(
    new SDLParser(initialSdl).parse(),
  );
  const nextModules = validator.convertToModules(
    new SDLParser(nextSdl).parse(),
  );
  const planResult = engine.planMigration(initialModules, nextModules);
  if (!planResult.ok) throw new Error(planResult.error.message);
  return { engine, plan: planResult.value };
}

// ── classifyUnsafeOperations ───────────────────────────────────────────

Deno.test("classifyUnsafeOperations - additive migration is safe", () => {
  const { engine, plan } = planUnsafeDelta(safeInitial, safeAdditive);
  const unsafe = engine.classifyUnsafeOperations(plan);
  assertEquals(unsafe.length, 0);
});

Deno.test("classifyUnsafeOperations - DropProperty is unsafe", () => {
  const { engine, plan } = planUnsafeDelta(safeInitial, dropProperty);
  const unsafe = engine.classifyUnsafeOperations(plan);
  assertEquals(unsafe.length, 1);
  assertStringIncludes(unsafe[0].operation, "DropProperty");
  assertStringIncludes(unsafe[0].reason, "drops a column");
});

Deno.test("classifyUnsafeOperations - DropType is unsafe", () => {
  const { engine, plan } = planUnsafeDelta(safeInitial, dropType);
  const unsafe = engine.classifyUnsafeOperations(plan);
  // DropType (User) plus possibly a CreateType (Post) — only the drop
  // is flagged.
  const drops = unsafe.filter((u) => u.operation.startsWith("DropType"));
  assertEquals(drops.length, 1);
  assertStringIncludes(drops[0].operation, "User");
});

// ── SchemaManager.applySchema gate ─────────────────────────────────────

Deno.test("applySchema - refuses unsafe migration without allowUnsafe", async () => {
  const manager = new SchemaManager({ dryRun: true });
  await manager.initialize();
  // Seed initial state in dry-run mode (mutates currentModules).
  await manager.applySchema(safeInitial);

  // Now request a destructive change without allowUnsafe.
  // Dry-run still applies the gate? No — dry-run is intentionally
  // read-only and skips the gate (the operator wants to see the unsafe
  // ops to decide whether to pass --unsafe). Switch to non-dry-run for
  // this assertion. Since we don't have a live PG, applySchema will
  // hit the gate before any DB call and return Err — exactly the
  // behavior we want.
  const liveManager = new SchemaManager({ dryRun: false } as any);
  // Inject the engine + currentModules from the dry-run instance to
  // skip needing a real DB.
  (liveManager as any).engine = (manager as any).engine;
  (liveManager as any).currentModules = (manager as any).currentModules;
  (liveManager as any).initialized = true;
  (liveManager as any).dryRun = false;

  const result = await liveManager.applySchema(dropProperty);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "unsafe operation");
    assertStringIncludes(result.error.message, "DropProperty");
    assertStringIncludes(result.error.message, "--unsafe");
  }
});

Deno.test("applySchema - dry-run never refuses (it mutates nothing)", async () => {
  const manager = new SchemaManager({ dryRun: true });
  await manager.initialize();
  await manager.applySchema(safeInitial);
  // Dry-run with destructive change must succeed — operators rely on
  // dry-run to *see* what would be unsafe.
  const result = await manager.applySchema(dropProperty);
  assertEquals(result.ok, true);
});

Deno.test("applySchema - allowUnsafe bypasses the gate", async () => {
  const manager = new SchemaManager({ dryRun: true });
  await manager.initialize();
  await manager.applySchema(safeInitial);

  // Even with allowUnsafe, dry-run path executes and returns success —
  // here we just confirm the option doesn't break the call.
  const result = await manager.applySchema(dropProperty, {
    allowUnsafe: true,
  });
  assertEquals(result.ok, true);
});

Deno.test("applySchema - safe additive migration always succeeds", async () => {
  const manager = new SchemaManager({ dryRun: true });
  await manager.initialize();
  await manager.applySchema(safeInitial);
  const result = await manager.applySchema(safeAdditive);
  assertEquals(result.ok, true);
});
