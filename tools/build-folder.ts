// Where a build of the application is written, and how it gets into place (testing.md 8.2). A build takes its
// time, and whoever starts the application meanwhile must find the application of before: so a build never
// writes into the folder that is in use. It writes into a folder beside it, and that folder takes the other's
// place by a rename when everything is in it. A build that fails leaves the folder in use as it was.

import fs from 'node:fs';
import path from 'node:path';

const STAGING = '.partial-';
const PREVIOUS = '.previous-';
/** A build takes seconds. What bears one of the two names and is older than this was left by a build that was interrupted. */
export const STALE_MS = 60 * 60 * 1000;

/** The folder beside `target` that one build writes into: `dist.partial-<id>`. The id is the process's, so two builds at once do not share one. */
export function stagingFolder(target: string, id: string | number = process.pid): string {
  return `${target}${STAGING}${id}`;
}

const codeOf = (thrown: unknown): unknown => (thrown as { code?: unknown } | null)?.code;
const reasonOf = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown));

/**
 * Deletes the folders interrupted builds left beside `target`: those with a staging or a replaced folder's name
 * that were last written more than an hour ago. A build of another process that is under way is younger and
 * stays. Returns what it deleted.
 */
export function removeStale(target: string, now: number = Date.now()): string[] {
  const parent = path.dirname(target);
  const base = path.basename(target);
  const removed: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(parent);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!name.startsWith(`${base}${STAGING}`) && !name.startsWith(`${base}${PREVIOUS}`)) continue;
    const folder = path.join(parent, name);
    try {
      if (now - fs.statSync(folder).mtimeMs < STALE_MS) continue;
      fs.rmSync(folder, { recursive: true, force: true });
      removed.push(folder);
    } catch {
      // Somebody else is deleting it, or it cannot be deleted: the next build tries again.
    }
  }
  return removed;
}

/** The files of a folder, as paths relative to it with `/`. */
function filesOf(folder: string, prefix = ''): string[] {
  return fs.readdirSync(path.join(folder, prefix), { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    return entry.isDirectory() ? filesOf(folder, rel) : [rel];
  });
}

/** What `replaceFolder` uses of the file system. A test hands in a rename that fails as it does for a folder in use. */
export interface FolderOps { renameSync(from: string, to: string): void }

let replaced = 0;

/**
 * Puts the folder `staging` in the place of `target`, and returns how: `'renamed'` when `target` was moved
 * aside and `staging` renamed to it, two renames between which `target` is missing for no longer than it takes
 * to make the second; `'copied'` when `target` could not be moved, as Windows refuses for a folder a running
 * program has open: its files are then replaced one by one, and those the new build lacks are deleted last.
 * Either way `staging` is gone afterwards, and nothing of the folder that was replaced is left.
 * Throws when the new build could not be put in place; `target` is then what it was, as far as the system allowed.
 */
export function replaceFolder(staging: string, target: string, ops: FolderOps = fs): 'renamed' | 'copied' {
  const previous = `${target}${PREVIOUS}${process.pid}-${++replaced}`;
  let moved = false;
  try {
    ops.renameSync(target, previous);
    moved = true;
  } catch (thrown) {
    if (codeOf(thrown) !== 'ENOENT') {
      copyOver(staging, target);
      return 'copied';
    }
  }
  try {
    ops.renameSync(staging, target);
  } catch (thrown) {
    if (moved) {
      try {
        ops.renameSync(previous, target);
      } catch {
        // The folder of before stays under its other name; the message says where the two are.
      }
    }
    throw new Error(`The build is complete in ${staging} but could not be moved to ${target}: ${reasonOf(thrown)}`);
  }
  if (moved) fs.rmSync(previous, { recursive: true, force: true });
  return 'renamed';
}

function copyOver(staging: string, target: string): void {
  const next = new Set(filesOf(staging));
  // New files first, each written whole beside its place and renamed onto it: a reader finds the old file or the new one.
  for (const rel of next) {
    const to = path.join(target, ...rel.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const from = path.join(staging, ...rel.split('/'));
    const temporary = `${to}.${process.pid}.tmp`;
    fs.copyFileSync(from, temporary);
    try {
      fs.renameSync(temporary, to);
    } catch {
      // A file that is open cannot be renamed onto where a folder that is open cannot be moved: it is written in place.
      fs.rmSync(temporary, { force: true });
      fs.copyFileSync(from, to);
    }
  }
  for (const rel of filesOf(target)) {
    if (!next.has(rel)) fs.rmSync(path.join(target, ...rel.split('/')), { force: true });
  }
  fs.rmSync(staging, { recursive: true, force: true });
}
