// tests/nodes/generate/eroded-noise.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  at, conformance, diff, expectClose, expectLadder, expectStats, fieldOf, renderLadder, renderNode, stats, TEST_SETTINGS, type FieldData,
} from '../../helpers/index.ts';
import { mixSeed } from '../../../src/core/api.ts';
import def, { ERODED } from '../../../src/core/nodes/generate/eroded-noise.ts';
import fractal from '../../../src/core/nodes/generate/fractal-noise.ts';
import { lattice, octaveSeed, shift, simplexD, soften, turn, type Vec2 } from './_noise-cpu.ts';

conformance(def);

const f = Math.fround;

interface Eroded { readonly size: number; readonly erosion: number; readonly octaves: number; readonly gain: number; readonly seed: number }
const BASE: Eroded = { size: 0.25, erosion: 0.75, octaves: 8, gain: 0.5, seed: 0 };
const render = async (eroded: Partial<Eroded>, res = 257): Promise<FieldData> => (await renderNode(def, { res, params: { ...BASE, ...eroded } })).out;

// The constants of the kernel that the node does not export.
const CREASE = 0.08, SPREAD = 0.31, KNEE = 0.4, ROOM = 0.1;

/** The kernel, written again for the CPU with the twin of its library. `frameSeed` is mixSeed(project seed, node seed). */
function reference(u: number, v: number, eroded: Eroded, frameSeed: number): number {
  const erosion = f(eroded.erosion), top = Math.sqrt(1 + CREASE * CREASE) - CREASE;
  let q = lattice([u, v], f(1 / eroded.size));
  let sum = 0, norm = 0, power = 0, amp = 1, finer = 1;
  let turned: Vec2 = [1, 0];
  let slope: Vec2 = [0, 0];
  for (let i = 0; i < eroded.octaves; i++) {
    const s = octaveSeed(mixSeed(frameSeed, 0), i);
    const move = shift(s);
    const [n, dx, dy] = simplexD(f(q[0] + move[0]), f(q[1] + move[1]), s);
    const reach = Math.sqrt(n * n + CREASE * CREASE);
    const blend = i === 0 ? 0 : erosion * ERODED.ridge;
    const value = n + (1 - (2 * (reach - CREASE)) / top - n) * blend;
    const rate = 1 + (((-2 / top) * n) / reach - 1) * blend;
    let keep = 1 / (1 + erosion * ERODED.damping * (slope[0] ** 2 + slope[1] ** 2));
    if (i > 0) {
      const level = Math.min(Math.max((0.5 + (0.5 * sum) / norm - 0.15) / 0.7, 0), 1);
      keep *= 1 + (2 * level * level * (3 - 2 * level) - 1) * erosion;
    }
    sum += amp * keep * value;
    const scale = amp * keep * finer * rate;
    slope = [slope[0] + scale * (dx * turned[0] + dy * turned[1]), slope[1] + scale * (dy * turned[0] - dx * turned[1])];
    norm += amp;
    power += amp * amp;
    amp *= f(eroded.gain);
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

/** What a texel differs by from the mean of its four neighbours, summed over the texels a test selects: roughness at the scale of a texel. */
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

test('generate/eroded-noise: it is the sum its definition gives, each octave held back by the slope and the height of those before', async () => {
  // The CPU sums in float64 at the lattice coordinates the kernel reaches in float32. Measured, the two differ by
  // up to 1e-5 at the defaults and by 6e-5 at full erosion with strong fine octaves.
  for (const [change, allowed] of [
    [{}, 3e-5],
    [{ erosion: 1, size: 0.11, octaves: 6, gain: 0.65, seed: 4 }, 2e-4],
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
  const worn = floorsAndCrests(await render({ erosion: 0.75 }, 513));
  const full = floorsAndCrests(await render({ erosion: 1 }, 513));
  // Measured: plain noise 0.0028 on both; at the default erosion 0.00038 and 0.0021; at full erosion 0.00021 and 0.0026.
  assert.ok(plain.crests < 1.5 * plain.floors && plain.floors < 1.5 * plain.crests, `plain noise: ${plain.floors} on the floors, ${plain.crests} on the crests`);
  assert.ok(worn.crests > 4 * worn.floors, `at the default erosion: ${worn.floors} on the floors, ${worn.crests} on the crests`);
  assert.ok(full.crests > 8 * full.floors, `at full erosion: ${full.floors} on the floors, ${full.crests} on the crests`);
  // The floors have lost three quarters of their roughness or more; the crests have kept most of theirs.
  assert.ok(worn.floors < 0.25 * plain.floors, `the floors: ${worn.floors} worn against ${plain.floors} plain`);
  assert.ok(worn.crests > 0.6 * plain.crests, `the crests: ${worn.crests} worn against ${plain.crests} plain`);
});

test('generate/eroded-noise: any erosion smooths most of the terrain, and more of it hollows the slopes further', async () => {
  const levels = [0, 0.25, 0.5, 0.75, 1];
  const fields: FieldData[] = [];
  for (const erosion of levels) fields.push(await render({ erosion, size: 0.1 }, 513));
  const rough = fields.map((field) => roughness(field, () => true).mean);
  const means = fields.map((field) => stats(field).mean);
  for (let k = 1; k < levels.length; k++) {
    // The slopes and floors lose their detail with the first quarter of the erosion; beyond it the crests grow
    // sharper as fast as the rest grows smoother, and the whole stays at well under half the roughness of plain noise.
    assert.ok(rough[k]! < 0.5 * rough[0]!, `roughness ${rough[k]} at erosion ${levels[k]} against ${rough[0]} without`);
    // Hollow slopes: wide valley floors and narrow crests, so more of the terrain lies low.
    assert.ok(means[k]! < means[k - 1]! - 0.02, `mean height ${means[k]} at erosion ${levels[k]} against ${means[k - 1]} at ${levels[k - 1]}`);
  }
  // Plain noise has as much ground above its mean as below; eroded, the median lies well under the mean.
  const plain = stats(fields[0]!), worn = stats(fields[4]!);
  assert.ok(Math.abs(plain.p50 - plain.mean) < 0.01 && worn.p50 < worn.mean - 0.02, `median ${plain.p50} and mean ${plain.mean} plain, ${worn.p50} and ${worn.mean} eroded`);
});

test('generate/eroded-noise: the heights stay within 0..1 at every setting, with the crests near the top at the defaults', async () => {
  expectStats(await render({}, 513), { min: [0, 0.15], max: [0.8, 1], mean: [0.3, 0.42] });
  for (const change of [{ erosion: 1 }, { erosion: 1, gain: 1, octaves: 16 }, { erosion: 0.5, gain: 0, octaves: 1 }, { erosion: 1, size: 0.01 }, { erosion: 0.2, size: 2 }]) {
    const s = stats(await render(change));
    assert.ok(s.min > 0 && s.max < 1, `${JSON.stringify(change)}: ${s.min} to ${s.max}`);
  }
});

test('generate/eroded-noise: another seed gives other mountains, and every level of the ladder the same ones', async () => {
  const base = await render({});
  const other = await render({ seed: 1 });
  assert.ok(diff(base, other).differing > 0.99 * base.data.length);
  expectStats(other, { mean: [0.28, 0.44] });
  const levels = await renderLadder(def, { resolutions: [129, 257, 513], params: { erosion: 1, size: 0.13, gain: 0.6 } });
  expectLadder(levels[129]!.out, levels[257]!.out, { max: 1e-6 });
  expectLadder(levels[129]!.out, levels[513]!.out, { max: 1e-6 });
  // Levels of an 8129 build, whose cells are no power of two of the terrain.
  const build = await renderLadder(def, { resolutions: [128, 255, 509] });
  expectLadder(build[128]!.out, build[255]!.out, { max: 1e-6 });
  expectLadder(build[128]!.out, build[509]!.out, { max: 1e-6 });
});
