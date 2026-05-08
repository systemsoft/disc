/**
 * Tests for the identity-disc geometry (#3d).
 *
 * Lives in `tests/` so it runs under the project's deno test slice
 * (the ui/-side Vitest config is broken; same dance as
 * `tests/ui-query-builder-synth.test.ts`).
 */

import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { layoutDisc } from "../ui/src/lib/identity-disc-layout.ts";

const CX = 300;
const CY = 300;
const R = 200;

function near(a: number, b: number, msg?: string): void {
  assertAlmostEquals(a, b, 1e-6, msg);
}

Deno.test("zero counts → empty orbits, only center", () => {
  const layout = layoutDisc({
    cx: CX,
    cy: CY,
    radius: R,
    outgoingCount: 0,
    incomingCount: 0
  });
  assertEquals(layout.center, { x: CX, y: CY });
  assertEquals(layout.outgoing, []);
  assertEquals(layout.incoming, []);
});

Deno.test("single outgoing sits straight right (3 o'clock)", () => {
  const layout = layoutDisc({
    cx: CX,
    cy: CY,
    radius: R,
    outgoingCount: 1,
    incomingCount: 0
  });
  assertEquals(layout.outgoing.length, 1);
  near(layout.outgoing[0].angle, 90);
  near(layout.outgoing[0].x, CX + R);
  near(layout.outgoing[0].y, CY);
});

Deno.test("single incoming sits straight left (9 o'clock)", () => {
  const layout = layoutDisc({
    cx: CX,
    cy: CY,
    radius: R,
    outgoingCount: 0,
    incomingCount: 1
  });
  assertEquals(layout.incoming.length, 1);
  near(layout.incoming[0].angle, 270);
  near(layout.incoming[0].x, CX - R);
  near(layout.incoming[0].y, CY);
});

Deno.test("two outgoing fill the arc endpoints (30° and 150°)", () => {
  const layout = layoutDisc({
    cx: CX,
    cy: CY,
    radius: R,
    outgoingCount: 2,
    incomingCount: 0
  });
  assertEquals(layout.outgoing.map(p => p.angle), [30, 150]);
  // 30° is upper-right; 150° is lower-right. Both must be on the right semicircle.
  for (const p of layout.outgoing) {
    assert(p.x > CX, `outgoing at ${p.angle}° must be on the right side`);
  }
});

Deno.test("two incoming fill the arc endpoints (210° and 330°)", () => {
  const layout = layoutDisc({
    cx: CX,
    cy: CY,
    radius: R,
    outgoingCount: 0,
    incomingCount: 2
  });
  assertEquals(layout.incoming.map(p => p.angle), [210, 330]);
  for (const p of layout.incoming) {
    assert(p.x < CX, `incoming at ${p.angle}° must be on the left side`);
  }
});

Deno.test("four outgoing distribute evenly across the 120° arc", () => {
  const layout = layoutDisc({
    cx: CX,
    cy: CY,
    radius: R,
    outgoingCount: 4,
    incomingCount: 0
  });
  assertEquals(layout.outgoing.map(p => p.angle), [30, 70, 110, 150]);
});

Deno.test("orbital points lie on the radius circle", () => {
  const layout = layoutDisc({
    cx: CX,
    cy: CY,
    radius: R,
    outgoingCount: 5,
    incomingCount: 3
  });
  for (const p of [...layout.outgoing, ...layout.incoming]) {
    const dx = p.x - CX;
    const dy = p.y - CY;
    near(Math.sqrt(dx * dx + dy * dy), R, `point at ${p.angle}° not on circle`);
  }
});

Deno.test("outgoing and incoming halves don't overlap", () => {
  // With 6 of each, the spread is dense — verify nothing crosses to the wrong side.
  const layout = layoutDisc({
    cx: CX,
    cy: CY,
    radius: R,
    outgoingCount: 6,
    incomingCount: 6
  });
  for (const p of layout.outgoing) {
    assert(p.x >= CX - 1e-6, `outgoing leaked left at ${p.angle}°`);
  }
  for (const p of layout.incoming) {
    assert(p.x <= CX + 1e-6, `incoming leaked right at ${p.angle}°`);
  }
});

Deno.test("rejects negative radius / counts", () => {
  assertThrows(() => layoutDisc({ cx: 0, cy: 0, radius: -1, outgoingCount: 0, incomingCount: 0 }));
  assertThrows(() =>
    layoutDisc({
      cx: 0,
      cy: 0,
      radius: 100,
      outgoingCount: -1,
      incomingCount: 0
    })
  );
  assertThrows(() =>
    layoutDisc({
      cx: 0,
      cy: 0,
      radius: 100,
      outgoingCount: 0,
      incomingCount: -1
    })
  );
});
