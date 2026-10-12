import type { Engine } from '../../src/core/runtime.ts';
import { exclusive, liveEngine } from './engine.ts';
import { fail } from './stats.ts';

/**
 * Fails unless the engine's ledger shows nothing WORKING and nothing pinned and, with `emptyCache`, no cache
 * entry either (testing.md 2.8). The message carries the MemoryReport.
 */
export function checkLeaks(engine: Engine, emptyCache = false): void {
  const memory = engine.memory();
  const problems: string[] = [];
  if (memory.workingBytes !== 0) problems.push(`workingBytes is ${memory.workingBytes}: a field of a node is still WORKING`);
  if (memory.pinnedBytes !== 0) problems.push(`pinnedBytes is ${memory.pinnedBytes}: a FieldHandle was not released`);
  if (emptyCache && memory.cacheBytes !== 0) problems.push(`cacheBytes is ${memory.cacheBytes}: the cache holds an entry`);
  if (problems.length > 0) fail(`Leaked textures: ${problems.join('; ')}. MemoryReport: ${JSON.stringify(memory)}`);
}

/** Throws unless Engine.memory() reports workingBytes === 0 and pinnedBytes === 0. The message carries the MemoryReport. */
export function expectNoLeaks(): Promise<void> {
  // After the harness call that is under way, if one is: its own fields are WORKING until it has settled.
  return exclusive(async () => {
    const engine = liveEngine();
    // No engine was created, or the last one was disposed: nothing is held.
    if (engine) checkLeaks(engine);
  });
}
