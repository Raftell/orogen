// tests/nodes/surface/fault.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  at, conformance, expectClose, expectIdentical, expectLadder, fieldOf, fixtures, renderLadder, renderNode, stats, traceNode, TEST_SETTINGS, type FieldData,
} from '../../helpers/index.ts';
import def, { FAULT, faultLines, type FaultLine } from '../../../src/core/nodes/surface/fault.ts';
import { frameSeed, mapField } from './_probe.ts';

conformance(def);

const N = 257;
const L = N - 1;
/** What the node adds to a terrain. */
const moved = (out: FieldData, src: FieldData): FieldData => mapField(out, (v, x, y) => v - at(src, x, y));

interface Faults { readonly count: number; readonly height: number; readonly angle: number; readonly spread: number; readonly reach: number; readonly seed: number }
const BASE: Faults = { count: 6, height: 0.25, angle: 20, spread: 20, reach: 0.6, seed: 0 };
const linesOf = (faults: Faults): FaultLine[] => faultLines(frameSeed(faults.seed), faults.count, faults.height, faults.angle, faults.spread);

/** How far across the plane of a fault climbs one height, as a length: the kernel's `run` under the test settings. */
const RUN = TEST_SETTINGS.heightRange / (Math.tan((FAULT.scarp * Math.PI) / 180) * TEST_SETTINGS.terrainSize);
const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};
const clamp01 = (x: number): number => Math.min(Math.max(x, 0), 1);

/** How far the faults move the ground at (u, v), on the CPU, for a ground whose broad shape is the function `ground` and that stands at `z` there. */
function shift(lines: readonly FaultLine[], reach: number, ground: (u: number, v: number) => number, z: number, u: number, v: number): number {
  let sum = 0;
  for (const line of lines) {
    const dx = u - line.x, dy = v - line.y;
    const across = -dx * line.dy + dy * line.dx;
    if (Math.abs(across) >= reach) continue;
    const along = dx * line.dx + dy * line.dy;
    const thrown = Math.abs(line.throw) * (1 - smoothstep(FAULT.whole, 1, Math.abs(along) / line.half));
    const half = 0.5 * thrown * (1 - smoothstep(0, reach, Math.abs(across)));
    const plane = ground(clamp01(line.x + along * line.dx), clamp01(line.y + along * line.dy)) + (Math.sign(line.throw) * across) / RUN;
    sum += Math.min(Math.max(plane - z, -half), half);
  }
  return sum;
}

test('surface/fault: every fault throws the ground on its one side up against the other, across the plane of the fault', async () => {
  // A plane is its own broad shape: the smoothing leaves it as it is, up to the border.
  const tilted = (u: number, v: number): number => 0.3 + 0.2 * u + 0.1 * v;
  const src = fieldOf(N, tilted);
  for (const change of [{}, { count: 1, seed: 3 }, { count: 32, height: 0.05, spread: 90, reach: 0.1, seed: 7 }, { count: 4, height: 0.5, angle: 300, spread: 0, reach: 1.5 }]) {
    const faults = { ...BASE, ...change };
    const { out } = await renderNode(def, { inputs: { in: src }, params: { ...faults } });
    const lines = linesOf(faults);
    // On a scarp the ground climbs 0.027 a texel: there the last bit of a distance is worth 1e-5 for every fault that crosses.
    expectClose(moved(out, src), fieldOf(N, (u, v) => shift(lines, faults.reach, tilted, tilted(u, v), u, v)), { max: 1e-4 });
  }
});

test('surface/fault: across the middle of a fault the ground is offset by its throw, and at the reach it is back at its level', async () => {
  const flat = fieldOf(513, () => 0.5);
  const faults = { ...BASE, count: 1, height: 0.1, reach: 0.2, seed: 5 };
  const { out } = await renderNode(def, { res: 513, inputs: { in: flat }, params: { ...faults } });
  const [line] = linesOf(faults);
  assert.ok(line !== undefined && Math.abs(line.throw) >= 0.05 && Math.abs(line.throw) <= 0.1);
  // The scarp of a throw of 0.1 is 0.0144 wide, 7.4 texels: eight texels to either side of the line are beyond it.
  const step = 8 / 512;
  const sample = (side: number): number => {
    const x = Math.round((line.x - side * step * line.dy) * 512), y = Math.round((line.y + side * step * line.dx) * 512);
    return at(out, Math.min(Math.max(x, 0), 512), Math.min(Math.max(y, 0), 512));
  };
  assert.ok(line.x > 0.05 && line.x < 0.95 && line.y > 0.05 && line.y < 0.95, 'the fault of this seed has its middle on the terrain');
  const offset = sample(1) - sample(-1);
  // Rounding to texels moves a sample by up to a texel across the fault, where the tilt back has hardly begun.
  assert.ok(Math.abs(offset - line.throw * (1 - smoothstep(0, 0.2, step))) < 0.01 * Math.abs(line.throw), `the ground is offset by ${offset}; the throw is ${line.throw}`);
  // One side is lifted by half the throw and the other dropped by half.
  const s = stats(moved(out, flat));
  assert.ok(Math.abs(s.max - 0.5 * Math.abs(line.throw)) < 0.01 * Math.abs(line.throw) && Math.abs(s.min + 0.5 * Math.abs(line.throw)) < 0.01 * Math.abs(line.throw), `the ground is moved by ${s.min} to ${s.max}`);
  // Beyond the reach nothing has moved.
  let beyond = 0, texels = 0;
  for (let y = 0; y < 513; y++) {
    for (let x = 0; x < 513; x++) {
      const across = -(x / 512 - line.x) * line.dy + (y / 512 - line.y) * line.dx;
      if (Math.abs(across) < 0.2) continue;
      beyond = Math.max(beyond, Math.abs(at(out, x, y) - 0.5));
      texels++;
    }
  }
  assert.ok(texels > 10000 && beyond === 0, `${texels} texels beyond the reach are moved by up to ${beyond}`);
});

test('surface/fault: the scarp is one flat face as steep as rock stands, whatever the ground it cuts', async () => {
  // One fault along x through a fractal terrain: its plane climbs along y alone, by the same height from row to row.
  const src = await fixtures.fbm(N);
  const faults = { ...BASE, count: 1, height: 0.3, angle: 0, spread: 0, reach: 4, seed: 2 };
  const { out } = await renderNode(def, { inputs: { in: src }, params: { ...faults } });
  const [line] = linesOf(faults);
  assert.ok(line !== undefined);
  const lift = moved(out, src);
  const rise = (Math.sign(line.throw) / L) / RUN;
  let face = 0, off = 0;
  for (let y = 0; y < N - 1; y++) {
    for (let x = 0; x < N; x++) {
      const thrown = Math.abs(line.throw) * (1 - smoothstep(FAULT.whole, 1, Math.abs(x / L - line.x) / line.half));
      const half = (v: number): number => 0.5 * thrown * (1 - smoothstep(0, 4, Math.abs(v - line.y)));
      // Both texels on the face: neither is as far from the terrain as its block is lifted or dropped.
      if (Math.abs(at(lift, x, y)) > 0.98 * half(y / L) - 1e-4 || Math.abs(at(lift, x, y + 1)) > 0.98 * half((y + 1) / L) - 1e-4) continue;
      face++;
      off = Math.max(off, Math.abs(at(out, x, y + 1) - at(out, x, y) - rise));
    }
  }
  // The face of a throw of 0.15 to 0.3 is 5.5 to 11 texels wide where the ground is even, and 257 long.
  assert.ok(face > 500, `${face} pairs of texels lie on the face`);
  assert.ok(off < 2e-5, `from one row to the next the face climbs ${rise}, within ${off}`);
  // No ground is moved further than half the throw, and both blocks are moved.
  const s = stats(lift);
  assert.ok(s.max <= 0.15 + 1e-6 && s.min >= -0.15 - 1e-6 && s.max > 0.07 && s.min < -0.07, `the ground is moved by ${s.min} to ${s.max}`);

  // On level ground nothing is steeper than the plane, at any throw: a low scarp is a narrow one.
  const flat = fieldOf(N, () => 0);
  const limit = Math.tan((FAULT.scarp * Math.PI) / 180);
  for (const height of [1, 0.02]) {
    const stepped = await renderNode(def, { inputs: { in: flat }, params: { ...faults, height } });
    let steepest = 0;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if (x < L) steepest = Math.max(steepest, Math.abs(at(stepped.out, x + 1, y) - at(stepped.out, x, y)));
        if (y < L) steepest = Math.max(steepest, Math.abs(at(stepped.out, x, y + 1) - at(stepped.out, x, y)));
      }
    }
    const tangent = (steepest * L * TEST_SETTINGS.heightRange) / TEST_SETTINGS.terrainSize;
    assert.ok(tangent <= limit * 1.001, `at a throw of ${height} the scarp climbs at a tangent of ${tangent}; ${limit} is ${FAULT.scarp} degrees`);
  }
});

test('surface/fault: the faults run within the spread of the direction, throw half the height or more, and more faults leave the first', async () => {
  const lines = linesOf({ ...BASE, count: 32, angle: 100, spread: 25, height: 0.3 });
  assert.equal(lines.length, 32);
  let up = 0;
  for (const line of lines) {
    const turn = (Math.atan2(line.dy, line.dx) * 180) / Math.PI;
    assert.ok(Math.abs(turn - 100) <= 25 + 1e-9, `a fault runs at ${turn} degrees`);
    assert.ok(Math.abs(line.throw) >= FAULT.least * 0.3 - 1e-12 && Math.abs(line.throw) <= 0.3 + 1e-12, `a fault throws ${line.throw}`);
    assert.ok(line.half >= FAULT.half[0] && line.half <= FAULT.half[1] && line.x >= 0 && line.x < 1 && line.y >= 0 && line.y < 1);
    if (line.throw > 0) up++;
  }
  assert.ok(up >= 8 && up <= 24, `${up} of 32 faults throw their left side up`);
  const parallel = linesOf({ ...BASE, count: 8, angle: 45, spread: 0 });
  for (const line of parallel) assert.ok(Math.abs(line.dx - Math.SQRT1_2) < 1e-12 && Math.abs(line.dy - Math.SQRT1_2) < 1e-12);
  const fewer = linesOf({ ...BASE, count: 5 }), more = linesOf({ ...BASE, count: 9 });
  assert.deepEqual(more.slice(0, 5), fewer);
  assert.notDeepEqual(linesOf({ ...BASE, count: 5, seed: 1 }), fewer);
});

test('surface/fault: no throw and no reach give the input itself', async () => {
  const src = await fixtures.fbm(N);
  for (const params of [{ height: 0 }, { reach: 0 }, { height: -1 }] as Record<string, number>[]) {
    const { outputs, report } = await traceNode(def, { inputs: { in: src }, params });
    expectIdentical(outputs.out!, src);
    assert.equal(report.nodes.node!.peakBytes, 0, 'an alias of the input: no texture, no pass');
  }
});

test('surface/fault: the faults are the same at two levels of the ladder', async () => {
  // The plane of a fault is a function of the place, and the broad shape it goes through is the same on both grids.
  for (const params of [{ ...BASE }, { ...BASE, height: 1 }, { ...BASE, height: 0.02, count: 32, reach: 0.05 }]) {
    const levels = await renderLadder(def, { inputs: { in: 'terrain' }, params });
    expectLadder(levels[257]!.out, levels[513]!.out, { rel: 0.003 });
  }
});
