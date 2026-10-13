// tests/nodes/filter/transform.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  at, channelOf, conformance, expectClose, expectIdentical, expectLadder, fixtures, renderLadder, renderNode, traceNode,
  type FieldData,
} from '../../helpers/index.ts';
import type { ParamValue } from '../../../src/core/api.ts';
import def from '../../../src/core/nodes/filter/transform.ts';
import flip from '../../../src/core/nodes/filter/flip.ts';
import { gaussian, inner, mapField, resampled, type Edge } from './_reference.ts';

conformance(def);

const N = 257;
const L = N - 1;
const C = L / 2;
const SRC = fixtures.terrain(N);
const IDENTITY = { offset: [0, 0], angle: 0, zoom: 1 } as const;

const transform = async (params: Readonly<Record<string, ParamValue>>, src: FieldData = SRC): Promise<FieldData> =>
  (await renderNode(def, { inputs: { in: src }, params: { ...IDENTITY, ...params } })).out;

/** The source position of the output texel (x, y): turned back by the angle and shrunk by the zoom about the centre. */
function source(offset: readonly [number, number], angle: number, zoom: number): (x: number, y: number) => readonly [number, number] {
  const r = (angle * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return (x, y) => {
    const qx = x - C - offset[0] * L, qy = y - C - offset[1] * L;
    return [C + (c * qx + s * qy) / zoom, C + (-s * qx + c * qy) / zoom];
  };
}

test('filter/transform: no offset, no angle and a zoom of 1 give the input itself, under every edge rule', async () => {
  for (const edge of ['clamp', 'mirror', 'repeat', 'constant']) {
    const { outputs, report } = await traceNode(def, { inputs: { in: SRC }, params: { ...IDENTITY, edge } });
    expectIdentical(outputs.out, SRC);
    assert.equal(report.nodes.node.peakBytes, 0, 'an alias of the input: no texture, no pass');
  }
  // A full turn is no turn.
  expectIdentical(await transform({ angle: 360 }), SRC);
});

test('filter/transform: an offset of whole texels moves the texels whole: there is no half-texel shift', async () => {
  // 16 texels to the right and 8 down. The kernel runs, and reads the picture at its own vertices.
  const out = await transform({ offset: [16 / L, 8 / L], edge: 'constant', height: 0.25 });
  expectIdentical(out, mapField(SRC, (x, y) => (x >= 16 && y >= 8 ? at(SRC, x - 16, y - 8) : 0.25)));
  // And so does a kernel that has nothing to do but an offset too small to see.
  const still = await transform({ offset: [1e-9, 0] });
  expectClose(still, SRC, { max: 1e-6 });
});

test('filter/transform: the edge rules fill what the moved picture no longer covers', async () => {
  const offset = [16 / L, 0] as const;
  const filled = (fill: (x: number, y: number) => number): FieldData => mapField(SRC, (x, y) => (x >= 16 ? at(SRC, x - 16, y) : fill(x, y)));
  expectIdentical(await transform({ offset, edge: 'clamp' }), filled((_x, y) => at(SRC, 0, y)));
  expectIdentical(await transform({ offset, edge: 'mirror' }), filled((x, y) => at(SRC, 16 - x, y)));
  // The terrain repeats with the period of its width, on which the first and the last vertex are one place.
  expectIdentical(await transform({ offset, edge: 'repeat' }), filled((x, y) => at(SRC, x - 16 + L, y)));
  expectIdentical(await transform({ offset, edge: 'constant', height: 0.7 }), filled(() => 0.7));
});

test('filter/transform: a quarter turn is the quarter turn of the flip node, and the angle is clockwise in the top view', async () => {
  const quarter = await transform({ angle: 90 });
  expectIdentical(quarter, (await renderNode(flip, { inputs: { in: SRC }, params: { mode: 'turn-90' } })).out);
  expectIdentical(await transform({ angle: 90 }, fixtures.rampX(N)), fixtures.rampY(N));
});

test('filter/transform: offset, angle and zoom together place the picture as the cubic reading of the input says', async () => {
  const cases: readonly (readonly [readonly [number, number], number, number, Edge])[] = [
    [[0, 0], 30, 1, 'clamp'],
    [[0.1, -0.05], 0, 2, 'mirror'],
    [[-0.2, 0.3], 200, 1.3, 'repeat'],
    [[0.05, 0.05], 75, 1, 'constant'],
  ];
  for (const [offset, angle, zoom, edge] of cases) {
    const out = await transform({ offset, angle, zoom, edge, height: 0.4 });
    // Positions are computed in float32 on the GPU: a few millionths of a texel on slopes of 0.02 a texel.
    expectClose(out, resampled(SRC, source(offset, angle, zoom), edge, 0.4), { max: 1e-4 });
  }
});

test('filter/transform: a zoom of 2 doubles the picture about its center', async () => {
  const out = await transform({ zoom: 2 });
  for (const [x, y] of [[128, 128], [0, 0], [256, 256], [100, 30], [6, 250]] as const) {
    assert.equal(at(out, x, y), at(SRC, (x + 128) / 2, (y + 128) / 2), `texel (${x}, ${y})`);
  }
});

test('filter/transform: a picture that is shrunk loses the detail its texels can no longer hold, not its shape', async () => {
  // Shrunk to a quarter, read every fourth texel: what is finer is removed first by a Gaussian of 1.94 texels.
  const src = await fixtures.fbm(N);
  const out = await transform({ zoom: 0.25, edge: 'repeat' }, src);
  expectClose(inner(out, 100), inner(resampled(gaussian(src, 0.5 * Math.sqrt(15)), source([0, 0], 0, 0.25), 'repeat'), 100), { max: 1e-4 });
  // Stripes two texels wide, read every fourth texel, would all be read on a crest: a level of 0.75 that is not there.
  // The Gaussian reads beyond the border what the edge rule puts there, so the seams of the repetition are level too.
  const stripes = mapField(SRC, (x) => 0.5 + 0.25 * Math.cos(Math.PI * x));
  const shrunk = await transform({ zoom: 0.25, edge: 'repeat' }, stripes);
  assert.equal(at(resampled(stripes, source([0, 0], 0, 0.25), 'repeat'), 100, 100), 0.75);
  expectClose(shrunk, mapField(SRC, () => 0.5), { max: 1e-3 });
});

test('filter/transform: a color is placed channel by channel and stays opaque, also where a level fills in', async () => {
  const color = fixtures.color(N);
  const out = await transform({ angle: 30, zoom: 0.8, edge: 'constant', height: 0.5 }, color);
  assert.equal(out.kind, 'color');
  const blue = await transform({ angle: 30, zoom: 0.8, edge: 'constant', height: 0.5 }, channelOf(color, 2));
  expectClose(channelOf(out, 2), blue, { max: 2e-3 });
  expectIdentical(channelOf(out, 3), fixtures.one(N));
  assert.equal(at(out, 0, 0, 0), 0.5, 'outside the turned picture the color is the gray of the level');
});

test('filter/transform: the placed picture is the same at two levels of the ladder', async () => {
  const levels = await renderLadder(def, { params: { offset: [0.1, 0.03], angle: 40, zoom: 1.5, edge: 'mirror' } });
  expectLadder(levels[257].out, levels[513].out, { rel: 0.01 });
});
