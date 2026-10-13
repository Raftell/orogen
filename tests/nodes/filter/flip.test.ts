// tests/nodes/filter/flip.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, channelOf, conformance, expectIdentical, fixtures, renderNode, type FieldData } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/filter/flip.ts';
import { mapField } from './_reference.ts';

conformance(def);

const N = 257;
const L = N - 1;
// Not symmetric under any of the six modes.
const SRC = fixtures.terrain(N);

/** Where each mode takes the texel (x, y) of its output from. */
const SOURCE: Readonly<Record<string, (x: number, y: number) => readonly [number, number]>> = {
  horizontal: (x, y) => [L - x, y],
  vertical: (x, y) => [x, L - y],
  both: (x, y) => [L - x, L - y],
  'turn-90': (x, y) => [y, L - x],
  'turn-270': (x, y) => [L - y, x],
  transpose: (x, y) => [y, x],
};
const flipped = (f: FieldData, mode: string): FieldData => mapField(f, (x, y) => at(f, ...SOURCE[mode]!(x, y)));
const flip = async (f: FieldData, mode: string): Promise<FieldData> => (await renderNode(def, { inputs: { in: f }, params: { mode } })).out;

test('filter/flip: the modes of the node are the six of this test', () => {
  const mode = def.params.find((param) => param.name === 'mode');
  assert.ok(mode?.kind === 'enum');
  assert.deepEqual(mode.options.map((option) => option.value), Object.keys(SOURCE));
  assert.equal(def.maskable ?? false, false);
});

for (const mode of Object.keys(SOURCE)) {
  test(`filter/flip: mode ${mode} moves every texel whole`, async () => {
    expectIdentical(await flip(SRC, mode), flipped(SRC, mode));
  });
}

test('filter/flip: a quarter turn is clockwise in the top view: what rose towards +X rises towards +Y', async () => {
  // rampX is its u; turned by 90 degrees it is the v of rampY, and turned back it is itself.
  expectIdentical(await flip(fixtures.rampX(N), 'turn-90'), fixtures.rampY(N));
  expectIdentical(await flip(fixtures.rampY(N), 'turn-270'), fixtures.rampX(N));
  expectIdentical(await flip(await flip(SRC, 'turn-90'), 'turn-270'), SRC);
  expectIdentical(await flip(await flip(SRC, 'turn-90'), 'turn-90'), await flip(SRC, 'both'));
});

test('filter/flip: a mirror image mirrored again is the picture, and two mirrors make a half turn', async () => {
  for (const mode of ['horizontal', 'vertical', 'both', 'transpose']) expectIdentical(await flip(await flip(SRC, mode), mode), SRC);
  expectIdentical(await flip(await flip(SRC, 'horizontal'), 'vertical'), await flip(SRC, 'both'));
});

test('filter/flip: a color is moved with all four channels', async () => {
  // A color keeps 11 significant bits: the fixture as the engine stores it is what a half turn and a half turn back give.
  const color = await flip(await flip(fixtures.color(N), 'both'), 'both');
  const out = await flip(color, 'horizontal');
  assert.equal(out.kind, 'color');
  for (const channel of [0, 1, 2, 3] as const) expectIdentical(channelOf(out, channel), flipped(channelOf(color, channel), 'horizontal'));
});
