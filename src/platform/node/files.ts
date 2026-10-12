import fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { FileError } from '../../core/runtime.ts';
import type { FileSink, FileSource, FileWriter } from '../../core/runtime.ts';

// One read or write call of the operating system is limited to 2 GiB - 1.
const MAX_IO_BYTES = 1 << 30;
// How often a watched file's identity is compared (runtime.md 6.1 rule 5).
const WATCH_INTERVAL_MS = 250;

type FileCode = FileError['code'];

function codeOf(error: unknown): FileCode {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'not-found';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'denied';
  return 'io';
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readError(error: unknown, file: string): FileError {
  if (error instanceof FileError) return error;
  // A folder is not a file: reading one fails as reading a name that does not exist.
  const code = (error as { code?: unknown } | null)?.code === 'EISDIR' ? 'not-found' : codeOf(error);
  if (code === 'not-found') return new FileError(code, file, `File not found: ${file}`);
  if (code === 'denied') return new FileError(code, file, `No permission to read ${file}`);
  return new FileError(code, file, `Cannot read ${file}: ${reasonOf(error)}`);
}

function writeError(error: unknown, relPath: string, file: string): FileError {
  if (error instanceof FileError) return error;
  const code = codeOf(error);
  if (code === 'denied') return new FileError(code, relPath, `No permission to write ${file}`);
  return new FileError(code, relPath, `Cannot write ${file}: ${reasonOf(error)}`);
}

/** runtime.md 6.1, on node:fs. Called without `new`. `projectFolder` is null for a project that was never saved. */
export function NodeFileSource(projectFolder: string | null): FileSource {
  const base = projectFolder === null ? null : path.resolve(projectFolder);

  function resolve(file: string): string {
    if (typeof file !== 'string' || file === '' || file.includes('\0')) {
      throw new FileError('invalid-path', String(file), 'The file path is empty or not a path');
    }
    if (path.isAbsolute(file)) return path.normalize(file);
    if (base === null) {
      throw new FileError('invalid-path', file, `"${file}" is relative to the project file, and the project has not been saved`);
    }
    return path.resolve(base, file);
  }

  async function stat(file: string): Promise<{ readonly size: number; readonly mtimeMs: number } | null> {
    const resolved = resolve(file);
    try {
      const s = await fs.promises.stat(resolved);
      return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null;
    } catch (error) {
      if (codeOf(error) === 'not-found') return null;
      throw readError(error, resolved);
    }
  }

  async function read(file: string, range?: { readonly offset: number; readonly length: number }): Promise<Uint8Array<ArrayBuffer>> {
    const resolved = resolve(file);
    if (range && !(Number.isSafeInteger(range.offset) && range.offset >= 0 && Number.isSafeInteger(range.length) && range.length >= 0)) {
      throw new RangeError(`read range { offset: ${range.offset}, length: ${range.length} } is not a pair of non-negative integers`);
    }
    let handle: FileHandle | null = null;
    try {
      handle = await fs.promises.open(resolved, 'r');
      const info = await handle.stat();
      if (!info.isFile()) throw new FileError('not-found', resolved, `File not found: ${resolved}`);
      const start = range ? Math.min(range.offset, info.size) : 0;
      const length = range ? Math.min(range.length, info.size - start) : info.size;
      // The result owns a buffer of its own, of exactly its length: it can be transferred to a CPU task.
      const bytes = new Uint8Array(new ArrayBuffer(length));
      let done = 0;
      while (done < length) {
        const { bytesRead } = await handle.read(bytes, done, Math.min(length - done, MAX_IO_BYTES), start + done);
        if (bytesRead === 0) break;      // the file shrank while it was read
        done += bytesRead;
      }
      return done === length ? bytes : bytes.slice(0, done);
    } catch (error) {
      throw readError(error, resolved);
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  function watch(file: string, onChange: () => void): () => void {
    const resolved = resolve(file);
    // Polling follows a file through being replaced by a rename, and sees one that does not exist yet.
    const listener = (now: fs.Stats, before: fs.Stats): void => {
      const existsNow = now.isFile();
      const existedBefore = before.isFile();
      if (existsNow !== existedBefore || (existsNow && (now.size !== before.size || now.mtimeMs !== before.mtimeMs))) onChange();
    };
    fs.watchFile(resolved, { persistent: false, interval: WATCH_INTERVAL_MS }, listener);
    let watching = true;
    return () => {
      if (!watching) return;
      watching = false;
      fs.unwatchFile(resolved, listener);
    };
  }

  return { resolve, stat, read, watch };
}

/** The operating-system path of a sink path, or null when the path breaks rule 1 of runtime.md 6.2. */
function sinkPath(root: string, relPath: string): string | null {
  if (typeof relPath !== 'string' || relPath.includes('\\') || relPath.includes(':') || relPath.includes('\0')) return null;
  const segments = relPath.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  return path.join(root, ...segments);
}

/** runtime.md 6.2, on node:fs. Called without `new`. */
export function NodeFileSink(rootFolder: string): FileSink {
  const root = path.resolve(rootFolder);
  // Rule 4: every path this sink has open or has closed. An aborted path is free again.
  const taken = new Set<string>();
  const open = new Set<FileWriter>();

  async function create(relPath: string): Promise<FileWriter> {
    const file = sinkPath(root, relPath);
    if (file === null) {
      throw new FileError('invalid-path', String(relPath), `"${relPath}" is not a relative path of plain segments separated by "/"`);
    }
    if (taken.has(relPath)) throw new Error(`"${relPath}" is written twice: this sink already has a writer for it`);
    taken.add(relPath);
    const partial = `${file}.partial`;
    let handle: FileHandle;
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      handle = await fs.promises.open(partial, 'w');
    } catch (error) {
      taken.delete(relPath);
      throw writeError(error, relPath, file);
    }

    let state: 'open' | 'closed' | 'aborted' = 'open';
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

    /** Closes the handle and deletes the partial file. Never rejects: nothing more can be done about a file that cannot be deleted. */
    const discard = async (): Promise<void> => {
      await handle.close().catch(() => {});
      await fs.promises.rm(partial, { force: true }).catch(() => {});
    };
    const fail = async (error: unknown): Promise<FileError> => {
      failure = writeError(error, relPath, file);
      state = 'aborted';
      open.delete(writer);
      taken.delete(relPath);
      await discard();
      return failure;
    };

    const writer: FileWriter = {
      write(chunk: Uint8Array): Promise<void> {
        return serial(async () => {
          if (failure) throw failure;
          if (state !== 'open') throw new Error(`"${relPath}" was ${state}; nothing more can be written to it`);
          if (!(chunk instanceof Uint8Array)) throw await fail(new TypeError('a chunk must be a Uint8Array'));
          try {
            let done = 0;
            while (done < chunk.byteLength) {
              const { bytesWritten } = await handle.write(chunk, done, Math.min(chunk.byteLength - done, MAX_IO_BYTES), null);
              done += bytesWritten;
            }
            bytes += chunk.byteLength;
          } catch (error) {
            throw await fail(error);
          }
        });
      },
      close(): Promise<{ readonly bytes: number }> {
        closing ??= serial(async () => {
          if (failure) throw failure;
          if (state !== 'open') throw new Error(`"${relPath}" was aborted; it cannot be closed`);
          try {
            await handle.sync();
            await handle.close();
            await fs.promises.rename(partial, file);
          } catch (error) {
            throw await fail(error);
          }
          state = 'closed';
          open.delete(writer);
          return { bytes };
        });
        return closing;
      },
      abort(): Promise<void> {
        return serial(async () => {
          if (state !== 'open') return;
          state = 'aborted';
          open.delete(writer);
          taken.delete(relPath);
          await discard();
        });
      },
    };
    open.add(writer);
    return writer;
  }

  async function write(relPath: string, data: Uint8Array | string): Promise<void> {
    const writer = await create(relPath);
    try {
      await writer.write(typeof data === 'string' ? new TextEncoder().encode(data) : data);
      await writer.close();
    } catch (error) {
      await writer.abort();
      throw error;
    }
  }

  async function abortAll(): Promise<void> {
    await Promise.all([...open].map((writer) => writer.abort()));
  }

  return { create, write, abortAll };
}
