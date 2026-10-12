import type { CpuRunner } from './cpu/runner.ts';
import type { FieldStats } from './eval/context.ts';
import type { EvalTarget, EvaluateOptions, EvaluateResult } from './eval/evaluator.ts';
import type { EngineTestHooks } from './eval/hooks.ts';
import type { Thumbnail } from './eval/thumbnails.ts';
import type { GpuContext } from './gpu/device.ts';
import type { FieldHandle, MemoryReport } from './gpu/pool.ts';
import type { GraphDoc } from './graph/doc.ts';
import type { NodeRegistry } from './graph/registry.ts';
import type { FileSource } from './io/files.ts';

export interface EngineOptions {
  readonly gpu: GpuContext;
  readonly registry: NodeRegistry;
  readonly files: FileSource;            // 6.1
  readonly cpu: CpuRunner;               // 6.3
  readonly budgetBytes: number;          // 2.4
  readonly test?: EngineTestHooks;       // 5.14
}

/**
 * Resolves when the engine's own kernels are compiled; rejects when one fails.
 * The first call seals defineLib, defineKernel, defineCpuTask and defineNode (engine.md, Module scope).
 */
export function createEngine(opts: EngineOptions): Promise<Engine> {
  throw new Error('not implemented: createEngine');
}

export interface Engine {
  readonly gpu: GpuContext;
  readonly epoch: number;                // starts at 1; +1 on every replaceDevice
  readonly registry: NodeRegistry;       // the registry of EngineOptions

  evaluate(doc: GraphDoc, targets: readonly EvalTarget[], opts: EvaluateOptions): Promise<EvaluateResult>;   // 5.2
  /** Node id → content key (5.4), for every node that has one. No GPU work. */
  keys(doc: GraphDoc): Promise<ReadonlyMap<string, string>>;

  /** As ctx.read (engine.md 4.7), for published content. */
  read(field: FieldHandle, rows?: readonly [y0: number, y1: number]): Promise<Float32Array<ArrayBuffer>>;
  /** As ctx.stats. */
  stats(field: FieldHandle<'field'>): Promise<FieldStats>;
  /** Registers GPU memory that is not a pool texture with the ledger (2.4): the viewport renderer's, for one. */
  reserve(bytes: number, label: string): { release(): void };

  /** The last measured duration of a node's evaluate() in this session, by node id. */
  lastTiming(nodeId: string): { readonly resolution: number; readonly wallMs: number } | null;
  onThumbnail(listener: (t: Thumbnail) => void): () => void;     // 5.12

  memory(): MemoryReport;
  trim(opts?: { keepResolution?: number }): Promise<void>;       // 2.8
  setBudget(bytes: number): void;
  setFiles(files: FileSource): void;
  replaceDevice(gpu: GpuContext): Promise<void>;                 // 5.9
  dispose(): Promise<void>;
}
