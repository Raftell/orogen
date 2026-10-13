// tests/nodes/color/natural.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, compareLadder, conformance, expectIdentical, fieldOf, renderLadder, renderNode, stats, type FieldData } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/color/natural.ts';
import { COLOR, luma } from './_reference.ts';

conformance(def);

const MODES = ['alpine', 'temperate', 'desert', 'volcanic', 'arctic'] as const;
/** No variation: the color is a function of the shape of the terrain alone. */
const PLAIN = { variation: 0 } as const;
/** A project without a sea, which the test settings have at 0.25. */
const NO_SEA = { seaLevel: 0 } as const;

/** Level ground at one height. */
const level = (height: number): FieldData => fieldOf(257, () => height);
/** A plane that rises towards +X at `tilt` degrees around the height 0.3 at its middle. With the test settings a rise of k across the terrain is a slope of k / 4. */
const plane = (tilt: number, middle = 0.3): FieldData => fieldOf(257, (u) => middle + 4 * Math.tan((tilt * Math.PI) / 180) * (u - 0.5));
/** The color at the middle of the picture. */
const middle = (f: FieldData): readonly [number, number, number] => [at(f, 128, 128, 0), at(f, 128, 128, 1), at(f, 128, 128, 2)];
const lumaOf = (c: readonly [number, number, number]): number => luma(c[0], c[1], c[2]);
/** How far green stands above the other two channels: above 0 for vegetation, around 0 or below for rock, sand and snow. */
const greenness = (c: readonly [number, number, number]): number => c[1] - Math.max(c[0], c[2]);
const mean = (f: FieldData): readonly [number, number, number] => [stats(f, 0).mean, stats(f, 1).mean, stats(f, 2).mean];
const distance = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

test('color/natural: every color is one a surface can have: opaque, and each channel within 0..1', async () => {
  for (const mode of MODES) {
    const { out } = await renderNode(def, { inputs: { in: 'terrain', flow: 'cone', snow: 'mask' }, params: { mode, variation: 1 } });
    for (const channel of [0, 1, 2] as const) {
      const s = stats(out, channel);
      assert.ok(s.min >= 0 && s.max <= 1, `${mode}: channel ${channel} spans ${s.min} to ${s.max}`);
    }
    assert.ok(stats(out, 3).min === 1 && stats(out, 3).max === 1, `${mode}: the alpha is not 1 everywhere`);
  }
});

test('color/natural: without variation level ground has one color, and a plane one color along each of its contours', async () => {
  const flat = (await renderNode(def, { inputs: { in: level(0.2), flow: null, snow: null }, params: PLAIN, settings: NO_SEA })).out;
  for (const channel of [0, 1, 2] as const) assert.ok(stats(flat, channel).max - stats(flat, channel).min <= COLOR, `channel ${channel} of level ground varies`);
  // rampX rises along x alone: every column is one height, and one color.
  const ramp = (await renderNode(def, { inputs: { in: 'rampX', flow: null, snow: null }, params: PLAIN, settings: NO_SEA })).out;
  for (const x of [3, 60, 128, 200, 253]) {
    for (const channel of [0, 1, 2] as const) {
      for (const y of [0, 77, 256]) assert.ok(Math.abs(at(ramp, x, y, channel) - at(ramp, x, 128, channel)) <= COLOR, `column ${x} varies along its contour`);
    }
  }
  // With variation the same contour is mottled.
  const mottled = (await renderNode(def, { inputs: { in: 'rampX', flow: null, snow: null }, settings: NO_SEA })).out;
  let spread = 0;
  for (let y = 0; y < 257; y++) spread = Math.max(spread, Math.abs(at(mottled, 128, y, 1) - at(mottled, 128, 128, 1)));
  assert.ok(spread > 5 * COLOR, `along a contour the green varies by ${spread} at the most`);
});

test('color/natural: gentle low ground is vegetation and steep ground is rock, in every landscape that is not a desert', async () => {
  for (const mode of ['alpine', 'temperate'] as const) {
    const gentle = middle((await renderNode(def, { inputs: { in: plane(8), flow: null, snow: null }, params: { ...PLAIN, mode }, settings: NO_SEA })).out);
    const wall = middle((await renderNode(def, { inputs: { in: plane(82), flow: null, snow: null }, params: { ...PLAIN, mode }, settings: NO_SEA })).out);
    assert.ok(greenness(gentle) > 0.04, `${mode}: gentle ground is ${gentle.join(', ')}`);
    assert.ok(greenness(wall) < 0.01, `${mode}: a wall is ${wall.join(', ')}`);
    assert.ok(distance(gentle, wall) > 0.15, `${mode}: gentle ground and a wall differ by ${distance(gentle, wall)}`);
  }
  // The steeper the ground, the less vegetation it carries: greenness falls from the meadow to bare rock.
  let last = Infinity;
  for (const tilt of [5, 40, 56, 62, 68]) {
    const g = greenness(middle((await renderNode(def, { inputs: { in: plane(tilt), flow: null, snow: null }, params: PLAIN, settings: NO_SEA })).out));
    assert.ok(g <= last + COLOR, `at ${tilt} degrees the greenness is ${g}, above the ${last} of gentler ground`);
    last = g;
  }
  assert.ok(last < 0.01, `at 68 degrees the greenness is still ${last}`);
});

test('color/natural: vegetation is graded by height and ends below the summits', async () => {
  const low = middle((await renderNode(def, { inputs: { in: level(0.1), flow: null, snow: null }, params: PLAIN, settings: NO_SEA })).out);
  const high = middle((await renderNode(def, { inputs: { in: level(0.5), flow: null, snow: null }, params: PLAIN, settings: NO_SEA })).out);
  const summit = middle((await renderNode(def, { inputs: { in: level(0.95), flow: null, snow: null }, params: PLAIN, settings: NO_SEA })).out);
  // The meadow of low ground is green, the grass of high ground yellower, the summit bare and pale.
  assert.ok(greenness(low) > 0.04, `the meadow is ${low.join(', ')}`);
  assert.ok(greenness(high) < greenness(low) - 0.03 && greenness(high) > greenness(summit) + 0.01, `the high grass is ${high.join(', ')}, the summit ${summit.join(', ')}`);
  assert.ok(Math.abs(summit[0] - summit[1]) < 0.05 && lumaOf(summit) > lumaOf(low), `the summit is ${summit.join(', ')}`);
  // Steep ground that still carries woods low down is bare rock high up.
  const lowSlope = middle((await renderNode(def, { inputs: { in: plane(50, 0.1), flow: null, snow: null }, params: PLAIN, settings: NO_SEA })).out);
  const highSlope = middle((await renderNode(def, { inputs: { in: plane(50, 0.6), flow: null, snow: null }, params: PLAIN, settings: NO_SEA })).out);
  assert.ok(greenness(lowSlope) > 0.03 && greenness(highSlope) < 0.01, `a slope of 50 degrees is ${lowSlope.join(', ')} low down and ${highSlope.join(', ')} high up`);
});

test('color/natural: sheltered ground is darker and lusher than open ground at the same height', async () => {
  // A dimple 51 m deep in level ground: its floor is level too, and sheltered by its sides.
  const dimple = fieldOf(257, (u, v) => 0.3 - 0.05 * Math.exp(-((u - 0.5) ** 2 + (v - 0.5) ** 2) / (2 * 0.03 ** 2)));
  const { out } = await renderNode(def, { inputs: { in: dimple, flow: null, snow: null }, params: PLAIN, settings: NO_SEA });
  const open: readonly [number, number, number] = [at(out, 5, 5, 0), at(out, 5, 5, 1), at(out, 5, 5, 2)];
  const floor = middle(out);
  assert.ok(lumaOf(floor) < lumaOf(open) - 0.02, `the floor of the hollow has the luminance ${lumaOf(floor)}, open ground ${lumaOf(open)}`);
  assert.ok(greenness(floor) > 0.02, `the floor of the hollow is ${floor.join(', ')}`);
});

test('color/natural: a gully is lusher and darker than the rib beside it, on gentle ground and on steep ground', async () => {
  // A hillside that falls towards +Y, ribbed along its fall: 16 ribs across the terrain, with a rib along the
  // column 128 and a gully along the column 136. The same shape is a gentle hillside in a low height range, 2
  // degrees, and a steep one in a high range, 31 degrees: a relief is measured against the slope it lies on.
  const hillside = fieldOf(257, (u, v) => 0.6 - 0.6 * v + 0.01 * Math.cos(2 * Math.PI * 16 * u));
  const colorAt = (f: FieldData, x: number): readonly [number, number, number] => [at(f, x, 150, 0), at(f, x, 150, 1), at(f, x, 150, 2)];
  for (const heightRange of [256, 1024, 4096]) {
    for (const mode of ['alpine', 'temperate'] as const) {
      const { out } = await renderNode(def, { inputs: { in: hillside, flow: null, snow: null }, params: { ...PLAIN, mode }, settings: { ...NO_SEA, heightRange } });
      const rib = colorAt(out, 128), gully = colorAt(out, 136);
      assert.ok(greenness(gully) > greenness(rib) + 0.02, `${mode}, ${heightRange} m: the gully is ${gully.join(', ')}, the rib ${rib.join(', ')}`);
      assert.ok(lumaOf(gully) < lumaOf(rib) - 0.01, `${mode}, ${heightRange} m: the gully has the luminance ${lumaOf(gully)}, the rib ${lumaOf(rib)}`);
    }
  }
});

test('color/natural: the five landscapes have five palettes', async () => {
  const pictures = new Map<string, readonly [number, number, number]>();
  for (const mode of MODES) pictures.set(mode, mean((await renderNode(def, { inputs: { in: 'terrain', flow: null, snow: null }, params: { mode }, settings: NO_SEA })).out));
  for (const a of MODES) {
    for (const b of MODES) {
      if (a < b) assert.ok(distance(pictures.get(a)!, pictures.get(b)!) > 0.03, `${a} and ${b} differ by ${distance(pictures.get(a)!, pictures.get(b)!)} in their mean color`);
    }
  }
  const alpine = pictures.get('alpine')!, temperate = pictures.get('temperate')!, desert = pictures.get('desert')!;
  const volcanic = pictures.get('volcanic')!, arctic = pictures.get('arctic')!;
  assert.ok(desert[0] > desert[1] && desert[1] > desert[2], `the desert is red before green before blue: ${desert.join(', ')}`);
  assert.ok(temperate[1] - temperate[0] > alpine[1] - alpine[0], 'the temperate landscape is greener than the alpine one');
  assert.ok(lumaOf(volcanic) < 0.8 * lumaOf(alpine), 'the volcanic landscape is darker than the alpine one');
  assert.ok(arctic[2] - arctic[0] > alpine[2] - alpine[0], 'the arctic landscape is bluer than the alpine one');
});

test('color/natural: snow lies where the mask says, and a mask of nothing is no snow', async () => {
  const bare = (await renderNode(def, { inputs: { in: 'terrain', flow: null, snow: null }, settings: NO_SEA })).out;
  const none = (await renderNode(def, { inputs: { in: 'terrain', flow: null, snow: 'zero' }, settings: NO_SEA })).out;
  expectIdentical(none, bare);
  // The mask fixture is 1 inside a radius of 0.2 around the middle and 0 beyond 0.35.
  const { out } = await renderNode(def, { inputs: { in: 'terrain', flow: null, snow: 'mask' }, settings: NO_SEA });
  for (const [x, y] of [[128, 128], [100, 140], [150, 110]] as const) {
    for (const channel of [0, 1, 2] as const) assert.ok(at(out, x, y, channel) > 0.55, `inside the mask (${x}, ${y}) is not snow: channel ${channel} is ${at(out, x, y, channel)}`);
    assert.ok(at(out, x, y, 2) >= at(out, x, y, 0), 'snow is white to bluish');
  }
  for (const [x, y] of [[5, 5], [250, 128], [128, 12]] as const) {
    for (const channel of [0, 1, 2] as const) assert.equal(at(out, x, y, channel), at(bare, x, y, channel), `outside the mask (${x}, ${y}) changed`);
  }
  // In every landscape full snow is brighter than anything the ground has.
  for (const mode of MODES) {
    const white = (await renderNode(def, { inputs: { in: 'terrain', flow: null, snow: 'one' }, params: { mode }, settings: NO_SEA })).out;
    assert.ok(stats(white, 1).min > 0.5, `${mode}: under full snow the darkest green is ${stats(white, 1).min}`);
  }
});

test('color/natural: thin snow lies in the gullies and leaves the ribs, and the edge of a mask is frayed by the ground', async () => {
  // Level ground with ribs and gullies along Y, 20 m high: a rib along the column 128, a gully along the column 136.
  const ridged = fieldOf(257, (u) => 0.3 + 0.02 * Math.cos(2 * Math.PI * 16 * u));
  const colorAt = (f: FieldData, x: number, y = 128): readonly [number, number, number] => [at(f, x, y, 0), at(f, x, y, 1), at(f, x, y, 2)];
  const render = async (snow: FieldData | null): Promise<FieldData> =>
    (await renderNode(def, { inputs: { in: ridged, flow: null, snow }, params: PLAIN, settings: NO_SEA })).out;
  const bare = await render(null);

  // A mask of one half all over: the gullies hold their snow, and the ribs have lost theirs.
  const thin = await render(fieldOf(257, () => 0.5));
  assert.ok(Math.min(...colorAt(thin, 136)) > 0.55, `under thin snow the gully is ${colorAt(thin, 136).join(', ')}`);
  assert.ok(distance(colorAt(thin, 128), colorAt(bare, 128)) <= COLOR, `under thin snow the rib is ${colorAt(thin, 128).join(', ')}, bare it is ${colorAt(bare, 128).join(', ')}`);
  // A mask of 1 covers both, and the snow of the gully lies in shade: it is the bluer of the two.
  const full = await render(fieldOf(257, () => 1));
  const rib = colorAt(full, 128), gully = colorAt(full, 136);
  assert.ok(Math.min(...rib) > 0.55 && Math.min(...gully) > 0.55, `under full snow the rib is ${rib.join(', ')}, the gully ${gully.join(', ')}`);
  assert.ok(gully[2] - gully[0] > rib[2] - rib[0] + 0.03, 'the snow of the gully is no bluer than that of the rib');

  // A mask with a hard edge, 1 above the row 128 and 0 from it on: just beyond the edge the gully has snow and
  // the rib has none, and just inside it the rib has begun to lose its snow.
  const edged = await render(fieldOf(257, (u, v) => (v < 0.5 ? 1 : 0)));
  assert.ok(lumaOf(colorAt(edged, 136, 128)) > lumaOf(colorAt(bare, 136, 128)) + 0.05, `beyond the edge the gully is ${colorAt(edged, 136, 128).join(', ')}`);
  assert.ok(distance(colorAt(edged, 128, 128), colorAt(bare, 128, 128)) <= COLOR, `beyond the edge the rib is ${colorAt(edged, 128, 128).join(', ')}`);
  assert.ok(lumaOf(colorAt(edged, 128, 127)) < lumaOf(colorAt(full, 128, 127)) - 0.02, `inside the edge the rib is ${colorAt(edged, 128, 127).join(', ')}`);
  // Far from the edge the mask decides alone.
  for (const x of [128, 132, 136]) {
    assert.ok(distance(colorAt(edged, x, 100), colorAt(full, x, 100)) <= COLOR && distance(colorAt(edged, x, 160), colorAt(bare, x, 160)) <= COLOR, `far from the edge the column ${x} is not what the mask says`);
  }
});

test('color/natural: a stream darkens the ground along its line, and a flow of nothing is no flow', async () => {
  const ground = level(0.2);
  const dry = (await renderNode(def, { inputs: { in: ground, flow: null, snow: null }, params: PLAIN, settings: NO_SEA })).out;
  expectIdentical((await renderNode(def, { inputs: { in: ground, flow: 'zero', snow: null }, params: PLAIN, settings: NO_SEA })).out, dry);
  // Every texel drains itself alone, one part in 257 squared of the terrain: no stream anywhere.
  const own = fieldOf(257, () => 1 / 257 ** 2);
  expectIdentical((await renderNode(def, { inputs: { in: ground, flow: own, snow: null }, params: PLAIN, settings: NO_SEA })).out, dry);

  // One line down the middle that drains a twentieth of the terrain, in ground that drains itself alone.
  const river = fieldOf(257, (u) => (Math.round(u * 256) === 128 ? 0.05 : 1 / 257 ** 2));
  const { out } = await renderNode(def, { inputs: { in: ground, flow: river, snow: null }, params: PLAIN, settings: NO_SEA });
  const drySpot = middle(dry);
  for (const y of [10, 128, 240]) {
    const bed: readonly [number, number, number] = [at(out, 128, y, 0), at(out, 128, y, 1), at(out, 128, y, 2)];
    assert.ok(lumaOf(bed) < 0.75 * lumaOf(drySpot), `the line of the river has the luminance ${lumaOf(bed)}, dry ground ${lumaOf(drySpot)}`);
    for (const channel of [0, 1, 2] as const) assert.equal(at(out, 30, y, channel), at(dry, 30, y, channel), 'far from the river the ground changed');
  }
  // A smaller stream darkens less.
  const brook = fieldOf(257, (u) => (Math.round(u * 256) === 128 ? 0.002 : 1 / 257 ** 2));
  const small = (await renderNode(def, { inputs: { in: ground, flow: brook, snow: null }, params: PLAIN, settings: NO_SEA })).out;
  const line: readonly [number, number, number] = [at(small, 128, 128, 0), at(small, 128, 128, 1), at(small, 128, 128, 2)];
  assert.ok(lumaOf(line) < lumaOf(drySpot) - COLOR && lumaOf(line) > lumaOf(middle(out)) + 0.01, `the brook has the luminance ${lumaOf(line)}`);
});

test('color/natural: a flow that lies everywhere wets the ground and is no stream bed', async () => {
  // A field that is no drainage, a mask or a noise, drains nothing along a line: the ground is moist all over,
  // darker and still vegetation, where the line of a river is its bed.
  const ground = level(0.2);
  const dry = middle((await renderNode(def, { inputs: { in: ground, flow: null, snow: null }, params: PLAIN, settings: NO_SEA })).out);
  const soaked = (await renderNode(def, { inputs: { in: ground, flow: 'one', snow: null }, params: PLAIN, settings: NO_SEA })).out;
  for (const channel of [0, 1, 2] as const) assert.ok(stats(soaked, channel).max - stats(soaked, channel).min <= COLOR, 'ground that is wet all over has one color');
  const wet = middle(soaked);
  assert.ok(lumaOf(wet) < lumaOf(dry) - 0.02 && greenness(wet) > 0.03, `ground that is wet all over is ${wet.join(', ')}, dry ground ${dry.join(', ')}`);
  const river = fieldOf(257, (u) => (Math.round(u * 256) === 128 ? 0.05 : 1 / 257 ** 2));
  const bed = middle((await renderNode(def, { inputs: { in: ground, flow: river, snow: null }, params: PLAIN, settings: NO_SEA })).out);
  assert.ok(greenness(bed) < greenness(wet) - 0.02, `the bed of a river is ${bed.join(', ')}`);
});

test('color/natural: a stream is the same stream at every resolution', async () => {
  // The line is one texel wide at each level, twice as narrow at the finer one, and drains the same share.
  const pictures: Record<number, FieldData> = {};
  for (const res of [257, 513]) {
    const river = fieldOf(res, (u) => (Math.round(u * (res - 1)) === (res - 1) / 2 ? 0.01 : 1 / res ** 2));
    pictures[res] = (await renderNode(def, { res, inputs: { in: fieldOf(res, () => 0.2), flow: river, snow: null }, params: PLAIN, settings: NO_SEA })).out;
  }
  const coarse = lumaOf(middle(pictures[257]!));
  const fine = luma(at(pictures[513]!, 256, 256, 0), at(pictures[513]!, 256, 256, 1), at(pictures[513]!, 256, 256, 2));
  assert.ok(Math.abs(coarse - fine) <= 0.015, `the line of the stream has the luminance ${coarse} at 257 and ${fine} at 513`);
});

test('color/natural: ground below the sea level of the project is seabed, with a beach above it; a sea level of 0 is no sea', async () => {
  // A plane from 0.1 to 0.5 across the terrain, 5.7 degrees: the sea of the test settings, at 0.25, covers its left part.
  const coast = fieldOf(257, (u) => 0.1 + 0.4 * u);
  const { out } = await renderNode(def, { inputs: { in: coast, flow: null, snow: null }, params: PLAIN });
  const colorAt = (f: FieldData, x: number): readonly [number, number, number] => [at(f, x, 128, 0), at(f, x, 128, 1), at(f, x, 128, 2)];
  const deep = colorAt(out, 5), shallow = colorAt(out, 85), beach = colorAt(out, 99), land = colorAt(out, 200);
  assert.ok(deep[2] > deep[0] && deep[2] > deep[1], `deep under the sea the ground is ${deep.join(', ')}`);
  assert.ok(lumaOf(shallow) > lumaOf(deep), 'the seabed is lighter in the shallows');
  assert.ok(beach[0] > beach[2] && lumaOf(beach) > lumaOf(land), `the beach is ${beach.join(', ')}, the land above it ${land.join(', ')}`);
  assert.ok(greenness(land) > 0.04, `the land is ${land.join(', ')}`);
  // Without a sea the same ground is land from one end to the other.
  const dry = (await renderNode(def, { inputs: { in: coast, flow: null, snow: null }, params: PLAIN, settings: NO_SEA })).out;
  for (const x of [5, 85, 99, 200]) assert.ok(greenness(colorAt(dry, x)) > 0.02, `without a sea the ground at ${x} is ${colorAt(dry, x).join(', ')}`);
  // Snow does not lie on the sea.
  const snowed = (await renderNode(def, { inputs: { in: coast, flow: null, snow: 'one' }, params: PLAIN })).out;
  assert.ok(distance(colorAt(snowed, 5), deep) <= COLOR && colorAt(snowed, 200)[1] > 0.6, 'snow covers the land and leaves the seabed');
});

test('color/natural: two levels of the ladder agree where the terrain is smooth at the scale of a texel', async () => {
  const levels = await renderLadder(def, { inputs: { in: 'terrain', flow: null, snow: null }, settings: NO_SEA });
  const d = compareLadder(levels[257]!.out!, levels[513]!.out!);
  assert.ok(d.rel <= 0.01, `the terrain fixture differs by ${d.rel} of its standard deviation`);
});
