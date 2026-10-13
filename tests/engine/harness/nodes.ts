// The nodes the tests of the harness evaluate: each does one thing a test can predict exactly. Not a test file.

import { defineKernel, defineNode } from '../../../src/core/api.ts';

const scaleKernel = defineKernel({
  name: 'ref/h-scale',
  inputs: { src: 'field' },
  outputs: { out: 'field' },
  params: { factor: 'f32' },
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return src_at(px) * P.factor; }',
});

/** in * factor. Maskable. */
export const scale = defineNode({
  type: 'ref/h-scale',
  title: 'Scale (Reference)',
  category: 'ref',
  description: 'Multiplies a field by a factor.',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [{ kind: 'float', name: 'factor', unit: 'none', default: 2, min: -100, max: 100, help: 'The factor.' }],
  kernels: [scaleKernel],
  maskable: true,
  evaluate(ctx) {
    const out = ctx.alloc('field');
    ctx.run(scaleKernel, { in: { src: ctx.input('in') }, out: { out }, params: { factor: ctx.params.factor } });
    ctx.output('out', out);
  },
});

/** out = in, half = in / 2; `half` is made only when it is wanted. How often evaluate() ran is counted. */
export const splitCalls = { count: 0, halves: 0 };
export const split = defineNode({
  type: 'ref/h-split',
  title: 'Split (Reference)',
  category: 'ref',
  description: 'Passes its input on, and offers half of it.',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }, { name: 'half', type: 'field', role: 'data' }],
  params: [],
  kernels: [scaleKernel],
  evaluate(ctx) {
    splitCalls.count++;
    ctx.output('out', ctx.input('in'));
    if (!ctx.wants('half')) return;
    splitCalls.halves++;
    const half = ctx.alloc('field');
    ctx.run(scaleKernel, { in: { src: ctx.input('in') }, out: { out: half }, params: { factor: 0.5 } });
    ctx.output('half', half);
  },
});

const dimKernel = defineKernel({
  name: 'ref/h-dim',
  inputs: { src: 'color' },
  outputs: { out: 'color' },
  code: 'fn compute(px: vec2i, uv: vec2f) -> vec4f { let c = src_at(px); return vec4f(0.5 * c.rgb, c.a); }',
});

/** A colour at half its brightness. */
export const dim = defineNode({
  type: 'ref/h-dim',
  title: 'Dim (Reference)',
  category: 'ref',
  description: 'Halves the brightness of a colour.',
  inputs: [{ name: 'in', type: 'color' }],
  outputs: [{ name: 'out', type: 'color' }],
  params: [],
  kernels: [dimKernel],
  evaluate(ctx) {
    const out = ctx.alloc('color');
    ctx.run(dimKernel, { in: { src: ctx.input('in') }, out: { out } });
    ctx.output('out', out);
  },
});

/** Whatever is connected, unchanged: a field or a colour. */
export const either = defineNode({
  type: 'ref/h-either',
  title: 'Either (Reference)',
  category: 'ref',
  description: 'Passes a field or a colour on.',
  inputs: [{ name: 'in', type: 'any' }],
  outputs: [{ name: 'out', type: { sameAs: 'in' } }],
  params: [],
  kernels: [],
  evaluate(ctx) {
    ctx.output('out', ctx.input('in'));
  },
});

/** One of five colours and of three heights, passed on: which fixture an input was given shows in the output. */
export const pick = defineNode({
  type: 'ref/h-pick',
  title: 'Pick (Reference)',
  category: 'ref',
  description: 'Passes one of its inputs on.',
  inputs: [
    { name: 'a', type: 'color' }, { name: 'x', type: 'field' }, { name: 'b', type: 'color' }, { name: 'y', type: 'any' }, { name: 'c', type: 'color' },
    { name: 'd', type: 'color' }, { name: 'z', type: 'field', role: 'data' }, { name: 'e', type: 'color' }, { name: 'weights', type: 'field', role: 'mask' },
  ],
  outputs: [{ name: 'out', type: 'color' }, { name: 'height', type: 'field' }],
  params: [
    { kind: 'int', name: 'colorIndex', default: 0, min: 0, max: 4, help: 'The color input that is passed on.' },
    { kind: 'int', name: 'heightIndex', default: 0, min: 0, max: 3, help: 'The height input that is passed on.' },
  ],
  kernels: [],
  evaluate(ctx) {
    ctx.output('out', ctx.input((['a', 'b', 'c', 'd', 'e'] as const)[ctx.params.colorIndex]!));
    const height = ctx.input((['x', 'y', 'z', 'weights'] as const)[ctx.params.heightIndex]!);
    if (height.kind !== 'field') throw new Error('The input y was given a color');
    ctx.output('height', height);
  },
});

/** Throws its message when it has one; otherwise passes its input on. */
export const failing = defineNode({
  type: 'ref/h-fail',
  title: 'Fail (Reference)',
  category: 'ref',
  description: 'Fails with a message, or passes its input on.',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [{ kind: 'text', name: 'message', default: '', help: 'The error to raise; none when empty.' }],
  kernels: [],
  evaluate(ctx) {
    if (ctx.params.message !== '') throw new Error(ctx.params.message);
    ctx.output('out', ctx.input('in'));
  },
});

const addKernel = defineKernel({
  name: 'ref/h-add',
  inputs: { src: 'field' },
  outputs: { out: 'field' },
  params: { k: 'f32' },
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return src_at(px) + P.k; }',
});

/** in + count / 64, one 64th per iteration of a loop. */
export const climb = defineNode({
  type: 'ref/h-climb',
  title: 'Climb (Reference)',
  category: 'ref',
  description: 'Raises a field a little in each of a number of rounds.',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [{ kind: 'int', name: 'count', default: 8, min: 0, max: 64, help: 'More rounds raise the field further.' }],
  kernels: [addKernel],
  async evaluate(ctx) {
    let a = ctx.clone(ctx.input('in'));
    let b = ctx.alloc('field');
    await ctx.loop(ctx.params.count, () => {
      ctx.run(addKernel, { in: { src: a }, out: { out: b }, params: { k: 1 / 64 } });
      [a, b] = [b, a];
    });
    ctx.output('out', a);
  },
});

/** A field that holds one number everywhere: a parameter, the sea level, the cell size in metres or the height range. */
export const probe = defineNode({
  type: 'ref/h-probe',
  title: 'Probe (Reference)',
  category: 'ref',
  description: 'Fills a field with a number the evaluation context gives.',
  inputs: [],
  outputs: [{ name: 'out', type: 'field', role: 'data' }],
  params: [
    {
      kind: 'enum', name: 'what', default: 'value', help: 'Which number fills the field.',
      options: [{ value: 'value', label: 'Value' }, { value: 'sea', label: 'Sea level' }, { value: 'cell', label: 'Cell size' }, { value: 'range', label: 'Height range' }],
    },
    { kind: 'float', name: 'value', unit: 'none', default: 0.5, min: -100, max: 100, help: 'The number of the first choice.' },
  ],
  kernels: [],
  uses: ['seaLevel'],
  evaluate(ctx) {
    const { what, value } = ctx.params;
    const number = what === 'sea' ? ctx.setting('seaLevel') : what === 'cell' ? ctx.cellSize : what === 'range' ? ctx.heightRange : value;
    ctx.output('out', ctx.alloc('field', { clear: number }));
  },
});

/** A field that holds the first byte of a file, as a fraction of 255. */
export const firstByte = defineNode({
  type: 'ref/h-byte',
  title: 'Byte (Reference)',
  category: 'ref',
  description: 'Fills a field with the first byte of a file.',
  inputs: [],
  outputs: [{ name: 'out', type: 'field', role: 'data' }],
  params: [{ kind: 'file', name: 'file', default: '', filters: ['bin'], help: 'The file whose first byte is read.' }],
  kernels: [],
  async evaluate(ctx) {
    if (ctx.params.file === '') throw new Error('No file selected');
    const bytes = await ctx.readFile(ctx.params.file);
    ctx.output('out', ctx.alloc('field', { clear: (bytes[0] ?? 0) / 255 }));
  },
});

export const harnessNodes = [scale, split, dim, either, failing, climb, probe, firstByte];
