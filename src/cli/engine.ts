// The device and the engine of a subcommand that evaluates: one Node process with the engine on the main
// thread (runtime.md 8.1), made as runtime.md prescribes for headless use.

import {
  budgetBytes as budgetOf, createEngine, DEFAULT_PREFERENCES,
  type Engine, type EngineTestHooks, type FileSource, type GpuCaps, type GpuContext, type NodeRegistry,
} from '../core/runtime.ts';
import { createNodeCpuRunner } from '../platform/node/cpu.ts';
import { createNodeGpu } from '../platform/node/gpu.ts';
import type { DeviceOptions } from './args.ts';

/** runtime.md 2.4 with default preferences: 60 % of the video memory, taken as 4 GiB where the platform does not tell. */
export function defaultBudgetBytes(caps: GpuCaps): number {
  return budgetOf(caps, DEFAULT_PREFERENCES);
}

type Slice = Parameters<NonNullable<EngineTestHooks['onSlice']>>[0];

/** What the engine did during one evaluation, beyond its events. */
export interface RunLog {
  readonly slices: number;
  readonly longestSliceMs: number;
  /** The kernels of the longest slice; empty when no slice completed. */
  readonly longestSliceKernels: readonly string[];
  /**
   * What the application would report as non-fatal `engine-error` events (runtime.md 7.7): a GPU error that
   * no error scope captured (5.8 rule 5). A slice above the hard ceiling is the other one, and is read from
   * longestSliceMs.
   */
  readonly engineErrors: readonly string[];
}

export interface CliEngine {
  readonly gpu: GpuContext;
  readonly engine: Engine;
  readonly budgetBytes: number;
  /** A request id greater than every one handed out before (runtime.md 5.2). */
  nextRequestId(): number;
  /** Starts recording; the returned function stops it and gives the record. */
  record(): () => RunLog;
  /** runtime.md 1.5 rule 5: the engine first, then the device. */
  close(): Promise<void>;
}

/** Rejects with GpuUnavailableError when the options give no usable device. */
export async function openEngine(opts: {
  readonly device: DeviceOptions;
  readonly budgetBytes: number | null;
  readonly registry: NodeRegistry;
  readonly files: FileSource;
}): Promise<CliEngine> {
  const gpu = await createNodeGpu({ profile: opts.device.profile, ...(opts.device.adapter !== undefined ? { adapter: opts.device.adapter } : {}) });

  let log: { slices: number; longest: Slice | null; engineErrors: string[] } | null = null;
  // The hook is the engine's only report of a slice's kernels and duration. It must not throw into the stream.
  const onSlice = (slice: Slice): void => {
    if (!log) return;
    log.slices++;
    // Only a measured duration is held against the ceiling (runtime.md 3.5): not the wait of a slice that was queued.
    if (slice.resolved && (log.longest === null || slice.measuredMs > log.longest.measuredMs)) log.longest = slice;
  };
  gpu.device.addEventListener('uncapturederror', (event) => {
    log?.engineErrors.push((event as GPUUncapturedErrorEvent).error.message.split('\n')[0]!);
  });

  const budgetBytes = opts.budgetBytes ?? defaultBudgetBytes(gpu.caps);
  let engine: Engine;
  try {
    engine = await createEngine({ gpu, registry: opts.registry, files: opts.files, cpu: createNodeCpuRunner(), budgetBytes, test: { onSlice } });
  } catch (thrown) {
    gpu.destroy();
    throw thrown;
  }

  let requestId = 0;
  let closed = false;
  return {
    gpu, engine, budgetBytes,
    nextRequestId: () => ++requestId,
    record() {
      const mine: NonNullable<typeof log> = { slices: 0, longest: null, engineErrors: [] };
      log = mine;
      return () => {
        if (log === mine) log = null;
        return {
          slices: mine.slices, longestSliceMs: mine.longest?.measuredMs ?? 0, longestSliceKernels: mine.longest?.kernels ?? [],
          engineErrors: mine.engineErrors,
        };
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await engine.dispose();
      } finally {
        gpu.destroy();
      }
    },
  };
}
