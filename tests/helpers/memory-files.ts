import type { FileSink, FileSource } from '../../src/core/runtime.ts';

export interface MemorySource extends FileSource {
  put(path: string, bytes: Uint8Array, mtimeMs?: number): void;            // mtimeMs defaults to a counter that grows with every put
  remove(path: string): void;
}
export interface MemorySink extends FileSink {
  readonly files: ReadonlyMap<string, Uint8Array>;                         // closed files, by path
  readonly open: readonly string[];                                        // paths with an unclosed writer
}
export function memorySource(files?: Readonly<Record<string, Uint8Array>>): MemorySource {
  throw new Error('not implemented: memorySource');
}
export function memorySink(): MemorySink {
  throw new Error('not implemented: memorySink');
}
