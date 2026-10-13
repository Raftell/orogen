// tests/nodes/filter/slope-warp.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectClose, expectIdentical, expectLadder, fixtures, renderLadder, renderNode, traceNode, type FieldData } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/filter/slope-warp.ts';
import { cubicAt, mapField, pathEnd, smoothed } from './_reference.ts';

conformance(def);

const N = 257;
const L = N - 1;

/** The node on the CPU: each texel reads the terrain where 11 steps up the slope of the smoothed terrain end, `reach` texels away on ground of 45 degrees. */
function pushed(src: FieldData, reach: number, sigma: number): FieldData {
  const shape = sigma > 0 ? smoothed(src, sigma) : src;
  return mapField(src, (x, y) => cubicAt(src, ...pathEnd(shape, x, y, reach, 11)));
}

test('filter/slope-warp: each point takes the height found the distance along the path up the slope of the smoothed terrain, or down it', async () => {
  // A distance of 0.03 is 7.68 texels at 257, a radius of 0.02 a Gaussian of 5.12 texels.
  const src = await fixtures.fbm(N);
  const down = await renderNode(def, { inputs: { in: src }, params: { distance: 0.03, radius: 0.02 } });
  // The path is followed in float32 over a terrain smoothed in float32, on a terrain that changes by up to 0.05
  // a texel: the two agree to 1e-5 rms, and at a texel in 66049 whose path passes a crest, where the last bit of
  // the smoothed terrain decides which way it goes on, by up to 0.003.
  expectClose(down.out, pushed(src, 7.68, 5.12), { max: 4e-3, rms: 5e-5 });
  const up = await renderNode(def, { inputs: { in: src }, params: { distance: 0.03, radius: 0.02, mode: 'uphill' } });
  expectClose(up.out, pushed(src, -7.68, 5.12), { max: 4e-3, rms: 5e-5 });
});

test('filter/slope-warp: downhill moves an even slope down itself, in proportion to its steepness, and uphill up it', async () => {
  // rampX rises towards +X at 0.25 metres per metre: it moves by a quarter of the distance, 0.01.
  const shift = 0.04 * 0.25;
  const down = await renderNode(def, { inputs: { in: 'rampX' }, params: { distance: 0.04 } });
  const up = await renderNode(def, { inputs: { in: 'rampX' }, params: { distance: 0.04, mode: 'uphill' } });
  for (const x of [48, 128, 200]) {
    // What was at x + shift is now at x: the slope has moved towards -X, downhill, and is higher at every point.
    assert.ok(Math.abs(at(down.out, x, 100) - (x / L + shift)) < 1e-5, `downhill at ${x}: ${at(down.out, x, 100)}`);
    assert.ok(Math.abs(at(up.out, x, 100) - (x / L - shift)) < 1e-5, `uphill at ${x}: ${at(up.out, x, 100)}`);
  }
  // The smoothed slope is the slope up to the border, so the push is whole there too. (Smoothed by a blur that
  // continues the terrain level beyond the border, the slope is 0.88 of itself three texels from it, and the
  // terrain is pushed 0.0012 less there than inside: a frame.) A texel reads from inside the terrain here.
  for (const y of [0, 100, L]) {
    assert.ok(Math.abs(at(down.out, 3, y) - (3 / L + shift)) < 1e-5, `downhill three texels from the border, row ${y}: ${at(down.out, 3, y)}`);
    assert.ok(Math.abs(at(up.out, L - 3, y) - ((L - 3) / L - shift)) < 1e-5, `uphill three texels from the border, row ${y}: ${at(up.out, L - 3, y)}`);
  }
});

test('filter/slope-warp: downhill swells a peak and uphill pinches it, and level ground stays as it is', async () => {
  // The cone stands on a floor: beyond 0.25 from its centre the ground is level.
  const cone = fixtures.cone(N);
  const down = await renderNode(def, { inputs: { in: cone }, params: { distance: 0.03, radius: 0.004 } });
  const up = await renderNode(def, { inputs: { in: cone }, params: { distance: 0.03, radius: 0.004, mode: 'uphill' } });
  // On the flank, 0.125 from the centre, the cone is 0.5 high and at 45 degrees, where the push is the whole
  // distance: the flank moves 0.03, which is 0.12 of height.
  const flank = at(cone, 160, 128), moved = 4 * 0.03;
  assert.ok(Math.abs(at(down.out, 160, 128) - (flank + moved)) < 2e-3, `downhill the flank is at ${at(down.out, 160, 128)}`);
  assert.ok(Math.abs(at(up.out, 160, 128) - (flank - moved)) < 2e-3, `uphill the flank is at ${at(up.out, 160, 128)}`);
  let changed = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (Math.hypot(x - 128, y - 128) > 80 && (at(down.out, x, y) !== 0 || at(up.out, x, y) !== 0)) changed++;
  assert.equal(changed, 0, 'texels of the floor that moved');

  // The path follows the slope and ends at the crest: within the distance of the summit a point takes a height
  // near the summit's, and none reads the far side, as one stride along the slope would, which leaves a pit of
  // 0.12 around the summit. A path of 11 steps of 0.7 texels overshoots this cone's tip, which is a point, by
  // half a step at most: by the height of that, 0.005, the swollen peak is uneven.
  for (const x of [129, 131, 134]) assert.ok(at(down.out, x, 128) > 0.95, `${x - 128} texels from the summit the swollen peak is ${at(down.out, x, 128)} high`);
  for (let x = 128; x < 190; x++) assert.ok(at(down.out, x + 1, 128) <= at(down.out, x, 128) + 0.006, `the swollen peak rises again at ${x + 1}`);
});

test('filter/slope-warp: a larger radius follows the broad shape: the push no longer turns with every bump', async () => {
  // Pushed along the slope of every bump, neighbouring texels are read from places far apart and the terrain
  // comes out torn; pushed along the slope of its broad shape, it keeps its surface.
  const src = await fixtures.fbm(N);
  const rough = await renderNode(def, { inputs: { in: src }, params: { distance: 0.02, radius: 0.0005 } });
  const smooth = await renderNode(def, { inputs: { in: src }, params: { distance: 0.02, radius: 0.03 } });
  const tear = (f: FieldData): number => {
    let sum = 0;
    for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) sum += (at(f, x - 1, y) - 2 * at(f, x, y) + at(f, x + 1, y)) ** 2;
    return Math.sqrt(sum);
  };
  assert.ok(tear(smooth.out) < 0.8 * tear(rough.out), `the pushed terrain bends ${tear(smooth.out)} with a wide radius and ${tear(rough.out)} with none`);
});

test('filter/slope-warp: no distance gives the input itself', async () => {
  const src = await fixtures.fbm(N);
  for (const distance of [0, -0.1]) {
    const { outputs, report } = await traceNode(def, { inputs: { in: src }, params: { distance } });
    expectIdentical(outputs.out, src);
    assert.equal(report.nodes.node.peakBytes, 0, 'an alias of the input: no texture, no pass');
  }
});

test('filter/slope-warp: the push is the same at two levels of the ladder', async () => {
  const levels = await renderLadder(def, { inputs: { in: 'terrain' }, params: { distance: 0.03, radius: 0.02 } });
  expectLadder(levels[257].out, levels[513].out, { rel: 0.01 });
});
