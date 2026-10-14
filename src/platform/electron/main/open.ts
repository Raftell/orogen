// What the bridge hands to the system's default programs, and what it tells of a path (runtime.md 8.6). Each
// function answers whether a request is one of the three the bridge serves, and with what; main.ts does the
// opening. No Electron import, so the rules are tested without it.
//
// A program the system starts for a file runs with the user's rights, and for some kinds of file the program is
// the file itself. The page therefore names no arbitrary path: a web address, a page of the documentation that
// came with the application, or a file a build wrote, in the folder of that build.

import fs from 'node:fs';
import path from 'node:path';

import type { PathStat } from '../ipc.ts';

/** No address the page shows is longer; a longer one is a mistake or an attack. */
const URL_MAX = 2048;
/** The kinds of file the user documentation holds that a person opens: pages and their pictures. */
const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.png']);
/** The kinds of file a build writes (export-unreal.md 2.6, 3.3): images, raw samples, the manifest and the report. */
const BUILD_EXTENSIONS: ReadonlySet<string> = new Set(['.png', '.r16', '.r8', '.r32', '.exr', '.tif', '.json']);
/**
 * How the files of a build say that they are one: MANIFEST_SCHEMA_ID and REPORT_SCHEMA_ID of
 * src/export/manifest.ts without their version. Repeated here because the main process imports nothing of
 * src/export/ (8.4); tests/ui/platform/unit/open.test.ts holds the two equal.
 */
export const BUILD_SCHEMAS = { manifest: 'orogen.unreal.landscape/', report: 'orogen.build-report/' } as const;
const MANIFEST_SUFFIX = '.orogen.json';
const REPORT_SUFFIX = '.report.json';
/** A manifest lists a few dozen files; one above this is no manifest. */
const BUILD_JSON_MAX = 4 * 2 ** 20;

/** The address to open, or null: `http` and `https` alone, without a user name or a password in it. */
export function externalUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0 || url.length > URL_MAX) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '' || parsed.hostname === '') return null;
  return parsed.href;
}

async function regularFile(file: string): Promise<boolean> {
  try {
    // lstat: a link is not followed. What it points to may be anything, anywhere.
    return (await fs.promises.lstat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * The file of the user documentation that `name` names, or null. `name` is relative to `docsFolder` with `/`
 * separators (`unreal-import.md`, `images/application.png`): no empty, `.` or `..` segment, no backslash, no
 * colon. The file exists, is a page or a picture, and is no link.
 */
export async function documentFile(docsFolder: string, name: unknown): Promise<string | null> {
  if (typeof name !== 'string' || name === '' || name.includes('\0') || name.includes('\\') || name.includes(':')) return null;
  const segments = name.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  if (!DOCUMENT_EXTENSIONS.has(path.extname(name).toLowerCase())) return null;
  const file = path.join(docsFolder, ...segments);
  return await regularFile(file) ? file : null;
}

async function schemaOf(file: string): Promise<string | null> {
  try {
    if ((await fs.promises.stat(file)).size > BUILD_JSON_MAX) return null;
    const value: unknown = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    const schema = typeof value === 'object' && value !== null ? (value as { schema?: unknown }).schema : undefined;
    return typeof schema === 'string' ? schema : null;
  } catch {
    return null;
  }
}

/**
 * Whether a folder is one a build of Orogen wrote into: it holds a manifest (`*.orogen.json`) or a report
 * (`*.report.json`) with Orogen's schema. That is the output folder of a build that succeeded and the staging
 * folder of one that did not (export-unreal.md 3.8).
 */
export async function isBuildFolder(folder: string): Promise<boolean> {
  let names: string[];
  try {
    names = await fs.promises.readdir(folder);
  } catch {
    return false;
  }
  for (const name of names) {
    const lower = name.toLowerCase();
    const family = lower.endsWith(MANIFEST_SUFFIX) ? BUILD_SCHEMAS.manifest : lower.endsWith(REPORT_SUFFIX) ? BUILD_SCHEMAS.report : null;
    if (family !== null && (await schemaOf(path.join(folder, name)))?.startsWith(family)) return true;
  }
  return false;
}

/**
 * The file of a build that `file` names, or null. It is an absolute path of a file that exists, is no link, is
 * of a kind a build writes, and lies directly in a folder a build wrote into: the folders the user chose for
 * builds are known by what is in them, in this run and in every later one.
 */
export async function buildFile(file: unknown): Promise<string | null> {
  if (typeof file !== 'string' || file === '' || file.includes('\0') || !path.isAbsolute(file)) return null;
  const resolved = path.normalize(file);
  if (!BUILD_EXTENSIONS.has(path.extname(resolved).toLowerCase())) return null;
  if (!(await regularFile(resolved))) return null;
  return await isBuildFolder(path.dirname(resolved)) ? resolved : null;
}

const ABSENT: PathStat = { exists: false, isFile: false, size: 0, mtimeMs: 0 };

/**
 * What a path names. A relative path is taken from the folder of the project file, as a document stores the
 * path of a file under that folder (6.1 rule 2); without a project file it names nothing. A path that names
 * nothing, or that cannot be looked at, is absent: the answer is for showing, and whoever reads the file hears
 * why it cannot be read.
 */
export async function statPath(file: unknown, projectPath: unknown = null): Promise<PathStat> {
  if (typeof file !== 'string') throw new TypeError(`"${String(file)}" is not a path`);
  if (file === '' || file.includes('\0')) return ABSENT;
  let resolved: string;
  if (path.isAbsolute(file)) resolved = path.normalize(file);
  else if (typeof projectPath === 'string' && path.isAbsolute(projectPath)) resolved = path.resolve(path.dirname(projectPath), file);
  else return ABSENT;
  try {
    const info = await fs.promises.stat(resolved);
    return { exists: true, isFile: info.isFile(), size: info.isFile() ? info.size : 0, mtimeMs: info.mtimeMs };
  } catch {
    return ABSENT;
  }
}
