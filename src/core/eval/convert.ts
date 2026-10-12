import { defineKernel, MASK_INPUT, type AnyKernel } from '../gpu/kernel.ts';
import type { PoolTexture } from '../gpu/pool.ts';
import type { EngineParts } from './parts.ts';
import { produce, runKernel } from './service.ts';

// The evaluator's own content (runtime.md 5.6): conversions, mask blends and constants. Each function is one
// service call: it resolves with a WORKING texture whose work has completed without a GPU error, which the
// evaluator publishes.

const grey = defineKernel({
  name: 'core/convert#grey',
  inputs: { src: 'field' },
  outputs: { out: 'color' },
  cost: 1,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> vec4f {
  let v = src_at(px);
  return vec4f(v, v, v, 1.0);
}`,
});

const luma = defineKernel({
  name: 'core/convert#luma',
  inputs: { src: 'color' },
  outputs: { out: 'field' },
  cost: 1,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  return dot(src_at(px).rgb, vec3f(0.2126, 0.7152, 0.0722));
}`,
});

const blend = (kind: 'field' | 'color') => defineKernel({
  name: `core/mask#${kind}`,
  inputs: { a: kind, b: kind, mask: MASK_INPUT },
  outputs: { out: kind },
  cost: 3,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> out_t {
  let va = a_at(px);
  let vb = b_at(px);
  let t = mask_at(px);
  // A device may evaluate mix as a + t * (b - a), which is not b at t = 1: the two ends are selected, so that a
  // mask of 1 gives the node's result and a mask of 0 its input, bit for bit.
  return select(select(mix(va, vb, t), vb, t >= 1.0), va, t <= 0.0);
}`,
});
const blends = { field: blend('field'), color: blend('color') };

/** The kernels of this module, for createEngine to compile. */
export function convertKernels(): readonly AnyKernel[] {
  return [grey, luma, blends.field, blends.color];
}

/** 'grey': field to color, vec4f(v, v, v, 1). 'luma': color to field, 0.2126 r + 0.7152 g + 0.0722 b. */
export function convert(
  parts: EngineParts, src: PoolTexture, conversion: 'grey' | 'luma', mode: 'preview' | 'build', signal?: AbortSignal,
): Promise<PoolTexture> {
  return produce(parts, 'convert', mode, signal, conversion === 'grey' ? 'color' : 'field', src.width, src.height, (out) => {
    runKernel(parts, 'convert', conversion === 'grey' ? grey : luma, { in: { src }, out: { out } });
  });
}

/** mix(base, result, saturate(mask)) per channel, in the kind of `result`. `mask` is a field. */
export function maskBlend(
  parts: EngineParts, base: PoolTexture, result: PoolTexture, mask: PoolTexture, mode: 'preview' | 'build', signal?: AbortSignal,
): Promise<PoolTexture> {
  const kind = result.kind === 'color' ? 'color' : 'field';
  return produce(parts, 'mask', mode, signal, kind, result.width, result.height, (out) => {
    runKernel(parts, 'mask', blends[kind], { in: { a: base, b: result, mask }, out: { out } });
  });
}

/** res × res cleared to the constant of the kind: 0 for a field, (0, 0, 0, 1) for a color. */
export function constant(
  parts: EngineParts, kind: 'field' | 'color', res: number, mode: 'preview' | 'build', signal?: AbortSignal,
): Promise<PoolTexture> {
  return produce(parts, 'constant', mode, signal, kind, res, res, (out) => {
    parts.stream.clear(out, kind === 'field' ? [0, 0, 0, 0] : [0, 0, 0, 1]);
  });
}
