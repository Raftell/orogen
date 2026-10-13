// Paths as text. The page has no file system (runtime.md 8.1): a path is what a dialog of the main process
// returned, written as its platform writes it, and everything here works on either notation.

const isSeparator = (char: string | undefined): boolean => char === '/' || char === '\\';

/** `C:\Builds` and `c:/builds/` are one folder on Windows; a POSIX path is compared as it is written. */
function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

/** The path without separators at its end. The root of a drive keeps its one: `/`, `C:\`. */
export function trimPath(path: string): string {
  let end = path.length;
  while (end > 1 && isSeparator(path[end - 1])) end--;
  const cut = path.slice(0, end);
  return /^[A-Za-z]:$/.test(cut) ? `${cut}${path[end] ?? '\\'}` : cut;
}

/** The segments of a path, in a form two spellings of one folder share. */
function segments(path: string): string[] {
  const parts = trimPath(path).split(/[\\/]+/).filter((part) => part !== '');
  return isWindowsPath(path) ? parts.map((part) => part.toLowerCase()) : parts;
}

/** The separator a path is written with: the last one it uses, else that of its platform. */
function separatorOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (cut >= 0) return path[cut]!;
  return isWindowsPath(path) ? '\\' : '/';
}

/** `name` inside the folder `dir`, written as `dir` is written. */
export function joinPath(dir: string, name: string): string {
  const base = trimPath(dir);
  return isSeparator(base[base.length - 1]) ? `${base}${name}` : `${base}${separatorOf(dir)}${name}`;
}

/** The folder that holds the path; '' when the path names nothing above itself. */
export function folderOf(path: string): string {
  const whole = trimPath(path);
  const cut = Math.max(whole.lastIndexOf('/'), whole.lastIndexOf('\\'));
  if (cut < 0) return '';
  return trimPath(whole.slice(0, cut + 1));
}

/** The last segment of a path. */
export function baseName(path: string): string {
  const whole = trimPath(path);
  const cut = Math.max(whole.lastIndexOf('/'), whole.lastIndexOf('\\'));
  return cut < 0 ? whole : whole.slice(cut + 1);
}

export function sameFolder(a: string, b: string): boolean {
  if (isWindowsPath(a) !== isWindowsPath(b)) return false;
  const left = segments(a), right = segments(b);
  return left.length === right.length && left.every((part, i) => part === right[i]);
}

/** Whether `inner` lies inside `outer`, at any depth. A folder does not contain itself. */
export function contains(outer: string, inner: string): boolean {
  if (isWindowsPath(outer) !== isWindowsPath(inner)) return false;
  const left = segments(outer), right = segments(inner);
  return left.length < right.length && left.every((part, i) => part === right[i]);
}

/** `/` and `C:\`: a folder with nothing above it, beside which no build could be staged. A network share is left to the build to judge. */
export function isRoot(path: string): boolean {
  if (path.startsWith('\\\\')) return false;
  const parts = segments(path);
  return isWindowsPath(path) ? parts.length <= 1 : parts.length === 0;
}

/**
 * A path short enough for one line: its end, which is what tells two build folders apart, behind an ellipsis.
 * The whole path belongs in the tooltip of whatever shows this.
 */
export function shortPath(path: string, maxChars: number): string {
  const whole = trimPath(path);
  if (whole.length <= maxChars) return whole;
  const separator = separatorOf(whole);
  const parts = whole.split(/[\\/]+/).filter((part) => part !== '');
  let kept = parts[parts.length - 1] ?? whole;
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = `${parts[i]}${separator}${kept}`;
    if (next.length + 2 > maxChars) break;
    kept = next;
  }
  if (kept.length + 2 > maxChars) return `…${kept.slice(kept.length - Math.max(1, maxChars - 1))}`;
  return `…${separator}${kept}`;
}
