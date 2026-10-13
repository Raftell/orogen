// tests/nodes/generate/eroded-noise.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  at, conformance, diff, expectClose, expectLadder, expectStats, fieldOf, renderLadder, renderNode, stats, TEST_SETTINGS, type FieldData,
} from '../../helpers/index.ts';
import { hashCell, mixSeed } from '../../../src/core/api.ts';
import def, { ERODED } from '../../../src/core/nodes/generate/eroded-noise.ts';
import fractal from '../../../src/core/nodes/generate/fractal-noise.ts';
import { corners, hashUnit2, lattice, octaveSeed, shift, simplexD, soften, turn, type Vec2 } from './_noise-cpu.ts';

conformance(def);

const f = Math.fround;

interface Eroded { readonly size: number; readonly erosion: number; readonly octaves: number; readonly gain: number; readonly seed: number }
const BASE: Eroded = { size: 0.25, erosion: 1, octaves: 8, gain: 0.5, seed: 0 };
const render = async (eroded: Partial<Eroded>, res = 257): Promise<FieldData> => (await renderNode(def, { res, params: { ...BASE, ...eroded } })).out;

// The constants of the kernel that the node does not export.
const SPREAD = 0.31, KNEE = 0.4, ROOM = 0.1, TAU = f(6.283185307);

/** The kernel's `gullies`: (cos, sin) of the wave blended from the three lattice points around p. */
function gullies(px: number, py: number, k: Vec2, seed: number): Vec2 {
  let c = 0, s = 0, weight = 0;
  for (const { cx, cy, x, y } of corners(px, py)) {
    const t = Math.max(0.5 - (x * x + y * y), 0);
    const w = t ** 4;
    const anchor = hashUnit2(hashCell(cx, cy, seed));
    const phase = TAU * (k[0] * (x - (anchor[0] - 0.5)) + k[1] * (y - (anchor[1] - 0.5)));
    c += w * Math.cos(phase);
    s += w * Math.sin(phase);
    weight += w;
  }
  return [c / weight, s / weight];
}

const smoothstep = (lo: number, hi: number, x: number): number => {
  const t = Math.min(Math.max((x - lo) / (hi - lo), 0), 1);
  return t * t * (3 - 2 * t);
};

/** The kernel, written again for the CPU with the twin of its library. `frameSeed` is mixSeed(project seed, node seed). */
function reference(u: number, v: number, eroded: Eroded, frameSeed: number): number {
  const erosion = f(eroded.erosion), gain = f(eroded.gain);
  const stripes = f(ERODED.stripes), steep2 = ERODED.steep ** 2;
  let q = lattice([u, v], f(1 / eroded.size));
  let sum = 0, norm = 0, power = 0, amp = 1, finer = 1, level = 0.5, fading = 1;
  let turned: Vec2 = [1, 0];
  let slope: Vec2 = [0, 0];
  let flow: Vec2 = [0, 0];
  for (let i = 0; i < eroded.octaves; i++) {
    const s = octaveSeed(mixSeed(frameSeed, 0), i);
    const move = shift(s);
    const px = f(q[0] + move[0]), py = f(q[1] + move[1]);
    const [n, dx, dy] = simplexD(px, py, s);
    const scale = amp * finer;
    const d: Vec2 = [scale * (dx * turned[0] + dy * turned[1]), scale * (dy * turned[0] - dx * turned[1])];
    if (i < ERODED.massif) {
      sum += amp * n;
      slope = [slope[0] + d[0], slope[1] + d[1]];
      flow = [flow[0] + d[0], flow[1] + d[1]];
      level = 0.5 + (0.5 * sum) / (norm + amp);
    } else {
      const high = Math.min(Math.max((level - 0.15) / 0.7, 0), 1);
      const crest = (2 * high * high * (3 - 2 * high)) / (1 + (ERODED.damping * (slope[0] ** 2 + slope[1] ** 2)) / steep2);
      const keep = 1 + (crest - 1) * erosion;
      const reach = 1 / Math.sqrt(flow[0] ** 2 + flow[1] ** 2 + steep2);
      const along: Vec2 = [flow[1] * reach, -flow[0] * reach];
      const k: Vec2 = [f(stripes * (along[0] * turned[0] - along[1] * turned[1])), f(stripes * (along[0] * turned[1] + along[1] * turned[0]))];
      const wave = gullies(px, py, k, octaveSeed(mixSeed(frameSeed, 1), i));
      const strength = erosion * ERODED.depth * fading * (along[0] ** 2 + along[1] ** 2) * smoothstep(0.1, 0.4, level);
      sum += amp * (keep * n + strength * wave[0]);
      slope = [slope[0] + keep * d[0], slope[1] + keep * d[1]];
      const wall = ERODED.branch * strength * amp * finer * TAU * stripes * -wave[1];
      flow = [flow[0] + wall * along[0], flow[1] + wall * along[1]];
      fading *= ERODED.fade;
    }
    norm += amp;
    power += amp * amp;
    amp *= gain;
    finer *= 2;
    const tq = turn(q);
    q = [f(tq[0] * 2), f(tq[1] * 2)];
    turned = turn(turned);
  }
  const h = 0.5 + soften((SPREAD * (1 + ERODED.lift * erosion) * sum) / Math.sqrt(power), KNEE, ROOM);
  return Math.pow(h, 1 + ERODED.hollow * erosion);
}
const referenceField = (res: number, eroded: Eroded): FieldData => {
  const frameSeed = mixSeed(TEST_SETTINGS.seed, eroded.seed);
  return fieldOf(res, (u, v) => reference(f(u), f(v), eroded, frameSeed));
};

/** The field averaged over the square of 2 r + 1 texels around each texel, the borders clamped. */
function blurred(field: FieldData, r: number): FieldData {
  const n = field.width;
  const pass = (src: Float32Array, stride: number, other: number): Float32Array => {
    const out = new Float32Array(src.length);
    for (let line = 0; line < n; line++) {
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += src[line * other + Math.min(Math.max(i + k, 0), n - 1) * stride]!;
        out[line * other + i * stride] = sum / (2 * r + 1);
      }
    }
    return out;
  };
  return { ...field, data: pass(pass(field.data, 1, n), n, 1) };
}

/** The field at a point between texels. */
function sample(field: FieldData, x: number, y: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  return (at(field, x0, y0) * (1 - fx) + at(field, x0 + 1, y0) * fx) * (1 - fy) + (at(field, x0, y0 + 1) * (1 - fx) + at(field, x0 + 1, y0 + 1) * fx) * fy;
}

/**
 * How much more the ground bends across the slope than down it, on the steeper half of the terrain: the mean
 * squared second difference over two texels along the contour, divided by the same along the line of fall.
 * The slope is that of the broad shape, the field averaged over 17 texels. 1 for detail without a direction.
 */
function grain(field: FieldData): number {
  const broad = blurred(field, 8);
  const n = field.width, edge = 16, step = 2;
  const steepness: number[] = [];
  const gradient = (x: number, y: number): Vec2 => [at(broad, x + 1, y) - at(broad, x - 1, y), at(broad, x, y + 1) - at(broad, x, y - 1)];
  for (let y = edge; y < n - edge; y++) for (let x = edge; x < n - edge; x++) steepness.push(Math.hypot(...gradient(x, y)));
  const median = Float64Array.from(steepness).sort()[steepness.length >> 1]!;
  let across = 0, down = 0;
  for (let y = edge; y < n - edge; y++) {
    for (let x = edge; x < n - edge; x++) {
      const g = gradient(x, y);
      const length = Math.hypot(g[0], g[1]);
      if (length <= median) continue;
      const ux = (g[0] / length) * step, uy = (g[1] / length) * step;
      const h = at(field, x, y);
      down += (sample(field, x + ux, y + uy) + sample(field, x - ux, y - uy) - 2 * h) ** 2;
      across += (sample(field, x - uy, y + ux) + sample(field, x + uy, y - ux) - 2 * h) ** 2;
    }
  }
  return across / down;
}

/** What a texel differs by from the mean of its four neighbours, over the texels a test selects: roughness at the scale of a texel. */
function roughness(field: FieldData, select: (h: number) => boolean): { readonly mean: number; readonly count: number } {
  let sum = 0, count = 0;
  for (let y = 1; y < field.height - 1; y++) {
    for (let x = 1; x < field.width - 1; x++) {
      const h = at(field, x, y);
      if (!select(h)) continue;
      sum += Math.abs(h - 0.25 * (at(field, x - 1, y) + at(field, x + 1, y) + at(field, x, y - 1) + at(field, x, y + 1)));
      count++;
    }
  }
  return { mean: sum / Math.max(count, 1), count };
}

test('generate/eroded-noise: it is the sum its definition gives: the massif, the plain octaves held back and the gullies that run down the slope so far', async () => {
  // The CPU sums in float64 at the lattice coordinates the kernel reaches in float32. Each octave of gullies takes
  // its direction from the sums before it, so a difference could grow from octave to octave; measured, the two
  // differ by 4e-6 at the defaults and by 8e-6 with strong fine octaves.
  for (const [change, allowed] of [
    [{}, 3e-5],
    [{ erosion: 0.6, size: 0.11, octaves: 6, gain: 0.65, seed: 4 }, 5e-5],
    [{ erosion: 0.3, size: 0.6, octaves: 12, seed: 8 }, 3e-5],
  ] as const) {
    const eroded = { ...BASE, ...change };
    expectClose(await render(eroded, 129), referenceField(129, eroded), { max: allowed });
  }
});

test('generate/eroded-noise: without erosion it is the fractal noise of the same size, octaves, roughness and seed', async () => {
  for (const [size, octaves, gain, seed] of [[0.25, 8, 0.5, 0], [0.08, 5, 0.7, 3]] as const) {
    const plain = (await renderNode(fractal, { params: { mode: 'fbm', size, octaves, gain, lacunarity: 2, warpStrength: 0, seed } })).out;
    expectClose(await render({ erosion: 0, size, octaves, gain, seed }), plain, { max: 1e-5 });
  }
});

test('generate/eroded-noise: the first two octaves are the massif, which erosion hollows and does not cut', async () => {
  // With two octaves there is nothing but the massif. The fractal noise of the same two octaves is 0.5 + 0.31 x
  // where it lies within 0.1..0.9, the part its soft limit leaves alone: that gives x, and x the eroded height.
  const plain = (await renderNode(fractal, { params: { mode: 'fbm', size: 0.25, octaves: 2, gain: 0.5, lacunarity: 2, warpStrength: 0, seed: 0 } })).out;
  const massif = await render({ octaves: 2 });
  let worst = 0, count = 0;
  for (let i = 0; i < plain.data.length; i++) {
    const p = plain.data[i]!;
    if (Math.abs(p - 0.5) >= KNEE - 1e-3) continue;
    const expected = (0.5 + soften((1 + ERODED.lift) * (p - 0.5), KNEE, ROOM)) ** (1 + ERODED.hollow);
    worst = Math.max(worst, Math.abs(massif.data[i]! - expected));
    count++;
  }
  assert.ok(count > 0.9 * plain.data.length && worst < 2e-5, `${count} texels compared, the worst differs by ${worst}`);
  // The third octave is the first that cuts gullies.
  assert.ok(diff(await render({ octaves: 3 }), massif).rms > 0.02);
});

test('generate/eroded-noise: on the valley floors nothing is left but the massif', async () => {
  // Where the massif lies in the lowest tenth of its range, full erosion leaves neither gullies nor plain detail:
  // eight octaves give there what the two of the massif give, divided by the root of the summed squares of all
  // eight amplitudes. x is read from the fractal noise of the two octaves, as in the test above.
  const gain = 0.5;
  const plain = (await renderNode(fractal, { params: { mode: 'fbm', size: 0.25, octaves: 2, gain, lacunarity: 2, warpStrength: 0, seed: 0 } })).out;
  const full = await render({ octaves: 8, gain });
  const power = (octaves: number): number => Array.from({ length: octaves }, (_, i) => gain ** (2 * i)).reduce((a, b) => a + b, 0);
  let worst = 0, count = 0;
  for (let i = 0; i < plain.data.length; i++) {
    const p = plain.data[i]!;
    if (Math.abs(p - 0.5) >= KNEE - 1e-3) continue;
    const x = (p - 0.5) / SPREAD;                                   // the massif's sum over the root of its own summed squares
    const level = 0.5 + (0.5 * x * Math.sqrt(power(2))) / (1 + gain);
    if (level >= 0.1 - 1e-3) continue;
    const expected = (0.5 + soften(SPREAD * (1 + ERODED.lift) * x * Math.sqrt(power(2) / power(8)), KNEE, ROOM)) ** (1 + ERODED.hollow);
    worst = Math.max(worst, Math.abs(full.data[i]! - expected));
    count++;
  }
  assert.ok(count > 200 && worst < 2e-5, `${count} texels of valley floor, the worst differs by ${worst}`);
});

test('generate/eroded-noise: the gullies run down the slopes, where the detail of plain noise has no direction', async () => {
  // Measured at 513: 0.98 without erosion, 1.54 at half erosion and 3.96 at full erosion.
  const plain = grain(await render({ erosion: 0 }, 513));
  const half = grain(await render({ erosion: 0.5 }, 513));
  const full = grain(await render({ erosion: 1 }, 513));
  assert.ok(plain > 0.85 && plain < 1.18, `plain noise bends ${plain} times as much across the slope as down it`);
  assert.ok(half > 1.3 * plain, `at half erosion the ground bends ${half} times as much across the slope as down it`);
  assert.ok(full > 3 && full > 1.5 * half, `at full erosion the ground bends ${full} times as much across the slope as down it, against ${half} at half`);
  // The same at another size and seed: a property of the node, not of one terrain.
  const other = grain(await render({ size: 0.4, seed: 5 }, 513));
  assert.ok(other > 3, `at size 0.4: ${other}`);
});

test('generate/eroded-noise: the valley floors are smooth and the crests rough, where plain noise is equally rough everywhere', async () => {
  // The lowest and the highest fifth of each terrain, by its own heights.
  const floorsAndCrests = (field: FieldData): { readonly floors: number; readonly crests: number } => {
    const sorted = Float32Array.from(field.data).sort();
    const low = sorted[Math.floor(0.2 * sorted.length)]!, high = sorted[Math.floor(0.8 * sorted.length)]!;
    const floors = roughness(field, (h) => h < low), crests = roughness(field, (h) => h > high);
    assert.ok(floors.count > 40000 && crests.count > 40000);
    return { floors: floors.mean, crests: crests.mean };
  };
  const plain = floorsAndCrests(await render({ erosion: 0 }, 513));
  const worn = floorsAndCrests(await render({ erosion: 0.5 }, 513));
  const full = floorsAndCrests(await render({ erosion: 1 }, 513));
  assert.ok(plain.crests < 1.5 * plain.floors && plain.floors < 1.5 * plain.crests, `plain noise: ${plain.floors} on the floors, ${plain.crests} on the crests`);
  // Measured: plain noise 0.0028 on both; at half erosion 0.0015 and 0.0022; at full erosion 0.0007 and 0.0025.
  assert.ok(worn.crests > 1.3 * worn.floors, `at half erosion: ${worn.floors} on the floors, ${worn.crests} on the crests`);
  assert.ok(full.crests > 2.5 * full.floors, `at full erosion: ${full.floors} on the floors, ${full.crests} on the crests`);
  // The lowest fifth has lost two thirds of its roughness or more, and what is left is the foot of the gullied
  // slopes; the crests have kept most of theirs.
  assert.ok(full.floors < 0.35 * plain.floors, `the floors: ${full.floors} eroded against ${plain.floors} plain`);
  assert.ok(full.crests > 0.7 * plain.crests, `the crests: ${full.crests} eroded against ${plain.crests} plain`);
});

test('generate/eroded-noise: more erosion hollows the slopes further, so more of the terrain lies low', async () => {
  const levels = [0, 0.25, 0.5, 0.75, 1];
  const fields: FieldData[] = [];
  for (const erosion of levels) fields.push(await render({ erosion, size: 0.1 }, 513));
  const means = fields.map((field) => stats(field).mean);
  for (let k = 1; k < levels.length; k++) {
    assert.ok(means[k]! < means[k - 1]! - 0.01, `mean height ${means[k]} at erosion ${levels[k]} against ${means[k - 1]} at ${levels[k - 1]}`);
  }
  // Plain noise has as much ground above its mean as below; eroded, the median lies under the mean.
  const plain = stats(fields[0]!), worn = stats(fields[4]!);
  assert.ok(Math.abs(plain.p50 - plain.mean) < 0.01 && worn.p50 < worn.mean - 0.01, `median ${plain.p50} and mean ${plain.mean} plain, ${worn.p50} and ${worn.mean} eroded`);
});

test('generate/eroded-noise: the heights stay within 0..1 at every setting, with the crests near the top at the defaults', async () => {
  expectStats(await render({}, 513), { min: [0, 0.15], max: [0.85, 1], mean: [0.32, 0.5] });
  for (const change of [{ gain: 1, octaves: 16 }, { erosion: 0.5, gain: 0, octaves: 1 }, { size: 0.01 }, { erosion: 0.2, size: 2 }, { gain: 1, octaves: 16, size: 0.001 }]) {
    const s = stats(await render(change));
    assert.ok(s.min > 0 && s.max < 1, `${JSON.stringify(change)}: ${s.min} to ${s.max}`);
  }
});

test('generate/eroded-noise: another seed gives other mountains, and every level of the ladder the same ones', async () => {
  const base = await render({});
  const other = await render({ seed: 1 });
  assert.ok(diff(base, other).differing > 0.99 * base.data.length);
  expectStats(other, { mean: [0.32, 0.5] });
  const levels = await renderLadder(def, { resolutions: [129, 257, 513], params: { erosion: 1, size: 0.13, gain: 0.6 } });
  expectLadder(levels[129]!.out, levels[257]!.out, { max: 1e-6 });
  expectLadder(levels[129]!.out, levels[513]!.out, { max: 1e-6 });
  // Levels of an 8129 build, whose cells are no power of two of the terrain.
  const build = await renderLadder(def, { resolutions: [128, 255, 509] });
  expectLadder(build[128]!.out, build[255]!.out, { max: 1e-6 });
  expectLadder(build[128]!.out, build[509]!.out, { max: 1e-6 });
});
