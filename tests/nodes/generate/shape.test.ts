// tests/nodes/generate/shape.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, diff, expectClose, expectMask, expectStats, fieldOf, renderNode, stats, type FieldData } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/generate/shape.ts';

conformance(def);

type Vec2 = readonly [number, number];
const saturate = (x: number): number => Math.min(Math.max(x, 0), 1);

/** Distance to an ellipse, negative inside, by search: the nearest of 720 points of the quadrant, then bisection around it. */
function ellipseDistance(p: Vec2, [a, b]: Vec2): number {
  const x = Math.abs(p[0]), y = Math.abs(p[1]);
  const square = (angle: number): number => (a * Math.cos(angle) - x) ** 2 + (b * Math.sin(angle) - y) ** 2;
  const step = Math.PI / 2 / 720;
  let best = 0;
  for (let k = 1; k <= 720; k++) if (square(k * step) < square(best * step)) best = k;
  let lo = Math.max(best - 1, 0) * step, hi = Math.min(best + 1, 720) * step;
  for (let round = 0; round < 60; round++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    if (square(m1) < square(m2)) hi = m2; else lo = m1;
  }
  const d = Math.sqrt(square((lo + hi) / 2));
  return (x / a) ** 2 + (y / b) ** 2 < 1 ? -d : d;
}

function rectangleDistance(p: Vec2, [a, b]: Vec2): number {
  const qx = Math.abs(p[0]) - a, qy = Math.abs(p[1]) - b;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
}

/** A regular polygon stretched to the extent, its first corner straight up (towards row 0), the others clockwise in the top view. */
function polygonDistance(p: Vec2, [a, b]: Vec2, sides: number): number {
  const corner = (k: number): Vec2 => {
    const angle = -Math.PI / 2 + (2 * Math.PI * k) / sides;
    return [a * Math.cos(angle), b * Math.sin(angle)];
  };
  let nearest = Infinity, inside = true;
  for (let k = 0; k < sides; k++) {
    const [ax, ay] = corner(k), [bx, by] = corner(k + 1);
    const ex = bx - ax, ey = by - ay, wx = p[0] - ax, wy = p[1] - ay;
    const h = saturate((wx * ex + wy * ey) / (ex * ex + ey * ey));
    nearest = Math.min(nearest, Math.hypot(wx - ex * h, wy - ey * h));
    if (ex * wy - ey * wx < 0) inside = false;
  }
  return inside ? -nearest : nearest;
}

const DISTANCES: Readonly<Record<string, (p: Vec2, extent: Vec2, sides: number) => number>> = {
  ellipse: ellipseDistance,
  rectangle: rectangleDistance,
  polygon: polygonDistance,
};

interface Shape { readonly mode: string; readonly center: Vec2; readonly extent: Vec2; readonly angle: number; readonly feather: number; readonly count: number }
const BASE: Shape = { mode: 'ellipse', center: [0.5, 0.5], extent: [0.3, 0.2], angle: 0, feather: 0.02, count: 6 };

/** The node's definition in float64: the distance to the outline in the shape's own frame, faded across the feather. */
function reference(res: number, shape: Shape): FieldData {
  const r = (shape.angle * Math.PI) / 180;
  return fieldOf(res, (u, v) => {
    const dx = u - shape.center[0], dy = v - shape.center[1];
    const local: Vec2 = [dx * Math.cos(r) + dy * Math.sin(r), dy * Math.cos(r) - dx * Math.sin(r)];
    const distance = DISTANCES[shape.mode]!(local, shape.extent, shape.count);
    if (shape.feather <= 0) return distance <= 0 ? 1 : 0;
    const t = saturate(0.5 - distance / shape.feather);
    return t * t * (3 - 2 * t);
  });
}
const render = async (shape: Partial<Shape>, res = 257): Promise<FieldData> => (await renderNode(def, { res, params: { ...BASE, ...shape } })).out;

test('generate/shape: the modes of the node are the three of this test', () => {
  const mode = def.params.find((param) => param.name === 'mode');
  assert.ok(mode?.kind === 'enum');
  assert.deepEqual(mode.options.map((option) => option.value), Object.keys(DISTANCES));
});

test('generate/shape: an ellipse fades across its feather by the true distance to its outline, however long it is', async () => {
  // A feather of 0.1 turns a distance into the mask with a slope of up to 15. The nearest point of an ellipse is
  // found in four rounds: measured, the mask is within 8e-6 up to a shape twelve times as long as wide and within
  // 3.1e-4 at forty-five times, which is a distance wrong by 2e-5 of the terrain width.
  for (const [extent, angle, allowed] of [[[0.3, 0.2], 0, 2e-5], [[0.25, 0.25], 0, 2e-5], [[0.4, 0.06], 25, 2e-5], [[0.03, 0.35], 110, 2e-5], [[0.45, 0.01], 300, 1e-3]] as const) {
    const shape = { ...BASE, extent, angle, feather: 0.1, center: [0.47, 0.55] as const };
    expectClose(await render(shape, 129), reference(129, shape), { max: allowed });
  }
});

test('generate/shape: a rectangle and a polygon fade by the true distance too, round the outside of their corners', async () => {
  for (const [extent, angle, center] of [[[0.3, 0.2], 0, [0.5, 0.5]], [[0.12, 0.33], 40, [0.4, 0.6]], [[0.5, 0.02], 200, [0.6, 0.3]]] as const) {
    const box = { ...BASE, mode: 'rectangle', extent, angle, center, feather: 0.05 };
    expectClose(await render(box), reference(257, box), { max: 2e-5 });
    // The corners of a polygon are turned one from the next in float32: they lie within 1e-6 of where they should.
    for (const count of [3, 5, 16]) {
      const polygon = { ...BASE, mode: 'polygon', extent, angle, center, feather: 0.05, count };
      expectClose(await render(polygon), reference(257, polygon), { max: 2e-4 });
    }
  }
});

test('generate/shape: the edge is 0.5 on the outline, 1 half a feather inside it and 0 half a feather outside', async () => {
  // A rectangle 128 by 64 texels with a feather of 16: its right side is column 192. The rows are well inside it.
  const out = await render({ mode: 'rectangle', extent: [0.25, 0.125], feather: 0.0625 });
  expectMask(out);
  for (const y of [112, 128, 140]) {
    assert.ok(Math.abs(at(out, 192, y) - 0.5) <= 1e-6);
    assert.equal(at(out, 184, y), 1);
    assert.equal(at(out, 200, y), 0);
    // A quarter of the feather out: smoothstep of 0.25.
    assert.ok(Math.abs(at(out, 196, y) - 0.15625) <= 1e-5);
  }
  assert.equal(at(out, 128, 128), 1);
  assert.equal(at(out, 0, 0), 0);
});

test('generate/shape: without a feather the mask is 0 or 1, and 1 on exactly the area of the shape', async () => {
  const ones = (f: FieldData): number => f.data.reduce((count, value) => count + (value === 1 ? 1 : 0), 0);
  const hard = async (shape: Partial<Shape>): Promise<number> => {
    const out = await render({ ...shape, feather: 0 });
    assert.equal(ones(out) + out.data.reduce((count, value) => count + (value === 0 ? 1 : 0), 0), out.data.length, 'values other than 0 and 1');
    return ones(out);
  };
  // 128 by 64 texels with the outline on texels, which belong to the shape: 129 by 65.
  assert.equal(await hard({ mode: 'rectangle', extent: [0.25, 0.125] }), 129 * 65);
  // By area, in cells of 1 / 256: an ellipse is pi a b, and a regular polygon of n sides n / 2 sin(2 pi / n) a b.
  const cells = 256 * 256;
  const within = (count: number, area: number): boolean => Math.abs(count / (area * cells) - 1) <= 0.01;
  assert.ok(within(await hard({ extent: [0.3, 0.2] }), Math.PI * 0.3 * 0.2));
  assert.ok(within(await hard({ mode: 'polygon', count: 4, extent: [0.3, 0.2] }), 2 * 0.3 * 0.2));
  assert.ok(within(await hard({ mode: 'polygon', count: 16, extent: [0.3, 0.3], angle: 77 }), 8 * Math.sin(Math.PI / 8) * 0.09));
});

test('generate/shape: a wider feather fades more of the terrain and keeps the outline where it is', async () => {
  const narrow = await render({ feather: 0.02 });
  const wide = await render({ feather: 0.2 });
  const fading = (f: FieldData): number => f.data.reduce((count, value) => count + (value > 0 && value < 1 ? 1 : 0), 0);
  assert.ok(fading(wide) > 5 * fading(narrow), `${fading(wide)} texels fade at 0.2 against ${fading(narrow)} at 0.02`);
  // The outline is the contour of 0.5 at any feather: on the right end of the ellipse, 0.3 from the center.
  const edge = 128 + 0.3 * 256;
  for (const out of [narrow, wide]) assert.ok(at(out, Math.floor(edge), 128) > 0.5 && at(out, Math.ceil(edge), 128) < 0.5);
  assert.ok(stats(wide).mean > 0.9 * stats(narrow).mean && stats(wide).mean < 1.1 * stats(narrow).mean);
});

test('generate/shape: the angle turns the shape clockwise in the top view, and a polygon has its first corner at the top', async () => {
  // Turned by 90 degrees, a rectangle is the rectangle with its extents exchanged.
  expectClose(await render({ mode: 'rectangle', extent: [0.3, 0.1], angle: 90 }), await render({ mode: 'rectangle', extent: [0.1, 0.3] }), { max: 1e-5 });
  // At 30 degrees the long axis points to the right and down the screen (engine.md 1.8): 0.25 along it is
  // inside the shape, and the same distance to the right and up is not.
  const turned = await render({ mode: 'rectangle', extent: [0.3, 0.05], angle: 30, feather: 0 });
  const texel = (angle: number): readonly [number, number] => [Math.round(128 + 64 * Math.cos((angle * Math.PI) / 180)), Math.round(128 + 64 * Math.sin((angle * Math.PI) / 180))];
  assert.equal(at(turned, ...texel(30)), 1);
  assert.equal(at(turned, ...texel(-30)), 0);
  // A triangle: one corner straight up from the center, towards row 0, and a side below it.
  const triangle = await render({ mode: 'polygon', count: 3, extent: [0.3, 0.3], feather: 0 });
  assert.equal(at(triangle, 128, 128 - 70), 1);
  assert.equal(at(triangle, 128, 128 + 70), 0);
  assert.equal(at(triangle, 128, 128 + 30), 1);
  expectStats(triangle, { min: [0, 0], max: [1, 1] });
});
