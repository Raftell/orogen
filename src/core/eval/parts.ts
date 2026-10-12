import type { CpuRunner } from '../cpu/runner.ts';
import type { DefaultTextures } from '../gpu/defaults.ts';
import type { GpuContext } from '../gpu/device.ts';
import type { AnyKernel } from '../gpu/kernel.ts';
import type { PipelineCache } from '../gpu/pipelines.ts';
import type { ManagedPool } from '../gpu/pool.ts';
import type { Readback } from '../gpu/readback.ts';
import type { CommandStream } from '../gpu/stream.ts';
import type { FileSource } from '../io/files.ts';

/**
 * Everything of the engine that the evaluator's modules share. The members up to `readback` live on one
 * device and are replaced together by Engine.replaceDevice; `files` is replaced by Engine.setFiles.
 */
export interface EngineParts {
  readonly gpu: GpuContext;
  readonly epoch: number;
  readonly pool: ManagedPool;
  readonly stream: CommandStream;
  readonly pipelines: PipelineCache;
  readonly defaults: DefaultTextures;
  readonly readback: Readback;
  readonly files: FileSource;
  readonly cpu: CpuRunner;
  /**
   * Shared by every EngineParts of one device. `retired` is set when the engine has forgotten the device (it was
   * lost or replaced) or was disposed: what lived on it, a FieldHandle for one, is dead from then on (runtime.md 5.9).
   */
  readonly device: { retired: boolean };
  /** True for the engine's own kernels: those of the shared ops and of the evaluator's services. ctx.run accepts them from any node. */
  isEngineKernel(kernel: AnyKernel): boolean;
}

/** Whether what lives on the device of `parts` can still be used. */
export function deviceAlive(parts: EngineParts): boolean {
  return !parts.gpu.lost && !parts.device.retired;
}
