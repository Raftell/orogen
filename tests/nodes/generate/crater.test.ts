// tests/nodes/generate/crater.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectClose, expectStats, fieldOf, fixtures, renderNode, stats } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/generate/crater.ts';
import { deviation, mapField, mean, ring } from './_land-probe.ts';

conformance(def);

/** The crater alone: no terrain connected, so it is cut into level ground at `height`. */
const alone = { in: null } as const;

test('generate/crater: without a terrain the ground is level at the ground level, far from the crater exactly', async () => {
  // A radius of 0.05: the ejecta ends 8 radii from the center, inside the terrain.
  const { out } = await renderNode(def, { inputs: alone, params: { radius: 0.05 } });
  for (const [x, y] of [[0, 0], [256, 0], [0, 256], [256, 256], [128, 4], [4, 128]] as const) {
    assert.equal(at(out, x, y), 0.5, `texel (${x}, ${y}), more than 8 radii from the center`);
  }
  const lower = await renderNode(def, { inputs: alone, params: { radius: 0.05, height: 0.3 } });
  expectClose(lower.out, mapField(out, (value) => value - 0.2), { max: 1e-6 });
});

test('generate/crater: the floor lies the depth below the ground, and a central peak rises from it', async () => {
  for (const depth of [0.1, 0.3]) {
    const bowl = await renderNode(def, { inputs: alone, params: { depth, peak: 0 } });
    assert.ok(Math.abs(at(bowl.out, 128, 128) - (0.5 - depth)) <= 1e-6, `at depth ${depth} the center of a plain bowl is at ${at(bowl.out, 128, 128)}`);
    expectStats(bowl.out, { min: [0.5 - depth - 1e-6, 0.5 - depth + 1e-6] });
    // The peak is a part of the depth: at 0.5 it stands half as high as the crater is deep.
    const peaked = await renderNode(def, { inputs: alone, params: { depth, peak: 0.5 } });
    assert.ok(Math.abs(at(peaked.out, 128, 128) - (0.5 - 0.5 * depth)) <= 1e-6, `at depth ${depth} the central peak tops at ${at(peaked.out, 128, 128)}`);
    // Around the peak the floor is still at its depth.
    assert.ok(stats(peaked.out).min < 0.5 - 0.9 * depth, `the floor around the peak is at ${stats(peaked.out).min}`);
  }
});

test('generate/crater: the rim stands above the ground at the radius, and the ejecta thins out beyond it', async () => {
  const radius = 0.2, rim = 0.06;
  const { out } = await renderNode(def, { inputs: alone, params: { radius, rim, ejecta: 0 } });
  // The rim wanders by up to 6 % of the radius, and its crest is rounded: around the nominal radius the ground
  // stands well above level, and nowhere higher than the rim height.
  const crest = mean(ring(out, 0.5, 0.5, radius));
  assert.ok(crest > 0.5 + 0.4 * rim, `the mean height at the radius is ${crest}`);
  expectStats(out, { max: [0.5 + 0.6 * rim, 0.5 + rim] });
  const heights = [1.15, 1.5, 2.0, 2.4].map((k) => mean(ring(out, 0.5, 0.5, k * radius)));
  for (let k = 1; k < heights.length; k++) assert.ok(heights[k]! < heights[k - 1]! && heights[k]! > 0.5, `the ejecta at ring ${k} is at ${heights[k]}`);
  // Inside, the wall falls from the rim to the floor.
  assert.ok(mean(ring(out, 0.5, 0.5, 0.7 * radius)) < 0.5 && mean(ring(out, 0.5, 0.5, 0.4 * radius)) < mean(ring(out, 0.5, 0.5, 0.7 * radius)));
});

test('generate/crater: ejecta roughens the ground outside the rim and leaves the bowl alone', async () => {
  const clean = await renderNode(def, { inputs: alone, params: { ejecta: 0 } });
  const strewn = await renderNode(def, { inputs: alone, params: { ejecta: 1 } });
  // Defaults: radius 0.25. At 1.5 radii the streaks make the ground uneven around the crater.
  assert.ok(deviation(ring(strewn.out, 0.5, 0.5, 0.375, 720)) > 2 * deviation(ring(clean.out, 0.5, 0.5, 0.375, 720)), 'streaks around the crater');
  let worst = 0;
  for (let y = 88; y <= 168; y++) for (let x = 88; x <= 168; x++) worst = Math.max(worst, Math.abs(at(strewn.out, x, y) - at(clean.out, x, y)));
  assert.ok(worst <= 1e-6, `inside 0.6 radii the bowl moved by ${worst}`);
});

test('generate/crater: without flattening the crater is added to the terrain, and on a slope it lies on the slope', async () => {
  const flat = await renderNode(def, { inputs: alone });
  // Without flattening: the terrain plus what the impact added to level ground.
  const terrain = fixtures.terrain(257);
  const added = await renderNode(def, { inputs: { in: terrain }, params: { flatten: 0 } });
  expectClose(added.out, mapField(terrain, (value, x, y) => value + at(flat.out, x, y) - 0.5), { max: 1e-6 });
  // The ground an impact strikes is the plane that fits the terrain under the crater. A terrain that is a plane
  // is that ground itself: flattening finds nothing to wipe out, and the crater lies tilted on the slope.
  const slope = fieldOf(257, (u, v) => 0.3 + 0.3 * u + 0.1 * v);
  const tilted = await renderNode(def, { inputs: { in: slope } });
  expectClose(tilted.out, mapField(slope, (value, x, y) => value + at(flat.out, x, y) - 0.5), { max: 1e-5 });
});

test('generate/crater: flattening wipes out the relief of the terrain inside the rim and leaves the slope the crater lies on', async () => {
  // A slope with bumps 0.03 high, a twentieth of the terrain apart: small beside a crater of radius 0.25.
  const bump = (u: number, v: number): number => 0.03 * Math.sin(40 * Math.PI * u) * Math.sin(40 * Math.PI * v);
  const slope = fieldOf(257, (u, v) => 0.3 + 0.3 * u + 0.1 * v);
  const bumpy = fieldOf(257, (u, v) => 0.3 + 0.3 * u + 0.1 * v + bump(u, v));
  const flat = await renderNode(def, { inputs: alone });
  const added = await renderNode(def, { inputs: { in: bumpy }, params: { flatten: 0 } });
  const stamped = await renderNode(def, { inputs: { in: bumpy } });
  const half = await renderNode(def, { inputs: { in: bumpy }, params: { flatten: 0.5 } });
  let inside = 0, halfway = 0, outside = 0;
  for (let y = 0; y <= 256; y++) {
    for (let x = 0; x <= 256; x++) {
      const r = Math.hypot(x - 128, y - 128) / 64;                 // in radii: the default radius is 0.25
      // What the crater alone makes of the slope without the bumps.
      const clean = at(slope, x, y) + at(flat.out, x, y) - 0.5;
      if (r < 0.8) {
        inside = Math.max(inside, Math.abs(at(stamped.out, x, y) - clean));
        halfway = Math.max(halfway, Math.abs(at(half.out, x, y) - clean - 0.5 * bump(x / 256, y / 256)));
      }
      if (r > 1.75) outside = Math.max(outside, Math.abs(at(stamped.out, x, y) - at(added.out, x, y)));
    }
  }
  // The plane is fitted through the terrain at vertices of the coarsest ladder level, bumps included, which
  // moves it by a part of their height.
  assert.ok(inside < 0.009, `inside the rim ${inside} is left of bumps 0.03 high`);
  assert.ok(halfway < 0.009, `at half flattening the ground inside the rim is ${halfway} from half the bumps`);
  assert.ok(outside <= 1e-6, `outside the rim the terrain changed by ${outside} more than the ejecta adds`);
});

test('generate/crater: an impact moves the ground by a few of its depths at the most', async () => {
  // A pillar 0.5 high under a crater 0.02 deep: flattening takes three depths off its top and no more.
  const pillar = fieldOf(257, (u, v) => (Math.hypot(u - 0.5, v - 0.5) < 0.05 ? 0.9 : 0.4));
  const added = await renderNode(def, { inputs: { in: pillar }, params: { flatten: 0, depth: 0.02, rim: 0.01, peak: 0 } });
  const stamped = await renderNode(def, { inputs: { in: pillar }, params: { depth: 0.02, rim: 0.01, peak: 0 } });
  const cut = at(added.out, 128, 128) - at(stamped.out, 128, 128);
  assert.ok(cut > 0.04 && cut <= 0.06 + 1e-6, `the top of the pillar came down by ${cut}; three depths are 0.06`);
});

test('generate/crater: the center and the radius place and size the crater', async () => {
  // Half the radius, moved by a quarter of the terrain: texel 192 + k, 64 + k of the small crater is texel 128 + 2k of the large one.
  const large = await renderNode(def, { inputs: alone, params: { radius: 0.2 } });
  const small = await renderNode(def, { inputs: alone, params: { radius: 0.1, center: [0.75, 0.25] } });
  let worst = 0;
  for (let j = -60; j <= 60; j++) for (let i = -60; i <= 60; i++) worst = Math.max(worst, Math.abs(at(small.out, 192 + i, 64 + j) - at(large.out, 128 + 2 * i, 128 + 2 * j)));
  assert.ok(worst <= 1e-6, `the two craters differ by up to ${worst}; allowed 1e-6`);
});
