/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Filter-compiler tests — pure function, no client.
 *
 * The compiler turns a Filter object (or combinator wrapping Filter
 * objects) into an EdgeQL filter clause + a bound-parameter map. The
 * generated `client.<type>.filter()` method delegates to it. These
 * tests pin the EdgeQL output character-for-character so the codegen
 * wiring stage doesn't have to re-derive expectations.
 */

import { assertEquals, assertThrows } from "@std/assert";
import type { TypeInfo } from "./filter-compiler.ts";
import { compileFilter } from "./filter-compiler.ts";
import { and, not, or } from "./query-builder.ts";

const merchantInfo: TypeInfo = {
  casts: {
    id: "<uuid>",
    email: "<str>"
  },
  links: {}
};

const paymentInfo: TypeInfo = {
  casts: {
    id: "<uuid>",
    amount: "<float64>",
    status: "<str>",
    created: "<datetime>"
  },
  links: {
    merchant: () => merchantInfo
  }
};

Deno.test("compileFilter — bare value compiles to equality with cast + bound parameter", () => {
  const result = compileFilter("Payment", { status: "paid" }, paymentInfo);
  assertEquals(result.clause, ".status = <str>$p0");
  assertEquals(result.variables, { p0: "paid" });
});

Deno.test("compileFilter — multiple top-level keys are implicit AND", () => {
  const result = compileFilter(
    "Payment",
    { status: "paid", amount: 100 },
    paymentInfo
  );
  assertEquals(
    result.clause,
    ".status = <str>$p0 and .amount = <float64>$p1"
  );
  assertEquals(result.variables, { p0: "paid", p1: 100 });
});

const channelInfo: TypeInfo = {
  casts: { id: "<uuid>", name: "<str>" },
  links: {},
  computed: {
    counts: { videos: "<int64>", posts: "<int64>" },
    storage: { bytes: "<int64>" }
  }
};

Deno.test("compileFilter — computed tuple field compiles to a dotted path with the field cast", () => {
  const result = compileFilter(
    "Channel",
    { counts: { videos: { gte: 5 } } },
    channelInfo
  );
  assertEquals(result.clause, "(.counts.videos >= <int64>$p0)");
  assertEquals(result.variables, { p0: 5 });
});

Deno.test("compileFilter — computed tuple coexists with scalar predicate", () => {
  const result = compileFilter(
    "Channel",
    { name: "x", storage: { bytes: { gt: 1000 } } },
    channelInfo
  );
  assertEquals(
    result.clause,
    ".name = <str>$p0 and (.storage.bytes > <int64>$p1)"
  );
  assertEquals(result.variables, { p0: "x", p1: 1000 });
});

Deno.test("compileFilter — undefined field value is skipped (no unbound placeholder)", () => {
  // Pattern: filter by id OR slug, where one is undefined. The undefined
  // field must NOT emit a $param (which would have no bound value and break
  // parameter binding: "supplies 1 parameters, but ... requires 2").
  const result = compileFilter(
    "Payment",
    { status: undefined, amount: 100 },
    paymentInfo
  );
  assertEquals(result.clause, ".amount = <float64>$p0");
  assertEquals(result.variables, { p0: 100 });
});

Deno.test("compileFilter — null is a real value, not skipped", () => {
  const result = compileFilter("Payment", { status: null }, paymentInfo);
  assertEquals(result.clause, ".status = <str>$p0");
  assertEquals(result.variables, { p0: null });
});

Deno.test("compileFilter — operator object emits one clause per op", () => {
  const result = compileFilter(
    "Payment",
    { amount: { gt: 100, lte: 1000 } },
    paymentInfo
  );
  assertEquals(
    result.clause,
    ".amount > <float64>$p0 and .amount <= <float64>$p1"
  );
  assertEquals(result.variables, { p0: 100, p1: 1000 });
});

Deno.test("compileFilter — every operator maps to the right EdgeQL op", () => {
  const cases: Array<[string, string]> = [
    ["eq", "="],
    ["ne", "!="],
    ["gt", ">"],
    ["gte", ">="],
    ["lt", "<"],
    ["lte", "<="],
    ["like", "like"],
    ["ilike", "ilike"]
  ];
  for (const [op, sql] of cases) {
    const result = compileFilter(
      "Payment",
      { amount: { [op]: 5 } },
      paymentInfo
    );
    assertEquals(result.clause, `.amount ${sql} <float64>$p0`);
  }
});

Deno.test("compileFilter — link recursion compiles to dotted path", () => {
  const result = compileFilter(
    "Payment",
    { merchant: { email: "a@b.c" } },
    paymentInfo
  );
  assertEquals(result.clause, "(.merchant.email = <str>$p0)");
  assertEquals(result.variables, { p0: "a@b.c" });
});

Deno.test("compileFilter — link recursion preserves outer scalar clauses", () => {
  const result = compileFilter(
    "Payment",
    {
      status: "paid",
      merchant: { email: "a@b.c" }
    },
    paymentInfo
  );
  assertEquals(
    result.clause,
    ".status = <str>$p0 and (.merchant.email = <str>$p1)"
  );
  assertEquals(result.variables, { p0: "paid", p1: "a@b.c" });
});

Deno.test("compileFilter — or() across two Filter objects emits OR", () => {
  const result = compileFilter(
    "Payment",
    or({ status: "paid" }, { status: "refunded" }),
    paymentInfo
  );
  assertEquals(
    result.clause,
    "(.status = <str>$p0) or (.status = <str>$p1)"
  );
  assertEquals(result.variables, { p0: "paid", p1: "refunded" });
});

Deno.test("compileFilter — and() makes implicit-AND across an object explicit when nested under or()", () => {
  const result = compileFilter(
    "Payment",
    or(
      and({ status: "paid", amount: { gt: 100 } }),
      { status: "refunded" }
    ),
    paymentInfo
  );
  assertEquals(
    result.clause,
    "((.status = <str>$p0 and .amount > <float64>$p1)) or (.status = <str>$p2)"
  );
});

Deno.test("compileFilter — not() wraps its argument", () => {
  const result = compileFilter(
    "Payment",
    not({ status: "paid" }),
    paymentInfo
  );
  assertEquals(result.clause, "not (.status = <str>$p0)");
  assertEquals(result.variables, { p0: "paid" });
});

Deno.test("compileFilter — unknown operator inside an op-shaped object throws with field context", () => {
  // The operator-object heuristic triggers when at least one key matches a
  // known op (`gt` here), then iterating finds the unknown key and throws.
  assertThrows(
    () =>
      compileFilter(
        "Payment",
        { amount: { gt: 5, weirdOp: 5 } } as Record<string, unknown>,
        paymentInfo
      ),
    Error,
    "Unknown operator \"weirdOp\""
  );
});

Deno.test("compileFilter — reserved keys (select/order_by/limit/offset) are skipped (Stage D adds them)", () => {
  const result = compileFilter(
    "Payment",
    {
      status: "paid",
      select: { id: true, amount: true },
      order_by: "-created",
      limit: 10,
      offset: 5
    } as Record<string, unknown>,
    paymentInfo
  );
  // Reserved keys do NOT appear in the filter clause
  assertEquals(result.clause, ".status = <str>$p0");
  assertEquals(result.variables, { p0: "paid" });
});

Deno.test("compileFilter — empty filter yields empty clause + no variables", () => {
  const result = compileFilter("Payment", {}, paymentInfo);
  assertEquals(result.clause, "");
  assertEquals(result.variables, {});
});

Deno.test("compileFilter — Date and bigint values pass through to variables verbatim", () => {
  const when = new Date("2026-01-01T00:00:00Z");
  const result = compileFilter(
    "Payment",
    { created: { gte: when } },
    paymentInfo
  );
  assertEquals(result.clause, ".created >= <datetime>$p0");
  assertEquals(result.variables, { p0: when });
});

// --- Stage D: reserved keys (select / order_by / limit / offset) ---

Deno.test("Stage D — selectShape: flat boolean shape compiles to { f1, f2 }", () => {
  const result = compileFilter(
    "Payment",
    { select: { id: true, amount: true } },
    paymentInfo
  );
  assertEquals(result.selectShape, "{ id, amount }");
});

Deno.test("Stage D — selectShape: false / undefined keys are excluded", () => {
  const result = compileFilter(
    "Payment",
    { select: { id: true, amount: false, status: true } },
    paymentInfo
  );
  assertEquals(result.selectShape, "{ id, status }");
});

Deno.test("Stage D — selectShape: nested link narrows sub-selection", () => {
  const result = compileFilter(
    "Payment",
    { select: { id: true, merchant: { email: true } } },
    paymentInfo
  );
  assertEquals(result.selectShape, "{ id, merchant: { email } }");
});

Deno.test("Stage D — selectShape: order_by on a link sub-shape orders that link", () => {
  const result = compileFilter(
    "Payment",
    { select: { id: true, merchant: { email: true, order_by: ["-name"] } } },
    paymentInfo
  );
  assertEquals(
    result.selectShape,
    "{ id, merchant: { email } order by .name desc }"
  );
});

Deno.test("Stage D — selectShape: order_by at the top level of select is ignored", () => {
  // Top-level result ordering uses the sibling `order_by`, not one buried in
  // the select shape — the latter has no parent link to attach to.
  const result = compileFilter(
    "Payment",
    { select: { id: true, order_by: ["-amount"] } },
    paymentInfo
  );
  assertEquals(result.selectShape, "{ id }");
  assertEquals(result.orderBy, null);
});

Deno.test("Stage D — selectShape: link `order_by` coexists with top-level order_by", () => {
  const result = compileFilter(
    "Payment",
    {
      order_by: "-amount",
      select: { merchant: { "*": true, order_by: "name" } }
    },
    paymentInfo
  );
  assertEquals(result.selectShape, "{ merchant: { * } order by .name }");
  assertEquals(result.orderBy, "order by .amount desc");
});

Deno.test("Stage D — selectShape: link as `true` pulls all fields (uses *)", () => {
  const result = compileFilter(
    "Payment",
    { select: { id: true, merchant: true } },
    paymentInfo
  );
  assertEquals(result.selectShape, "{ id, merchant: { * } }");
});

Deno.test("Stage D — selectShape: `*` splat key emits a bare splat", () => {
  const result = compileFilter(
    "Payment",
    { select: { "*": true } },
    paymentInfo
  );
  assertEquals(result.selectShape, "{ * }");
});

Deno.test("Stage D — selectShape: `*` splat combines with a nested link", () => {
  const result = compileFilter(
    "Payment",
    { select: { "*": true, merchant: true } },
    paymentInfo
  );
  assertEquals(result.selectShape, "{ *, merchant: { * } }");
});

Deno.test("Stage D — selectShape: `*` splat is honored inside a nested link", () => {
  const result = compileFilter(
    "Payment",
    { select: { id: true, merchant: { "*": true } } },
    paymentInfo
  );
  assertEquals(result.selectShape, "{ id, merchant: { * } }");
});

Deno.test("Stage D — selectShape: `*` splat set to false is skipped", () => {
  const result = compileFilter(
    "Payment",
    { select: { "*": false, id: true } },
    paymentInfo
  );
  assertEquals(result.selectShape, "{ id }");
});

Deno.test("Stage D — selectShape: throws on unknown link in nested select", () => {
  assertThrows(
    () =>
      compileFilter(
        "Payment",
        { select: { mystery: { foo: true } } } as Record<string, unknown>,
        paymentInfo
      ),
    Error,
    "select: unknown link \"mystery\""
  );
});

Deno.test("Stage D — selectShape rejects identifier-injection in keys", () => {
  assertThrows(
    () =>
      compileFilter(
        "Payment",
        { select: { "id; drop table": true } } as Record<string, unknown>,
        paymentInfo
      ),
    Error,
    "Invalid select key"
  );
});

Deno.test("Stage D — orderBy: bare string compiles to ascending order clause", () => {
  const result = compileFilter(
    "Payment",
    { order_by: "amount" },
    paymentInfo
  );
  assertEquals(result.orderBy, "order by .amount");
});

Deno.test("Stage D — orderBy: leading minus sign means desc", () => {
  const result = compileFilter(
    "Payment",
    { order_by: "-created" },
    paymentInfo
  );
  assertEquals(result.orderBy, "order by .created desc");
});

Deno.test("Stage D — orderBy: array of strings joins with `then`", () => {
  const result = compileFilter(
    "Payment",
    { order_by: ["-created", "amount"] },
    paymentInfo
  );
  assertEquals(result.orderBy, "order by .created desc then .amount");
});

Deno.test("Stage D — orderBy: random() compiles to a random ordering", () => {
  const result = compileFilter(
    "Payment",
    { order_by: "random()" },
    paymentInfo
  );
  assertEquals(result.orderBy, "order by random()");
});

Deno.test("Stage D — orderBy: random() composes with field ordering via `then`", () => {
  const result = compileFilter(
    "Payment",
    { order_by: ["-created", "random()"] },
    paymentInfo
  );
  assertEquals(result.orderBy, "order by .created desc then random()");
});

Deno.test("Stage D — orderBy rejects unknown zero-arg functions", () => {
  assertThrows(
    () =>
      compileFilter(
        "Payment",
        { order_by: "now()" } as Record<string, unknown>,
        paymentInfo
      ),
    Error,
    "Invalid order_by function"
  );
});

Deno.test("Stage D — orderBy rejects identifier-injection", () => {
  assertThrows(
    () =>
      compileFilter(
        "Payment",
        { order_by: "amount; drop table" } as Record<string, unknown>,
        paymentInfo
      ),
    Error,
    "Invalid order_by field"
  );
});

Deno.test("Stage D — limit/offset surface as numbers; non-integers throw", () => {
  const ok = compileFilter(
    "Payment",
    { limit: 10, offset: 20 },
    paymentInfo
  );
  assertEquals(ok.limit, 10);
  assertEquals(ok.offset, 20);

  assertThrows(
    () => compileFilter("Payment", { limit: 1.5 }, paymentInfo),
    Error,
    "limit must be a non-negative integer"
  );
  assertThrows(
    () => compileFilter("Payment", { offset: -1 }, paymentInfo),
    Error,
    "offset must be a non-negative integer"
  );
});

Deno.test("Stage D — reserved keys at top-level coexist with predicate keys", () => {
  const result = compileFilter(
    "Payment",
    {
      status: "paid",
      amount: { gte: 100 },
      select: { id: true, amount: true },
      order_by: "-created",
      limit: 5
    },
    paymentInfo
  );
  assertEquals(
    result.clause,
    ".status = <str>$p0 and .amount >= <float64>$p1"
  );
  assertEquals(result.selectShape, "{ id, amount }");
  assertEquals(result.orderBy, "order by .created desc");
  assertEquals(result.limit, 5);
  assertEquals(result.offset, null);
});

Deno.test("Stage D — reserved keys nested inside link object are NOT extracted (links carry no query options)", () => {
  // A `select` inside a link object is treated as part of the link's
  // own filter recursion — not as a top-level shape directive. That
  // would be ambiguous and isn't supported. The compiler should still
  // skip the key (no error), so the link recursion proceeds.
  const result = compileFilter(
    "Payment",
    {
      merchant: { email: "a@b.c", limit: 1 } as Record<string, unknown>
    },
    paymentInfo
  );
  // Top-level limit unset; the inner `limit: 1` is dropped silently.
  assertEquals(result.clause, "(.merchant.email = <str>$p0)");
  assertEquals(result.limit, null);
});

Deno.test("Stage D — combinator-only root has no reserved-key extraction", () => {
  // `or(...)` at root → no reserved keys reachable. selectShape, orderBy,
  // limit, offset all stay null.
  const result = compileFilter(
    "Payment",
    or({ status: "paid" }, { status: "refunded" }),
    paymentInfo
  );
  assertEquals(result.selectShape, null);
  assertEquals(result.orderBy, null);
  assertEquals(result.limit, null);
  assertEquals(result.offset, null);
});

// --- Stage E: in / not_in operators with array_unpack ---

Deno.test("Stage E — in operator emits array_unpack with widened array cast", () => {
  const result = compileFilter(
    "Payment",
    { status: { in: ["paid", "refunded"] } },
    paymentInfo
  );
  assertEquals(
    result.clause,
    ".status in array_unpack(<array<str>>$p0)"
  );
  assertEquals(result.variables, { p0: ["paid", "refunded"] });
});

Deno.test("Stage E — not_in operator emits `not in` with array_unpack", () => {
  const result = compileFilter(
    "Payment",
    { amount: { not_in: [0, -1] } },
    paymentInfo
  );
  assertEquals(
    result.clause,
    ".amount not in array_unpack(<array<float64>>$p0)"
  );
  assertEquals(result.variables, { p0: [0, -1] });
});

Deno.test("Stage E — in coexists with other ops on the same field", () => {
  const result = compileFilter(
    "Payment",
    { amount: { gte: 100, in: [100, 200, 300] } },
    paymentInfo
  );
  assertEquals(
    result.clause,
    ".amount >= <float64>$p0 and .amount in array_unpack(<array<float64>>$p1)"
  );
  assertEquals(result.variables, { p0: 100, p1: [100, 200, 300] });
});

// --- Stage F: `filter` on a link sub-shape (narrows the linked set) ---

/**
 * A sibling link key in the Filter object constrains the *parent*
 * (`.videos.isDraft = …` → EXISTS); `filter` inside that link's `select`
 * sub-shape constrains the *linked set* itself. These pin the distinction,
 * plus the parameter ordering that lets the server bind both in one query.
 */

const videoInfo: TypeInfo = {
  casts: {
    id: "<uuid>",
    title: "<str>",
    isDraft: "<int64>",
    created: "<datetime>"
  },
  links: {}
};

const ownerInfo: TypeInfo = {
  casts: { id: "<uuid>", name: "<str>" },
  links: {}
};

const chanInfo: TypeInfo = {
  casts: { id: "<uuid>", slug: "<str>" },
  links: {
    videos: () => videoInfo,
    owners: () => ownerInfo
  }
};

Deno.test("Stage F — select link `filter` narrows that link's set", () => {
  const result = compileFilter(
    "Channel",
    { select: { "*": true, videos: { "*": true, filter: { isDraft: 0n } } } },
    chanInfo
  );
  assertEquals(
    result.selectShape,
    "{ *, videos: { * } filter .isDraft = <int64>$p0 }"
  );
  assertEquals(result.variables, { p0: 0n });
  // The predicate stays inside the shape — it must not constrain the parent.
  assertEquals(result.clause, "");
});

Deno.test("Stage F — select link `filter` paths are relative to the target type", () => {
  // `.isDraft`, not `.videos.isDraft` — inside the sub-shape the scope is the
  // linked type, so the path prefix resets.
  const result = compileFilter(
    "Channel",
    { select: { videos: { title: true, filter: { isDraft: 0n } } } },
    chanInfo
  );
  assertEquals(
    result.selectShape,
    "{ videos: { title } filter .isDraft = <int64>$p0 }"
  );
});

Deno.test("Stage F — select link `filter` supports operators and implicit AND", () => {
  const result = compileFilter(
    "Channel",
    {
      select: {
        videos: {
          "*": true,
          filter: { isDraft: 0n, title: { ilike: "%hi%" } }
        }
      }
    },
    chanInfo
  );
  assertEquals(
    result.selectShape,
    "{ videos: { * } filter .isDraft = <int64>$p0 and .title ilike <str>$p1 }"
  );
  assertEquals(result.variables, { p0: 0n, p1: "%hi%" });
});

Deno.test("Stage F — select link `filter` accepts combinators", () => {
  const result = compileFilter(
    "Channel",
    {
      select: {
        videos: { "*": true, filter: or({ isDraft: 0n }, { title: "pinned" }) }
      }
    },
    chanInfo
  );
  assertEquals(
    result.selectShape,
    "{ videos: { * } filter (.isDraft = <int64>$p0) or (.title = <str>$p1) }"
  );
});

Deno.test("Stage F — select link `filter` precedes order_by in clause order", () => {
  const result = compileFilter(
    "Channel",
    {
      select: {
        videos: { "*": true, filter: { isDraft: 0n }, order_by: ["-created"] }
      }
    },
    chanInfo
  );
  assertEquals(
    result.selectShape,
    "{ videos: { * } filter .isDraft = <int64>$p0 order by .created desc }"
  );
});

Deno.test("Stage F — sub-shape `filter` params are bound before where-clause params", () => {
  // The server binds Object.values(variables) positionally and the compiler
  // numbers parameters as it meets them — shape first, then where. If these
  // two orders ever diverge, every parameter binds to the wrong slot.
  const result = compileFilter(
    "Channel",
    {
      slug: "music",
      select: { "*": true, videos: { "*": true, filter: { isDraft: 0n } } }
    },
    chanInfo
  );
  assertEquals(
    result.selectShape,
    "{ *, videos: { * } filter .isDraft = <int64>$p0 }"
  );
  assertEquals(result.clause, ".slug = <str>$p1");
  assertEquals(Object.keys(result.variables), ["p0", "p1"]);
});

Deno.test("Stage F — sub-shape `filter` coexists with a sibling link predicate", () => {
  // `videos:` at the root still filters Channels (EXISTS); the one in `select`
  // filters the returned videos. Both can appear in the same query.
  const result = compileFilter(
    "Channel",
    {
      videos: { isDraft: 0n },
      select: { "*": true, videos: { "*": true, filter: { isDraft: 0n } } }
    },
    chanInfo
  );
  assertEquals(
    result.selectShape,
    "{ *, videos: { * } filter .isDraft = <int64>$p0 }"
  );
  assertEquals(result.clause, "(.videos.isDraft = <int64>$p1)");
  assertEquals(Object.keys(result.variables), ["p0", "p1"]);
});

Deno.test("Stage F — link sub-shape with only a `filter` falls back to { * }", () => {
  const result = compileFilter(
    "Channel",
    { select: { videos: { filter: { isDraft: 0n } } } },
    chanInfo
  );
  assertEquals(
    result.selectShape,
    "{ videos: { * } filter .isDraft = <int64>$p0 }"
  );
});

Deno.test("Stage F — nested links each carry their own `filter`", () => {
  const nestedInfo: TypeInfo = {
    casts: { id: "<uuid>", slug: "<str>" },
    links: { videos: () => ({ ...videoInfo, links: { owners: () => ownerInfo } }) }
  };
  const result = compileFilter(
    "Channel",
    {
      select: {
        videos: {
          "*": true,
          filter: { isDraft: 0n },
          owners: { name: true, filter: { name: "ada" } }
        }
      }
    },
    nestedInfo
  );
  assertEquals(
    result.selectShape,
    "{ videos: { *, owners: { name } filter .name = <str>$p0 } " +
      "filter .isDraft = <int64>$p1 }"
  );
  assertEquals(Object.keys(result.variables), ["p0", "p1"]);
});

Deno.test("Stage F — `filter` at the top level of select is ignored", () => {
  // Root narrowing uses the Filter object's own fields; a `filter` buried in
  // the select shape has no parent link to attach to.
  const result = compileFilter(
    "Channel",
    { select: { "*": true, filter: { slug: "music" } } },
    chanInfo
  );
  assertEquals(result.selectShape, "{ * }");
  assertEquals(result.clause, "");
  assertEquals(result.variables, {});
});
