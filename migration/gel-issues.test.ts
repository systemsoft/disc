/**
 * Regression pins and gap markers for upstream Gel migration issues.
 *
 * Each test maps to a specific gh/geldata issue from `docs/future-triage.md`.
 * The intent is to (a) pin behavior Disc already handles correctly and
 * (b) document explicit gaps so future schema-evolution work has clear
 * starting points.
 *
 * Cross-reference table:
 *   gh/geldata#1147 — abstract type extraction with shared properties (closed-completed upstream 2020)
 *   gh/geldata#4343 — DROP CONSTRAINT (closed-not_planned upstream)
 *   gh/geldata#8517 — drop enum with dependents (open upstream)
 */

import { assertEquals } from "@std/assert";
import { SDLParser } from "../schema/parser.ts";
import { SDLConverter } from "../schema/converter.ts";
import { SchemaDiffer } from "./differ.ts";
import * as Types from "./types.ts";

function diff(beforeSrc: string, afterSrc: string): Types.MigrationOperation[] {
  const conv = new SDLConverter();
  const before = conv.convertToModules(new SDLParser(beforeSrc).parse());
  const after = conv.convertToModules(new SDLParser(afterSrc).parse());
  return new SchemaDiffer().diff(before, after);
}

// ---------------------------------------------------------------------------
// gh/geldata#1147: abstract type extraction triggered InternalServerError
// when re-applied. Disc must produce a non-empty diff once and an empty
// diff on the second pass (idempotent).
// ---------------------------------------------------------------------------
Deno.test("Gel #1147: abstract extraction is idempotent (no ISE on rerun)", () => {
  const before = `
    module default {
      type User {
        required nickname: str;
        required created_at: datetime {
          default := datetime_current();
          readonly := true;
        };
        edited_at: datetime;
      }
      type Article {
        author: User;
      }
    }
  `;

  const after = `
    module default {
      abstract type Editable {
        required created_at: datetime {
          default := datetime_current();
          readonly := true;
        };
        edited_at: datetime;
      }
      type User extending Editable {
        required nickname: str;
      }
      type Article extending Editable {
        author: User;
      }
    }
  `;

  // First pass: produces a real diff (creates Editable, drops the local
  // properties on User since they now come from the parent).
  const ops1 = diff(before, after);
  const kinds1 = ops1.map((op) => op.kind);
  assertEquals(
    kinds1.includes("CreateType"),
    true,
    "first pass should create the abstract Editable type",
  );

  // Second pass over the *same* schema state: empty diff. This is the
  // bug from #1147 — a non-empty rerun blows up with ISE upstream.
  const ops2 = diff(after, after);
  assertEquals(
    ops2.length,
    0,
    "rerunning the diff over an unchanged schema must be idempotent",
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#4343: closed-not_planned upstream. Disc supports property-level
// `DROP CONSTRAINT` (the most common case) — this pins that path. Type-level
// `constraint expression on (...)` removal is currently a no-op in the
// differ; see `Disc-vs-Gel divergence` in the continuity ledger.
// ---------------------------------------------------------------------------
Deno.test("Gel #4343: property-level DROP CONSTRAINT produces an AlterProperty op", () => {
  const before = `
    module default {
      type User {
        required email: str {
          constraint exclusive;
        };
      }
    }
  `;

  const after = `
    module default {
      type User {
        required email: str;
      }
    }
  `;

  const ops = diff(before, after);
  assertEquals(ops.length, 1);
  const alter = ops[0] as Types.AlterTypeOperation;
  assertEquals(alter.kind, "AlterType");
  assertEquals(alter.typeName, "User");
  const propOp = alter.operations[0] as Types.AlterPropertyOperation;
  assertEquals(propOp.kind, "AlterProperty");
  assertEquals(propOp.propertyName, "email");
  const drop = propOp.changes.find((c) => c.kind === "DropConstraint");
  assertEquals(drop?.oldValue, "exclusive");
});

// ---------------------------------------------------------------------------
// gh/geldata#8517: cannot drop/alter enum because of dependent objects.
// Disc currently does not diff scalar/enum declarations at all, so a value
// addition is invisible to the differ. This is a *known gap* — pinned here
// as a no-op so future work that lands enum-level diffing will trip this
// test and have to update it intentionally.
// ---------------------------------------------------------------------------
Deno.test("Gel #8517: scalar/enum value changes are currently not diffed (known gap)", () => {
  const before = `
    module default {
      scalar type CurrentRoles extending enum<admin, user>;
      type CurrentUser {
        required role: CurrentRoles;
      }
    }
  `;

  const after = `
    module default {
      scalar type CurrentRoles extending enum<admin, user, guest>;
      type CurrentUser {
        required role: CurrentRoles;
      }
    }
  `;

  const ops = diff(before, after);
  // When enum-level diffing lands, this assertion has to be updated.
  // Until then, document the gap explicitly.
  assertEquals(
    ops.length,
    0,
    "enum value changes are not yet detected by SchemaDiffer (gh/geldata#8517 follow-up)",
  );
});
