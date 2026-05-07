/**
 * Identity-disc geometry (Disc-original feature #3d).
 *
 * Pure layout: given an outgoing-link count and an incoming-reference
 * count, returns SVG coordinates for the centered object and the
 * orbiting nodes. Outgoing links sweep the right semicircle; incoming
 * references sweep the left. Each cluster fills a 120° arc so the
 * orbital nodes never collapse into a vertical line — the disc reads
 * as a circular layout no matter how lopsided the link structure is.
 *
 * Lives next to the SvelteKit page so the layout is independently
 * testable; the page just calls `layoutDisc()` with its current
 * counts and renders SVG accordingly.
 */

export interface Point {
  x: number;
  y: number;
}

export interface OrbitalPoint extends Point {
  /** Angle in degrees, measured clockwise from straight up (12 o'clock). */
  angle: number;
}

export interface DiscLayout {
  center: Point;
  outgoing: OrbitalPoint[];
  incoming: OrbitalPoint[];
}

export interface LayoutOptions {
  cx: number;
  cy: number;
  radius: number;
  outgoingCount: number;
  incomingCount: number;
}

/** Right semicircle arc (in degrees, clockwise-from-up) for outgoing links. */
const OUTGOING_ARC: [number, number] = [30, 150];
/** Left semicircle arc for incoming references. */
const INCOMING_ARC: [number, number] = [210, 330];

function spread(count: number, [start, end]: [number, number]): number[] {
  if (count <= 0) return [];
  if (count === 1) return [(start + end) / 2];
  const step = (end - start) / (count - 1);
  return Array.from({ length: count }, (_, i) => start + i * step);
}

function pointAt(
  cx: number,
  cy: number,
  radius: number,
  angleDeg: number,
): OrbitalPoint {
  // SVG coordinates: y grows downward. Convert "clockwise from up" to
  // standard math by rotating -90° so 0° lands at the top.
  const rad = (angleDeg - 90) * Math.PI / 180;
  return {
    angle: angleDeg,
    x: cx + radius * Math.cos(rad),
    y: cy + radius * Math.sin(rad),
  };
}

export function layoutDisc(opts: LayoutOptions): DiscLayout {
  const { cx, cy, radius, outgoingCount, incomingCount } = opts;
  if (radius < 0) throw new Error("radius must be non-negative");
  if (outgoingCount < 0 || incomingCount < 0) {
    throw new Error("counts must be non-negative");
  }
  return {
    center: { x: cx, y: cy },
    outgoing: spread(outgoingCount, OUTGOING_ARC).map((a) => pointAt(cx, cy, radius, a)),
    incoming: spread(incomingCount, INCOMING_ARC).map((a) => pointAt(cx, cy, radius, a)),
  };
}
