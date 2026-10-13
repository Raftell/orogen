// tests/nodes/color/gradient-map.test.ts
import { test } from 'node:test';
import { channelOf, conformance, expectClose, expectIdentical, fieldOf, fixtures, renderNode, type FieldData } from '../../helpers/index.ts';
import type { GradientParam, GradientStop } from '../../../src/core/api.ts';
import def from '../../../src/core/nodes/color/gradient-map.ts';
import { COLOR, colorFrom, gradientAt, saturate } from './_reference.ts';

conformance(def);

const DEFAULT = def.params.find((param): param is GradientParam => param.kind === 'gradient')!.default;

/** The gradient at the place of every value between the two ends, texel by texel, opaque. */
function mapped(src: FieldData, stops: readonly GradientStop[], inMin: number, inMax: number): FieldData {
  return colorFrom(src, (i) => {
    const v = src.data[i]!;
    const t = inMin === inMax ? (v >= inMin ? 1 : 0) : saturate((v - inMin) / (inMax - inMin));
    return [...gradientAt(stops, t), 1];
  });
}

test('color/gradient-map: every value gets the color of the gradient at that value, and values outside 0..1 the color of its ends', async () => {
  // A ramp from -0.25 to 1.25 crosses every stop of the default gradient and leaves it at both ends.
  const src = fieldOf(257, (u, v) => 1.5 * (0.7 * u + 0.3 * v) - 0.25);
  const { out } = await renderNode(def, { inputs: { in: src } });
  expectClose(out, mapped(src, DEFAULT, 0, 1), { max: COLOR });
});

test('color/gradient-map: a gradient of two stops is a straight blend from one color to the other', async () => {
  const stops: GradientStop[] = [{ t: 0, color: [1, 0, 0] }, { t: 1, color: [0, 0.5, 1] }];
  const { out } = await renderNode(def, { inputs: { in: 'rampX' }, params: { gradient: stops } });
  expectClose(channelOf(out, 0), fieldOf(257, (u) => 1 - u), { max: COLOR });
  expectClose(channelOf(out, 1), fieldOf(257, (u) => 0.5 * u), { max: COLOR });
  expectClose(channelOf(out, 2), fixtures.rampX(257), { max: COLOR });
  expectIdentical(channelOf(out, 3), fixtures.one(257));
});

test('color/gradient-map: the input minimum and maximum say which values the two ends of the gradient belong to', async () => {
  const src = fixtures.terrain(257);
  for (const [inMin, inMax] of [[0.25, 0.75], [0.4, 0.5], [-1, 3]] as const) {
    const { out } = await renderNode(def, { inputs: { in: src }, params: { inMin, inMax } });
    expectClose(out, mapped(src, DEFAULT, inMin, inMax), { max: COLOR });
  }
  // Data of any range: slopes in degrees, mapped from 10 to 60.
  const degrees = fieldOf(257, (u, v) => 90 * u * v);
  const { out } = await renderNode(def, { inputs: { in: degrees }, params: { inMin: 10, inMax: 60 } });
  expectClose(out, mapped(degrees, DEFAULT, 10, 60), { max: COLOR });
});

test('color/gradient-map: a maximum below the minimum turns the gradient over, and the two on one value are a threshold', async () => {
  const stops: GradientStop[] = [{ t: 0, color: [1, 0, 0] }, { t: 1, color: [0, 0, 1] }];
  const turned = await renderNode(def, { inputs: { in: 'rampX' }, params: { gradient: stops, inMin: 1, inMax: 0 } });
  expectClose(channelOf(turned.out, 0), fixtures.rampX(257), { max: COLOR });
  expectClose(channelOf(turned.out, 2), fieldOf(257, (u) => 1 - u), { max: COLOR });

  // Below the threshold the left end, from it on the right end: nothing is divided by the width of the range.
  const src = fixtures.rampX(257);
  const step = await renderNode(def, { inputs: { in: src }, params: { gradient: stops, inMin: 0.5, inMax: 0.5 } });
  expectIdentical(step.out, mapped(src, stops, 0.5, 0.5));
});

test('color/gradient-map: values far beyond a narrow range get the colors of the ends', async () => {
  const stops: GradientStop[] = [{ t: 0, color: [0, 1, 0] }, { t: 1, color: [1, 0, 1] }];
  // Values of 1e30 on either side of a range a millionth wide: their place in the range is beyond any float.
  const src = fieldOf(257, (u) => (u < 0.5 ? -1e30 : 1e30));
  const { out } = await renderNode(def, { inputs: { in: src }, params: { gradient: stops, inMin: 0.5, inMax: 0.500001 } });
  expectIdentical(out, mapped(src, stops, 0.5, 0.500001));
});
