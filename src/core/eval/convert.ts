import type { AnyKernel } from '../gpu/kernel.ts';
import type { PoolTexture } from '../gpu/pool.ts';
import type { EngineParts } from './parts.ts';

// The evaluator's own content (runtime.md 5.6): conversions, mask blends and constants. Each function encodes
// for a service owner it opens and returns a WORKING texture, which the evaluator publishes once the owner has settled.

/** The kernels of this module, for createEngine to compile. */
export function convertKernels(): readonly AnyKernel[] {
  throw new Error('not implemented: convertKernels');
}

/** 'grey': field to color, vec4f(v, v, v, 1). 'luma': color to field, 0.2126 r + 0.7152 g + 0.0722 b. */
export function convert(parts: EngineParts, src: PoolTexture, conversion: 'grey' | 'luma', mode: 'preview' | 'build'): PoolTexture {
  throw new Error('not implemented: convert');
}

/** mix(base, result, saturate(mask)) per channel, in the kind of `result`. `mask` is a field. */
export function maskBlend(parts: EngineParts, base: PoolTexture, result: PoolTexture, mask: PoolTexture, mode: 'preview' | 'build'): PoolTexture {
  throw new Error('not implemented: maskBlend');
}

/** res × res cleared to the constant of the kind: 0 for a field, (0, 0, 0, 1) for a color. */
export function constant(parts: EngineParts, kind: 'field' | 'color', res: number, mode: 'preview' | 'build'): PoolTexture {
  throw new Error('not implemented: constant');
}
