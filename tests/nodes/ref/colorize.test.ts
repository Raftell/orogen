// tests/nodes/ref/colorize.test.ts
import { test } from 'node:test';
import { channelOf, colorOf, conformance, expectClose, expectIdentical, fieldOf, fixtures, renderNode, type FieldData } from '../../helpers/index.ts';
import type { GradientParam, GradientStop } from '../../../src/core/api.ts';
import def from '../../../src/core/nodes/ref/colorize.ts';

conformance(def);

/** What a value stored in a `color` field may differ by from a float32 computation (testing.md 3.4). */
const COLOR = 2e-3;

const DEFAULT = def.params.find((param): param is GradientParam => param.kind === 'gradient')!.default;

/** A gradient as its definition reads: linear between the neighbouring stops, constant before the first and after the last. */
function gradientAt(stops: readonly GradientStop[], t: number): readonly number[] {
  if (t <= stops[0].t) return stops[0].color;
  for (let k = 1; k < stops.length; k++) {
    const a = stops[k - 1], b = stops[k];
    if (t <= b.t) return a.color.map((from, c) => from + ((t - a.t) / (b.t - a.t)) * (b.color[c] - from));
  }
  return stops[stops.length - 1].color;
}

/** mix(base, gradient(saturate(in)), strength) with alpha 1, texel by texel. Without a base it is black. */
function colorized(src: FieldData, stops: readonly GradientStop[], strength: number, base?: FieldData): FieldData {
  const data = new Float32Array(src.data.length * 4);
  for (let i = 0; i < src.data.length; i++) {
    const painted = gradientAt(stops, Math.min(1, Math.max(0, src.data[i])));
    for (let c = 0; c < 3; c++) {
      const under = base ? base.data[i * 4 + c] : 0;
      data[i * 4 + c] = under + strength * (painted[c] - under);
    }
    data[i * 4 + 3] = 1;
  }
  return { kind: 'color', width: src.width, height: src.height, channels: 4, data };
}

test('ref/colorize: every height gets the color of the gradient at that height, and heights outside 0..1 the color of its ends', async () => {
  // A ramp from -0.25 to 1.25 crosses every stop of the default gradient and leaves it at both ends.
  const src = fieldOf(257, (u, v) => 1.5 * (0.7 * u + 0.3 * v) - 0.25);
  const { out } = await renderNode(def, { inputs: { in: src, base: null } });
  expectClose(out, colorized(src, DEFAULT, 1), { max: COLOR });
});

test('ref/colorize: a gradient of two stops is a straight blend from one color to the other', async () => {
  const stops: GradientStop[] = [{ t: 0, color: [1, 0, 0] }, { t: 1, color: [0, 0.5, 1] }];
  const { out } = await renderNode(def, { inputs: { in: 'rampX', base: null }, params: { gradient: stops } });
  expectClose(channelOf(out, 0), fieldOf(257, (u) => 1 - u), { max: COLOR });
  expectClose(channelOf(out, 1), fieldOf(257, (u) => 0.5 * u), { max: COLOR });
  expectClose(channelOf(out, 2), fixtures.rampX(257), { max: COLOR });
});

test('ref/colorize: the strength mixes the gradient over the base color', async () => {
  // The color fixture is (u, v, terrain, 1).
  const src = fixtures.terrain(257);
  const base = fixtures.color(257);
  const half = await renderNode(def, { inputs: { in: src, base }, params: { strength: 0.5 } });
  expectClose(half.out, colorized(src, DEFAULT, 0.5, base), { max: COLOR });
  const none = await renderNode(def, { inputs: { in: src, base }, params: { strength: 0 } });
  expectClose(none.out, base, { max: COLOR });
  const full = await renderNode(def, { inputs: { in: src, base }, params: { strength: 1 } });
  expectClose(full.out, colorized(src, DEFAULT, 1), { max: COLOR });
});

test('ref/colorize: an unconnected base is black', async () => {
  const src = fixtures.terrain(257);
  const half = await renderNode(def, { inputs: { in: src, base: null }, params: { strength: 0.5 } });
  expectClose(half.out, colorized(src, DEFAULT, 0.5), { max: COLOR });
  const none = await renderNode(def, { inputs: { in: src, base: null }, params: { strength: 0 } });
  expectIdentical(none.out, colorOf(257, () => [0, 0, 0, 1]));
});

test('ref/colorize: the output is opaque whatever the alpha of the base', async () => {
  const base = colorOf(257, (u, v) => [u, v, 0.5, 0.25 * u]);
  const { out } = await renderNode(def, { inputs: { in: 'terrain', base }, params: { strength: 0.5 } });
  expectIdentical(channelOf(out, 3), fixtures.one(257));
});
