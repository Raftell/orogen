// tests/nodes/ref/combine.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conformance, expectClose, expectIdentical, fieldOf, fixtures, renderNode, type FieldData, type FixtureName } from '../../helpers/index.ts';
import type { ParamValue } from '../../../src/core/api.ts';
import def from '../../../src/core/nodes/ref/combine.ts';

conformance(def);

// The default inputs: `a` is the terrain fixture and `b` the cone.
const A = fixtures.terrain(257);
const B = fixtures.cone(257);

/** The node at 257. An input that is not named gets its default fixture, the mask too: here it is unconnected unless given. */
async function combine(params: Readonly<Record<string, ParamValue>>, mask: FieldData | FixtureName | null = null): Promise<FieldData> {
  return (await renderNode(def, { params, inputs: { mask } })).out;
}

/** A field computed texel by texel from `a`, `b` and a third field, in float64. */
function zip(third: FieldData, fn: (a: number, b: number, c: number) => number): FieldData {
  return { ...A, data: A.data.map((a, i) => fn(a, B.data[i], third.data[i])) };
}
const each = (fn: (a: number, b: number) => number): FieldData => zip(A, fn);

const MODES: Readonly<Record<string, (a: number, b: number) => number>> = {
  mix: (_a, b) => b,
  add: (a, b) => a + b,
  multiply: (a, b) => a * b,
  max: Math.max,
  min: Math.min,
};

test('ref/combine: the modes of the node are the five of this test', () => {
  const mode = def.params.find((param) => param.name === 'mode');
  assert.ok(mode?.kind === 'enum');
  assert.deepEqual(mode.options.map((option) => option.value), Object.keys(MODES));
});

for (const [mode, combined] of Object.entries(MODES)) {
  test(`ref/combine: mode ${mode}: full strength gives the combination, half strength the mean of it and \`a\``, async () => {
    // The two ends of the strength are selected, not blended: where the combination is one of the inputs, its
    // bits pass through. A sum or a product is arithmetic of the GPU compared with arithmetic done here, which
    // is never bit-compared (testing.md 5.2).
    const full = await combine({ mode, strength: 1 });
    if (mode === 'add' || mode === 'multiply') expectClose(full, each(combined), { max: 1e-6 });
    else expectIdentical(full, each(combined));
    expectClose(await combine({ mode, strength: 0.5 }), each((a, b) => a + 0.5 * (combined(a, b) - a)), { max: 1e-6 });
    expectIdentical(await combine({ mode, strength: 0 }), A);
  });
}

test('ref/combine: the mask scales the strength texel by texel, and is saturated on reading', async () => {
  // The mask fixture is 1 inside a radius of 0.2 and 0 outside 0.35.
  const mask = fixtures.mask(257);
  expectClose(await combine({ mode: 'add', strength: 0.8 }, mask), zip(mask, (a, b, m) => a + 0.8 * m * b), { max: 1e-6 });

  // A data field is a legal mask: below 0 it reads 0 and above 1 it reads 1.
  const wild = fieldOf(257, (u) => 4 * u - 1.5);
  expectClose(await combine({ mode: 'mix', strength: 1 }, wild), zip(wild, (a, b, m) => a + Math.min(1, Math.max(0, m)) * (b - a)), { max: 1e-6 });
});

test('ref/combine: an unconnected mask reads 1, and a mask of 0 leaves `a`', async () => {
  const params = { mode: 'multiply', strength: 0.5 };
  expectIdentical(await combine(params, null), await combine(params, 'one'));
  expectIdentical(await combine(params, 'zero'), A);
});

test('ref/combine: version 1 stored `amount` in percent; the migration turns it into a strength', async () => {
  assert.equal(def.version, 2);
  assert.deepEqual(def.migrate!({ mode: 'add', amount: 25 }, 1), { mode: 'add', strength: 0.25 });
  // What the user never set was not stored, and takes the default of this version.
  assert.deepEqual(def.migrate!({ mode: 'max' }, 1), { mode: 'max' });
  assert.deepEqual(def.migrate!({ strength: 0.75 }, 2), { strength: 0.75 }, 'only the step from version 1 changes anything');
  // The migrated parameters of a mix at 25 percent give a quarter of `b`.
  const migrated = def.migrate!({ mode: 'mix', amount: 25 }, 1) as Record<string, ParamValue>;
  expectClose(await combine(migrated), each((a, b) => a + 0.25 * (b - a)), { max: 1e-6 });
});
