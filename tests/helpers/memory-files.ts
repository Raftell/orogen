import path from 'node:path';

import { FileError, type FileSink, type FileSource, type FileWriter } from '../../src/core/runtime.ts';

export interface MemorySource extends FileSource {
  put(path: string, bytes: Uint8Array, mtimeMs?: number): void;            // mtimeMs defaults to a counter that grows with every put
  remove(path: string): void;
}
export interface MemorySink extends FileSink {
  readonly files: ReadonlyMap<string, Uint8Array>;                         // closed files, by path
  readonly open: readonly string[];                                        // paths with an unclosed writer
}

/** The folder a relative path of a memory source is taken from: the folder of its project file. Paths use `/` on every platform. */
const PROJECT_FOLDER = '/project';

/** runtime.md 6.1 over a table. */
export function memorySource(files?: Readonly<Record<string, Uint8Array>>): MemorySource {
  const table = new Map<string, { bytes: Uint8Array<ArrayBuffer>; mtimeMs: number }>();
  const watchers = new Map<string, Set<() => void>>();
  let clock = 0;

  function resolve(file: string): string {
    if (typeof file !== 'string' || file === '' || file.includes('\0')) {
      throw new FileError('invalid-path', String(file), 'The file path is empty or not a path');
    }
    return path.posix.resolve(PROJECT_FOLDER, file.replaceAll('\\', '/'));
  }
  /** After the change, never inside the call that makes it: a listener may read the source. */
  function changed(resolved: string): void {
    for (const listener of [...(watchers.get(resolved) ?? [])]) {
      queueMicrotask(() => {
        if (watchers.get(resolved)?.has(listener)) listener();
      });
    }
  }

  const source: MemorySource = {
    resolve,
    async stat(file) {
      const entry = table.get(resolve(file));
      return entry ? { size: entry.bytes.length, mtimeMs: entry.mtimeMs } : null;
    },
    async read(file, range) {
      const resolved = resolve(file);
      if (range && !(Number.isSafeInteger(range.offset) && range.offset >= 0 && Number.isSafeInteger(range.length) && range.length >= 0)) {
        throw new RangeError(`read range { offset: ${range.offset}, length: ${range.length} } is not a pair of non-negative integers`);
      }
      const entry = table.get(resolved);
      if (!entry) throw new FileError('not-found', resolved, `File not found: ${resolved}`);
      const start = range ? Math.min(range.offset, entry.bytes.length) : 0;
      const end = range ? Math.min(start + range.length, entry.bytes.length) : entry.bytes.length;
      // A copy that owns its whole buffer: it can be transferred to a CPU task (6.1 rule 3).
      return entry.bytes.slice(start, end);
    },
    watch(file, onChange) {
      const resolved = resolve(file);
      let listeners = watchers.get(resolved);
      if (!listeners) watchers.set(resolved, listeners = new Set());
      const listener = (): void => onChange();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && watchers.get(resolved) === listeners) watchers.delete(resolved);
      };
    },
    put(file, bytes, mtimeMs) {
      if (!(bytes instanceof Uint8Array)) throw new TypeError('MemorySource.put: the content of a file is a Uint8Array');
      if (mtimeMs !== undefined && !Number.isFinite(mtimeMs)) throw new RangeError(`MemorySource.put: mtimeMs ${String(mtimeMs)} is not a time`);
      const resolved = resolve(file);
      clock++;
      table.set(resolved, { bytes: new Uint8Array(bytes), mtimeMs: mtimeMs ?? clock });
      changed(resolved);
    },
    remove(file) {
      const resolved = resolve(file);
      if (table.delete(resolved)) changed(resolved);
    },
  };
  for (const [file, bytes] of Object.entries(files ?? {})) source.put(file, bytes);
  return source;
}

/** Rule 1 of runtime.md 6.2. */
function validSinkPath(relPath: unknown): relPath is string {
  if (typeof relPath !== 'string' || relPath.includes('\\') || relPath.includes(':') || relPath.includes('\0')) return false;
  return !relPath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

/**
 * runtime.md 6.2 over a table. A writer collects its bytes apart, as a `.partial` file would hold them, and
 * `files` gains the path only when close() resolves.
 */
export function memorySink(): MemorySink {
  const closed = new Map<string, Uint8Array>();
  // Rule 4: every path this sink has open or has closed. An aborted or failed path is free again.
  const taken = new Set<string>();
  const writers = new Map<FileWriter, string>();
  const creating = new Set<Promise<void>>();
  let aborts = 0;

  async function createWriter(relPath: string): Promise<FileWriter> {
    const generation = aborts;
    if (!validSinkPath(relPath)) {
      throw new FileError('invalid-path', String(relPath), `"${String(relPath)}" is not a relative path of plain segments separated by "/"`);
    }
    if (taken.has(relPath)) throw new Error(`"${relPath}" is written twice: this sink already has a writer for it`);
    taken.add(relPath);
    // As on a disk, the file is opened in a later turn: abortAll() can overtake a create (rule 5).
    await Promise.resolve();

    let state: 'open' | 'closed' | 'aborted' = 'open';
    let parts: Uint8Array[] = [];
    let bytes = 0;
    let failure: FileError | null = null;
    // Every operation waits for the one before it, so a caller that does not await a write cannot reorder bytes.
    let last: Promise<unknown> = Promise.resolve();
    let closing: Promise<{ readonly bytes: number }> | null = null;
    const serial = <T>(step: () => Promise<T>): Promise<T> => {
      const next = last.then(step, step);
      last = next.catch(() => {});
      return next;
    };
    const discard = (): void => {
      writers.delete(writer);
      taken.delete(relPath);
      parts = [];
    };

    const writer: FileWriter = {
      write(chunk) {
        return serial(async () => {
          if (failure) throw failure;
          if (state !== 'open') throw new Error(`"${relPath}" was ${state}; nothing more can be written to it`);
          if (!(chunk instanceof Uint8Array)) {
            failure = new FileError('io', relPath, `Cannot write ${relPath}: a chunk must be a Uint8Array`);
            state = 'aborted';
            discard();
            throw failure;
          }
          // Exactly the bytes of the view, copied: the caller may reuse its buffer once this resolves (rule 2).
          parts.push(chunk.slice());
          bytes += chunk.byteLength;
        });
      },
      close() {
        closing ??= serial(async () => {
          if (failure) throw failure;
          if (state !== 'open') throw new Error(`"${relPath}" was aborted; it cannot be closed`);
          const whole = new Uint8Array(bytes);
          let at = 0;
          for (const part of parts) {
            whole.set(part, at);
            at += part.length;
          }
          parts = [];
          state = 'closed';
          writers.delete(writer);
          closed.set(relPath, whole);
          return { bytes };
        });
        return closing;
      },
      abort() {
        return serial(async () => {
          if (state !== 'open') return;
          state = 'aborted';
          discard();
        });
      },
    };
    writers.set(writer, relPath);
    if (aborts !== generation) await writer.abort();
    return writer;
  }

  function create(relPath: string): Promise<FileWriter> {
    const created = createWriter(relPath);
    const settled = created.then(() => {}, () => {}).finally(() => { creating.delete(settled); });
    creating.add(settled);
    return created;
  }

  return {
    get files() { return closed; },
    get open() { return [...writers.values()]; },
    create,
    async write(relPath, data) {
      const writer = await create(relPath);
      try {
        await writer.write(typeof data === 'string' ? new TextEncoder().encode(data) : data);
        await writer.close();
      } catch (error) {
        await writer.abort();
        throw error;
      }
    },
    async abortAll() {
      aborts++;
      // A create that is under way aborts its own writer before it hands it out, and is waited for here.
      await Promise.all([...[...writers.keys()].map((writer) => writer.abort()), ...creating]);
    },
  };
}
