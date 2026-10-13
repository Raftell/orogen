// tests/nodes/generate/gradient.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectClose, expectStats, fieldOf, fixtures, renderNode, type FieldData } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/generate/gradient.ts';

conformance(def);

const saturate = (x: number): number => Math.min(Math.max(x, 0), 1);
const PROFILES: Readonly<Record<string, (t: number) => number>> = {
  linear: (t) => saturate(t),
  mirrored: (t) => saturate(1 - Math.abs(2 * t - 1)),
  smooth: (t) => saturate(t) ** 2 * (3 - 2 * saturate(t)),
};

/** The node's definition, in float64: the ramp is centred on the terrain's centre plus the offset. */
function reference(res: number, mode: string, angle: number, size: number, offset: readonly [number, number]): FieldData {
  const r = (angle * Math.PI) / 180;
  return fieldOf(res, (u, v) => PROFILES[mode]!(((u - 0.5 - offset[0]) * Math.cos(r) + (v - 0.5 - offset[1]) * Math.sin(r)) / size + 0.5));
}

test('generate/gradient: the modes of the node are the three of this test', () => {
  const mode = def.params.find((param) => param.name === 'mode');
  assert.ok(mode?.kind === 'enum');
  assert.deepEqual(mode.options.map((option) => option.value), Object.keys(PROFILES));
});

test('generate/gradient: at its defaults it rises from 0 on the left border to 1 on the right, and the angle turns it clockwise', async () => {
  const rampX = fixtures.rampX(257);
  const rampY = fixtures.rampY(257);
  const flipped = (f: FieldData): FieldData => ({ ...f, data: f.data.map((value) => 1 - value) });
  expectClose((await renderNode(def)).out, rampX, { max: 1e-6 });
  // 90 degrees is +Y, down the screen (engine.md 1.8).
  expectClose((await renderNode(def, { params: { angle: 90 } })).out, rampY, { max: 1e-6 });
  expectClose((await renderNode(def, { params: { angle: 180 } })).out, flipped(rampX), { max: 1e-6 });
  expectClose((await renderNode(def, { params: { angle: 270 } })).out, flipped(rampY), { max: 1e-6 });
});

for (const mode of Object.keys(PROFILES)) {
  test(`generate/gradient: mode ${mode} is its profile along the direction, for any angle, length and offset`, async () => {
    for (const [angle, size, offset] of [[30, 0.6, [0.1, -0.05]], [215, 1.7, [0, 0]], [300, 0.2, [-0.2, 0.3]]] as const) {
      const { out } = await renderNode(def, { params: { mode, angle, size, offset } });
      expectClose(out, reference(257, mode, angle, size, offset), { max: 2e-6 });
    }
  });
}

test('generate/gradient: the length is the distance from 0 to 1, centred on the terrain', async () => {
  // Half the terrain: 0 up to a quarter in, 1 from three quarters on, and the middle of the ramp in the middle.
  const { out } = await renderNode(def, { params: { size: 0.5 } });
  for (const y of [0, 100, 256]) {
    for (let x = 0; x <= 64; x++) assert.equal(at(out, x, y), 0);
    for (let x = 192; x <= 256; x++) assert.equal(at(out, x, y), 1);
    assert.ok(Math.abs(at(out, 128, y) - 0.5) <= 1e-6 && Math.abs(at(out, 96, y) - 0.25) <= 1e-6);
  }
});

test('generate/gradient: the offset moves the ramp without changing it', async () => {
  // A quarter of the terrain to the right is 64 texels at 257.
  const base = await renderNode(def, { params: { size: 0.5, angle: 20 } });
  const moved = await renderNode(def, { params: { size: 0.5, angle: 20, offset: [0.25, 0] } });
  let worst = 0;
  for (let y = 0; y < 257; y++) for (let x = 64; x < 257; x++) worst = Math.max(worst, Math.abs(at(moved.out, x, y) - at(base.out, x - 64, y)));
  assert.ok(worst <= 2e-6, `the moved ramp differs from the ramp by up to ${worst}; allowed 2e-6`);
});

test('generate/gradient: mirrored is a ridge along the middle of the ramp, and smooth meets its two ends level', async () => {
  const mirrored = (await renderNode(def, { params: { mode: 'mirrored', size: 0.5 } })).out;
  const linear = (await renderNode(def, { params: { size: 0.5 } })).out;
  const smooth = (await renderNode(def, { params: { mode: 'smooth', size: 0.5 } })).out;
  expectStats(mirrored, { min: [0, 0], max: [1, 1] });
  for (let k = 0; k <= 128; k++) {
    // The same height at the same distance on either side of the crest, which is the centre column.
    assert.ok(Math.abs(at(mirrored, 128 - k, 77) - at(mirrored, 128 + k, 77)) <= 1e-6);
    assert.ok(Math.abs(at(mirrored, 128 - k, 77) - Math.max(0, 1 - k / 64)) <= 1e-6);
  }
  // Smooth has the ends and the middle of the linear ramp, and leaves each end with a tenth of its slope or less.
  for (const x of [64, 128, 192]) assert.ok(Math.abs(at(smooth, x, 5) - at(linear, x, 5)) <= 1e-6);
  const firstStep = (f: FieldData): number => at(f, 66, 5) - at(f, 64, 5);
  assert.ok(firstStep(smooth) > 0 && firstStep(smooth) < 0.1 * firstStep(linear), `first step ${firstStep(smooth)} against ${firstStep(linear)}`);
});
