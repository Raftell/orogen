// The evaluator's own content (runtime.md 5.6, engine.md 4.2, 4.13, 4.14): conversion between field and
// colour, bypass, the maskable blend and pass-through.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { defineKernel, defineNode } from '../../../src/core/api.ts';
import { assertUniform, calls, constantNode, endings, eventsOf, gainNode, rampNode, startEngine, tintNode, worst } from './rig.ts';

const invertKernel = defineKernel({
  name: 'test/invert',
  inputs: { src: 'color' },
  outputs: { out: 'color' },
  cost: 1,
  code: 'fn compute(px: vec2i, uv: vec2f) -> vec4f { let c = src_at(px); return vec4f(vec3f(1.0) - c.rgb, c.a); }',
});
/** A colour in, a colour out: 1 - rgb. */
const invertNode = defineNode({
  type: 'ref/invert',
  title: 'Invert (Test)',
  category: 'ref',
  description: 'Inverts a colour.',
  inputs: [{ name: 'in', type: 'color' }],
  outputs: [{ name: 'out', type: 'color' }],
  params: [],
  kernels: [invertKernel],
  maskable: true,
  evaluate(ctx) {
    calls.set('ref/invert', (calls.get('ref/invert') ?? 0) + 1);
    const out = ctx.alloc('color');
    ctx.run(invertKernel, { in: { src: ctx.input('in') }, out: { out } });
    ctx.output('out', out);
  },
});

const halve = (kind: 'field' | 'color') => defineKernel({
  name: `test/halve#${kind}`,
  inputs: { src: kind },
  outputs: { out: kind },
  cost: 1,
  code: 'fn compute(px: vec2i, uv: vec2f) -> out_t { return src_at(px) * 0.5; }',
});
const halveKernels = { field: halve('field'), color: halve('color') };
/** Takes a field or a colour as connected and gives the same kind. */
const halveNode = defineNode({
  type: 'ref/halve',
  title: 'Halve (Test)',
  category: 'ref',
  description: 'Halves a field or a colour.',
  inputs: [{ name: 'in', type: 'any' }],
  outputs: [{ name: 'out', type: { sameAs: 'in' } }],
  params: [],
  kernels: [halveKernels.field, halveKernels.color],
  maskable: true,
  evaluate(ctx) {
    const src = ctx.input('in');
    if (src.kind === 'field') {
      const out = ctx.alloc('field');
      ctx.run(halveKernels.field, { in: { src }, out: { out } });
      ctx.output('out', out);
    } else {
      const out = ctx.alloc('color');
      ctx.run(halveKernels.color, { in: { src }, out: { out } });
      ctx.output('out', out);
    }
  },
});

/** Gives its input straight to its output: an alias. */
const passNode = defineNode({
  type: 'ref/pass',
  title: 'Pass (Test)',
  category: 'ref',
  description: 'Passes its input through.',
  inputs: [{ name: 'in', type: 'any' }],
  outputs: [{ name: 'out', type: { sameAs: 'in' } }],
  params: [],
  kernels: [],
  maskable: true,
  evaluate(ctx) {
    calls.set('ref/pass', (calls.get('ref/pass') ?? 0) + 1);
    ctx.output('out', ctx.input('in'));
  },
});

const pairKernel = defineKernel({
  name: 'test/pair',
  inputs: { src: 'field' },
  outputs: { out: 'field', extra: 'field' },
  cost: 1,
  code: 'fn compute(px: vec2i, uv: vec2f) -> Out { return Out(src_at(px) + 1.0, src_at(px) + 2.0); }',
});
/** Maskable, with a second output and a second, required input. Its params cannot be normalised unless `mode` is valid. */
const pairNode = defineNode({
  type: 'ref/pair',
  title: 'Pair (Test)',
  category: 'ref',
  description: 'Gives in + 1 and in + 2.',
  inputs: [{ name: 'in', type: 'field' }, { name: 'other', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }, { name: 'extra', type: 'field', role: 'data' }, { name: 'tint', type: 'color' }],
  params: [{ kind: 'enum', name: 'mode', default: 'one', options: [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }], help: 'An enum.' }],
  kernels: [pairKernel],
  maskable: true,
  evaluate(ctx) {
    calls.set('ref/pair', (calls.get('ref/pair') ?? 0) + 1);
    const out = ctx.alloc('field');
    const extra = ctx.alloc('field');
    ctx.run(pairKernel, { in: { src: ctx.input('in') }, out: { out, extra } });
    ctx.output('out', out);
    ctx.output('extra', extra);
    ctx.output('tint', ctx.alloc('color', { clear: [1, 1, 1, 1] }));
  },
});

const paintKernel = defineKernel({
  name: 'test/paint',
  inputs: { src: 'field' },
  outputs: { out: 'color' },
  cost: 1,
  code: 'fn compute(px: vec2i, uv: vec2f) -> vec4f { return vec4f(src_at(px), 0.0, 0.0, 1.0); }',
});
/** A field in, a colour out: it cannot be bypassed. */
const paintNode = defineNode({
  type: 'ref/paint',
  title: 'Paint (Test)',
  category: 'ref',
  description: 'Paints a field red.',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'color' }],
  params: [],
  kernels: [paintKernel],
  evaluate(ctx) {
    const out = ctx.alloc('color');
    ctx.run(paintKernel, { in: { src: ctx.input('in') }, out: { out } });
    ctx.output('out', out);
  },
});

/** Maskable with an optional inputs[0]: a constant when nothing is connected. */
const baseNode = defineNode({
  type: 'ref/base',
  title: 'Base (Test)',
  category: 'ref',
  description: 'Gives a level, over its input where masked.',
  inputs: [{ name: 'in', type: 'field', optional: true }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [],
  kernels: [],
  maskable: true,
  evaluate: (ctx) => ctx.output('out', ctx.alloc('field', { clear: 8 })),
});

const t = await startEngine([constantNode, rampNode, tintNode, gainNode, invertNode, halveNode, passNode, pairNode, paintNode, baseNode]);
after(() => t.dispose());

const LUMA = 0.2126 * 0.25 + 0.7152 * 0.5 + 0.0722 * 0.75;
/** Slices of an engine service that completed since `from`. */
const serviceSlices = (service: string, from: number): number => t.slices.slice(from).filter((s) => s.service === service).length;
/** Every texel of a colour readback is `rgba`. */
function assertColor(data: Float32Array | null | undefined, rgba: readonly number[], message: string, tolerance = 1e-3): void {
  assert.ok(data && data.length % 4 === 0 && data.length > 0, `${message}: a colour readback`);
  const w = worst(data, (i) => rgba[i % 4]!);
  assert.ok(w.difference <= tolerance, `${message}: float ${w.index} is ${data[w.index]}, expected ${rgba[w.index % 4]}`);
}

test('conversion: a field input reads a colour as luma, a colour input reads a field as grey; "any" is never converted', async () => {
  await t.engine.trim();
  const doc = t.doc({
    tint: { type: 'ref/tint' },
    level: { type: 'ref/constant', params: { value: 0.25 } },
    luma: { type: 'ref/gain', params: { gain: 2 }, inputs: { in: 'tint.out' } },
    grey: { type: 'ref/invert', inputs: { in: 'level.out' } },
    anyColor: { type: 'ref/halve', inputs: { in: 'tint.out' } },
    anyField: { type: 'ref/halve', inputs: { in: 'level.out' } },
  });
  const out = await t.run(doc, ['luma.out', 'grey.out', 'anyColor.out', 'anyField.out']);
  assert.equal(out.result.status, 'ok', JSON.stringify(out.result.errors));
  assert.equal(out.data[0]!.length, 65 * 65, 'a field');
  assertUniform(out.data[0], 2 * LUMA, 'luma of (0.25, 0.5, 0.75), doubled', 1e-4);
  assertColor(out.data[1], [0.75, 0.75, 0.75, 1], 'grey of 0.25, inverted');
  assertColor(out.data[2], [0.125, 0.25, 0.375, 0.5], 'a colour through an "any" port: the output has the kind of the input');
  assert.equal(out.data[3]!.length, 65 * 65);
  assertUniform(out.data[3], 0.125, 'a field through an "any" port');
  t.noLeaks();
});

test('a conversion is content of its own: made once per source, shared by its readers, cached', async () => {
  await t.engine.trim();
  const doc = t.doc({
    tint: { type: 'ref/tint' },
    a: { type: 'ref/gain', params: { gain: 2 }, inputs: { in: 'tint.out' } },
    b: { type: 'ref/gain', params: { gain: 3 }, inputs: { in: 'tint.out' } },
  });
  let from = t.slices.length;
  const first = await t.run(doc, ['a.out', 'b.out', 'tint.out:field']);
  assert.equal(serviceSlices('convert', from), 1, 'one luma conversion for two readers and a target');
  assertUniform(first.data[0], 2 * LUMA, 'a', 1e-4);
  assertUniform(first.data[1], 3 * LUMA, 'b', 1e-4);
  assertUniform(first.data[2], LUMA, 'the target delivered as a field', 1e-4);
  assert.equal(first.result.fields.length, 3);

  from = t.slices.length;
  const edited = t.doc({
    tint: { type: 'ref/tint' },
    a: { type: 'ref/gain', params: { gain: 5 }, inputs: { in: 'tint.out' } },
  });
  const second = await t.run(edited, ['a.out']);
  assert.deepEqual(endings(second.events), { tint: 'cached', a: 'run' });
  assert.equal(serviceSlices('convert', from), 0, 'the conversion is a cache hit');
  assertUniform(second.data[0], 5 * LUMA, 'a after the edit', 1e-4);
  t.noLeaks();
});

test('a target with "as" yields the converted field; the kind it already has costs nothing', async () => {
  await t.engine.trim();
  const doc = t.doc({ level: { type: 'ref/constant', params: { value: 0.5 } }, tint: { type: 'ref/tint' } });
  const from = t.slices.length;
  const { result } = await t.evaluate(doc, ['level.out:color', 'level.out:field', 'tint.out:field', 'tint.out:color', 'tint.out']);
  assert.deepEqual(result.fields.map((f) => f!.kind), ['color', 'field', 'field', 'color', 'color']);
  assertColor(await t.engine.read(result.fields[0]!), [0.5, 0.5, 0.5, 1], 'grey');
  assertUniform(await t.engine.read(result.fields[1]!), 0.5, 'a field as a field');
  assertUniform(await t.engine.read(result.fields[2]!), LUMA, 'luma', 1e-4);
  assertColor(await t.engine.read(result.fields[3]!), [0.25, 0.5, 0.75, 1], 'a colour as a colour');
  assert.equal(result.fields[3]!.texture, result.fields[4]!.texture, 'no conversion, no copy');
  assert.equal(serviceSlices('convert', from), 2);
  for (const field of result.fields) field!.release();
  t.noLeaks();
});

test('bypass: outputs[0] is the field connected to inputs[0], every other output the constant of its kind', async () => {
  await t.engine.trim();
  calls.clear();
  const doc = t.doc({
    level: { type: 'ref/constant', params: { value: 3 } },
    // No "other" input and an unknown enum value: a bypassed node has no missing input and no parameter error.
    pair: { type: 'ref/pair', params: { mode: 'nonsense' }, inputs: { in: 'level.out' }, bypass: true },
    after: { type: 'ref/gain', params: { gain: 2 }, inputs: { in: 'pair.out' } },
    extra: { type: 'ref/gain', params: { gain: 2 }, inputs: { in: 'pair.extra' } },
  });
  const out = await t.run(doc, ['after.out', 'pair.out', 'pair.extra', 'pair.tint', 'extra.out']);
  assert.equal(out.result.status, 'ok', JSON.stringify(out.result.errors));
  assert.deepEqual(endings(out.events), { level: 'run', pair: 'cached', after: 'run', extra: 'run' });
  assert.equal(eventsOf(out.events, 'eval-start')[0]!.plan.find((p) => p.nodeId === 'pair')!.state, 'bypassed');
  assert.equal(calls.get('ref/pair'), undefined, 'evaluate() of a bypassed node is not called');
  assertUniform(out.data[0], 6, 'the reader of a bypassed node reads its input');
  assertUniform(out.data[1], 3, 'outputs[0] is inputs[0]');
  assertUniform(out.data[2], 0, 'another field output is 0');
  assertColor(out.data[3], [0, 0, 0, 1], 'another colour output is (0, 0, 0, 1)');
  assertUniform(out.data[4], 0, 'a reader of a constant');
  t.noLeaks();
});

test('bypass: converted as the input would be, the constant when nothing is connected, ignored when the types differ', async () => {
  await t.engine.trim();
  const doc = t.doc({
    level: { type: 'ref/constant', params: { value: 0.25 } },
    grey: { type: 'ref/invert', inputs: { in: 'level.out' }, bypass: true },
    empty: { type: 'ref/invert', bypass: true },
    paint: { type: 'ref/paint', inputs: { in: 'level.out' }, bypass: true },
    generator: { type: 'ref/constant', params: { value: 9 }, bypass: true },
    chain: { type: 'ref/gain', inputs: { in: 'level.out' }, bypass: true },
    chain2: { type: 'ref/gain', inputs: { in: 'chain.out' }, bypass: true },
  });
  const out = await t.run(doc, ['grey.out', 'empty.out', 'paint.out', 'generator.out', 'chain2.out']);
  assert.equal(out.result.status, 'ok', JSON.stringify(out.result.errors));
  assertColor(out.data[0], [0.25, 0.25, 0.25, 1], 'the field as the colour input would read it');
  assertColor(out.data[1], [0, 0, 0, 1], 'an unconnected inputs[0]');
  assertColor(out.data[2], [0.25, 0, 0, 1], 'field in, colour out: bypass has no effect');
  assertUniform(out.data[3], 9, 'a node without inputs: bypass has no effect');
  assertUniform(out.data[4], 0.25, 'two bypassed nodes in a row');
  assert.deepEqual(endings(out.events), { level: 'run', grey: 'cached', empty: 'cached', paint: 'run', generator: 'run', chain: 'cached', chain2: 'cached' });

  // The keys follow the content: a bypassed node has the key of what it passes on, under a name of its own.
  const keys = await t.engine.keys(doc);
  assert.equal(new Set([keys.get('level'), keys.get('chain'), keys.get('chain2')]).size, 3);
  assert.equal(JSON.parse(keys.get('empty')!)[0], 'const');
  t.noLeaks();
});

test('maskable: outputs[0] becomes mix(inputs[0], outputs[0], saturate(mask)); other outputs are untouched', async () => {
  await t.engine.trim();
  calls.clear();
  const graph = (maskGain: number) => t.doc({
    level: { type: 'ref/constant', params: { value: 4 } },
    // 2u * gain - 0.5: below 0 on the left, above 1 on the right.
    mask: { type: 'ref/ramp', params: { gainX: 2 * maskGain, gainY: 0, base: -0.5 } },
    pair: { type: 'ref/pair', inputs: { in: 'level.out', other: 'level.out', mask: 'mask.out' } },
    reader: { type: 'ref/gain', params: { gain: 10 }, inputs: { in: 'pair.out' } },
  });
  const blended = (maskGain: number, scale: number) => (i: number): number => {
    const m = Math.min(1, Math.max(0, 2 * maskGain * ((i % 65) / 64) - 0.5));
    return scale * (4 + (5 - 4) * m);
  };
  let from = t.slices.length;
  const out = await t.run(graph(1), ['pair.out', 'pair.extra', 'reader.out']);
  assert.equal(out.result.status, 'ok', JSON.stringify(out.result.errors));
  assert.ok(worst(out.data[0]!, blended(1, 1)).difference < 1e-5, 'pair.out is blended over its input');
  assertUniform(out.data[1], 6, 'pair.extra is as computed');
  assert.ok(worst(out.data[2]!, blended(1, 10)).difference < 1e-4, 'every reader gets the blended field');
  assert.deepEqual([out.data[0]![0], out.data[0]![64]], [4, 5], 'mask 0 keeps the input, mask 1 takes the result');
  assert.equal(serviceSlices('mask', from), 1);

  // A changed mask repeats the blend and not the node.
  from = t.slices.length;
  const changed = await t.run(graph(2), ['pair.out']);
  assert.deepEqual(endings(changed.events), { level: 'cached', mask: 'run', pair: 'cached' });
  assert.equal(calls.get('ref/pair'), 1);
  assert.ok(worst(changed.data[0]!, blended(2, 1)).difference < 1e-5);
  assert.equal(serviceSlices('mask', from), 1);

  // Both blends are content of their own.
  from = t.slices.length;
  assert.deepEqual(endings((await t.run(graph(1), ['pair.out'])).events), { level: 'cached', mask: 'cached', pair: 'cached' });
  assert.equal(serviceSlices('mask', from), 0);
  const keys1 = await t.engine.keys(graph(1)), keys2 = await t.engine.keys(graph(2));
  assert.notEqual(keys1.get('pair'), keys2.get('pair'), 'the mask is in the content key of outputs[0]');
  assert.equal(JSON.parse(keys1.get('pair')!)[0], 'mask');
  t.noLeaks();
});

test('maskable: nothing is added without a mask; a colour mask is read as luma; a colour is blended per channel', async () => {
  await t.engine.trim();
  let from = t.slices.length;
  const plain = await t.run(t.doc({
    level: { type: 'ref/constant', params: { value: 4 } },
    gain: { type: 'ref/gain', params: { gain: 3 }, inputs: { in: 'level.out' } },
  }), ['gain.out']);
  assertUniform(plain.data[0], 12, 'no mask');
  assert.equal(serviceSlices('mask', from), 0, 'no pass, no texture');

  from = t.slices.length;
  const doc = t.doc({
    tint: { type: 'ref/tint' },
    level: { type: 'ref/constant', params: { value: 0.5 } },
    byColor: { type: 'ref/gain', params: { gain: 3 }, inputs: { in: 'level.out', mask: 'tint.out' } },
    colour: { type: 'ref/invert', inputs: { in: 'tint.out', mask: 'level.out' } },
    any: { type: 'ref/halve', inputs: { in: 'tint.out', mask: 'level.out' } },
  });
  const out = await t.run(doc, ['byColor.out', 'colour.out', 'any.out']);
  assert.equal(out.result.status, 'ok', JSON.stringify(out.result.errors));
  assertUniform(out.data[0], 0.5 + (1.5 - 0.5) * LUMA, 'a mask of kind colour is converted with luma', 1e-4);
  // mix((0.25, 0.5, 0.75, 1), (0.75, 0.5, 0.25, 1), 0.5)
  assertColor(out.data[1], [0.5, 0.5, 0.5, 1], 'a colour blended by a field mask');
  assertColor(out.data[2], [0.1875, 0.375, 0.5625, 0.75], 'an "any" node is blended in the kind it received');
  assert.equal(serviceSlices('mask', from), 3);
  t.noLeaks();
});

test('pass-through: an input given as an output is an alias, with a key of its own; its mask blend is skipped', async () => {
  await t.engine.trim();
  calls.clear();
  const doc = t.doc({
    level: { type: 'ref/constant', params: { value: 7 } },
    mask: { type: 'ref/constant', params: { value: 0.5 } },
    pass: { type: 'ref/pass', inputs: { in: 'level.out', mask: 'mask.out' } },
    reader: { type: 'ref/gain', params: { gain: 2 }, inputs: { in: 'pass.out' } },
  });
  const from = t.slices.length;
  const { result, events } = await t.evaluate(doc, ['pass.out', 'level.out', 'reader.out']);
  assert.equal(result.status, 'ok', JSON.stringify(result.errors));
  assert.deepEqual(endings(events), { level: 'run', mask: 'run', pass: 'run', reader: 'run' });
  assert.equal(result.fields[0]!.texture, result.fields[1]!.texture, 'no texture is allocated for the alias');
  assertUniform(await t.engine.read(result.fields[0]!), 7, 'pass.out');
  assertUniform(await t.engine.read(result.fields[2]!), 14, 'reader.out');
  assert.equal(serviceSlices('mask', from), 0, 'mix(x, x, m) is x');
  assert.equal(t.engine.memory().pinnedBytes, 2 * 65 * 65 * 4, 'two textures behind three handles');
  for (const field of result.fields) field!.release();

  const keys = await t.engine.keys(doc);
  assert.notEqual(keys.get('pass'), keys.get('level'), 'aliasing changes memory and work, never a key');
  assert.deepEqual(endings((await t.run(doc, ['reader.out'])).events), { level: 'cached', mask: 'cached', pass: 'cached', reader: 'cached' });
  assert.equal(calls.get('ref/pass'), 1);

  // The alias keeps its texture alive when the source's own entry is gone.
  await t.engine.trim();
  const colour = await t.run(t.doc({ tint: { type: 'ref/tint' }, pass: { type: 'ref/pass', inputs: { in: 'tint.out' } } }), ['pass.out']);
  assertColor(colour.data[0], [0.25, 0.5, 0.75, 1], 'a colour passed through');
  t.noLeaks();
});

test('maskable with an optional inputs[0] that is unconnected: the blend uses the constant in its place', async () => {
  await t.engine.trim();
  const doc = t.doc({
    mask: { type: 'ref/constant', params: { value: 0.25 } },
    base: { type: 'ref/base', inputs: { mask: 'mask.out' } },
  });
  const out = await t.run(doc, ['base.out']);
  assert.equal(out.result.status, 'ok', JSON.stringify(out.result.errors));
  assertUniform(out.data[0], 2, 'mix(0, 8, 0.25)');
  t.noLeaks();
});
