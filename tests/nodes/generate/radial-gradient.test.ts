// tests/nodes/generate/radial-gradient.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectClose, expectStats, fieldOf, fixtures, renderNode, type FieldData } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/generate/radial-gradient.ts';

conformance(def);

const saturate = (x: number): number => Math.min(Math.max(x, 0), 1);
/** The profiles by distance d from the centre. The ring lies inside the radius: its crest is half its width in. */
const PROFILES: Readonly<Record<string, (d: number, radius: number, width: number) => number>> = {
  cone: (d, radius) => saturate(1 - d / radius),
  dome: (d, radius) => Math.sqrt(saturate(1 - (d / radius) ** 2)),
  bell: (d, radius) => 1 - saturate(d / radius) ** 2 * (3 - 2 * saturate(d / radius)),
  ring: (d, radius, width) => saturate(1 - Math.abs(d - (radius - width / 2)) / (width / 2)),
};

function reference(res: number, mode: string, center: readonly [number, number], radius: number, width: number): FieldData {
  return fieldOf(res, (u, v) => PROFILES[mode]!(Math.hypot(u - center[0], v - center[1]), radius, width));
}

test('generate/radial-gradient: the modes of the node are the four of this test', () => {
  const mode = def.params.find((param) => param.name === 'mode');
  assert.ok(mode?.kind === 'enum');
  assert.deepEqual(mode.options.map((option) => option.value), Object.keys(PROFILES));
});

test('generate/radial-gradient: a cone of radius 0.25 is the cone of the test fixtures', async () => {
  // max(0, 1 - 4 * distance from the centre): 1 on the centre texel, 0 from 64 texels out.
  const { out } = await renderNode(def, { params: { radius: 0.25 } });
  expectClose(out, fixtures.cone(257), { max: 1e-6 });
  assert.equal(at(out, 128, 128), 1);
  assert.equal(at(out, 128 + 64, 128), 0);
});

for (const mode of Object.keys(PROFILES)) {
  test(`generate/radial-gradient: mode ${mode} is its profile of the distance, for any center and radius`, async () => {
    for (const [center, radius, width] of [[[0.5, 0.5], 0.5, 0.2], [[0.3, 0.65], 0.27, 0.05], [[1.1, -0.2], 1.4, 0.6]] as const) {
      const { out } = await renderNode(def, { params: { mode, center, radius, width } });
      // A distance computed in float32 is off by up to 2e-7. The dome is vertical at its rim, where that moves the
      // value by 3e-4, and a ring of width 0.05 rises by 40 per unit of distance.
      expectClose(out, reference(257, mode, center, radius, width), { max: mode === 'dome' ? 1e-3 : mode === 'ring' ? 1e-5 : 2e-6, rms: 2e-6 });
    }
  });
}

test('generate/radial-gradient: every mode is 0 from the radius outwards, and the hills are 1 on the center', async () => {
  for (const mode of Object.keys(PROFILES)) {
    const { out } = await renderNode(def, { params: { mode, radius: 0.25 } });
    // The crest of the ring is a circle between texels; the summit of a hill is the center texel.
    expectStats(out, { min: [0, 0], max: mode === 'ring' ? [0.99, 1] : [1, 1] });
    let outside = 0;
    for (let y = 0; y < 257; y++) for (let x = 0; x < 257; x++) if (Math.hypot(x - 128, y - 128) >= 64.01) outside = Math.max(outside, at(out, x, y));
    assert.equal(outside, 0, `mode ${mode} outside the radius`);
    assert.equal(at(out, 128, 128), mode === 'ring' ? 0 : 1, `mode ${mode} on the center`);
  }
});

test('generate/radial-gradient: the dome stands above the bell and the cone, and the bell leaves the center level', async () => {
  const [cone, dome, bell] = await Promise.all(['cone', 'dome', 'bell'].map(async (mode) => (await renderNode(def, { params: { mode } })).out));
  let below = 0;
  for (let i = 0; i < dome!.data.length; i++) if (dome!.data[i]! < Math.max(bell!.data[i]!, cone!.data[i]!) - 1e-6) below++;
  assert.equal(below, 0, 'texels where the dome is lower than the bell or the cone');
  // One texel from the summit, a 128th of the radius, the cone has dropped by its full slope and the bell,
  // 3 r^2 - 2 r^3, by 3 / 128 of that.
  const drop = (f: FieldData): number => 1 - at(f, 129, 128);
  assert.ok(drop(bell!) > 0 && drop(bell!) < 0.03 * drop(cone!), `the bell drops ${drop(bell!)} in the first texel, the cone ${drop(cone!)}`);
});

test('generate/radial-gradient: the ring has its foot on the radius, its crest half its width in, and nothing inside', async () => {
  // Radius 96 texels and width 32: 0 up to 64 texels from the center, 1 at 80, 0 again from 96.
  const { out } = await renderNode(def, { params: { mode: 'ring', radius: 0.375, width: 0.125 } });
  for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
    assert.equal(at(out, 128 + 80 * dx, 128 + 80 * dy), 1);
    assert.ok(Math.abs(at(out, 128 + 72 * dx, 128 + 72 * dy) - 0.5) <= 1e-6 && Math.abs(at(out, 128 + 88 * dx, 128 + 88 * dy) - 0.5) <= 1e-6);
    for (const k of [0, 30, 64, 96, 120]) assert.equal(at(out, 128 + k * dx, 128 + k * dy), 0);
  }
  // A ring wider than its radius is as wide as the radius: a cone turned inside out, with its crest half way.
  const wide = await renderNode(def, { params: { mode: 'ring', radius: 0.25, width: 1 } });
  expectClose(wide.out, reference(257, 'ring', [0.5, 0.5], 0.25, 0.25), { max: 2e-6 });
});
