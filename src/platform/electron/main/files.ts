// Text files for the bridge (runtime.md 8.6): project files are small JSON and travel as text. Nothing heavy
// comes through here: images and exports are read and written in the engine worker.

import fs from 'node:fs';
import path from 'node:path';

/** A project file is small. A file above this was chosen by mistake, and one message of its size would stall the interface. */
export const MAX_TEXT_BYTES = 64 * 2 ** 20;

function absolute(file: unknown): string {
  if (typeof file !== 'string' || file === '' || file.includes('\0') || !path.isAbsolute(file)) {
    throw new TypeError(`"${String(file)}" is not an absolute file path`);
  }
  return path.normalize(file);
}

export async function readTextFile(file: string): Promise<string> {
  const resolved = absolute(file);
  const info = await fs.promises.stat(resolved);
  if (!info.isFile()) throw new Error(`${resolved} is not a file`);
  if (info.size > MAX_TEXT_BYTES) throw new Error(`${resolved} holds ${info.size} bytes; a text file read through the bridge has at most ${MAX_TEXT_BYTES}`);
  return fs.promises.readFile(resolved, 'utf8');
}

let temporaries = 0;

/** Atomic: the text goes to a temporary file beside the target, which then replaces it. The target is the old file or the new one, never a part. */
export async function writeTextFile(file: string, text: string): Promise<void> {
  const resolved = absolute(file);
  if (typeof text !== 'string') throw new TypeError('The text to write is not a string');
  const temporary = `${resolved}.${process.pid}-${++temporaries}.tmp`;
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(temporary, 'w');
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporary, resolved);
  } catch (thrown) {
    await handle?.close().catch(() => {});
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
    throw thrown;
  }
}

/**
 * The form a document stores a file path in (runtime.md 6.1 rule 2): relative to the project file, with `/`
 * separators, when the file lies under the project's folder, and absolute otherwise. `p` is the path module of
 * the platform the paths belong to.
 */
export function toProjectPath(projectPath: string | null, filePath: string, p: typeof path = path): string {
  const file = p.resolve(filePath);
  if (projectPath === null || projectPath === '') return file;
  const relative = p.relative(p.dirname(p.resolve(projectPath)), file);
  // Outside the folder the relative form begins with `..`; on another drive it is absolute.
  if (relative === '' || relative === '..' || relative.startsWith(`..${p.sep}`) || p.isAbsolute(relative)) return file;
  return relative.split(p.sep).join('/');
}
