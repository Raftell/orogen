// How a build ended, said with what was and what was not written (export-unreal.md 3.1, 3.8). A build that
// did not succeed leaves the output folder as it was: the data files become visible together, in the last
// phase, and the folder is swapped in only when everything succeeded. No DOM and no React.

import type { BuildPlan, BuildResult } from '../../../../core/runtime.ts';
import { formatBytes, plural } from './format.ts';
import { joinPath } from './paths.ts';
import { hasLandscape, NO_LANDSCAPE } from './plan.ts';

export interface Outcome {
  readonly tone: 'ok' | 'warning' | 'error' | 'neutral';
  /** A title: no full stop. */
  readonly headline: string;
  /** What was written. One or two sentences. */
  readonly written: string;
  /** What was not written, and that the output folder is as it was; null for a build that succeeded. */
  readonly kept: string | null;
  /** The places the two speak of, each with its whole path. */
  readonly places: readonly { readonly label: string; readonly path: string }[];
  /** The folder to show: the build's, or the staging folder that holds its report. */
  readonly folder: string | null;
  /** The file to select when the folder is shown: the manifest of a build, else its report. */
  readonly file: string | null;
}

const errorCodes = (result: BuildResult): Set<string> => new Set(result.problems.filter((problem) => problem.severity === 'error').map((problem) => problem.code));

/**
 * `requested` is the folder the build was asked to write to (`build-start`); null when nobody recorded it.
 * `plan` is the plan the build sent, null when it sent none: the folder was refused before anything was planned.
 */
export function describeOutcome(result: BuildResult, requested: string | null, plan: BuildPlan | null): Outcome {
  const planned = plan ? plan.files.length : 0;
  const none = planned > 0 ? `None of the ${plural(planned, 'planned file')} was put in place` : 'No file was put in place';
  const asked = requested === null ? [] : [{ label: 'Output folder', path: requested }];
  // A build that got as far as computing leaves its report in the staging folder (3.8 rule 6).
  const report = result.report !== null && result.outDir !== null ? [{ label: 'Report', path: joinPath(result.outDir, result.report) }] : [];
  const reported = report.length > 0 ? ' The report of this build lies in a folder beside it, which the next build removes.' : '';
  const codes = errorCodes(result);

  if (result.status === 'ok') {
    const bytes = result.files.reduce((sum, file) => sum + file.bytes, 0);
    const leftover = result.problems.some((problem) => problem.code === 'E_COMMIT_FAILED');
    const warnings = result.problems.filter((problem) => problem.severity === 'warning').length;
    return {
      tone: warnings > 0 ? 'warning' : 'ok',
      headline: warnings > 0 ? `Build finished with ${plural(warnings, 'warning')}` : 'Build finished',
      written: `${plural(result.files.length, 'file')}, ${formatBytes(bytes)}. The output folder holds this build and nothing else.`
        + (leftover ? ' The build it replaced could not be deleted and lies beside it.' : '')
        // A build that "finished" with textures alone has not exported the terrain, and nothing else would say so.
        + (plan !== null && !hasLandscape(plan) ? ` ${NO_LANDSCAPE}` : ''),
      kept: null,
      places: result.outDir !== null ? [{ label: 'Output folder', path: result.outDir }] : asked,
      folder: result.outDir,
      file: result.manifest,
    };
  }
  if (result.status === 'aborted') {
    return {
      tone: 'neutral', headline: 'Build cancelled',
      written: 'Nothing was written to the output folder.',
      kept: `${none}: the folder holds what it held before.${reported}`,
      places: [...asked, ...report], folder: result.outDir, file: result.report,
    };
  }
  if (result.status === 'device-lost') {
    return {
      tone: 'error', headline: 'Build stopped: device lost',
      written: 'Nothing was written to the output folder.',
      kept: `${none}: the folder holds what it held before. The build is not resumed: build again when the device is ready.${reported}`,
      places: [...asked, ...report], folder: result.outDir, file: result.report,
    };
  }
  if (codes.has('E_OUT_DIR')) {
    return {
      tone: 'error', headline: 'The output folder was refused',
      written: 'Nothing was planned, computed or written.',
      kept: 'The folder was not touched. Orogen replaces a folder only when it holds an earlier Orogen build and nothing else.',
      places: asked, folder: null, file: null,
    };
  }
  if (plan && !plan.ok) {
    return {
      tone: 'error', headline: 'The build did not start',
      written: 'The plan has an error, so nothing was computed and nothing was written.',
      kept: 'The output folder holds what it held before.',
      places: asked, folder: null, file: null,
    };
  }
  if (codes.has('E_COMMIT_FAILED')) {
    return {
      tone: 'error', headline: 'The build could not be put in place',
      written: result.outDir !== null ? 'What the build wrote lies in a folder beside the output folder.' : 'What the build wrote was not put in place.',
      kept: 'The output folder holds what it held before.',
      places: [...asked, ...(result.outDir !== null ? [{ label: 'Written to', path: result.outDir }] : [])],
      folder: result.outDir, file: result.report,
    };
  }
  return {
    tone: 'error', headline: 'Build failed',
    written: 'Nothing was written to the output folder.',
    kept: `${none}: the folder holds what it held before.${reported}`,
    places: [...asked, ...report], folder: result.outDir, file: result.report,
  };
}

/** The files of the plan that a build did not write: all of them unless the build succeeded. */
export function unwrittenFiles(result: BuildResult, plan: BuildPlan | null): string[] {
  if (!plan || result.status === 'ok') return [];
  const written = new Set(result.files.map((file) => file.path));
  return plan.files.map((file) => file.path).filter((path) => !written.has(path));
}
