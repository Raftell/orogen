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

const codeOf = (thrown: unknown): unknown => (thrown as { readonly code?: unknown } | null)?.code;

/**
 * The codes Windows refuses a rename with while another program holds the file for a moment, and the waits
 * before each further attempt: the rule of `retryBusy` (runtime.md 6.2 rule 7), repeated here because the main
 * process does not load the engine's entry module. tests/ui/platform/unit/files.test.ts holds the two equal.
 */
const HELD_CODES: ReadonlySet<unknown> = new Set(['EPERM', 'EACCES', 'EBUSY']);
export const HELD_DELAYS_MS: readonly number[] = [20, 50, 100, 200, 400, 700, 1000];

export interface WriteOptions {
  /** Whether a rename that is refused because the file is held is tried again: Windows. Default: this platform's. */
  readonly held?: boolean;
  /** For a test: the rename, and other waits. */
  readonly rename?: (from: string, to: string) => Promise<void>;
  readonly delaysMs?: readonly number[];
}

/**
 * Atomic: the text goes to a temporary file beside the target, which then replaces it. The target is the old
 * file or the new one, never a part. The temporary file has a short name of its own (a name made from the
 * target's would be too long beside a target whose name is as long as the disk allows). A target that is a link
 * is written through, so the link stays; one that exists keeps its permissions; and one its owner made
 * read-only is refused, as writing into it would be: a rename alone asks nobody.
 */
export async function writeTextFile(file: string, text: string, options: WriteOptions = {}): Promise<void> {
  let resolved = absolute(file);
  if (typeof text !== 'string') throw new TypeError('The text to write is not a string');
  let mode: number | null = null;
  try {
    resolved = await fs.promises.realpath(resolved);
    const info = await fs.promises.stat(resolved);
    if (!info.isFile()) throw Object.assign(new Error(`${resolved} is not a file`), { code: 'EISDIR' });
    mode = info.mode & 0o777;
    await fs.promises.access(resolved, fs.constants.W_OK);
  } catch (thrown) {
    // No file there yet: the new one is made with the permissions any new file gets.
    if (codeOf(thrown) !== 'ENOENT') throw thrown;
  }
  const temporary = path.join(path.dirname(resolved), `.~og${process.pid}-${++temporaries}.tmp`);
  const rename = options.rename ?? ((from: string, to: string) => fs.promises.rename(from, to));
  const delays = (options.held ?? process.platform === 'win32') ? options.delaysMs ?? HELD_DELAYS_MS : [];
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(temporary, 'w');
    // What `open` is given is cut by the process's mask; this is not.
    if (mode !== null) await handle.chmod(mode);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporary, resolved);
        break;
      } catch (thrown) {
        if (attempt >= delays.length || !HELD_CODES.has(codeOf(thrown))) throw thrown;
        await new Promise<void>((resolve) => setTimeout(resolve, delays[attempt]));
      }
    }
  } catch (thrown) {
    await handle?.close().catch(() => {});
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
    throw thrown;
  }
}

/**
 * Why a file could not be written, for a person: the file and its folder by name, what is the matter, and what
 * helps. The system's own sentence names a temporary file nobody chose and says nothing of either. A failure
 * this has no words for keeps the system's.
 */
export function writeFailure(thrown: unknown, file: string): string {
  const name = path.basename(file);
  const folder = path.dirname(file);
  const elsewhere = 'Save the project somewhere else with File > Save As.';
  switch (codeOf(thrown)) {
    case 'EACCES':
    case 'EPERM':
      return `${name} cannot be written: the file or its folder ${folder} is read-only, or this account may not write there. ${elsewhere}`;
    case 'EROFS':
      return `${name} cannot be written: the disk that holds ${folder} is read-only. ${elsewhere}`;
    case 'ENOSPC':
    case 'EDQUOT':
      return `${name} cannot be written: the disk that holds ${folder} is full. Free some space and save again, or save somewhere else with File > Save As.`;
    case 'ENOENT':
    case 'ENOTDIR':
      return `${name} cannot be written: the folder ${folder} does not exist. ${elsewhere}`;
    case 'ENAMETOOLONG':
      return `${name} cannot be written: the name is longer than this disk allows. Save it under a shorter name with File > Save As.`;
    case 'EBUSY':
      return `${name} cannot be written: another program holds the file. Close it there and save again.`;
    case 'EISDIR':
      return `${name} cannot be written: a folder has that name. ${elsewhere}`;
    default:
      return thrown instanceof Error ? thrown.message : String(thrown);
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
