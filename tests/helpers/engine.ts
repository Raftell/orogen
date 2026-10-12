import type { NodeDef } from '../../src/core/api.ts';
import type { Engine, GpuContext, ProjectSettings } from '../../src/core/runtime.ts';

export type Slices = 'auto' | 'small' | 'one';

export interface TestEngine {
  readonly gpu: GpuContext;        // gpu.profile; gpu.caps.software, .compactFormats, .adapter
  readonly engine: Engine;         // for tests/engine, tests/export and tests/graphs
}

/** The process's engine with the given slicing. Created on first use; disposed by a root-level after() hook the harness registers. */
export function getEngine(slices?: Slices): Promise<TestEngine> {       // default 'auto'
  throw new Error('not implemented: getEngine');
}

export const TEST_SETTINGS: ProjectSettings = {
  terrainSize: 4096, heightRange: 1024, seed: 1, buildResolution: 513, previewLevel: 1, seaLevel: 0.25,
};

/**
 * Adds definitions to the registry of this process's engine. For a test whose graph names nodes by type
 * (a GraphSpec, a document, a project file): called at module scope with the definitions the file imports.
 */
export function useNodes(defs: readonly NodeDef[]): void {
  throw new Error('not implemented: useNodes');
}

/** What a harness call registers to receive the slices of the evaluation it makes (testing.md 2.1). Returns the function that removes it. */
export function onEngineSlice(listener: (s: { readonly nodeId: string | null; readonly kernels: readonly string[]; readonly measuredMs: number }) => void): () => void {
  throw new Error('not implemented: onEngineSlice');
}

/** OROGEN_TEST_OUTPUT, else `test-output`, as an absolute path. */
export function outputFolder(): string {
  throw new Error('not implemented: outputFolder');
}
