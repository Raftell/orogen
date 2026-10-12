// Type-level tests of the seams between the layers of core that no contract document prints: the device layer
// (src/core/gpu/) as the evaluator assembles and uses it, and the kernels of the shared ops. `npm run check` is
// the test: a change to one side of a seam that the other side cannot follow fails here. Only names that two
// areas share appear in this file. It is compiled and never run.

import type { AnyKernel } from '../../src/core/api.ts';
import type { AnyRunBindings, RunBindings } from '../../src/core/gpu/bindings.ts';
import { createDefaultTextures } from '../../src/core/gpu/defaults.ts';
import type { GpuContext } from '../../src/core/gpu/device.ts';
import { createLutBuffer } from '../../src/core/gpu/lut.ts';
import { createPipelineCache, KernelCompileError } from '../../src/core/gpu/pipelines.ts';
import { createPool, type ManagedPool, type PoolCacheHooks, type PoolOptions } from '../../src/core/gpu/pool.ts';
import { createReadback } from '../../src/core/gpu/readback.ts';
import { encodeRun, type RunEnv, type RunServices } from '../../src/core/gpu/run.ts';
import { sealDefinitions } from '../../src/core/gpu/seal.ts';
import {
  createStream, GpuOutOfMemoryError, GpuValidationError, WatchdogError, type SliceReport, type StreamHooks,
} from '../../src/core/gpu/stream.ts';
import { opsKernels } from '../../src/core/ops/kernels.ts';
import type { EngineTestHooks, WgslDiagnostic } from '../../src/core/runtime.ts';

// ---- the test hooks of runtime.md 5.14 reach the stream and the pool as they are --------------------------------
declare const hooks: EngineTestHooks;
export const streamHooks: StreamHooks = hooks;
export const poolHooks: NonNullable<PoolOptions['hooks']> = hooks;
export const onSlice: NonNullable<EngineTestHooks['onSlice']> = (s: SliceReport) => void s;

// ---- one device's worth of engine, in the order the factories allow ----------------------------------------------
export function assemble(gpu: GpuContext, cache: PoolCacheHooks, budgetBytes: number) {
  sealDefinitions();
  // The stream's ledger is the pool, and the pool needs the stream: the ledger is bound late.
  const late: { pool?: ManagedPool } = {};
  const reserve = (bytes: number, label: string): { release(): void } => late.pool!.reserve(bytes, label);
  const stream = createStream({ gpu, reserve, hooks, onOverrun: (slice) => void slice.measuredMs });
  const pool = createPool({ gpu, budgetBytes, stream, cache, hooks });
  late.pool = pool;
  const services: RunServices = { stream, pipelines: createPipelineCache(gpu), defaults: createDefaultTextures(gpu, reserve) };
  return { ...services, pool, readback: createReadback({ gpu, stream, reserve }) };
}

// ---- the engine's own kernels are compiled before any node runs ----------------------------------------------------
export async function compileEngineKernels(parts: ReturnType<typeof assemble>): Promise<WgslDiagnostic | null> {
  try {
    await Promise.all(opsKernels().map((kernel) => parts.pipelines.compile(kernel)));
    return null;
  } catch (thrown) {
    if (thrown instanceof KernelCompileError) return thrown.diagnostic;
    throw thrown;
  }
}

// ---- one owner from open to close: allocation, a run, a loop boundary, a LUT, a read, publication --------------
export async function work(
  parts: ReturnType<typeof assemble>, gpu: GpuContext, kernel: AnyKernel, bindings: AnyRunBindings, env: RunEnv, signal: AbortSignal,
): Promise<number | null> {
  const owner = parts.stream.open({ nodeId: 'node', service: null, mode: 'build', signal, limitScale: 0.5 });
  parts.stream.use(owner);
  const target = parts.pool.acquire('field', 257, 257);
  try {
    parts.stream.clear(target, [0, 0, 0, 0]);
    const lut = createLutBuffer(gpu.device, new Float32Array(4), 'vec4f');
    parts.stream.track(lut.scopes);
    const before = parts.stream.submitted;
    encodeRun(parts, kernel, bindings, env);
    await parts.stream.boundary(parts.stream.submitted === before);
    parts.stream.use(owner);
    const row = await parts.readback.read(target, [0, 1], signal);
    parts.stream.write(target, row, [0, 1]);
    const { gpuMs, slices } = await owner.settle();
    parts.pool.publish(target);
    void slices;
    return gpuMs;
  } catch (thrown) {
    parts.pool.release(target);
    if (thrown instanceof GpuValidationError) void thrown.detail;
    if (thrown instanceof GpuOutOfMemoryError || thrown instanceof WatchdogError) void thrown.message;
    throw thrown;
  } finally {
    owner.close();
  }
}

// ---- an engine service owns its slices by name ---------------------------------------------------------------------
export function service(parts: ReturnType<typeof assemble>): void {
  const owner = parts.stream.open({ nodeId: null, service: 'convert', mode: 'preview' });
  parts.stream.use(owner);
  parts.stream.encode((encoder) => void encoder.label, 0.1);
  parts.stream.submit();
  owner.close();
}

// ---- ctx.run: the typed bindings of a node reach the device layer untyped ---------------------------------------
export function untyped<KI, KO, KW, KU, KP, KL>(bindings: RunBindings<KI, KO, KW, KU, KP, KL>): AnyRunBindings {
  return bindings as AnyRunBindings;
}
