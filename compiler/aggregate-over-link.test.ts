/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Aggregates over link-set paths.
 *
 * A set-aggregate (`count`/`sum`/…) applied to a link-set must lower to a
 * correlated scalar subquery — a forward multi-link / backlink is a *set*
 * with no scalar column to wrap. Regression coverage for the three shapes a
 * multi-link / backlink can take, plus the `select <enum>` guard.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";

const SDL = `
module default {
  scalar type Status extending enum<"ACTIVE", "BANNED">;

  type Tag {
    required label -> str;
  }

  type Author {
    required name -> str;
    multi tags -> Tag;
  }

  type Post {
    required author -> Author;
    required size -> int64;
  }
}
`;

function schema() {
  const mgr = new SchemaManager({ dryRun: true });
  const parsed = mgr.parseSDL(SDL, { validate: false });
  if (!parsed.ok)
    throw parsed.error;
  return mgr.modulesToSchema(parsed.value);
}

function compile(edgeql: string): string {
  const result = new EdgeQLCompiler(schema()).compile(
    new EdgeQLParser(edgeql).parse()
  );
  if (!result.ok)
    throw result.error;
  return new SQLCodeGenerator().generate(result.value).replace(/\s+/g, " ");
}

Deno.test("aggregate - count(forward multi-link) is a junction-table subquery", () => {
  const sql = compile(`select Author { c := count(.tags) }`);
  // Must NOT emit a bare column reference (`COUNT(tags)`).
  assertEquals(/COUNT\(tags\)/i.test(sql), false, sql);
  assertStringIncludes(sql, `SELECT COUNT(*) FROM "author_tags"`);
  assertStringIncludes(sql, `"author_tags"."source_id" =`);
});

Deno.test("aggregate - count(backlink) counts target rows by FK", () => {
  const sql = compile(`select Author { c := count(.<author[is Post]) }`);
  // The old behavior wrapped a jsonb_agg subquery in COUNT() → always 1.
  assertEquals(/jsonb_agg/i.test(sql), false, sql);
  assertStringIncludes(sql, `SELECT COUNT(*) FROM "post"`);
  assertStringIncludes(sql, `"post"."author_id" =`);
});

Deno.test("aggregate - sum(backlink.prop) sums the target column, coalesced to 0", () => {
  const sql = compile(`select Author { s := sum(.<author[is Post].size) }`);
  assertStringIncludes(sql, `COALESCE(SUM("post"."size"), 0)`);
  assertStringIncludes(sql, `FROM "post" WHERE "post"."author_id" =`);
});

Deno.test("aggregate - count over a scalar property is unaffected (generic mapping)", () => {
  // `count(.size)` on Post counts the row's own scalar — must stay a plain
  // COUNT(column), not a correlated subquery.
  const sql = compile(`select Post { c := count(.size) }`);
  assertStringIncludes(sql, "COUNT(post_1.size)");
  assertEquals(/SELECT COUNT\(\*\) FROM/.test(sql), false, sql);
});

Deno.test("select <enum> enumerates its members, not a phantom relation", () => {
  const sql = compile(`select Status`);
  // No `FROM <enum_table>` — values come from the PG enum type itself.
  assertEquals(/FROM status/i.test(sql), false, sql);
  assertStringIncludes(sql, "unnest(enum_range(NULL::disc_enum_status))");
});

// ---------------------------------------------------------------------------
// Computed backlink links: `x := .<fwd[is T]` is a real selectable/countable
// reverse link, resolving through the forward link's junction (swapped) or FK.
// ---------------------------------------------------------------------------

const BACKLINK_SDL = `
module default {
  type Customer { required name -> str; multi subscriptions -> Channel; }
  type Channel {
    required title -> str;
    subscribers := .<subscriptions[is Customer];   # junction-based reverse
    videos := .<channel[is Video];                 # FK-based reverse
  }
  type Video { required channel -> Channel; required title -> str; }
}`;

function blSchema() {
  const mgr = new SchemaManager({ dryRun: true });
  const parsed = mgr.parseSDL(BACKLINK_SDL, { validate: false });
  if (!parsed.ok)
    throw parsed.error;
  return mgr.modulesToSchema(parsed.value);
}

function blCompile(edgeql: string): string {
  const r = new EdgeQLCompiler(blSchema()).compile(new EdgeQLParser(edgeql).parse());
  if (!r.ok)
    throw r.error;
  return new SQLCodeGenerator().generate(r.value).replace(/\s+/g, " ");
}

Deno.test("computed backlink - classified as a multi link, not a property", () => {
  const schema = blSchema();
  const channel = schema.types.get("Channel") ?? schema.types.get("default::Channel");
  const subs = channel!.links.get("subscribers");
  assertEquals(subs?.multi, true);
  assertEquals(subs?.computed, true);
  // junction reused with swapped columns
  assertEquals(subs?.junctionTable, "customer_subscriptions");
  assertEquals(subs?.junctionSourceColumn, "target_id");
  assertEquals(subs?.junctionTargetColumn, "source_id");
  // FK-based reverse keeps the backlink name
  assertEquals(channel!.links.get("videos")?.backlink, "channel");
});

Deno.test("computed backlink - selectable as a shape (junction-based)", () => {
  const sql = blCompile(`select Channel { subscribers: { name } }`);
  assertStringIncludes(sql, "customer_subscriptions");
  assertStringIncludes(sql, "customer_subscriptions.target_id = channel_1.id");
  assertStringIncludes(sql, "jsonb_agg");
});

Deno.test("computed backlink - selectable as a shape (FK-based)", () => {
  const sql = blCompile(`select Channel { videos: { title } }`);
  assertStringIncludes(sql, "FROM video");
  assertStringIncludes(sql, "video.channel_id = channel_1.id");
});

Deno.test("computed backlink - countable via the short name", () => {
  const j = blCompile(`select Channel { c := count(.subscribers) }`);
  assertStringIncludes(j, `SELECT COUNT(*) FROM "customer_subscriptions"`);
  assertStringIncludes(j, `"customer_subscriptions"."target_id" = "channel_1"."id"`);
  const f = blCompile(`select Channel { c := count(.videos) }`);
  assertStringIncludes(f, `SELECT COUNT(*) FROM "video"`);
  assertStringIncludes(f, `"video"."channel_id" = "channel_1"."id"`);
});
