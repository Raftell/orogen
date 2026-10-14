// What the environment and the command line ask of one run of the application (runtime.md 1.1 rule 5, 8.2;
// testing.md 2.9). Pure, so that the table of the test mode is tested without Electron.

import path from 'node:path';
import type { GpuProfile } from '../../../core/runtime.ts';

export interface Launch {
  /** OROGEN_TEST=1: a hidden window, no dialog, preferences in a temporary folder. */
  readonly test: boolean;
  /** OROGEN_TEST_DRIVER, in test mode only: the module the main process loads once the window has loaded. */
  readonly driver: string | null;
  /** The first argument: a project file, as an absolute path. */
  readonly project: string | null;
  readonly profile: GpuProfile;
  /** OROGEN_ELECTRON_GPU=software, or SOFTWARE_SWITCH on the command line: the run the user restarted with software rendering. */
  readonly software: boolean;
}

/**
 * The switch of a run that the user restarted with software rendering (runtime.md 8.6, 8.7 rule 16). It is on the
 * command line of that run alone: the next start is on the graphics card again.
 */
export const SOFTWARE_SWITCH = '--software-rendering';

/** Thrown for a variable that holds none of its values: the application says so and does not start. */
export class LaunchError extends Error {
  override name = 'LaunchError';
}

function oneOf<T extends string>(env: Readonly<Record<string, string | undefined>>, name: string, values: readonly T[], fallback: T): T {
  const value = env[name];
  if (value === undefined || value === '') return fallback;
  const found = values.find((v) => v === value);
  if (found === undefined) throw new LaunchError(`${name} is "${value}"; it is ${values.map((v) => `"${v}"`).join(' or ')}`);
  return found;
}

/**
 * `argv` is process.argv. Packaged, its first member is the application; started as `electron <folder>`, the
 * folder follows. Chromium's own switches (`--…`) may stand anywhere and are no arguments of ours.
 */
export function readLaunch(
  env: Readonly<Record<string, string | undefined>>,
  argv: readonly string[],
  opts: { readonly packaged: boolean; readonly cwd: string },
): Launch {
  const args = argv.slice(1).filter((arg) => !arg.startsWith('--')).slice(opts.packaged ? 0 : 1);
  const test = env.OROGEN_TEST === '1';
  const driver = test && env.OROGEN_TEST_DRIVER ? env.OROGEN_TEST_DRIVER : null;
  if (driver !== null && !path.isAbsolute(driver)) throw new LaunchError(`OROGEN_TEST_DRIVER is "${driver}"; it is an absolute path`);
  return {
    test,
    driver,
    project: args[0] !== undefined && args[0] !== '' ? path.resolve(opts.cwd, args[0]) : null,
    profile: oneOf(env, 'OROGEN_GPU_PROFILE', ['max', 'core'] as const, 'max'),
    software: oneOf(env, 'OROGEN_ELECTRON_GPU', ['hardware', 'software'] as const, 'hardware') === 'software' || argv.slice(1).includes(SOFTWARE_SWITCH),
  };
}

/**
 * The arguments of the run that takes this one's place with software rendering (`app.relaunch`): started from
 * source, the application's folder first; the switches this run was started with; the project to open, when there
 * is one; and SOFTWARE_SWITCH. `argv` is process.argv, `project` an absolute path or null.
 */
export function softwareRelaunchArgs(argv: readonly string[], opts: { readonly packaged: boolean }, project: string | null): string[] {
  const rest = argv.slice(1);
  const folder = opts.packaged ? [] : rest.filter((arg) => !arg.startsWith('--')).slice(0, 1);
  const switches = rest.filter((arg) => arg.startsWith('--') && arg !== SOFTWARE_SWITCH);
  return [...folder, ...switches, ...(project !== null ? [project] : []), SOFTWARE_SWITCH];
}

/**
 * The project file a second start of the application was given (8.2 rule 8), as an absolute path; null when it
 * was given none, or nothing that can be read as one. `argv` and `cwd` are the second start's own. The
 * environment of that start is not this one's and is not looked at: test mode has no second start.
 */
export function secondStartProject(argv: readonly string[], opts: { readonly packaged: boolean; readonly cwd: string }): string | null {
  try {
    return readLaunch({}, argv, opts).project;
  } catch {
    return null;
  }
}
