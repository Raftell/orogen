import type { AnyKernel } from '../gpu/kernel.ts';

/**
 * Every kernel the shared operations run. They are the engine's own: createEngine compiles them, and ctx.run
 * accepts them from any node although no NodeDef lists them (engine.md 4.6).
 */
export function opsKernels(): readonly AnyKernel[] {
  throw new Error('not implemented: opsKernels');
}
