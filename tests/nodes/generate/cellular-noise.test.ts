// tests/nodes/generate/cellular-noise.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  at, conformance, diff, expectClose, expectLadder, expectStats, fieldOf, renderLadder, renderNode, stats, TEST_SETTINGS, type FieldData,
} from '../../helpers/index.ts';
import { hashCell, hashU32, hashUnit, mixSeed } from '../../../src/core/api.ts';
import def, { CELLS } from '../../../src/core/nodes/generate/cellular-noise.ts';
import { soften } from './_noise-cpu.ts';

conformance(def);

const f = Math.fround;
const MODES = ['distance', 'second', 'edge', 'cell'] as const;
type Mode = (typeof MODES)[number];

interface Cells { readonly mode: Mode; readonly size: number; readonly jitter: number; readonly seed: number }
const BASE: Cells = { mode: 'distance', size: 0.125, jitter: 1, seed: 0 };
const render = async (cells: Partial<Cells>, res = 257): Promise<FieldData> => (await renderNode(def, { res, params: { ...BASE, ...cells } })).out;

interface Sample { readonly first: number; readonly second: number; readonly wall: number; readonly value: number }

const { pitch: PITCH, row: ROW, corner: CORNER } = CELLS;
// From the centre of a cell to every second of its corners, as the kernel holds them.
const SPOKES: readonly (readonly [number, number])[] = [[0, f(CORNER)], [f(f(-0.866025404) * f(CORNER)), f(f(-0.5) * f(CORNER))], [f(f(0.866025404) * f(CORNER)), f(f(-0.5) * f(CORNER))]];

/** The feature point of lattice point (i, j), from the centre of the terrain, in feature sizes: a point of one of the three rhombi of its cell. */
function featurePoint(i: number, j: number, jitter: number, seed: number): readonly [number, number] {
  const h = hashCell(i, j, seed), h2 = hashU32(h), rhombus = hashU32(h2) % 3;
  const a = SPOKES[rhombus]!, b = SPOKES[(rhombus + 1) % 3]!;
  return [(i + 0.5 * j) * PITCH + (hashUnit(h) * a[0] + hashUnit(h2) * b[0]) * jitter, j * ROW + (hashUnit(h) * a[1] + hashUnit(h2) * b[1]) * jitter];
}

/**
 * The definition, not the kernel's search: every lattice point up to five steps from the one below the point,
 * 91 of them where the kernel looks at 19, gives its feature point; the two nearest, the nearest wall of the
 * nearest point's cell and that cell's value follow. Agreement therefore also shows that two steps are enough.
 */
function sample(u: number, v: number, cells: Cells, frameSeed: number): Sample {
  const perSize = f(1 / cells.size), jitter = f(cells.jitter), seed = mixSeed(frameSeed, 0);
  const px = f(f(u - 0.5) * perSize), py = f(f(v - 0.5) * perSize);
  const j0 = Math.round(py / ROW), i0 = Math.round(px / PITCH - 0.5 * j0);
  const points: (readonly [number, number, number, number])[] = [];
  let first = Infinity, second = Infinity, nearest = 0;
  for (let j = -5; j <= 5; j++) {
    for (let i = -5; i <= 5; i++) {
      if (Math.abs(i + j) > 5) continue;
      const q = featurePoint(i0 + i, j0 + j, jitter, seed);
      const dx = q[0] - px, dy = q[1] - py, d2 = dx * dx + dy * dy;
      if (d2 < first) { second = first; first = d2; nearest = points.length; } else if (d2 < second) second = d2;
      points.push([dx, dy, i0 + i, j0 + j]);
    }
  }
  const [nx, ny, si, sj] = points[nearest]!;
  let wall = Infinity;
  points.forEach(([dx, dy], k) => {
    const ax = dx - nx, ay = dy - ny, span = ax * ax + ay * ay;
    if (k !== nearest && span > 1e-12) wall = Math.min(wall, (0.5 * (nx + dx) * ax + 0.5 * (ny + dy) * ay) / Math.sqrt(span));
  });
  return { first: Math.sqrt(first), second: Math.sqrt(second), wall: Math.max(wall, 0), value: hashUnit(hashCell(si, sj, mixSeed(frameSeed, 1))) };
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
    // The last setting has 4000 cells and full jitter: the texels fall anywhere in their cells, the corners included.
    for (const change of [{}, { size: 0.031, jitter: 0.6, seed: 5 }, { size: 0.4, jitter: 0.25, seed: 9 }, { size: 0.25, jitter: 0 }, { size: 0.0158, seed: 2 }]) {
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
      assert.ok(compared > 0.97 * 129 * 129);
      assert.ok(worst <= 2e-5, `mode ${mode}, size ${cells.size}: up to ${worst} from the definition; allowed 2e-5`);
    }
  });
}

test('generate/cellular-noise: without jitter the cells are a honeycomb, each hexagon as large as a square of the feature size', async () => {
  // A size that puts the points of one row 32 texels apart at 257: the pitch of the lattice is 1.0746 feature
  // sizes, the pitch of hexagons of area 1. A lattice point lies on the centre of the terrain.
  const comb = { size: 0.125 / PITCH, jitter: 0 };
  const distance = await render({ ...comb, mode: 'distance' });
  for (const x of [0, 32, 64, 96, 128, 160, 192, 224, 256]) {
    assert.ok(at(distance, x, 128) <= 1e-6, `the point at texel (${x}, 128)`);
    // Half way to the next point of the row, on the wall between the two cells.
    if (x < 256) assert.ok(Math.abs(at(distance, x + 16, 128) - PITCH / 2) < 1e-5);
  }
  // The next row lies sqrt(3) / 2 pitches further, half a pitch along: 27.7 texels down and 16 across.
  const rowTexels = 32 * (ROW / PITCH);
  assert.ok(Math.abs(at(distance, 144, 156) - ((156 - 128 - rowTexels) / 32) * PITCH) < 1e-5);
  // The pattern repeats along the row, and no texel is further from its point than the corner of a hexagon.
  let repeat = 0, furthest = 0;
  for (let y = 0; y < 257; y++) {
    for (let x = 0; x < 257; x++) {
      furthest = Math.max(furthest, at(distance, x, y));
      if (x + 32 < 257) repeat = Math.max(repeat, Math.abs(at(distance, x + 32, y) - at(distance, x, y)));
    }
  }
  assert.ok(repeat < 1e-5, `moved by one pitch the honeycomb differs by ${repeat}`);
  assert.ok(furthest <= CORNER + 1e-5 && furthest > CORNER - 0.03, `the furthest texel is ${furthest} from its point; a corner is ${CORNER}`);
  // The mean distance from the centre of a regular hexagon whose sides are a from it is
  // a (2 / 3 + ln(3) / 2) / sqrt(3) = 0.7020 a, and a is half the pitch.
  expectStats(distance, { mean: [0.7020 * (PITCH / 2) - 0.004, 0.7020 * (PITCH / 2) + 0.004] });

  // The second nearest point is a neighbour, a pitch from a point and half a pitch from the wall between the two.
  const second = await render({ ...comb, mode: 'second' });
  assert.ok(Math.abs(at(second, 128, 128) - 0.75 * PITCH) < 1e-5 && Math.abs(at(second, 144, 128) - 0.75 * (PITCH / 2)) < 1e-5);
  // The wall is half a pitch from the point: twice that, bent over at 0.9, on the point, and 0 on the wall.
  const edge = await render({ ...comb, mode: 'edge' });
  assert.ok(Math.abs(at(edge, 128, 128) - soften(PITCH, 0.9, 0.1)) < 1e-5 && at(edge, 144, 128) <= 1e-5);
  // One value per cell, the same on every texel within a quarter of a pitch of the point.
  const cell = await render({ ...comb, mode: 'cell' });
  const values = new Set<number>();
  for (const x of [32, 64, 96, 128, 160, 192, 224]) {
    const value = at(cell, x, 128);
    values.add(value);
    for (const [dx, dy] of [[7, 0], [-7, 0], [0, 7], [0, -7], [5, 5], [-5, -5]] as const) assert.equal(at(cell, x + dx, 128 + dy), value);
  }
  assert.equal(values.size, 7);
});

test('generate/cellular-noise: the distances are in feature sizes, 0 on a point and on a wall, and stay within 0..1', async () => {
  for (const jitter of [0, 0.5, 1]) {
    const [distance, second, edge, cell] = await Promise.all(MODES.map((mode) => render({ mode, size: 0.05, jitter }, 513)));
    // 400 cells. The nearest point is at most 1.24 away and typically 0.4; a wall is nearer than half a cell or so.
    expectStats(distance!, { min: [0, 0.06], max: [0.55, 1], mean: [0.35, 0.47] });
    expectStats(second!, { min: [0, 0.45], max: [0.7, 1], mean: [0.48, 0.6] });
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

test('generate/cellular-noise: a smaller feature size gives more cells, and jitter makes them unequal', async () => {
  /** The texels of every cell that does not touch the border, by the cell's value. */
  const areas = (field: FieldData): number[] => {
    const count = new Map<number, number>(), cut = new Set<number>();
    for (let y = 0; y < field.height; y++) {
      for (let x = 0; x < field.width; x++) {
        const value = at(field, x, y);
        count.set(value, (count.get(value) ?? 0) + 1);
        if (x === 0 || y === 0 || x === field.width - 1 || y === field.height - 1) cut.add(value);
      }
    }
    return [...count].filter(([value]) => !cut.has(value)).map(([, texels]) => texels);
  };
  const spread = (list: readonly number[]): { readonly mean: number; readonly relative: number } => {
    const mean = list.reduce((a, b) => a + b, 0) / list.length;
    return { mean, relative: Math.sqrt(list.reduce((a, b) => a + (b - mean) ** 2, 0) / list.length) / mean };
  };
  // One value per cell, and a cell has the area of a square of the feature size: 64 x 64 texels at size 0.25
  // and 257, and a twenty-fifth of that at size 0.05.
  const few = spread(areas(await render({ mode: 'cell', size: 0.25, jitter: 0 })));
  const many = areas(await render({ mode: 'cell', size: 0.05, jitter: 0 }));
  assert.ok(Math.abs(few.mean / 4096 - 1) < 0.03, `a cell of size 0.25 holds ${few.mean} texels`);
  assert.ok(many.length > 300 && many.length <= 400 && Math.abs(spread(many).mean / 163.84 - 1) < 0.03, `${many.length} whole cells of ${spread(many).mean} texels at size 0.05`);
  // Without jitter the cells are alike, but for the texels on their walls: measured, their areas differ by 2 %.
  // With full jitter by 24 %.
  const even = spread(many), free = spread(areas(await render({ mode: 'cell', size: 0.05, jitter: 1 })));
  assert.ok(even.relative < 0.06, `without jitter the areas differ by ${(100 * even.relative).toFixed(1)} %`);
  assert.ok(free.relative > 0.15, `with full jitter the areas differ by ${(100 * free.relative).toFixed(1)} %`);
  assert.ok(diff(await render({ mode: 'edge', size: 0.25, jitter: 0 }), await render({ mode: 'edge', size: 0.25, jitter: 1 })).rms > 0.1);
});

/** In place: the discrete Fourier transform of a row whose length is a power of two. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const r = re[i]!; re[i] = re[j]!; re[j] = r; const m = im[i]!; im[i] = im[j]!; im[j] = m; }
  }
  for (let length = 2; length <= n; length <<= 1) {
    const half = length >> 1, wr = Math.cos((-2 * Math.PI) / length), wi = Math.sin((-2 * Math.PI) / length);
    for (let i = 0; i < n; i += length) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const ur = re[i + k]!, ui = im[i + k]!;
        const vr = re[i + k + half]! * cr - im[i + k + half]! * ci, vi = re[i + k + half]! * ci + im[i + k + half]! * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + half] = ur - vr; im[i + k + half] = ui - vi;
        const next = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = next;
      }
    }
  }
}

/**
 * How much the lattice shows in a field of 513 texels: the power of the waves that the rows of lattice points
 * would give, within 15 % of their wavelength and 10 degrees of their three directions, over the power of the
 * waves of the same lengths half way between those directions. 1 for a field without a lattice.
 */
function latticeTrace(fields: readonly FieldData[], size: number): number {
  const n = 512, rows = 1 / (ROW * size);      // waves across the terrain, one per row of points: 512 texels of 513 are one terrain width
  let on = 0, onCount = 0, between = 0, betweenCount = 0;
  for (const field of fields) {
    const re = new Float64Array(n * n), im = new Float64Array(n * n);
    const mean = stats(field).mean;
    const window = (i: number): number => 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) re[y * n + x] = (at(field, x, y) - mean) * window(x) * window(y);
    const lineRe = new Float64Array(n), lineIm = new Float64Array(n);
    for (let y = 0; y < n; y++) {
      lineRe.set(re.subarray(y * n, (y + 1) * n)); lineIm.fill(0);
      fft(lineRe, lineIm);
      re.set(lineRe, y * n); im.set(lineIm, y * n);
    }
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) { lineRe[y] = re[y * n + x]!; lineIm[y] = im[y * n + x]!; }
      fft(lineRe, lineIm);
      for (let y = 0; y < n; y++) { re[y * n + x] = lineRe[y]!; im[y * n + x] = lineIm[y]!; }
    }
    for (let ky = -n / 2; ky < n / 2; ky++) {
      for (let kx = 0; kx < n / 2; kx++) {
        const k = Math.hypot(kx, ky);
        if (k < 0.85 * rows || k > 1.15 * rows) continue;
        // The rows run along x, so their waves run along y: at 90 degrees, and at 30 and 150. Folded to 0..60.
        const angle = (((Math.atan2(ky, kx) * 180) / Math.PI) % 60 + 60) % 60;
        const power = re[((ky + n) % n) * n + kx]! ** 2 + im[((ky + n) % n) * n + kx]! ** 2;
        if (Math.abs(angle - 30) <= 10) { on += power; onCount++; }
        if (angle <= 10 || angle >= 50) { between += power; betweenCount++; }
      }
    }
  }
  return on / onCount / (between / betweenCount);
}

test('generate/cellular-noise: full jitter leaves no more than a trace of the lattice of the points', async () => {
  // One point to a cell is an order that scattering each within its cell cannot remove altogether. Measured over
  // four seeds: mode distance 1.19 at full jitter, 8.0 at half the jitter and millions without; at full jitter
  // mode cell 0.90, second 1.43 and edge 1.50. The eye finds no rows in any of them.
  const fields = async (jitter: number, mode: Mode): Promise<FieldData[]> => {
    const list: FieldData[] = [];
    for (const seed of [0, 1, 2, 3]) list.push(await render({ mode, size: 0.04, jitter, seed }, 513));
    return list;
  };
  const free = latticeTrace(await fields(1, 'distance'), 0.04);
  const half = latticeTrace(await fields(0.5, 'distance'), 0.04);
  const none = latticeTrace(await fields(0, 'distance'), 0.04);
  assert.ok(free > 0.8 && free < 1.35, `with full jitter the waves of the lattice hold ${free.toFixed(3)} times the power of those between`);
  assert.ok(half > 4 && none > 1000, `${half.toFixed(2)} at half the jitter and ${none.toFixed(0)} without`);
  for (const [mode, most] of [['cell', 1.25], ['second', 1.7], ['edge', 1.8]] as const) {
    const trace = latticeTrace(await fields(1, mode), 0.04);
    assert.ok(trace > 0.75 && trace < most, `mode ${mode}, full jitter: ${trace.toFixed(3)}`);
  }
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
