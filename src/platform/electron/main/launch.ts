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
  /** OROGEN_ELECTRON_GPU=software. */
  readonly software: boolean;
}

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
    software: oneOf(env, 'OROGEN_ELECTRON_GPU', ['hardware', 'software'] as const, 'hardware') === 'software',
  };
}
