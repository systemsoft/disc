/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

// deno-lint-ignore-file no-explicit-any
import { assertEquals, assertStringIncludes } from "@std/assert";

import { SDLParser } from "../schema/parser.ts";
import { SchemaValidator } from "../schema/validator.ts";
import { MigrationEngine } from "./engine.ts";
import { SchemaManager } from "./schema-manager.ts";

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
    migrationsDir: "",
    schemaFile: "",
    databaseUrl: "",
    dryRun: true,
    autoApprove: true,
    backupBeforeMigration: false,
    rollbackOnError: false
  });
  const initialModules = validator.convertToModules(
    new SDLParser(initialSdl).parse()
  );
  const nextModules = validator.convertToModules(
    new SDLParser(nextSdl).parse()
  );
  const planResult = engine.planMigration(initialModules, nextModules);
  if (!planResult.ok) {
    throw new Error(planResult.error.message);
  }
  return { engine, plan: planResult.value };
}

// ── classifyUnsafeOperations ───────────────────────────────────────────

Deno.test("classifyUnsafeOperations - additive migration is safe", () => {
  const { engine, plan } = planUnsafeDelta(safeInitial, safeAdditive);
  const flagged = engine.classifyUnsafeOperations(plan);
  assertEquals(flagged.length, 0);
  // Each safe op is annotated on the operation itself.
  for (const op of plan.migrations[0].operations) {
    if (op.kind !== "AlterType") {
      continue;
    }
    assertEquals(op.classification, "safe");
  }
});

// gh/geldata#1840: schema changes with multiple plausible interpretations
// (rename-vs-drop-add, type narrowing without an explicit cast,
// link-cardinality flips) are flagged as `ambiguous` rather than silently
// applied. Disc's classifier surfaces them via the unsafe-gate so a
// non-interactive caller can refuse / re-prompt.

Deno.test("Gel #1840: ChangeType without explicit cast is ambiguous", () => {
  const before = `
    module default {
      type User {
        required age: int32;
      };
    }
  `;
  const after = `
    module default {
      type User {
        required age: int64;
      };
    }
  `;
  const { engine, plan } = planUnsafeDelta(before, after);
  const flagged = engine.classifyUnsafeOperations(plan);
  const ambiguous = flagged.filter(f => f.classification === "ambiguous");
  assertEquals(
    ambiguous.length >= 1,
    true,
    "expected at least one ambiguous flag"
  );
  assertStringIncludes(ambiguous[0].operation, "ChangeType");
  assertStringIncludes(ambiguous[0].reason, "explicit cast");
});

Deno.test("Gel #1840: optional → required flip is ambiguous", () => {
  const before = `
    module default {
      type User {
        bio: str;
      };
    }
  `;
  const after = `
    module default {
      type User {
        required bio: str;
      };
    }
  `;
  const { engine, plan } = planUnsafeDelta(before, after);
  const flagged = engine.classifyUnsafeOperations(plan);
  const ambiguous = flagged.filter(f => f.classification === "ambiguous");
  assertEquals(ambiguous.length, 1);
  assertStringIncludes(ambiguous[0].operation, "ChangeRequired");
  assertStringIncludes(ambiguous[0].reason, "NULL");
});

Deno.test("Gel #1840: ambiguous ops gate applySchema like unsafe", async () => {
  const manager = new SchemaManager({ dryRun: true });
  await manager.initialize();
  await manager.applySchema(`
    module default {
      type User {
        required age: int32;
      };
    }
  `);
  // Switch to non-dry-run so the gate applies.
  const liveManager = new SchemaManager({ dryRun: false } as any);
  (liveManager as any).engine = (manager as any).engine;
  (liveManager as any).currentModules = (manager as any).currentModules;
  (liveManager as any).initialized = true;
  (liveManager as any).dryRun = false;

  const result = await liveManager.applySchema(`
    module default {
      type User {
        required age: int64;
      };
    }
  `);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "ambiguous");
    assertStringIncludes(result.error.message, "--unsafe");
  }
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
  const drops = unsafe.filter(u => u.operation.startsWith("DropType"));
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
    allowUnsafe: true
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
