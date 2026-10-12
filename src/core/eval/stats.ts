import type { AnyKernel } from '../gpu/kernel.ts';
import type { PoolTexture } from '../gpu/pool.ts';
import type { FieldStats } from './context.ts';
import type { EngineParts } from './parts.ts';

/** The kernels of this module, for createEngine to compile. */
export function statsKernels(): readonly AnyKernel[] {
  throw new Error('not implemented: statsKernels');
}

/**
 * ctx.stats and Engine.stats (runtime.md 5.7 rule 4): reduced on the GPU to one record per 32 × 32 block and
 * combined on the CPU in float64. Encodes for the stream's current owner. `texture` has one channel.
 */
export function fieldStats(parts: EngineParts, texture: PoolTexture, signal?: AbortSignal): Promise<FieldStats> {
  throw new Error('not implemented: fieldStats');
}
