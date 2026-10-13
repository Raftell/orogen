// tests/nodes/generate/cellular-noise.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  at, conformance, diff, expectClose, expectLadder, expectStats, fieldOf, renderLadder, renderNode, stats, TEST_SETTINGS, type FieldData,
} from '../../helpers/index.ts';
import { hashCell, hashUnit, mixSeed } from '../../../src/core/api.ts';
import def from '../../../src/core/nodes/generate/cellular-noise.ts';
import { hashUnit2, soften } from './_noise-cpu.ts';

conformance(def);

const f = Math.fround;
const MODES = ['distance', 'second', 'edge', 'cell'] as const;
type Mode = (typeof MODES)[number];

interface Cells { readonly mode: Mode; readonly size: number; readonly jitter: number; readonly seed: number }
const BASE: Cells = { mode: 'distance', size: 0.125, jitter: 1, seed: 0 };
const render = async (cells: Partial<Cells>, res = 257): Promise<FieldData> => (await renderNode(def, { res, params: { ...BASE, ...cells } })).out;

interface Sample { readonly first: number; readonly second: number; readonly wall: number; readonly value: number }

/** The kernel, written again for the CPU: the two nearest feature points of the 5 x 5 cells around the point, the nearest wall and the cell's value. */
function sample(u: number, v: number, cells: Cells, frameSeed: number): Sample {
  const perSize = f(1 / cells.size), jitter = f(cells.jitter), seed = mixSeed(frameSeed, 0);
  const px = f(f(u - 0.5) * perSize), py = f(f(v - 0.5) * perSize);
  const cx = Math.floor(px), cy = Math.floor(py), fx = f(px - cx), fy = f(py - cy);
  const points: (readonly [number, number, number, number])[] = [];
  let first = 64, second = 64, nearest = 0;
  for (let j = -2; j <= 2; j++) {
    for (let i = -2; i <= 2; i++) {
      const unit = hashUnit2(hashCell(cx + i, cy + j, seed));
      const dx = i + 0.5 + (unit[0] - 0.5) * jitter - fx, dy = j + 0.5 + (unit[1] - 0.5) * jitter - fy;
      const d2 = dx * dx + dy * dy;
      if (d2 < first) { second = first; first = d2; nearest = points.length; } else if (d2 < second) second = d2;
      points.push([dx, dy, i, j]);
    }
  }
  const [nx, ny, hi, hj] = points[nearest]!;
  let wall = 64;
  points.forEach(([dx, dy], k) => {
    const ax = dx - nx, ay = dy - ny, span = ax * ax + ay * ay;
    if (k !== nearest && span > 1e-12) wall = Math.min(wall, (0.5 * (nx + dx) * ax + 0.5 * (ny + dy) * ay) / Math.sqrt(span));
  });
  return { first: Math.sqrt(first), second: Math.sqrt(second), wall: Math.max(wall, 0), value: hashUnit(hashCell(cx + hi, cy + hj, mixSeed(frameSeed, 1))) };
}
/** Heights follow the value up to 0.9 and bend towards 1 from there. */
const height = (s: Sample, mode: Mode): number =>
  mode === 'cell' ? s.value : soften(mode === 'distance' ? s.first : mode === 'second' ? 0.75 * s.second : 2 * s.wall, 0.9, 0.1);

test('generate/cellular-noise: the modes of the node are distance, second, edge and cell', () => {
  const mode = def.params.find((param) => param.name === 'mode');
  assert.ok(mode?.kind === 'enum');
  assert.deepEqual(mode.options.map((option) => option.value), MODES);
});

for (const mode of MODES) {
  test(`generate/cellular-noise: mode ${mode} is what the feature points of its definition give`, async () => {
    for (const change of [{}, { size: 0.031, jitter: 0.6, seed: 5 }, { size: 0.4, jitter: 0.25, seed: 9 }]) {
      const cells = { ...BASE, mode, ...change };
      const frameSeed = mixSeed(TEST_SETTINGS.seed, cells.seed);
      const out = await render(cells, 129);
      let worst = 0, compared = 0;
      for (let y = 0; y < 129; y++) {
        for (let x = 0; x < 129; x++) {
          const s = sample(f(x / 128), f(y / 128), cells, frameSeed);
          // On a wall the last bit of a distance decides whose cell a texel is in: its value is either neighbour's.
          if (mode === 'cell' && s.wall < 1e-4) continue;
          worst = Math.max(worst, Math.abs(at(out, x, y) - height(s, mode)));
          compared++;
        }
      }
      assert.ok(compared > 0.99 * 129 * 129);
      assert.ok(worst <= 2e-5, `mode ${mode}, size ${cells.size}: up to ${worst} from the definition; allowed 2e-5`);
    }
  });
}

test('generate/cellular-noise: without jitter the points are the centres of square cells, as wide as the feature size', async () => {
  // Four cells of 64 texels across at 257. (a, b): the position in the cell, from its centre, in cells.
  const local = (u: number): number => { const p = (u - 0.5) * 4; return p - Math.floor(p) - 0.5; };
  const grid = { size: 0.25, jitter: 0 };
  const distance = await render({ ...grid, mode: 'distance' });
  expectClose(distance, fieldOf(257, (u, v) => Math.hypot(local(u), local(v))), { max: 1e-6 });
  for (const centre of [32, 96, 160, 224]) assert.equal(at(distance, centre, 96), 0);
  // The second nearest centre is the one across the nearer side of the cell.
  const second = await render({ ...grid, mode: 'second' });
  expectClose(second, fieldOf(257, (u, v) => 0.75 * Math.hypot(1 - Math.max(Math.abs(local(u)), Math.abs(local(v))), Math.min(Math.abs(local(u)), Math.abs(local(v))))), { max: 1e-6 });
  // The walls are the sides of the cell: a pyramid, 1 on the centre before its top is bent over at 0.9.
  const edge = await render({ ...grid, mode: 'edge' });
  expectClose(edge, fieldOf(257, (u, v) => soften(2 * (0.5 - Math.max(Math.abs(local(u)), Math.abs(local(v)))), 0.9, 0.1)), { max: 1e-6 });
  for (const wall of [0, 64, 128, 192, 256]) assert.ok(at(edge, wall, 77) <= 1e-6 && at(edge, 77, wall) <= 1e-6);
  // One value per cell: every texel inside a square has the value of its centre, and the sixteen squares differ.
  const cell = await render({ ...grid, mode: 'cell' });
  const values = new Set<number>();
  for (let cy = 0; cy < 4; cy++) {
    for (let cx = 0; cx < 4; cx++) {
      const value = at(cell, 64 * cx + 32, 64 * cy + 32);
      values.add(value);
      for (let y = 64 * cy + 1; y < 64 * cy + 64; y += 7) for (let x = 64 * cx + 1; x < 64 * cx + 64; x += 7) assert.equal(at(cell, x, y), value);
    }
  }
  assert.equal(values.size, 16);
});

test('generate/cellular-noise: the distances are in feature sizes, 0 on a point and on a wall, and stay within 0..1', async () => {
  for (const jitter of [0, 0.5, 1]) {
    const [distance, second, edge, cell] = await Promise.all(MODES.map((mode) => render({ mode, size: 0.05, jitter }, 513)));
    // 400 cells. The nearest point is at most 1.42 away and typically 0.4; a wall is nearer than half a cell or so.
    expectStats(distance!, { min: [0, 0.06], max: [0.6, 1], mean: [0.35, 0.47] });
    expectStats(second!, { min: [0, 0.4], max: [0.7, 1], mean: [0.48, 0.57] });
    expectStats(edge!, { min: [0, 0.01], max: [0.9, 1], mean: [0.28, 0.38] });
    expectStats(cell!, { min: [0, 0.05], max: [0.95, 1], mean: [0.4, 0.6] });
    // The second nearest point is never nearer than the nearest. Where neither height is bent: distance <= second / 0.75.
    let wrong = 0;
    for (let i = 0; i < distance!.data.length; i++) {
      if (second!.data[i]! < 0.9 && distance!.data[i]! < 0.9 && distance!.data[i]! > second!.data[i]! / 0.75 + 1e-5) wrong++;
    }
    assert.equal(wrong, 0, `jitter ${jitter}: texels nearer to their second point than to their first`);
  }
});

test('generate/cellular-noise: a smaller feature size gives more cells, and jitter scatters them', async () => {
  const count = (field: FieldData): number => new Set(field.data).size;
  // One value per cell: about 1 / size squared of them, and the cells cut by the border.
  const few = count(await render({ mode: 'cell', size: 0.25 }));
  const many = count(await render({ mode: 'cell', size: 0.05 }));
  assert.ok(few >= 16 && few <= 40, `${few} cells at size 0.25`);
  assert.ok(many >= 400 && many <= 520, `${many} cells at size 0.05`);
  // Without jitter every wall is straight along a row or a column; with it hardly any texel keeps its height.
  const square = await render({ mode: 'edge', size: 0.25, jitter: 0 });
  const free = await render({ mode: 'edge', size: 0.25, jitter: 1 });
  assert.ok(diff(square, free).rms > 0.1);
  let onRow = 0;
  for (let x = 0; x < 257; x++) if (at(free, x, 64) <= 1e-6) onRow++;
  assert.ok(onRow < 20, `${onRow} texels of row 64 lie on a wall with full jitter; without jitter all 257 do`);
});

test('generate/cellular-noise: with full jitter the rows of the cells no longer show', async () => {
  // The two measures of the fractal noise's test: roughness across steps of five texels along the axes and the
  // 3-4-5 slants, and the curvature (h_xx - h_yy) along the axes against the same along the slants. The points
  // are scattered one to a square cell: measured, the roughness is alike within 1.2 % and the curvature within
  // 5 %, a trace of the rows that the eye does not find. At half the jitter the curvature ratio is 2.2.
  const steps = [[5, 0], [0, 5], [3, 4], [4, 3], [-3, 4], [-4, 3], [4, -3], [3, -4]] as const;
  const measure = async (jitter: number): Promise<{ readonly worst: number; readonly curvature: number }> => {
    const sums = steps.map(() => 0);
    let axes = 0, slants = 0;
    for (const seed of [0, 1, 2, 3]) {
      const out = await render({ size: 0.06, jitter, seed }, 513);
      for (let y = 8; y < 505; y++) {
        for (let x = 8; x < 505; x++) {
          const h = at(out, x, y);
          steps.forEach(([dx, dy], k) => { sums[k] += (at(out, x + dx, y + dy) - h) ** 2; });
          axes += (at(out, x + 5, y) + at(out, x - 5, y) - at(out, x, y + 5) - at(out, x, y - 5)) ** 2;
          slants += (at(out, x + 3, y + 4) + at(out, x - 3, y - 4) - at(out, x - 4, y + 3) - at(out, x + 4, y - 3)) ** 2;
        }
      }
    }
    const mean = sums.reduce((a, b) => a + b, 0) / sums.length;
    return { worst: Math.max(...sums.map((sum) => Math.abs(sum / mean - 1))), curvature: axes / slants };
  };
  const free = await measure(1);
  assert.ok(free.worst < 0.04, `the roughness along one direction differs from the mean of all by ${(100 * free.worst).toFixed(1)} %`);
  assert.ok(Math.abs(free.curvature - 1) < 0.1, `curvature along the axes is ${free.curvature.toFixed(3)} of that along the slants`);
  const half = await measure(0.5);
  assert.ok(half.curvature > 1.5, `at half the jitter the rows show: ${half.curvature.toFixed(3)}`);
});

test('generate/cellular-noise: every level of the ladder has the same cells, in every mode', async () => {
  // 129, 257 and 513 halve their cells exactly; 128, 255 and 509 are levels of an 8129 build, which do not
  // divide the terrain by a power of two. A cell's value jumps at its walls, so one differing bit would show.
  for (const mode of MODES) {
    for (const resolutions of [[129, 257, 513], [128, 255, 509]] as const) {
      const levels = await renderLadder(def, { resolutions, params: { mode, jitter: 0.8 } });
      expectLadder(levels[resolutions[0]]!.out, levels[resolutions[1]]!.out, { max: 1e-6 });
      expectLadder(levels[resolutions[0]]!.out, levels[resolutions[2]]!.out, { max: 1e-6 });
    }
  }
});

test('generate/cellular-noise: another seed scatters other points', async () => {
  const base = await render({});
  const other = await render({ seed: 1 });
  assert.ok(diff(base, other).differing > 0.99 * base.data.length);
  assert.ok(Math.abs(stats(base).mean - stats(other).mean) < 0.05);
});
