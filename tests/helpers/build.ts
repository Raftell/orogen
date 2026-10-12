import type { BuildEvent, BuildResult, FileSource, GraphDoc } from '../../src/core/runtime.ts';
import type { GraphSpec } from './graph.ts';
import type { MemorySink } from './memory-files.ts';

/** buildProject (export-unreal.md 3.1) with the process's engine as host and a new MemorySink. */
export function buildGraph(graph: GraphDoc | GraphSpec | string, opts?: {
  readonly resolution?: number;
  readonly files?: FileSource;
  readonly signal?: AbortSignal;
}): Promise<{ readonly result: BuildResult; readonly sink: MemorySink; readonly events: readonly BuildEvent[] }> {
  throw new Error('not implemented: buildGraph');
}
