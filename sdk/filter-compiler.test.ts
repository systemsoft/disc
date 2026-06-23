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
