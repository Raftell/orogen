// Type-level tests of the inference engine.md promises (3.13 "Types", 3.6, 4.2, 4.4, 4.6, 4.7) and of the export
// hook (export-unreal.md 2.1). `npm run check` is the test: a `@ts-expect-error` over a line that compiles is
// itself an error (TS2578), and expectType fails when a type is not exactly the one stated.
// This file is compiled and never run: it is not a *.test.ts file, and its definitions are not valid at run time.

import {
  defineKernel, defineNode, defineCpuTask, param, MASK_INPUT, decodeImage, ops,
  type Field, type FloatParam, type ParamDef, type PortDef, type Lut, type EvalContext, type OpContext, type ExportItem,
} from '../../src/core/api.ts';

/** Compile-time equality of two types. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
declare function expectType<A, B>(...ok: Equal<A, B> extends true ? [] : ['types differ', A, B]): void;

const step = defineKernel({
  name: 'ref/infer.step',
  inputs: { h: 'field', mask: MASK_INPUT, wide: { kind: 'color', size: 'any' } },
  outputs: { next: 'field' },
  inPlace: { moved: 'field' },
  params: { talus: 'f32', rate: 'f32', dir: 'vec2i', on: 'u32' },
  luts: { ramp: 'vec4f' },
  code: ``,
});
const gen = defineKernel({ name: 'ref/infer.gen', outputs: { out: 'color' }, code: `` });
const edt = defineCpuTask({
  name: 'ref/infer.edt',
  run(args: { data: Float32Array; w: number; h: number }) { return { data: args.data, w: args.w }; },
});

export default defineNode({
  type: 'ref/infer',
  title: 'Inference',
  category: 'ref',
  description: 'Exercises every inferred name of the contract.',
  inputs: [
    { name: 'in', type: 'field' },
    { name: 'tint', type: 'color', optional: true },
    { name: 'other', type: 'any', optional: true },
  ],
  outputs: [
    { name: 'out', type: 'field' },
    { name: 'moved', type: 'field', role: 'data' },
    { name: 'col', type: 'color' },
  ],
  params: [
    param.seed(),
    param.size(),
    param.size({ name: 'warpSize', label: 'Warp size' }),
    param.slope('talus'),
    { kind: 'enum', name: 'mode', help: 'h', default: 'mix', options: [{ value: 'mix', label: 'Mix' }, { value: 'add', label: 'Add' }] },
    { kind: 'bool', name: 'flag', help: 'h', default: true, visibleWhen: { param: 'mode', equals: 'mix' } },
    { kind: 'vec2', name: 'offset', unit: 'length', help: 'h', default: [0, 0], min: -1, max: 1 },
    { kind: 'color', name: 'tintColor', help: 'h', default: [1, 1, 1] },
    { kind: 'curve', name: 'profile', help: 'h', default: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
    { kind: 'gradient', name: 'ramp', help: 'h', default: [{ t: 0, color: [0, 0, 0] }, { t: 1, color: [1, 1, 1] }] },
    { kind: 'file', name: 'file', help: 'h', default: '', filters: ['png'] },
    { kind: 'text', name: 'label', help: 'h', default: 'x' },
    { kind: 'int', name: 'count', help: 'h', default: 1, min: 0, max: 4 },
  ],
  kernels: [step, gen],
  cpuTasks: [edt, decodeImage],
  uses: ['seaLevel'],
  externalKey(env) {
    expectType<typeof env.params.file, string>();
    // @ts-expect-error  a misspelt param name in externalKey
    env.params.fil;
    return env.params.file;
  },
  async evaluate(ctx) {
    // ---- positive: the types of ctx.params (4.5) -------------------------------------------------
    const p = ctx.params;
    expectType<typeof p.seed, number>();
    expectType<typeof p.size, number>();
    expectType<typeof p.warpSize, number>();
    expectType<typeof p.talus, number>();
    expectType<typeof p.mode, 'mix' | 'add'>();
    expectType<typeof p.flag, boolean>();
    expectType<typeof p.offset, readonly [number, number]>();
    expectType<typeof p.tintColor, readonly [number, number, number]>();
    expectType<typeof p.file, string>();
    expectType<typeof p.label, string>();
    expectType<typeof p.count, number>();

    // ---- positive: ports -------------------------------------------------------------------------
    const src = ctx.input('in');
    const tint = ctx.input('tint');
    const other = ctx.input('other');
    expectType<typeof src, Field<'field'>>();
    expectType<typeof tint, Field<'color'> | null>();
    expectType<typeof other, Field<'field'> | Field<'color'> | null>();
    if (other && other.kind === 'color') expectType<typeof other, Field<'color'>>();   // an 'any' input narrows by kind

    const out = ctx.alloc('field');
    const col = ctx.alloc('color');
    const lut = ctx.lut(new Float32Array(8), 'vec4f');
    const lutF = ctx.lut(new Float32Array(8), 'f32');
    expectType<typeof lut, Lut<'vec4f'>>();
    const good = { talus: 1, rate: 1, dir: [1, 0], on: true } as const;

    // the correct call; `mask` may be omitted, `moved` may be null
    ctx.run(step, { in: { h: src, wide: col }, out: { next: out }, rw: { moved: null }, params: good, luts: { ramp: lut } });
    ctx.run(gen, { out: { out: col } });

    // ---- 1. a typo in a param name ---------------------------------------------------------------
    // @ts-expect-error  Property 'sizee' does not exist on type 'ParamsOf<...>'. Did you mean 'size'?
    p.sizee;
    // @ts-expect-error  enumIndex takes the names of enum params only
    ctx.enumIndex('size');
    ctx.enumIndex('mode');
    // @ts-expect-error  unknown kernel param 'strenght'
    ctx.run(step, { in: { h: src, wide: col }, out: { next: out }, rw: { moved: null }, params: { ...good, strenght: 1 }, luts: { ramp: lut } });
    // @ts-expect-error  missing kernel param 'rate'
    ctx.run(step, { in: { h: src, wide: col }, out: { next: out }, rw: { moved: null }, params: { talus: 1, dir: [1, 0], on: 1 }, luts: { ramp: lut } });
    // @ts-expect-error  a vector passed for a scalar
    ctx.run(step, { in: { h: src, wide: col }, out: { next: out }, rw: { moved: null }, params: { ...good, talus: [1, 2] }, luts: { ramp: lut } });
    // @ts-expect-error  three numbers for a vec2i
    ctx.run(step, { in: { h: src, wide: col }, out: { next: out }, rw: { moved: null }, params: { ...good, dir: [1, 0, 0] }, luts: { ramp: lut } });
    // @ts-expect-error  params given to a kernel that declares none
    ctx.run(gen, { out: { out: col }, params: { a: 1 } });
    // @ts-expect-error  an undeclared project setting
    ctx.setting('sea');

    // ---- 2. a typo in a binding name -------------------------------------------------------------
    // @ts-expect-error  'height' is not an input of the kernel
    ctx.run(step, { in: { height: src, wide: col }, out: { next: out }, rw: { moved: null }, params: good, luts: { ramp: lut } });
    // @ts-expect-error  'nxt' is not an output of the kernel. Did you mean to write 'next'?
    ctx.run(step, { in: { h: src, wide: col }, out: { nxt: out }, rw: { moved: null }, params: good, luts: { ramp: lut } });
    // @ts-expect-error  'move' is not an in-place target of the kernel
    ctx.run(step, { in: { h: src, wide: col }, out: { next: out }, rw: { move: null }, params: good, luts: { ramp: lut } });
    // @ts-expect-error  'rmp' is not a lut of the kernel
    ctx.run(step, { in: { h: src, wide: col }, out: { next: out }, rw: { moved: null }, params: good, luts: { rmp: lut } });
    // @ts-expect-error  the slot name itself: 'inputs' instead of 'in'
    ctx.run(step, { inputs: { h: src, wide: col }, out: { next: out }, rw: { moved: null }, params: good, luts: { ramp: lut } });
    // @ts-expect-error  a required slot left out ('rw')
    ctx.run(step, { in: { h: src, wide: col }, out: { next: out }, params: good, luts: { ramp: lut } });
    // @ts-expect-error  null bound to a required input
    ctx.run(step, { in: { h: null, wide: col }, out: { next: out }, rw: { moved: null }, params: good, luts: { ramp: lut } });
    // @ts-expect-error  a colour bound to a 1-channel input
    ctx.run(step, { in: { h: col, wide: col }, out: { next: out }, rw: { moved: null }, params: good, luts: { ramp: lut } });
    // @ts-expect-error  a colour field bound to a 'field' output
    ctx.run(step, { in: { h: src, wide: col }, out: { next: col }, rw: { moved: null }, params: good, luts: { ramp: lut } });
    // @ts-expect-error  an 'f32' Lut bound to a 'vec4f' lut
    ctx.run(step, { in: { h: src, wide: col }, out: { next: out }, rw: { moved: null }, params: good, luts: { ramp: lutF } });
    // @ts-expect-error  a misspelt input port
    ctx.input('inn');

    // ---- 3. a typo in an output name -------------------------------------------------------------
    // @ts-expect-error  'outt' is not an output of the node
    ctx.output('outt', out);
    // @ts-expect-error  ctx.wants takes output names
    ctx.wants('movedd');
    // @ts-expect-error  a colour given to a 'field' output
    ctx.output('out', col);
    // @ts-expect-error  a misspelt output in a loop preview
    await ctx.loop(4, () => {}, { preview: () => ({ outt: out }) });
    await ctx.loop(4, () => {}, { preview: () => ({ out }) });

    // ---- the synchronous loop body (4.7 rule 1) --------------------------------------------------
    // @ts-expect-error  Type 'Promise<void>' is not assignable to type '"loop body must be synchronous"'
    await ctx.loop(4, async () => { ctx.run(gen, { out: { out: col } }); });
    // @ts-expect-error  a body that returns a promise
    await ctx.loop(4, () => ctx.flush());
    await ctx.loop(4, (i) => { ctx.run(gen, { out: { out: col }, iteration: i }); });

    // ---- CPU tasks (4.11 rule 6) -----------------------------------------------------------------
    const data = await ctx.read(src);
    const r = await ctx.cpu(edt, { data, w: src.width, h: src.height }, [data.buffer]);
    expectType<typeof r, { data: Float32Array; w: number }>();
    ctx.write(out, r.data);
    // @ts-expect-error  a missing task argument
    await ctx.cpu(edt, { data, w: 1 });
    const bytes = await ctx.readFile(p.file);
    const image = await ctx.cpu(decodeImage, { bytes }, [bytes.buffer]);
    expectType<typeof image.channels, 1 | 3 | 4>();

    // ---- helpers take OpContext or the untyped EvalContext ---------------------------------------
    helperOp(ctx);
    helperEval(ctx);
    ops.blend(ctx, src, out, tint ? 0.5 : 1);
    // @ts-expect-error  a field copied into a colour
    ops.copy(ctx, src, col);
    // @ts-expect-error  a field blended with a colour
    ops.blend(ctx, src, col, 0.5);

    ctx.output('out', out);
    ctx.output('col', col);
  },
});

function helperOp(ctx: OpContext): number { return ctx.res; }
function helperEval(ctx: EvalContext): number {
  expectType<ReturnType<typeof ctx.input>, Field<'field'> | Field<'color'> | null>();
  return ctx.seed;
}

// ---- names that are not literals are rejected, not silently accepted (4.6, LiteralNames) -----------------------
const MASK_WIDE: PortDef = { name: 'mask', type: 'field', role: 'mask', optional: true };
const MASK_OK = { name: 'mask', type: 'field', role: 'mask', optional: true } as const satisfies PortDef;
function durationWide(): FloatParam {
  return { kind: 'float', name: 'duration', unit: 'none', default: 1, min: 0, max: 10, help: 'How long it runs.' };
}
const sharedWide: readonly ParamDef[] = [param.seed(), param.size()];

export const widened = defineNode({
  type: 'ref/infer-wide', title: 'W', category: 'ref', description: 'x',
  // @ts-expect-error  a port constant typed PortDef has the name `string`
  inputs: [{ name: 'in', type: 'field' }, MASK_WIDE],
  outputs: [{ name: 'out', type: 'field' }],
  // @ts-expect-error  a helper declared to return FloatParam has the name `string`
  params: [param.size(), durationWide()],
  kernels: [],
  evaluate() {},
});
export const spread = defineNode({
  type: 'ref/infer-spread', title: 'S', category: 'ref', description: 'x',
  inputs: [{ name: 'in', type: 'field' }, MASK_OK],
  outputs: [{ name: 'out', type: 'field' }],
  // @ts-expect-error  a shared list typed ParamDef[] has names `string`
  params: [...sharedWide, param.gain()],
  kernels: [],
  evaluate(ctx) {
    expectType<ReturnType<typeof ctx.input<'mask'>>, Field<'field'> | null>();
  },
});

// ---- a maskable node has no ctx.input('mask') (4.13 rule 5) ---------------------------------------------------
export const maskable = defineNode({
  type: 'ref/infer-maskable', title: 'M', category: 'ref', description: 'x',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [],
  kernels: [],
  maskable: true,
  evaluate(ctx) {
    // @ts-expect-error  the evaluator's mask is invisible to evaluate()
    ctx.input('mask');
    // @ts-expect-error  a node without params has no ctx.params.anything
    ctx.params.size;
    ctx.output('out', ctx.input('in'));
  },
});

// ---- the export hook (export-unreal.md 2.1) -------------------------------------------------------------------
export const exporter = defineNode({
  type: 'io/export-infer', title: 'E', category: 'io', description: 'x',
  inputs: [{ name: 'in', type: 'field', role: 'mask' }],
  outputs: [],
  params: [
    { kind: 'bool', name: 'enabled', label: 'Enabled', default: true, help: 'Include this node in builds.' },
    { kind: 'text', name: 'layer', default: 'Layer', maxLength: 63, help: 'Name of the landscape target layer.' },
  ],
  kernels: [],
  evaluate() {},
  export(ctx) {
    expectType<typeof ctx.params.layer, string>();
    // @ts-expect-error  a misspelt input in the hook
    ctx.source('inn');
    // @ts-expect-error  a misspelt param in the hook
    ctx.params.layr;
    // @ts-expect-error  an item member of the wrong type
    const bad = [{ kind: 'layer', source: ctx.source('in'), layer: ctx.params.enabled, weightBlended: true }] satisfies readonly ExportItem[];
    void bad;
    return [{ kind: 'layer', source: ctx.source('in'), layer: ctx.params.layer, weightBlended: true }];
  },
});

// ---- visibleWhen is data, not a function (4.3) -----------------------------------------------------------------
export const visible = defineNode({
  type: 'ref/infer-visible', title: 'V', category: 'ref', description: 'x',
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    { kind: 'enum', name: 'rangeMode', help: 'h', default: 'fixed', options: [{ value: 'fixed', label: 'Fixed' }, { value: 'auto', label: 'Auto' }] },
    param.height({ name: 'heightMax', visibleWhen: { param: 'rangeMode', equals: 'fixed' } }),
    param.height({ name: 'heightMid', visibleWhen: { param: 'rangeMode', equals: ['fixed', 'auto'] } }),
    // @ts-expect-error  a predicate is not accepted
    { kind: 'float', name: 'heightMin', unit: 'height', help: 'h', default: 0, min: 0, max: 1, visibleWhen: (p: Record<string, unknown>) => p.rangeMode === 'fixed' },
  ],
  kernels: [],
  evaluate() {},
});

// ---- variants are typed by the union of their kinds, and an 'any' input narrows by kind (3.6, 4.2) -------------
const box3 = (kind: 'field' | 'color') => defineKernel({
  name: `ref/infer.box3#${kind}`,
  inputs: { src: kind, mask: MASK_INPUT },
  outputs: { out: kind },
  params: { dir: 'vec2i' },
  code: ``,
});
const box3Kernels = { field: box3('field'), color: box3('color') };
const relax = defineKernel({
  name: 'ref/infer.relax',
  mode: 'raw',
  unsafeReadWrite: { g: 'field' },
  raceFree: 'red-black: an invocation stores only where (x + y + parity) is even and loads only where it is odd',
  params: { parity: 'u32' },
  code: ``,
});

export const variants = defineNode({
  type: 'ref/infer-variants', title: 'B', category: 'ref', description: 'x',
  inputs: [{ name: 'in', type: 'any' }, { name: 'mask', type: 'field', role: 'mask', optional: true }],
  outputs: [{ name: 'out', type: { sameAs: 'in' } }],
  params: [],
  kernels: [box3Kernels.field, box3Kernels.color, relax],
  async evaluate(ctx) {
    const src = ctx.input('in');
    expectType<typeof src, Field<'field'> | Field<'color'>>();
    const out = ctx.alloc(src.kind);
    ctx.run(box3Kernels[src.kind], { in: { src, mask: ctx.input('mask') }, out: { out }, params: { dir: [1, 0] } });
    if (src.kind === 'field') {
      const g = ctx.clone(src);
      expectType<typeof g, Field<'field'>>();
      await ctx.loop(8, (i) => ctx.run(relax, { rw: { g }, params: { parity: i & 1 } }));
      // @ts-expect-error  an unsafeReadWrite target cannot be null
      ctx.run(relax, { rw: { g: null }, params: { parity: 0 } });
      ctx.release(g);
    }
    ctx.output('out', out);
  },
});
