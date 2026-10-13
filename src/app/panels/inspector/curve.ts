// Editing a curve (engine.md 4.3: at least 2 points, x strictly increasing, x and y in 0..1) as pure functions:
// every edit returns a new list that is a valid curve, and the same list when it changes nothing. The picture is
// sampled with evalCurve, the one definition of a curve (engine.md 4.9). No DOM and no React.

import { evalCurve, type CurvePoint } from '../../../core/api.ts';

/** The least distance in x between two points: two points never share an x. */
export const CURVE_GAP = 0.001;
export const CURVE_MAX_POINTS = 32;
/** What Ctrl snaps a dragged point to. */
export const CURVE_SNAP = 1 / 16;

/** Four decimals: finer than a pixel of the editor, and a document that stays readable. */
const round = (value: number): number => Number(value.toFixed(4));
const unit = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

/** The x a point may take: between its neighbours and on neither. */
export function xLimits(points: readonly CurvePoint[], index: number): { readonly lo: number; readonly hi: number } {
  const lo = index > 0 ? points[index - 1]!.x + CURVE_GAP : 0;
  const hi = index < points.length - 1 ? points[index + 1]!.x - CURVE_GAP : 1;
  return { lo: round(lo), hi: round(hi) };
}

/**
 * A new point at `x`. Without `y` it lies on the curve, which then keeps its shape as far as the interpolation
 * allows. Null when the curve is full or has no room at that x.
 */
export function addPoint(points: readonly CurvePoint[], x: number, y?: number): { readonly points: CurvePoint[]; readonly index: number } | null {
  if (points.length >= CURVE_MAX_POINTS) return null;
  const at = unit(x);
  let index = points.findIndex((point) => point.x > at);
  if (index < 0) index = points.length;
  const lo = index > 0 ? points[index - 1]!.x + CURVE_GAP : 0;
  const hi = index < points.length ? points[index]!.x - CURVE_GAP : 1;
  if (hi < lo) return null;
  const px = round(Math.min(hi, Math.max(lo, at)));
  const point = { x: px, y: round(unit(y ?? evalCurve(points, px))) };
  return { points: [...points.slice(0, index), point, ...points.slice(index)], index };
}

/** The point at `index` moved to (x, y), held between its neighbours. `snap` rounds both to that grid first. */
export function movePoint(points: readonly CurvePoint[], index: number, x: number, y: number, snap: number = 0): readonly CurvePoint[] {
  const current = points[index];
  if (!current) return points;
  const { lo, hi } = xLimits(points, index);
  const grid = (value: number): number => (snap > 0 ? Math.round(value / snap) * snap : value);
  // Neighbours closer than two gaps leave no x to move to: the point keeps its own.
  const nx = hi < lo ? current.x : round(Math.min(hi, Math.max(lo, unit(grid(x)))));
  const ny = round(unit(grid(y)));
  if (nx === current.x && ny === current.y) return points;
  return points.map((point, i) => (i === index ? { x: nx, y: ny } : point));
}

/** Without the point at `index`. A curve keeps two points. */
export function removePoint(points: readonly CurvePoint[], index: number): readonly CurvePoint[] {
  if (points.length <= 2 || index < 0 || index >= points.length) return points;
  return points.filter((_, i) => i !== index);
}

/** The middle of the widest gap between two points: where a point added by a button goes. */
export function widestGap(points: readonly CurvePoint[]): number {
  let best = 0.5;
  let width = -1;
  for (let i = 0; i + 1 < points.length; i++) {
    const gap = points[i + 1]!.x - points[i]!.x;
    if (gap > width) {
      width = gap;
      best = (points[i]!.x + points[i + 1]!.x) / 2;
    }
  }
  return round(best);
}

/**
 * The curve as `n` samples of evalCurve across 0..1, with a sample at every point as well, so that the picture
 * passes through the points exactly.
 */
export function sampleCurve(points: readonly CurvePoint[], n: number = 129): CurvePoint[] {
  const count = Math.min(1025, Math.max(2, Math.floor(n)));
  const xs = new Set<number>();
  for (let i = 0; i < count; i++) xs.add(i / (count - 1));
  for (const point of points) xs.add(unit(point.x));
  return [...xs].sort((a, b) => a - b).map((x) => ({ x, y: evalCurve(points, x) }));
}

/** The picture of the curve as the path of an SVG `width` by `height`: x to the right, y up. */
export function curvePath(points: readonly CurvePoint[], width: number, height: number, n?: number): string {
  const text = (value: number): string => String(Number(value.toFixed(2)));
  return sampleCurve(points, n).map((sample, i) => `${i === 0 ? 'M' : 'L'}${text(sample.x * width)} ${text((1 - sample.y) * height)}`).join('');
}

/** The point within `radius` pixels of (x, y), the nearest when several are; −1 when none is. x and y are in 0..1, y up. */
export function hitPoint(points: readonly CurvePoint[], x: number, y: number, width: number, height: number, radius: number): number {
  let best = -1;
  let distance = radius * radius;
  points.forEach((point, index) => {
    const dx = (point.x - x) * width;
    const dy = (point.y - y) * height;
    const d = dx * dx + dy * dy;
    if (d <= distance) {
      distance = d;
      best = index;
    }
  });
  return best;
}

export interface CurvePreset {
  readonly id: string;
  readonly label: string;
  readonly points: readonly CurvePoint[];
}

/** Curves to start from: what each does to a terrain's profile is in its name. */
export const CURVE_PRESETS: readonly CurvePreset[] = [
  { id: 'linear', label: 'Linear', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
  { id: 'ease-in', label: 'Ease in', points: [{ x: 0, y: 0 }, { x: 0.5, y: 0.2 }, { x: 1, y: 1 }] },
  { id: 'ease-out', label: 'Ease out', points: [{ x: 0, y: 0 }, { x: 0.5, y: 0.8 }, { x: 1, y: 1 }] },
  { id: 's-curve', label: 'S-curve', points: [{ x: 0, y: 0 }, { x: 0.25, y: 0.08 }, { x: 0.75, y: 0.92 }, { x: 1, y: 1 }] },
  { id: 'flat-valleys', label: 'Flat valleys', points: [{ x: 0, y: 0 }, { x: 0.35, y: 0.03 }, { x: 0.7, y: 0.5 }, { x: 1, y: 1 }] },
  { id: 'flat-tops', label: 'Flat tops', points: [{ x: 0, y: 0 }, { x: 0.3, y: 0.5 }, { x: 0.65, y: 0.97 }, { x: 1, y: 1 }] },
  { id: 'plateau', label: 'Plateau', points: [{ x: 0, y: 0 }, { x: 0.35, y: 0.55 }, { x: 0.65, y: 0.6 }, { x: 1, y: 1 }] },
  {
    id: 'steps',
    label: 'Steps',
    points: [{ x: 0, y: 0 }, { x: 0.22, y: 0.02 }, { x: 0.28, y: 0.32 }, { x: 0.47, y: 0.34 }, { x: 0.53, y: 0.66 }, { x: 0.72, y: 0.68 }, { x: 0.78, y: 0.98 }, { x: 1, y: 1 }],
  },
  { id: 'inverted', label: 'Inverted', points: [{ x: 0, y: 1 }, { x: 1, y: 0 }] },
];
