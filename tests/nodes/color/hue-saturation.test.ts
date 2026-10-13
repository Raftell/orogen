// tests/nodes/color/hue-saturation.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelOf, colorOf, conformance, expectClose, expectIdentical, fixtures, renderNode, stats, type FieldData } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/color/hue-saturation.ts';
import { COLOR, colorFrom, luma } from './_reference.ts';

conformance(def);

/** The parameters that change nothing; a test sets the one it is about. */
const NEUTRAL = { hue: 0, saturation: 1, lightness: 0, contrast: 1 } as const;
/** Middle gray in linear light: what the contrast leaves where it is. */
const PIVOT = 0.18;

interface Settings { readonly hue: number; readonly saturation: number; readonly lightness: number; readonly contrast: number }

/** The node as its help texts describe it, in float64: the hue turned, then the saturation, the lightness and the contrast. */
function adjusted(rgb: readonly number[], { hue, saturation, lightness, contrast }: Settings): number[] {
  let c = [...rgb];
  if (hue % 360 !== 0) {
    const hi = Math.max(...c), lo = Math.min(...c), chroma = hi - lo;
    if (chroma > 0) {
      const [r, g, b] = c as [number, number, number];
      const h = (hi === r ? (g - b) / chroma : hi === g ? 2 + (b - r) / chroma : 4 + (r - g) / chroma) + (hue % 360) / 60;
      const wheel = (n: number): number => {
        const k = (((n + h) % 6) + 6) % 6;
        return hi - chroma * Math.min(1, Math.max(0, Math.min(k, 4 - k)));
      };
      c = [wheel(5), wheel(3), wheel(1)];
    }
  }
  if (saturation !== 1) {
    const y = luma(c[0]!, c[1]!, c[2]!), lo = Math.min(...c), hi = Math.max(...c);
    // More vivid only until the smallest channel reaches 0 or the largest reaches 1.
    let s = saturation;
    if (s > 1 && y > lo) s = Math.min(s, Math.max(y / (y - lo), 1));
    if (s > 1 && hi > y && hi <= 1) s = Math.min(s, Math.max((1 - y) / (hi - y), 1));
    c = c.map((v) => Math.max(y + (v - y) * s, 0));
  }
  if (lightness > 0) c = c.map((v) => v + (1 - v) * lightness);
  if (lightness < 0) c = c.map((v) => v * (1 + lightness));
  if (contrast !== 1) c = c.map((v) => (v <= 0 ? (contrast === 0 ? PIVOT : 0) : PIVOT * (v / PIVOT) ** contrast));
  return c;
}

const reference = (src: FieldData, settings: Settings): FieldData =>
  colorFrom(src, (i) => [...adjusted([src.data[i * 4]!, src.data[i * 4 + 1]!, src.data[i * 4 + 2]!], settings), src.data[i * 4 + 3]!]);

/** Every hue at every saturation and brightness: the hue runs along u, and v fades the color into gray, black and white. */
const wheel = colorOf(257, (u, v) => {
  const k = (n: number): number => {
    const x = (n + 6 * u) % 6;
    return 1 - Math.min(1, Math.max(0, Math.min(x, 4 - x)));
  };
  const value = 0.15 + 0.8 * v, chroma = Math.abs(Math.sin(5 * v + u));
  return [value * (1 - chroma * (1 - k(5))), value * (1 - chroma * (1 - k(3))), value * (1 - chroma * (1 - k(1))), 1];
});

/** `src` as a color field holds it: what the node, which passes a color through when nothing is asked of it, was given. */
const stored = async (src: FieldData): Promise<FieldData> => (await renderNode(def, { inputs: { in: src }, params: NEUTRAL })).out;

test('color/hue-saturation: with every parameter neutral the color passes through bit for bit', async () => {
  // The third source leaves 0..1 on both sides and has an alpha of its own. A half float holds a value within
  // one part in 2048 of it.
  for (const src of [fixtures.color(257), wheel, colorOf(257, (u, v) => [3 * u, -v, 100 * u * v, 0.5 * u])]) {
    const { out } = await renderNode(def, { inputs: { in: src }, params: NEUTRAL });
    expectClose(out, colorFrom(src, (i) => [0, 1, 2, 3].map((c) => src.data[i * 4 + c]!)), { max: 100 / 2048 });
    expectClose(channelOf(out, 0), channelOf(src, 0), { max: 3 / 2048 });
    // Given what it returned, it returns it again, and a whole turn of the hue is no turn.
    expectIdentical((await renderNode(def, { inputs: { in: out }, params: NEUTRAL })).out, out);
    expectIdentical((await renderNode(def, { inputs: { in: src }, params: { ...NEUTRAL, hue: 360 } })).out, out);
  }
});

test('color/hue-saturation: the node is its four steps in order, on every hue, saturation and brightness', async () => {
  const cases: Settings[] = [
    { ...NEUTRAL, hue: 75 },
    { ...NEUTRAL, hue: 200, saturation: 0.6 },
    { ...NEUTRAL, saturation: 1.5 },
    { ...NEUTRAL, lightness: 0.3 },
    { ...NEUTRAL, lightness: -0.4 },
    { ...NEUTRAL, contrast: 1.6 },
    { ...NEUTRAL, contrast: 0.5 },
    { hue: 310, saturation: 1.3, lightness: -0.15, contrast: 1.25 },
    { hue: 45, saturation: 0.4, lightness: 0.2, contrast: 0.8 },
  ];
  for (const src of [await stored(wheel), await stored(fixtures.color(257))]) {
    for (const settings of cases) {
      const { out } = await renderNode(def, { inputs: { in: src }, params: { ...settings } });
      expectClose(out, reference(src, settings), { max: COLOR });
    }
  }
});

test('color/hue-saturation: a third of a turn moves red to green, green to blue and blue to red', async () => {
  const src = colorOf(257, (u, v) => [u, v, 0.25, 1]);
  const third = await renderNode(def, { inputs: { in: src }, params: { ...NEUTRAL, hue: 120 } });
  expectClose(channelOf(third.out, 1), channelOf(src, 0), { max: COLOR });
  expectClose(channelOf(third.out, 2), channelOf(src, 1), { max: COLOR });
  expectClose(channelOf(third.out, 0), channelOf(src, 2), { max: COLOR });
  const twoThirds = await renderNode(def, { inputs: { in: src }, params: { ...NEUTRAL, hue: 240 } });
  expectClose(channelOf(twoThirds.out, 2), channelOf(src, 0), { max: COLOR });
  expectClose(channelOf(twoThirds.out, 0), channelOf(src, 1), { max: COLOR });
  expectClose(channelOf(twoThirds.out, 1), channelOf(src, 2), { max: COLOR });
});

test('color/hue-saturation: turning the hue keeps a gray that gray and keeps the largest and the smallest channel of every color', async () => {
  const gray = colorOf(257, (u, v) => [0.9 * u * v, 0.9 * u * v, 0.9 * u * v, 1]);
  for (const hue of [30, 137, 301]) {
    expectIdentical((await renderNode(def, { inputs: { in: gray }, params: { ...NEUTRAL, hue } })).out,
      (await renderNode(def, { inputs: { in: gray }, params: NEUTRAL })).out);
    const { out } = await renderNode(def, { inputs: { in: wheel }, params: { ...NEUTRAL, hue } });
    const extreme = (f: FieldData, pick: (...values: number[]) => number): FieldData =>
      colorFrom(f, (i) => { const m = pick(f.data[i * 4]!, f.data[i * 4 + 1]!, f.data[i * 4 + 2]!); return [m, m, m, 1]; });
    expectClose(extreme(out, Math.max), extreme(wheel, Math.max), { max: COLOR });
    expectClose(extreme(out, Math.min), extreme(wheel, Math.min), { max: COLOR });
  }
});

test('color/hue-saturation: no saturation leaves the gray of the same luminance, and more saturation keeps the luminance', async () => {
  const src = await stored(wheel);
  const none = await renderNode(def, { inputs: { in: src }, params: { ...NEUTRAL, saturation: 0 } });
  const gray = colorFrom(src, (i) => { const y = luma(src.data[i * 4]!, src.data[i * 4 + 1]!, src.data[i * 4 + 2]!); return [y, y, y, 1]; });
  expectClose(none.out, gray, { max: COLOR });

  // The brightness stays, however far the saturation is raised: a color only becomes as vivid as its pure hue
  // of that brightness, with no channel below 0 and none above 1. The wheel has every hue, the light blues and
  // magentas among them, whose large channel weighs little in the brightness and would leave the range first.
  const lumaOf = (f: FieldData): FieldData => colorFrom(f, (i) => { const y = luma(f.data[i * 4]!, f.data[i * 4 + 1]!, f.data[i * 4 + 2]!); return [y, y, y, 1]; });
  for (const saturation of [1.5, 2, 16]) {
    const { out } = await renderNode(def, { inputs: { in: src }, params: { ...NEUTRAL, saturation } });
    expectClose(lumaOf(out), gray, { max: 2 * COLOR });
    for (const channel of [0, 1, 2] as const) {
      const s = stats(out, channel);
      assert.ok(s.min >= 0 && s.max <= 1 + COLOR, `saturation ${saturation}: channel ${channel} spans ${s.min} to ${s.max}`);
    }
  }
  // A light blue has room for a little more blue and no more: at any saturation it ends on the color whose blue is 1.
  const sky = colorOf(257, () => [0.3, 0.3, 0.95, 1]);
  const y = luma(0.3, 0.3, 0.95), most = (1 - y) / (0.95 - y);
  const vivid = (await renderNode(def, { inputs: { in: sky }, params: { ...NEUTRAL, saturation: 2 } })).out;
  expectClose(vivid, colorOf(257, () => [y + (0.3 - y) * most, y + (0.3 - y) * most, 1, 1]), { max: COLOR });
  // A color that is beyond the range already is not held to it: its luminance is kept all the same.
  const bright = colorOf(257, () => [0.5, 0.25, 4, 1]);
  const brighter = (await renderNode(def, { inputs: { in: bright }, params: { ...NEUTRAL, saturation: 1.25 } })).out;
  expectClose(lumaOf(brighter), lumaOf(bright), { max: 4 * COLOR });
  assert.ok(stats(brighter, 2).min > 4, `the blue of a color beyond the range went from 4 to ${stats(brighter, 2).min}`);
  // More saturation spreads the channels of a color further apart.
  const spread = (f: FieldData): number => {
    let sum = 0;
    for (let i = 0; i < f.width * f.height; i++) sum += Math.max(f.data[i * 4]!, f.data[i * 4 + 1]!, f.data[i * 4 + 2]!) - Math.min(f.data[i * 4]!, f.data[i * 4 + 1]!, f.data[i * 4 + 2]!);
    return sum / (f.width * f.height);
  };
  const half = (await renderNode(def, { inputs: { in: src }, params: { ...NEUTRAL, saturation: 0.5 } })).out;
  const more = (await renderNode(def, { inputs: { in: src }, params: { ...NEUTRAL, saturation: 1.5 } })).out;
  assert.ok(spread(half) < 0.6 * spread(src) && spread(more) > 1.15 * spread(src), `spreads ${spread(half)}, ${spread(src)}, ${spread(more)}`);
});

test('color/hue-saturation: the lightness ends in white and in black, exactly', async () => {
  const src = fixtures.color(257);
  const white = await renderNode(def, { inputs: { in: src }, params: { ...NEUTRAL, lightness: 1 } });
  expectIdentical(white.out, colorOf(257, () => [1, 1, 1, 1]));
  const black = await renderNode(def, { inputs: { in: src }, params: { ...NEUTRAL, lightness: -1 } });
  expectIdentical(black.out, colorOf(257, () => [0, 0, 0, 1]));
});

test('color/hue-saturation: the contrast leaves middle gray and black where they are and moves the rest away from the gray', async () => {
  const src = colorOf(257, (u) => (u < 0.25 ? [0, 0, 0, 1] : u < 0.5 ? [PIVOT, PIVOT, PIVOT, 1] : u < 0.75 ? [0.05, 0.05, 0.05, 1] : [0.6, 0.6, 0.6, 1]));
  const { out } = await renderNode(def, { inputs: { in: src }, params: { ...NEUTRAL, contrast: 2 } });
  const expected = colorOf(257, (u) => {
    const v = u < 0.25 ? 0 : u < 0.5 ? PIVOT : u < 0.75 ? 0.05 ** 2 / PIVOT : 0.6 ** 2 / PIVOT;
    return [v, v, v, 1];
  });
  expectClose(out, expected, { max: COLOR });
  // No contrast leaves middle gray everywhere, black included.
  const flat = await renderNode(def, { inputs: { in: src }, params: { ...NEUTRAL, contrast: 0 } });
  expectClose(flat.out, colorOf(257, () => [PIVOT, PIVOT, PIVOT, 1]), { max: 1e-3 });
});

test('color/hue-saturation: the alpha passes through whatever the parameters', async () => {
  const src = colorOf(257, (u, v) => [u, v, 0.5, 0.25 + 0.5 * u * v]);
  const { out } = await renderNode(def, { inputs: { in: src }, params: { hue: 90, saturation: 0.3, lightness: 0.5, contrast: 1.7 } });
  expectIdentical(channelOf(out, 3), channelOf((await renderNode(def, { inputs: { in: src }, params: NEUTRAL })).out, 3));
});
