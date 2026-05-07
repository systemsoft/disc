/**
 * Pins SchemaManager.previewMigrationOps() — the drift-detection path
 * that `disc migrate --status` uses to surface "in sync" vs "N pending
 * operation(s)" to operators (gh/geldata#8899).
 */

import { assert, assertEquals } from "@std/assert";
import { SchemaManager } from "./schema-manager.ts";

const SDL_INITIAL = `
type User {
  required name: str;
  required email: str;
}
`;

const SDL_DRIFTED = `
type User {
  required name: str;
  required email: str;
  age: int64;
}
`;

const SDL_INVALID = `type User { this is not valid SDL syntax`;

Deno.test("previewMigrationOps — empty SDL diff returns 0 ops (in sync)", async () => {
  const mgr = new SchemaManager({ dryRun: true });
  await mgr.initialize();
  // Apply the initial SDL so subsequent preview against the same
  // SDL has nothing to do.
  const apply = await mgr.applySchema(SDL_INITIAL);
  assert(apply.ok);
  const preview = mgr.previewMigrationOps(SDL_INITIAL);
  assert(preview.ok, `preview should succeed: ${!preview.ok && preview.error}`);
  assertEquals(preview.value.length, 0);
});

Deno.test("previewMigrationOps — SDL drift surfaces the pending ops", async () => {
  const mgr = new SchemaManager({ dryRun: true });
  await mgr.initialize();
  const apply = await mgr.applySchema(SDL_INITIAL);
  assert(apply.ok);
  const preview = mgr.previewMigrationOps(SDL_DRIFTED);
  assert(preview.ok);
  assert(preview.value.length > 0, "expected pending ops for drifted SDL");
  // Adding a property surfaces an AddProperty op (or AlterType depending
  // on diff granularity). Either way every op carries a kind string we
  // can render at the CLI.
  for (const op of preview.value) {
    assert(typeof op.kind === "string" && op.kind.length > 0);
  }
});

Deno.test("previewMigrationOps — initial schema (no prior apply) lists CREATE ops", async () => {
  const mgr = new SchemaManager({ dryRun: true });
  await mgr.initialize();
  // No applySchema beforehand → previewing against an empty applied
  // state should surface every type as a CreateType op.
  const preview = mgr.previewMigrationOps(SDL_INITIAL);
  assert(preview.ok);
  assert(preview.value.length > 0);
  assert(
    preview.value.some((op) => op.kind === "CreateType"),
    `expected CreateType in initial migration ops, got: ${preview.value.map((o) => o.kind).join(", ")}`,
  );
});

Deno.test("previewMigrationOps — invalid SDL returns parse error", async () => {
  const mgr = new SchemaManager({ dryRun: true });
  await mgr.initialize();
  const preview = mgr.previewMigrationOps(SDL_INVALID);
  assertEquals(preview.ok, false, "invalid SDL should fail to preview");
});
