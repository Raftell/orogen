// One small broken node for each conformance check, and a few sound ones, each handed to conformance(). This
// file is not run by the test layers: conformance.test.ts starts it as a test file of its own, in a child
// process, and reads which cases failed. Every node here fails the check it is named for, by the mistake a
// node author would make.
//
// Sizes: the fields of the suite, 33 to 513 texels per side, and 2049 in `deterministic-large`.

import assert from 'node:assert/strict';

import { bakeCurve, bakeGradient, defineKernel, defineNode, MASK_INPUT, noise, param } from '../../../src/core/api.ts';
import { conformance } from '../../helpers/index.ts';

// ---- kernels the nodes share ---------------------------------------------------------------------------------------

const copy = defineKernel({
  name: 'ref/bad-copy',
  inputs: { src: 'field' },
  outputs: { out: 'field' },
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return src_at(px); }',
});

const add = defineKernel({
  name: 'ref/bad-add',
  inputs: { src: 'field' },
  outputs: { out: 'field' },
  params: { k: 'f32' },
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return src_at(px) + P.k; }',
});

// ---- meta ----------------------------------------------------------------------------------------------------------

conformance(defineNode({
  type: 'ref/bad-meta',
  title: 'Bad Meta (Reference)',
  category: 'ref',
  description: 'This node copies its input.',      // no verb in the third person first
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [],
  kernels: [],
  evaluate(ctx) {
    ctx.output('out', ctx.input('in'));              // an alias: the node completes without a slice
  },
}));

// An export node has no outputs and is never evaluated: its suite is `meta` alone, which also asks the export
// rules (export-unreal.md 2.3). This one breaks them: it is not in the category io, and it is not named io/export-*.
conformance(defineNode({
  type: 'ref/bad-export',
  title: 'Bad Export (Reference)',
  category: 'ref',
  description: 'Declares what a build writes, from the wrong category.',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [],
  params: [],
  kernels: [],
  evaluate() { /* never called */ },
  export() {
    return [];
  },
}));

// ---- finite --------------------------------------------------------------------------------------------------------

const nan = defineKernel({
  name: 'ref/bad-finite',
  inputs: { src: 'field' },
  outputs: { out: 'field' },
  params: { bits: 'u32' },
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  if (px.x == 7 && px.y == 9) { return bitcast<f32>(P.bits); }
  return src_at(px);
}`,
});

conformance(defineNode({
  type: 'ref/bad-finite',
  title: 'Bad Finite (Reference)',
  category: 'ref',
  description: 'Stores one value that is not a number.',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [],
  kernels: [nan],
  evaluate(ctx) {
    const out = ctx.alloc('field');
    ctx.run(nan, { in: { src: ctx.input('in') }, out: { out }, params: { bits: 0x7fc00000 } });   // a quiet NaN
    ctx.output('out', out);
  },
}));

// ---- mask-range ----------------------------------------------------------------------------------------------------

const unsaturated = defineKernel({
  name: 'ref/bad-mask',
  inputs: { src: 'field' },
  outputs: { out: 'field' },
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return 1.5 * src_at(px); }',     // not saturated before storing
});

conformance(defineNode({
  type: 'ref/bad-mask',
  title: 'Bad Mask (Reference)',
  category: 'ref',
  description: 'Selects high ground, and forgets to saturate.',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field', role: 'mask' }],
  params: [],
  kernels: [unsaturated],
  evaluate(ctx) {
    const out = ctx.alloc('field');
    ctx.run(unsaturated, { in: { src: ctx.input('in') }, out: { out } });
    ctx.output('out', out);
  },
}));

// ---- alpha ---------------------------------------------------------------------------------------------------------

const translucent = defineKernel({
  name: 'ref/bad-alpha',
  inputs: { src: 'field' },
  outputs: { out: 'color' },
  code: 'fn compute(px: vec2i, uv: vec2f) -> vec4f { return vec4f(vec3f(src_at(px)), 0.5); }',
});

conformance(defineNode({
  type: 'ref/bad-alpha',
  title: 'Bad Alpha (Reference)',
  category: 'ref',
  description: 'Paints heights grey with an alpha of one half.',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'color' }],
  params: [],
  kernels: [translucent],
  evaluate(ctx) {
    const out = ctx.alloc('color');
    ctx.run(translucent, { in: { src: ctx.input('in') }, out: { out } });
    ctx.output('out', out);
  },
}));

// ---- generator-range -----------------------------------------------------------------------------------------------

const flat = defineKernel({
  name: 'ref/bad-range',
  outputs: { out: 'field' },
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return 0.1 + 0.1 * uv.x; }',     // spans 0.1, around 0.15
});

const narrow = defineNode({
  type: 'ref/bad-range',
  title: 'Bad Range (Reference)',
  category: 'ref',
  description: 'Generates a terrain that spans a tenth of the height range.',
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [],
  kernels: [flat],
  evaluate(ctx) {
    const out = ctx.alloc('field');
    ctx.run(flat, { out: { out } });
    ctx.output('out', out);
  },
});
conformance(narrow);
assert.throws(() => conformance(narrow), /was already called in this file/, 'a test file calls conformance once for a node');

// The same generator under a declared opt-out: the case is reported as skipped, with the reason.
const shelf = defineKernel({
  name: 'ref/good-shelf',
  outputs: { out: 'field' },
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return 0.1 + 0.1 * uv.x; }',
});
conformance(defineNode({
  type: 'ref/good-shelf',
  title: 'Good Shelf (Reference)',
  category: 'ref',
  description: 'Generates a gentle shelf, a single shape with a small span.',
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [],
  kernels: [shelf],
  evaluate(ctx) {
    const out = ctx.alloc('field');
    ctx.run(shelf, { out: { out } });
    ctx.output('out', out);
  },
}), { skip: { 'generator-range': 'Outputs a single shallow shape by design; its span is 0.1.' } });

// What is no generator although it has no required input (testing.md 3.2): a mask made from nothing, and a node
// with a `file` parameter. Neither is held to the height range, and both may declare a tolerance.
const disc = defineKernel({
  name: 'ref/good-disc',
  outputs: { out: 'field' },
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return saturate((0.1 - distance(uv, vec2f(0.5))) / 0.05); }',   // 0 on nine tenths of the terrain
});
conformance(defineNode({
  type: 'ref/good-disc',
  title: 'Good Disc (Reference)',
  category: 'ref',
  description: 'Generates a small disc as a mask.',
  inputs: [],
  outputs: [{ name: 'out', type: 'field', role: 'mask' }],
  params: [],
  kernels: [disc],
  evaluate(ctx) {
    const out = ctx.alloc('field');
    ctx.run(disc, { out: { out } });
    ctx.output('out', out);
  },
}), { resolutionTol: { value: 0.02, reason: 'A mask producer is no generator: the option is accepted, and this exact mask needs none of it.' } });

const level = defineKernel({
  name: 'ref/good-file',
  outputs: { out: 'field' },
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return 0.1 + 0.1 * uv.y; }',
});
conformance(defineNode({
  type: 'ref/good-file',
  title: 'Good File (Reference)',
  category: 'ref',
  description: 'Generates what a file would hold: heights of any range.',
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [{ kind: 'file', name: 'file', default: '', filters: ['png'], help: 'The file whose heights the node returns.' }],
  kernels: [level],
  evaluate(ctx) {
    const out = ctx.alloc('field');
    ctx.run(level, { out: { out } });
    ctx.output('out', out);
  },
}));

// A generator with an optional input, as a node that stamps into a terrain when one is connected: the generator
// checks apply, with every input connected.
const stamp = defineKernel({
  name: 'ref/good-stamp',
  inputs: { base: { kind: 'field', default: 0.5 } },
  outputs: { out: 'field' },
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return base_at(px) - 0.1 * saturate(1.0 - 8.0 * distance(uv, vec2f(0.5))); }',
});
conformance(defineNode({
  type: 'ref/good-stamp',
  title: 'Good Stamp (Reference)',
  category: 'ref',
  description: 'Generates a dent, in the terrain connected to it or in a flat field.',
  inputs: [{ name: 'in', type: 'field', optional: true }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [],
  kernels: [stamp],
  evaluate(ctx) {
    const out = ctx.alloc('field');
    ctx.run(stamp, { in: { base: ctx.input('in') }, out: { out } });
    ctx.output('out', out);
  },
}));

// ---- deterministic -------------------------------------------------------------------------------------------------

const leaky = defineKernel({
  name: 'ref/bad-recycled',
  inputs: { src: 'field', scratch: 'field' },
  outputs: { out: 'field' },
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return src_at(px) + 1e-30 * scratch_at(px); }',
});

conformance(defineNode({
  type: 'ref/bad-recycled',
  title: 'Bad Recycled (Reference)',
  category: 'ref',
  description: 'Reads a field it allocated and never wrote.',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [],
  kernels: [leaky],
  evaluate(ctx) {
    const scratch = ctx.alloc('field');              // contents undefined: zeros when the texture is new, another node's data when not
    const out = ctx.alloc('field');
    ctx.run(leaky, { in: { src: ctx.input('in'), scratch }, out: { out } });
    ctx.output('out', out);
  },
}));

// ---- deterministic-large, and slicing by a tile ----------------------------------------------------------------------

const race = defineKernel({
  name: 'ref/bad-race',
  mode: 'raw',
  unsafeReadWrite: { g: 'field' },
  raceFree: 'claimed, and false: every invocation loads the texels its neighbours store',
  code: /* wgsl */ `
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (!beginPixel(gid)) { return; }
  let px = pixel();
  let e = textureLoad(g, clampToGrid(px + vec2i(1, 0))).r;
  let w = textureLoad(g, clampToGrid(px - vec2i(1, 0))).r;
  let n = textureLoad(g, clampToGrid(px + vec2i(0, 1))).r;
  let s = textureLoad(g, clampToGrid(px - vec2i(0, 1))).r;
  textureStore(g, px, vec4f(0.25 * (e + w + n + s), 0.0, 0.0, 1.0));
}`,
});

conformance(defineNode({
  type: 'ref/bad-race',
  title: 'Bad Race (Reference)',
  category: 'ref',
  description: 'Relaxes a terrain in place, every texel reading what its neighbours write.',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [],
  kernels: [race],
  resolutionDependent: true,                          // keeps the node out of `resolution`: its races are the subject
  evaluate(ctx) {
    const g = ctx.clone(ctx.input('in'));
    for (let pass = 0; pass < 8; pass++) ctx.run(race, { rw: { g } });
    ctx.output('out', g);
  },
}));

// ---- resolution ----------------------------------------------------------------------------------------------------

const stripes = defineKernel({
  name: 'ref/bad-px',
  outputs: { out: 'field' },
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return 0.5 + 0.4 * sin(f32(px.x) * 0.2); }',   // positioned by px, not by uv
});

conformance(defineNode({
  type: 'ref/bad-px',
  title: 'Bad Px (Reference)',
  category: 'ref',
  description: 'Generates stripes a fixed number of texels wide.',
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [],
  kernels: [stripes],
  evaluate(ctx) {
    const out = ctx.alloc('field');
    ctx.run(stripes, { out: { out } });
    ctx.output('out', out);
  },
}));

// A measure that legitimately changes with the level: the difference to the next texel, as a physical slope.
const forward = (name: string) => defineKernel({
  name,
  inputs: { src: 'field' },
  outputs: { out: 'field' },
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  let rise = (src_at(px + vec2i(1, 0)) - src_at(px)) * frame.heightRange;
  return rise / frame.cellSize;
}`,
});
const slopeNode = (type: 'ref/bad-tolerance' | 'ref/good-tolerance', title: string) => {
  const kernel = forward(type);
  return defineNode({
    type,
    title,
    category: 'ref',
    description: 'Measures the slope towards the next texel.',
    inputs: [{ name: 'in', type: 'field' }],
    outputs: [{ name: 'out', type: 'field', role: 'data' }],
    params: [],
    kernels: [kernel],
    evaluate(ctx) {
      const out = ctx.alloc('field');
      ctx.run(kernel, { in: { src: ctx.input('in') }, out: { out } });
      ctx.output('out', out);
    },
  });
};
conformance(slopeNode('ref/bad-tolerance', 'Bad Tolerance (Reference)'));
conformance(slopeNode('ref/good-tolerance', 'Good Tolerance (Reference)'), {
  resolutionTol: { value: 0.2, reason: 'Measures slope with a one-sided difference; a finer level resolves steeper faces of the same terrain.' },
});

// ---- params --------------------------------------------------------------------------------------------------------

conformance(defineNode({
  type: 'ref/bad-divide',
  title: 'Bad Divide (Reference)',
  category: 'ref',
  description: 'Repeats a pass a number of times found by dividing by a soft length.',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [param.size()],
  kernels: [copy],
  async evaluate(ctx) {
    let a = ctx.clone(ctx.input('in'));
    let b = ctx.alloc('field');
    // A soft length can be typed as 0: the count is then infinite, and ctx.loop refuses it.
    await ctx.loop(Math.ceil(0.01 / Math.abs(ctx.params.size)), () => {
      ctx.run(copy, { in: { src: a }, out: { out: b } });
      [a, b] = [b, a];
    });
    ctx.output('out', a);
  },
}));

// ---- optional-unbound ----------------------------------------------------------------------------------------------

const guided = defineKernel({
  name: 'ref/bad-optional',
  inputs: { src: 'field', guide: 'field' },           // `guide` has no default: the kernel needs a field for it
  outputs: { out: 'field' },
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return src_at(px) + 0.01 * guide_at(px); }',
});

conformance(defineNode({
  type: 'ref/bad-optional',
  title: 'Bad Optional (Reference)',
  category: 'ref',
  description: 'Adds a guide it declares optional and cannot do without.',
  inputs: [{ name: 'in', type: 'field' }, { name: 'guide', type: 'field', role: 'data', optional: true }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [],
  kernels: [guided],
  evaluate(ctx) {
    const out = ctx.alloc('field');
    ctx.run(guided, { in: { src: ctx.input('in'), guide: ctx.input('guide')! }, out: { out } });
    ctx.output('out', out);
  },
}));

// ---- short-ladder --------------------------------------------------------------------------------------------------

conformance(defineNode({
  type: 'ref/bad-ladder',
  title: 'Bad Ladder (Reference)',
  category: 'ref',
  description: 'Works on the next coarser level without asking whether there is one.',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [],
  kernels: [copy],
  evaluate(ctx) {
    const coarse = ctx.ladder[1]!;                    // undefined at 33, 64 and 128: `?? ctx.res` is missing
    const half = ctx.alloc('field', { size: [coarse, coarse], clear: 0 });
    ctx.release(half);
    const out = ctx.alloc('field');
    ctx.run(copy, { in: { src: ctx.input('in') }, out: { out } });
    ctx.output('out', out);
  },
}));

// ---- mask-neutral --------------------------------------------------------------------------------------------------

const masked = defineKernel({
  name: 'ref/bad-neutral',
  inputs: { src: 'field', mask: { kind: 'field', default: 0 } },    // an unconnected mask reads 1: MASK_INPUT
  outputs: { out: 'field' },
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return src_at(px) * (1.0 - 0.5 * saturate(mask_at(px))); }',
});

conformance(defineNode({
  type: 'ref/bad-neutral',
  title: 'Bad Neutral (Reference)',
  category: 'ref',
  description: 'Lowers the terrain where its mask says so, and where no mask is connected not at all.',
  inputs: [{ name: 'in', type: 'field' }, { name: 'mask', type: 'field', role: 'mask', optional: true }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [],
  kernels: [masked],
  evaluate(ctx) {
    const out = ctx.alloc('field');
    ctx.run(masked, { in: { src: ctx.input('in'), mask: ctx.input('mask') }, out: { out } });
    ctx.output('out', out);
  },
}));

// ---- seed ----------------------------------------------------------------------------------------------------------

const waves = defineKernel({
  name: 'ref/bad-seed',
  outputs: { out: 'field' },
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return 0.5 + 0.3 * sin(6.2831853 * uv.x) * cos(6.2831853 * uv.y); }',
});

conformance(defineNode({
  type: 'ref/bad-seed',
  title: 'Bad Seed (Reference)',
  category: 'ref',
  description: 'Generates waves, and offers a seed that changes nothing.',
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [param.seed()],
  kernels: [waves],
  evaluate(ctx) {
    const out = ctx.alloc('field');
    ctx.run(waves, { out: { out } });
    ctx.output('out', out);
  },
}));

// ---- wants ---------------------------------------------------------------------------------------------------------

conformance(defineNode({
  type: 'ref/bad-wants',
  title: 'Bad Wants (Reference)',
  category: 'ref',
  description: 'Raises the terrain by an amount that depends on which outputs are asked for.',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }, { name: 'aux', type: 'field', role: 'data' }],
  params: [],
  kernels: [add],
  evaluate(ctx) {
    const out = ctx.alloc('field');
    ctx.run(add, { in: { src: ctx.input('in') }, out: { out }, params: { k: ctx.wants('aux') ? 0 : 0.125 } });
    ctx.output('out', out);
    if (ctx.wants('aux')) {
      const aux = ctx.alloc('field');
      ctx.run(add, { in: { src: ctx.input('in') }, out: { out: aux }, params: { k: 1 } });
      ctx.output('aux', aux);
    }
  },
}));

// ---- budget --------------------------------------------------------------------------------------------------------

conformance(defineNode({
  type: 'ref/bad-budget',
  title: 'Bad Budget (Reference)',
  category: 'ref',
  description: 'Keeps sixteen four-channel fields of state.',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [],
  kernels: [copy],
  evaluate(ctx) {
    // 16 fields of 16 bytes a texel: 16.9 GB at 8129, against the 3.5 GB a node may hold.
    const state = Array.from({ length: 16 }, () => ctx.alloc('aux', { clear: 0 }));
    const out = ctx.alloc('field');
    ctx.run(copy, { in: { src: ctx.input('in') }, out: { out } });
    for (const field of state) ctx.release(field);
    ctx.output('out', out);
  },
}));

// ---- abort ---------------------------------------------------------------------------------------------------------

let interrupted = false;                              // state outside the context: what a node must not keep

conformance(defineNode({
  type: 'ref/bad-abort',
  title: 'Bad Abort (Reference)',
  category: 'ref',
  description: 'Remembers between evaluations whether the last one was cut short.',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [],
  kernels: [add],
  async evaluate(ctx) {
    const offset = interrupted ? 0.25 : 0;
    interrupted = true;
    let a = ctx.clone(ctx.input('in'));
    let b = ctx.alloc('field');
    await ctx.loop(4, () => {
      ctx.run(add, { in: { src: a }, out: { out: b }, params: { k: offset } });
      [a, b] = [b, a];
    });
    interrupted = false;
    ctx.output('out', a);
  },
}));

// ---- slicing -------------------------------------------------------------------------------------------------------

conformance(defineNode({
  type: 'ref/bad-slicing',
  title: 'Bad Slicing (Reference)',
  category: 'ref',
  description: 'Counts the batches of its loop and adds the count to the terrain.',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [],
  kernels: [add],
  async evaluate(ctx) {
    let batches = 0;
    let a = ctx.clone(ctx.input('in'));
    let b = ctx.alloc('field');
    await ctx.loop(8, () => {
      ctx.run(add, { in: { src: a }, out: { out: b }, params: { k: 0 } });
      [a, b] = [b, a];
    }, { preview: () => { batches++; return {}; } });   // called between batches, whose sizes the framework chooses
    ctx.run(add, { in: { src: a }, out: { out: b }, params: { k: batches / 64 } });
    ctx.output('out', b);
  },
}));

// ---- sound nodes: every check that applies passes ------------------------------------------------------------------

// An `any` input in both variants, the node's own mask, a seed, two outputs of which one is a mask.
const blend = (kind: 'field' | 'color') => defineKernel({
  name: `ref/good-any#${kind}`,
  inputs: { src: kind, mask: MASK_INPUT },
  outputs: { out: kind, level: 'field' },
  params: { strength: 'f32' },
  includes: [noise],
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> Out {
  let v = src_at(px);
  let grain = 0.05 * noise_value(uv * 16.0, seedFor(0u));
  ${kind === 'field' ? 'let rough = v + grain; let grey = v;' : 'let rough = vec4f(v.rgb + vec3f(grain), v.a); let grey = dot(v.rgb, vec3f(0.2126, 0.7152, 0.0722));'}
  return Out(mix(v, rough, P.strength * mask_at(px)), saturate(grey));
}`,
});
const blends = { field: blend('field'), color: blend('color') };

conformance(defineNode({
  type: 'ref/good-any',
  title: 'Good Any (Reference)',
  category: 'ref',
  description: 'Roughens a field or a colour where its mask says so.',
  inputs: [{ name: 'in', type: 'any' }, { name: 'mask', type: 'field', role: 'mask', optional: true }],
  outputs: [{ name: 'out', type: { sameAs: 'in' } }, { name: 'level', type: 'field', role: 'mask' }],
  params: [param.strength(), param.seed()],
  kernels: [blends.field, blends.color],
  evaluate(ctx) {
    const src = ctx.input('in');
    const level = ctx.wants('level') ? ctx.alloc('field') : null;
    const params = { strength: ctx.params.strength };
    if (src.kind === 'field') {
      const out = ctx.alloc('field');
      ctx.run(blends.field, { in: { src, mask: ctx.input('mask') }, out: { out, level }, params });
      ctx.output('out', out);
    } else {
      const out = ctx.alloc('color');
      ctx.run(blends.color, { in: { src, mask: ctx.input('mask') }, out: { out, level }, params });
      ctx.output('out', out);
    }
    if (level) ctx.output('level', level);
  },
}));

// Every parameter kind the `params` check varies, a curve and a gradient as tables, a colour output.
const tone = defineKernel({
  name: 'ref/good-tone',
  inputs: { src: 'field' },
  outputs: { out: 'color' },
  params: { tint: 'vec3f', offset: 'vec2f', gain: 'f32', levels: 'i32', invert: 'u32', mode: 'u32' },
  luts: { shape: 'f32', ramp: 'vec4f' },
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> vec4f {
  var t = saturate(src_uv(uv + 0.01 * P.offset) * P.gain);
  if (P.levels > 1) { t = floor(t * f32(P.levels)) / f32(P.levels); }
  if (P.invert == 1u) { t = 1.0 - t; }
  t = shape_at(t);
  let painted = ramp_at(t).rgb;
  let rgb = select(painted, painted * P.tint, P.mode == 1u);
  return vec4f(rgb, 1.0);
}`,
});

conformance(defineNode({
  type: 'ref/good-tone',
  title: 'Good Tone (Reference)',
  category: 'ref',
  description: 'Paints heights through a curve and a gradient.',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'color' }],
  params: [
    { kind: 'gradient', name: 'gradient', default: [{ t: 0, color: [0, 0.1, 0.3] }, { t: 1, color: [1, 0.9, 0.7] }], help: 'The colours from low to high ground.' },
    { kind: 'curve', name: 'curve', default: [{ x: 0, y: 0 }, { x: 1, y: 1 }], help: 'Reshapes the heights before they are painted.' },
    { kind: 'color', name: 'tint', default: [1, 0.8, 0.6], help: 'Multiplies the painted colour in the tinted mode.' },
    { kind: 'enum', name: 'mode', default: 'plain', options: [{ value: 'plain', label: 'Plain' }, { value: 'tinted', label: 'Tinted' }], help: 'Whether the tint is applied.' },
    { kind: 'bool', name: 'invert', default: false, help: 'Paints high ground with the low colours.' },
    { kind: 'int', name: 'levels', default: 1, min: 1, max: 16, help: 'More levels give finer bands; one level paints without bands.' },
    { kind: 'vec2', name: 'offset', unit: 'length', default: [0, 0], min: -1, max: 1, soft: true, help: 'Shifts the heights that are painted.' },
    param.gain(),
  ],
  kernels: [tone],
  evaluate(ctx) {
    const p = ctx.params;
    const out = ctx.alloc('color');
    ctx.run(tone, {
      in: { src: ctx.input('in') },
      out: { out },
      params: { tint: p.tint, offset: p.offset, gain: 1 + p.gain, levels: p.levels, invert: p.invert, mode: ctx.enumIndex('mode') },
      luts: { shape: ctx.lut(bakeCurve(p.curve), 'f32'), ramp: ctx.lut(bakeGradient(p.gradient), 'vec4f') },
    });
    ctx.output('out', out);
  },
}));

// ---- the port shapes of the catalog that the nodes above do not have (nodes.md) -----------------------------------

// The channels of a colour as four optional inputs, the first of them the node's primary input (color/pack-channels).
// It writes alpha on purpose, which is the one legitimate reason to skip `alpha`.
const pack = defineKernel({
  name: 'ref/good-pack',
  inputs: { r: { kind: 'field', default: 0 }, g: { kind: 'field', default: 0 }, b: { kind: 'field', default: 0 }, a: { kind: 'field', default: 1 } },
  outputs: { out: 'color' },
  code: 'fn compute(px: vec2i, uv: vec2f) -> vec4f { return vec4f(r_at(px), g_at(px), b_at(px), a_at(px)); }',
});
conformance(defineNode({
  type: 'ref/good-pack',
  title: 'Good Pack (Reference)',
  category: 'ref',
  description: 'Packs four fields into the channels of one colour; alpha is the fourth field.',
  inputs: [
    { name: 'r', type: 'field', role: 'data', optional: true }, { name: 'g', type: 'field', role: 'data', optional: true },
    { name: 'b', type: 'field', role: 'data', optional: true }, { name: 'a', type: 'field', role: 'data', optional: true },
  ],
  outputs: [{ name: 'out', type: 'color' }],
  params: [],
  kernels: [pack],
  evaluate(ctx) {
    const out = ctx.alloc('color');
    ctx.run(pack, { in: { r: ctx.input('r'), g: ctx.input('g'), b: ctx.input('b'), a: ctx.input('a') }, out: { out } });
    ctx.output('out', out);
  },
}), { skip: { alpha: 'The alpha channel is the fourth packed field, as the description says.' } });

// A colour made from nothing (color/constant): no generator, and no height range to keep.
const solid = defineKernel({
  name: 'ref/good-solid',
  outputs: { out: 'color' },
  params: { tint: 'vec3f' },
  code: 'fn compute(px: vec2i, uv: vec2f) -> vec4f { return vec4f(P.tint, 1.0); }',
});
conformance(defineNode({
  type: 'ref/good-solid',
  title: 'Good Solid (Reference)',
  category: 'ref',
  description: 'Fills a colour field with one colour.',
  inputs: [],
  outputs: [{ name: 'out', type: 'color' }],
  params: [{ kind: 'color', name: 'color', default: [0.5, 0.25, 0.125], help: 'The colour of every texel.' }],
  kernels: [solid],
  evaluate(ctx) {
    const out = ctx.alloc('color');
    ctx.run(solid, { out: { out }, params: { tint: ctx.params.color } });
    ctx.output('out', out);
  },
}));

// A mask as the primary input, a mask and a data field out (select/distance, select/edge).
const band = defineKernel({
  name: 'ref/good-band',
  inputs: { src: MASK_INPUT },
  outputs: { out: 'field', raw: 'field' },
  code: 'fn compute(px: vec2i, uv: vec2f) -> Out { let v = src_at(px); return Out(saturate(4.0 * v * (1.0 - v)), v - 0.5); }',
});
conformance(defineNode({
  type: 'ref/good-band',
  title: 'Good Band (Reference)',
  category: 'ref',
  description: 'Selects the soft edge of a mask and gives its signed level.',
  inputs: [{ name: 'in', type: 'field', role: 'mask' }],
  outputs: [{ name: 'out', type: 'field', role: 'mask' }, { name: 'raw', type: 'field', role: 'data' }],
  params: [],
  kernels: [band],
  evaluate(ctx) {
    const out = ctx.alloc('field');
    const raw = ctx.wants('raw') ? ctx.alloc('field') : null;
    ctx.run(band, { in: { src: ctx.input('in') }, out: { out, raw } });
    ctx.output('out', out);
    if (raw) ctx.output('raw', raw);
  },
}));

// Several inputs of type `any`, all but the first optional, and the output of the kind of the first (adjust/switch).
const pick = (kind: 'field' | 'color') => defineKernel({
  name: `ref/good-switch#${kind}`,
  inputs: { a: kind, b: { kind, default: 0 } },
  outputs: { out: kind },
  params: { second: 'u32' },
  code: 'fn compute(px: vec2i, uv: vec2f) -> out_t { if (P.second == 1u && b_bound()) { return b_at(px); } return a_at(px); }',
});
const picks = { field: pick('field'), color: pick('color') };
conformance(defineNode({
  type: 'ref/good-switch',
  title: 'Good Switch (Reference)',
  category: 'ref',
  description: 'Passes one of its inputs through.',
  inputs: [{ name: 'a', type: 'any' }, { name: 'b', type: 'any', optional: true }],
  outputs: [{ name: 'out', type: { sameAs: 'a' } }],
  params: [{ kind: 'enum', name: 'mode', default: 'b', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], help: 'The input that is passed on.' }],
  kernels: [picks.field, picks.color],
  evaluate(ctx) {
    const a = ctx.input('a');
    const b = ctx.input('b');
    const second = ctx.params.mode === 'b';
    if (a.kind === 'field') {
      const out = ctx.alloc('field');
      ctx.run(picks.field, { in: { a, b: b?.kind === 'field' ? b : null }, out: { out }, params: { second } });
      ctx.output('out', out);
    } else {
      const out = ctx.alloc('color');
      ctx.run(picks.color, { in: { a, b: b?.kind === 'color' ? b : null }, out: { out }, params: { second } });
      ctx.output('out', out);
    }
  },
}));
