// Acceptance graph 04 (testing.md 10.2): colour. A colour output through a LUT, the colour variant of a node that
// takes either kind, and the two conversions a connection makes: a colour read as a field, a field as a colour.
//
// A value stored in a colour field keeps 11 significant bits: comparisons with a float32 computation allow 2e-3
// (testing.md 3.4).
//
// Sizes: fields of at most 513 x 513, compared by the harness; no field is handed to an assertion of node:assert.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import blur from '../../src/core/nodes/ref/blur.ts';
import colorize from '../../src/core/nodes/ref/colorize.ts';
import { channelOf, expectClose, expectLadder, renderGraph, renderNode, type FieldData } from '../helpers/index.ts';
import { colorFrom, expectTargets, graphFile, saturate } from './_graphs.ts';

const GRAPH = graphFile('04-color');
const TARGETS = ['soft.out', 'relief.out'];

/** The default gradient of ref/colorize at `t`: linear between its stops, in linear RGB. */
function gradient(t: number): readonly [number, number, number] {
  const param = colorize.params.find((candidate) => candidate.name === 'gradient');
  assert.ok(param?.kind === 'gradient');
  const stops = param.default;
  let k = 0;
  while (k < stops.length - 2 && stops[k + 1]!.t <= t) k++;
  const a = stops[k]!, b = stops[k + 1]!;
  const f = saturate((t - a.t) / (b.t - a.t));
  return [0, 1, 2].map((c) => a.color[c]! + (b.color[c]! - a.color[c]!) * f) as unknown as readonly [number, number, number];
}

/** How many texels of a colour have an alpha that is not exactly 1. */
function notOpaque(color: FieldData): number {
  let count = 0;
  for (let i = 3; i < color.data.length; i += 4) if (color.data[i] !== 1) count++;
  return count;
}

test('04-color: the statistics at 257 are those of the expectation file', async () => {
  const { fields, report } = await renderGraph(GRAPH, ['fbm.out', 'paint.out', 'soft.out', 'relief.out']);
  assert.equal(report.status, 'ok');
  expectTargets('04-color', fields);
});

test('04-color: a colour has four floats a texel and is opaque; the colouring is the gradient at the height', async () => {
  const { fields, report } = await renderGraph(GRAPH, [...TARGETS, 'paint.out', 'fbm.out']);
  assert.equal(report.status, 'ok');
  for (const target of ['paint.out', 'soft.out', 'relief.out']) {
    const color = fields[target]!;
    assert.deepEqual([color.kind, color.channels, color.data.length], ['color', 4, 257 * 257 * 4], target);
    assert.equal(notOpaque(color), 0, `${target}: texels whose alpha is not exactly 1`);
  }
  // The LUT: 256 samples of the gradient, read with interpolation at the saturated height.
  const fbm = fields['fbm.out']!;
  expectClose(fields['paint.out']!, colorFrom(fbm, (i) => gradient(saturate(fbm.data[i]!))), { max: 2e-3 });
});

test('04-color: a node that takes either kind blurs a colour channel by channel', async () => {
  const { fields } = await renderGraph(GRAPH, ['paint.out', 'soft.out']);
  const paint = fields['paint.out']!, soft = fields['soft.out']!;
  for (const channel of [0, 1, 2] as const) {
    const { out } = await renderNode(blur, { res: 257, inputs: { in: channelOf(paint, channel) }, params: { radius: 0.02 } });
    expectClose(channelOf(soft, channel), out, { max: 2e-3 });
  }
});

test('04-color: a colour connected to a field input is read as its luma, and a field connected to a colour input as grey', async () => {
  const { fields } = await renderGraph(GRAPH, ['soft.out', 'fbm.out', 'relief.out']);
  const soft = fields['soft.out']!, fbm = fields['fbm.out']!;
  // runtime.md 5.6. `relief` is ref/colorize at strength 0.5: mix(base, gradient(saturate(in)), 0.5).
  const expected = colorFrom(fbm, (i) => {
    const luma = 0.2126 * soft.data[4 * i]! + 0.7152 * soft.data[4 * i + 1]! + 0.0722 * soft.data[4 * i + 2]!;
    const painted = gradient(saturate(luma)), grey = fbm.data[i]!;
    return [grey + (painted[0] - grey) * 0.5, grey + (painted[1] - grey) * 0.5, grey + (painted[2] - grey) * 0.5];
  });
  expectClose(fields['relief.out']!, expected, { max: 2e-3 });
});

test('04-color: 257 and 513 agree within the default tolerance, for the colouring and for its blur', async () => {
  const coarse = (await renderGraph(GRAPH, ['paint.out', 'soft.out'], { res: 257 })).fields;
  const fine = (await renderGraph(GRAPH, ['paint.out', 'soft.out'], { res: 513 })).fields;
  expectLadder(coarse['paint.out']!, fine['paint.out']!, { rel: 0.01 });
  expectLadder(coarse['soft.out']!, fine['soft.out']!, { rel: 0.01 });
});
