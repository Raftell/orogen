// Output folder handling (export-unreal.md 3.8): a build is staged beside its output folder and swapped in on
// success, so the folder holds one complete build with its manifest, or is untouched.

import fs from 'node:fs';
import path from 'node:path';

import { BUSY_RM, retryBusy, type BuildEvent, type BuildProblem, type BuildResult, type Engine, type EvalEvent, type FileSink } from '../core/runtime.ts';
import { buildProject, type BuildOptions } from './build.ts';
import { MANIFEST_SCHEMA_ID, REPORT_SCHEMA_ID } from './manifest.ts';

export interface FolderBuildOptions extends Omit<BuildOptions, 'sink'> {
  readonly outDir: string;                       // absolute path of the output folder
  readonly createSink: (absDir: string) => FileSink;
}

const SCHEMA_FAMILY = MANIFEST_SCHEMA_ID.slice(0, MANIFEST_SCHEMA_ID.indexOf('/') + 1);
const REPORT_FAMILY = REPORT_SCHEMA_ID.slice(0, REPORT_SCHEMA_ID.indexOf('/') + 1);
const MANIFEST_SUFFIX = '.orogen.json';
const REPORT_SUFFIX = '.report.json';
/** In the staging folder while a build writes into it: whatever lies beside this file is that build's. */
export const STAGING_MARKER = '.orogen-staging';
/** What an operating system puts into a folder it has shown: not the user's work, and no part of a build either. */
const SYSTEM_FILES: ReadonlySet<string> = new Set(['thumbs.db', 'desktop.ini', '.ds_store']);
/** Where a file that another program holds for a moment is refused and is free a moment later (runtime.md 6.2). */
const WINDOWS = process.platform === 'win32';
const HELD = WINDOWS ? BUSY_RM : {};
const reasonOf = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown));
const codeOf = (thrown: unknown): unknown => (thrown as { code?: unknown } | null)?.code;

export const stagingOf = (outDir: string): string => `${outDir}.partial`;
export const previousOf = (outDir: string): string => `${outDir}.previous`;

/** What a folder is to a build that would replace or delete it. */
type Folder =
  | { readonly is: 'absent' | 'empty' }
  /** A build of Orogen and nothing else: `manifests` are its manifest files. */
  | { readonly is: 'build'; readonly manifests: readonly string[] }
  /** What a build that did not succeed leaves: its report, and nothing else. */
  | { readonly is: 'reports' }
  /** A staging folder a build was writing into when it was interrupted. */
  | { readonly is: 'staging' }
  /** Not Orogen's: `why` completes the sentence "<folder> ...". */
  | { readonly is: 'foreign'; readonly why: string };

/** The JSON object of a small file, or null when it cannot be read as one. */
async function jsonOf(file: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * Looks at a folder without changing it. A folder is a build when it holds a file `*.orogen.json` whose `schema`
 * begins with `orogen.unreal.landscape/` and, beside the manifests, only what they list under `files` and
 * reports: a folder into which somebody has put a file of their own is not Orogen's to replace.
 */
async function look(dir: string): Promise<Folder> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (thrown) {
    if (codeOf(thrown) === 'ENOENT') return { is: 'absent' };
    if (codeOf(thrown) === 'ENOTDIR') return { is: 'foreign', why: 'is a file, not a folder' };
    return { is: 'foreign', why: `cannot be read: ${reasonOf(thrown)}` };
  }
  if (entries.length === 0) return { is: 'empty' };
  if (entries.some((entry) => entry.name === STAGING_MARKER && entry.isFile())) return { is: 'staging' };

  const manifests: string[] = [];
  const listed = new Set<string>();
  const others: fs.Dirent[] = [];
  let reports = 0;
  for (const entry of entries) {
    const name = entry.name.toLowerCase();
    if (entry.isFile() && name.endsWith(MANIFEST_SUFFIX)) {
      const manifest = await jsonOf(path.join(dir, entry.name));
      if (typeof manifest?.schema === 'string' && manifest.schema.startsWith(SCHEMA_FAMILY)) {
        manifests.push(entry.name);
        for (const file of Array.isArray(manifest.files) ? manifest.files as unknown[] : []) {
          const listedPath = (file as { path?: unknown } | null)?.path;
          if (typeof listedPath === 'string') listed.add(listedPath.toLowerCase());
        }
        continue;
      }
    } else if (entry.isFile() && name.endsWith(REPORT_SUFFIX)) {
      const report = await jsonOf(path.join(dir, entry.name));
      if (typeof report?.schema === 'string' && report.schema.startsWith(REPORT_FAMILY)) {
        reports++;
        continue;
      }
    }
    others.push(entry);
  }
  const foreign = others.find((entry) => !entry.isFile() || !(listed.has(entry.name.toLowerCase()) || SYSTEM_FILES.has(entry.name.toLowerCase())));
  if (manifests.length === 0) {
    if (!foreign && reports > 0) return { is: 'reports' };
    return { is: 'foreign', why: `holds files and no Orogen build manifest (*${MANIFEST_SUFFIX})` };
  }
  if (foreign) return { is: 'foreign', why: `holds an Orogen build and also ${foreign.name}, which is no file of that build` };
  return { is: 'build', manifests };
}

/**
 * Why `outDir` cannot take a build, or null: it is acceptable when it does not exist, is empty, or holds a
 * previous build of Orogen and nothing else. Orogen replaces a folder only when it is a previous Orogen build.
 */
export async function outDirProblem(outDir: string): Promise<string | null> {
  if (path.dirname(outDir) === outDir) return `${outDir} is the root of a drive; a build needs a folder of its own`;
  const found = await look(outDir);
  if (found.is === 'absent' || found.is === 'empty' || found.is === 'build') return null;
  if (found.is === 'foreign' && !found.why.startsWith('holds')) return `${outDir} ${found.why}`;
  const why = found.is === 'foreign' ? found.why : 'holds the remains of a build and no Orogen build manifest';
  return `${outDir} ${why}; the output folder belongs to Orogen, which replaces everything in it, so choose an empty or a new folder, or move what is not the build's away`;
}

/**
 * Deletes a folder that is Orogen's. The manifests go last: a deletion that is interrupted leaves a folder that
 * is still known as a build, which the next build deletes.
 */
async function remove(dir: string, found: Folder): Promise<void> {
  if (found.is === 'absent') return;
  if (found.is === 'build') {
    for (const name of await fs.promises.readdir(dir)) {
      if (!found.manifests.includes(name)) await fs.promises.rm(path.join(dir, name), { recursive: true, force: true, ...HELD });
    }
  }
  await fs.promises.rm(dir, { recursive: true, force: true, ...HELD });
}

/**
 * The folder protocol of 3.8 around one build: `run` builds into the empty staging folder, and a build that
 * succeeded replaces `outDir`. Resolves with the build's result, its `outDir` and, where the swap failed, its
 * status and problems changed. `planFailed` says that nothing was evaluated or written: the staging folder is
 * then deleted.
 */
export async function intoFolder(
  outDir: string, requestId: number,
  run: (staging: string) => Promise<{ readonly result: BuildResult; readonly planFailed: boolean }>,
): Promise<BuildResult> {
  if (typeof outDir !== 'string' || !path.isAbsolute(outDir)) throw new TypeError(`The output folder ${JSON.stringify(outDir)} is not an absolute path`);
  const out = path.resolve(outDir);
  const refused = (code: BuildProblem['code'], message: string): BuildResult => ({
    requestId, status: 'errors', problems: [{ severity: 'error', code, message }], files: [], manifest: null, report: null, outDir: null, peakPoolBytes: null,
  });

  // 1. The folder is nobody else's.
  const problem = await outDirProblem(out);
  if (problem !== null) return refused('E_OUT_DIR', `Cannot build into this folder: ${problem}.`);

  // 2. Nothing is left of an earlier attempt, and the staging folder is empty. Both names beside the output folder
  // are deleted only when what they hold is Orogen's: a folder of the user's that happens to bear one is refused.
  const staging = stagingOf(out), previous = previousOf(out);
  const marker = path.join(staging, STAGING_MARKER);
  try {
    for (const [dir, leftover] of [[staging, await look(staging)], [previous, await look(previous)]] as const) {
      if (leftover.is === 'foreign' || (leftover.is !== 'absent' && leftover.is !== 'empty' && leftover.is !== 'build' && dir === previous)) {
        const why = leftover.is === 'foreign' ? leftover.why : 'holds the remains of a build and no Orogen build manifest';
        return refused('E_OUT_DIR', `Cannot build into this folder: a build needs the name ${dir} beside it, and what bears that name ${why}; move it away or choose another folder.`);
      }
      await remove(dir, leftover);
    }
    await fs.promises.mkdir(staging, { recursive: true });
    await fs.promises.writeFile(marker, '');
  } catch (thrown) {
    return refused('E_OUT_DIR', `Cannot prepare the folder ${staging} for the build: ${reasonOf(thrown)}.`);
  }

  // 3. The build. Once it has ended the staging folder holds what 3.8 says and nothing of the protocol's own.
  let built: Awaited<ReturnType<typeof run>>;
  try {
    built = await run(staging);
  } catch (thrown) {
    await fs.promises.rm(staging, { recursive: true, force: true, ...HELD }).catch(() => {});
    throw thrown;
  }
  const { result } = built;
  if (built.planFailed) {
    await fs.promises.rm(staging, { recursive: true, force: true, ...HELD }).catch(() => {});
    return { ...result, outDir: null };
  }
  const unmarked = await fs.promises.rm(marker, { force: true }).then(() => null, (thrown: unknown) => reasonOf(thrown));
  // 6. A build that did not succeed stays in the staging folder: its report and nothing else.
  if (result.status !== 'ok') return { ...result, outDir: staging };

  // 4. The swap. The output folder is looked at once more: a file put into it while the build ran is not deleted.
  const stays = (why: string): BuildResult => {
    const failure: BuildProblem = { severity: 'error', code: 'E_COMMIT_FAILED', message: `The build is complete but could not be moved to ${out}: ${why}; it is in ${staging}.` };
    return { ...result, status: 'errors', problems: [...result.problems, failure], files: [], manifest: null, outDir: staging };
  };
  const changed = unmarked ?? await outDirProblem(out);
  if (changed !== null) return stays(changed);
  let moved = false;
  try {
    if (fs.existsSync(out)) {
      await retryBusy(() => fs.promises.rename(out, previous), WINDOWS);
      moved = true;
    }
    await retryBusy(() => fs.promises.rename(staging, out), WINDOWS);
  } catch (thrown) {
    // 5. The complete build stays in the staging folder; what was in the output folder is put back.
    if (moved) await retryBusy(() => fs.promises.rename(previous, out), WINDOWS).catch(() => {});
    return stays(reasonOf(thrown));
  }
  try {
    const replaced = await look(previous);
    if (replaced.is === 'foreign') throw new Error(`that folder ${replaced.why}`);
    await remove(previous, replaced);
  } catch (thrown) {
    const leftover: BuildProblem = {
      severity: 'warning', code: 'E_COMMIT_FAILED',
      message: `The build is in ${out}, but the build it replaced could not be deleted from ${previous}: ${reasonOf(thrown)}.`,
    };
    return { ...result, problems: [...result.problems, leftover], outDir: out };
  }
  return { ...result, outDir: out };
}

/** Stages a build beside an output folder and swaps it in on success (3.8). */
export async function buildToFolder(engine: Engine, opts: FolderBuildOptions): Promise<BuildResult> {
  if (typeof opts !== 'object' || opts === null) throw new TypeError('buildToFolder: the options are an object');
  if (typeof opts.createSink !== 'function') throw new TypeError('buildToFolder: createSink makes the FileSink of a folder');
  const { outDir, createSink, onEvent, ...rest } = opts;
  const emit = (event: EvalEvent | BuildEvent): void => onEvent?.(event);

  // 'build-result' is emitted once, last, with the result the caller receives: the pipeline's own is held back.
  const seen = { planFailed: false, problems: 0 };
  const result = await intoFolder(outDir, opts.requestId, async (staging) => {
    const built = await buildProject(engine, {
      ...rest,
      sink: createSink(staging),
      onEvent(event) {
        if (event.type === 'build-plan') seen.planFailed = !event.plan.ok;
        if (event.type === 'build-result') seen.problems = event.result.problems.length;
        else emit(event);
      },
    });
    return { result: built, planFailed: seen.planFailed };
  });
  // The problems the folder added behind those of the pipeline, which the pipeline has announced itself.
  for (const problem of result.problems.slice(seen.problems)) emit({ type: 'build-problem', requestId: opts.requestId, problem });
  emit({ type: 'build-result', requestId: opts.requestId, result });
  return result;
}
