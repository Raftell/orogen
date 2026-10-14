// What tools/guard.mjs starts, and what it says of a command that was killed. Pure: the script hands in what it
// found on the machine, and tests/unit/guard.test.ts reads the answers.

export interface GuardInput {
  /** The command and its arguments, after the guard's own flags. */
  readonly args: readonly string[];
  /** `--lock` was given. */
  readonly lock: boolean;
  readonly mem: string;
  /** Seconds. */
  readonly limit: number;
  readonly platform: string;
  /** This guard runs inside another: the outer one holds the lock and the limits. */
  readonly nested: boolean;
  /** A systemd user session is there (Linux). */
  readonly systemd: boolean;
  /** `flock` is there (Linux). */
  readonly flock: boolean;
  /** The path of this Node. */
  readonly node: string;
  readonly lockFile: string;
}

export interface GuardCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** Started through the shell: npm and npx are scripts on Windows, which no process can be made of directly. */
  readonly shell: boolean;
  /** The memory cap and the time limit are a systemd scope's. */
  readonly scoped: boolean;
  /** The guard's own timer ends the command: where there is no scope and no outer guard. */
  readonly timer: boolean;
}

/**
 * The command line of one guarded run. With `--lock` the lock is taken outside the scope, so that the time a
 * run waits for another run's lock is not counted against its own limit: `flock <file> systemd-run … -- <command>`.
 */
export function guardCommand(input: GuardInput): GuardCommand {
  const { platform, nested } = input;
  let command = input.args[0] === 'node' ? input.node : input.args[0]!;
  let args = input.args.slice(1);
  const shell = platform === 'win32' && (command === 'npm' || command === 'npx');
  const scoped = !nested && platform === 'linux' && input.systemd;
  if (scoped) {
    args = ['--user', '--scope', '-q', '--collect', '-p', `MemoryMax=${input.mem}`, '-p', 'MemorySwapMax=0', '-p', `RuntimeMaxSec=${input.limit}`, '--', command, ...args];
    command = 'systemd-run';
  }
  if (input.lock && !nested && platform === 'linux' && input.flock) {
    args = [input.lockFile, command, ...args];
    command = 'flock';
  }
  return { command, args, shell, scoped, timer: !scoped && !nested };
}

/**
 * What to say of a command that did not end by itself; null for one that did. A scope that runs out of time is
 * sent SIGTERM, and one that exceeds its memory is killed; seen through `flock` either is an exit code of 128
 * plus the signal's number.
 */
export function killedMessage(code: number | null, signal: string | null, mem: string, limit: number, waited: boolean): string | null {
  const how = signal ?? (code === 143 ? 'SIGTERM' : code === 137 ? 'SIGKILL' : null);
  if (how === null) return null;
  const clock = waited ? `the ${limit}s time limit, which began when the lock was taken` : `the ${limit}s time limit`;
  if (how === 'SIGTERM') return `guard: command ended (SIGTERM): over ${clock}`;
  if (how === 'SIGKILL') return `guard: command killed (SIGKILL): over the ${mem} memory cap, or it did not end when ${clock} asked it to`;
  return `guard: command ended by ${how}`;
}
