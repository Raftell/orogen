// Driving the application (testing.md 2.9): launchApp starts the built application with `electron .` in test
// mode, and every AppDriver call is one request to tests/electron/driver.cjs, which the application loads in its
// main process. The application never outlives the test: close() ends it, a lost channel ends it from inside,
// and whatever is still alive when this process exits is killed.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

import type { GpuProfile } from '../../src/core/runtime.ts';
import { outputFolder, REPOSITORY } from './engine.ts';

export interface AppDriver {
  /** Evaluates an expression in the main window; the result is structured-cloned. */
  eval<T>(js: string): Promise<T>;
  /** Resolves when the expression is truthy. Polled from the main process every 50 ms. Default timeout 30 000 ms. */
  waitFor(js: string, timeoutMs?: number): Promise<void>;
  /** capturePage() of the main window to <OROGEN_TEST_OUTPUT>/ui/<name>.png; returns the path. */
  capture(name: string): Promise<string>;
  /** win.showInactive(): needed before anything that waits for page animation frames. */
  show(): Promise<void>;
  /** Console errors and uncaught exceptions since launch, from every process and worker of the application. */
  errors(): Promise<readonly string[]>;
  /** Quits the application. Rejects when errors() is not empty. */
  close(): Promise<void>;
}

const DRIVER = path.join(REPOSITORY, 'tests/electron/driver.cjs');
/** What `npm run build` writes (testing.md 8.2). */
const BUILT = ['dist/main.cjs', 'dist/preload.cjs', 'dist/index.html', 'dist/engine-worker.js', 'dist/cpu-worker.js'];
const WAIT_DEFAULT_MS = 30_000;
/** Backstops: how long the application may take to load its window, and to exit when told to. */
const READY_TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 10_000;
/** How much of the application's own output is kept for the message of a failed launch. */
const OUTPUT_KEPT = 8192;
const CAPTURE_NAME = /^[a-z0-9][a-z0-9/_.-]*$/;

type Reply = { readonly id: number; readonly ok: true; readonly value: unknown } | { readonly id: number; readonly ok: false; readonly error: string };

// ---- the applications that run ---------------------------------------------------------------------------------------
// A test closes its application in a `finally`. One that does not must neither leave it running nor keep this
// process from ending: every application still alive is killed when the file's tests are over, and again when
// the process exits.
/** Each running application, with what removes its temporary folder. */
const alive = new Map<ChildProcess, () => void>();

/**
 * Ends an application at once, with every process it started: it is the leader of a process group of its own.
 * Chromium's other processes would otherwise outlive the main one for a moment and write their last state.
 */
function kill(child: ChildProcess): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // The group is gone already, or was never made: the process itself is all there is to end.
    }
  }
  child.kill('SIGKILL');
}

const killAll = (): void => {
  for (const [left, remove] of alive) {
    kill(left);
    remove();
  }
  alive.clear();
};
after(killAll);
process.on('exit', killAll);

/**
 * Whether the application keeps this process alive. Only while something awaits it: an idle application whose
 * test forgot it must not hold the test runner open.
 */
function hold(child: ChildProcess, held: boolean): void {
  type Handle = { ref?(): void; unref?(): void } | null | undefined;
  for (const handle of [child, child.channel, child.stdout, child.stderr] as Handle[]) {
    if (held) handle?.ref?.();
    else handle?.unref?.();
  }
}

/**
 * Removes the folder a test-mode application kept its preferences in. The application removes it as it exits,
 * and Chromium then writes its last state there again; only whoever outlives the application can remove that.
 * Nothing but a folder the test mode makes is ever removed: `orogen-test-…` directly in the temporary folder.
 */
function removeUserData(folder: string | null): void {
  if (folder === null) return;
  try {
    // The temporary folder may be named through a link (macOS): the application names it as os.tmpdir() does.
    if (!path.basename(folder).startsWith('orogen-test-') || ![os.tmpdir(), fs.realpathSync(os.tmpdir())].includes(path.dirname(folder))) return;
    fs.rmSync(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // What is left is in the system's temporary folder.
  }
}

// ---- values ----------------------------------------------------------------------------------------------------------
// The channel carries JSON (tests/electron/driver.cjs says why and tags what JSON has no word for).
const VIEWS: Readonly<Record<string, new (buffer: ArrayBuffer) => ArrayBufferView>> = {
  Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array,
  BigInt64Array, BigUint64Array, DataView,
};

function bytes(base64: string): ArrayBuffer {
  const data = Buffer.from(base64, 'base64');
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  return buffer;
}

function decode(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map(decode);
  const tagged = value as { $?: unknown; v?: unknown; t?: unknown; name?: unknown; message?: unknown };
  if (!Object.hasOwn(tagged, '$')) return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, decode(member)]));
  switch (tagged.$) {
    case 'undefined': return undefined;
    case 'number': return Number(tagged.v);
    case 'bigint': return BigInt(tagged.v as string);
    case 'date': return new Date(tagged.v as number);
    case 'buffer': return bytes(tagged.v as string);
    case 'view': return new (VIEWS[tagged.t as string] ?? Uint8Array)(bytes(tagged.v as string));
    case 'error': return Object.assign(new Error(String(tagged.message)), { name: String(tagged.name) });
    case 'map': return new Map((tagged.v as [unknown, unknown][]).map(([k, v]) => [decode(k), decode(v)]));
    case 'set': return new Set((tagged.v as unknown[]).map(decode));
    case 'object': return Object.fromEntries(Object.entries(tagged.v as object).map(([key, member]) => [key, decode(member)]));
    default: throw new TypeError(`The test driver sent a value tagged "${String(tagged.$)}"`);
  }
}

function oneOf<T extends string>(name: string, value: string | undefined, values: readonly T[], fallback: T): T {
  if (value === undefined || value === '') return fallback;
  const found = values.find((v) => v === value);
  if (found === undefined) throw new TypeError(`${name} is "${value}"; it is ${values.map((v) => `"${v}"`).join(' or ')}`);
  return found;
}

export async function launchApp(opts?: {
  readonly open?: string;                        // a project file to open
  readonly profile?: GpuProfile;                 // default: OROGEN_GPU_PROFILE, else 'core'
  readonly gpu?: 'hardware' | 'software';        // default: OROGEN_ELECTRON_GPU, else 'hardware'
}): Promise<AppDriver> {
  const missing = BUILT.filter((file) => !fs.existsSync(path.join(REPOSITORY, file)));
  if (missing.length > 0) {
    throw new Error(`The application is not built: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing. Run "npm run build" first`);
  }
  const profile = opts?.profile ?? oneOf('OROGEN_GPU_PROFILE', process.env.OROGEN_GPU_PROFILE, ['core', 'max'] as const, 'core');
  const gpu = opts?.gpu ?? oneOf('OROGEN_ELECTRON_GPU', process.env.OROGEN_ELECTRON_GPU, ['hardware', 'software'] as const, 'hardware');
  // In Node the package `electron` is the path of its executable.
  const electron = createRequire(import.meta.url)('electron') as unknown as string;

  const env: NodeJS.ProcessEnv = { ...process.env, OROGEN_TEST: '1', OROGEN_TEST_DRIVER: DRIVER, OROGEN_GPU_PROFILE: profile, OROGEN_ELECTRON_GPU: gpu };
  // Set by some shells that run Electron's own scripts: with it the executable is plain Node and opens no window.
  delete env.ELECTRON_RUN_AS_NODE;
  // A relative project path is taken from the repository root, as the graph functions of the harness take it.
  const args = ['.', ...(opts?.open === undefined ? [] : [path.resolve(REPOSITORY, opts.open)])];
  const child = spawn(electron, args, { cwd: REPOSITORY, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], detached: process.platform !== 'win32' });
  /** The application's temporary folder, known once it has loaded. */
  let userData: string | null = null;
  alive.set(child, () => removeUserData(userData));

  let output = '';
  const keep = (chunk: Buffer): void => { output = (output + chunk.toString('utf8')).slice(-OUTPUT_KEPT); };
  child.stdout!.on('data', keep);
  child.stderr!.on('data', keep);

  const waiting = new Map<number, { resolve(value: unknown): void; reject(reason: Error): void }>();
  /** What awaits the application: calls, the start, the exit. It holds this process alive while that is not 0. */
  let awaited = 0;
  const awaiting = async <T>(work: Promise<T>): Promise<T> => {
    if (awaited++ === 0) hold(child, true);
    try {
      return await work;
    } finally {
      if (--awaited === 0) hold(child, false);
    }
  };
  let lastId = 0;
  /** Why no call can be made any more; null while the application runs. */
  let gone: string | null = null;
  let ready!: () => void;
  let failed!: (reason: Error) => void;
  const started = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });

  const exited = new Promise<void>((resolve) => {
    const end = (why: string): void => {
      if (gone !== null) return;
      gone = `${why}${output.trim() ? `\n--- its output ---\n${output.trim()}` : ''}`;
      alive.delete(child);
      failed(new Error(`The application did not start: ${gone}`));
      for (const call of waiting.values()) call.reject(new Error(`The application is gone: ${why}`));
      waiting.clear();
      removeUserData(userData);
      resolve();
    };
    child.once('error', (error) => end(`it could not be started (${error.message})`));
    child.once('exit', (code, signal) => end(signal ? `it was ended by ${signal}` : `it exited with code ${code}`));
  });

  child.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null) return;
    if ('ready' in message) {
      ready();
      return;
    }
    const reply = message as Reply;
    const call = waiting.get(reply.id);
    if (!call) return;
    waiting.delete(reply.id);
    if (!reply.ok) {
      call.reject(new Error(reply.error));
      return;
    }
    try {
      call.resolve(decode(reply.value));
    } catch (thrown) {
      call.reject(thrown instanceof Error ? thrown : new Error(String(thrown)));
    }
  });

  function call<T>(name: string, args: readonly unknown[]): Promise<T> {
    if (gone !== null) return Promise.reject(new Error(`The application is gone: ${gone}`));
    return awaiting(new Promise<T>((resolve, reject) => {
      const id = ++lastId;
      waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
      child.send({ id, call: name, args }, (error) => {
        if (!error || !waiting.delete(id)) return;
        reject(new Error(`The application could not be reached: ${error.message}`));
      });
    }));
  }

  /** Resolves when the process has exited; it is killed when it has not done so by itself in time. */
  async function ended(): Promise<void> {
    const backstop = setTimeout(() => kill(child), EXIT_TIMEOUT_MS);
    try {
      await awaiting(exited);
    } finally {
      clearTimeout(backstop);
    }
  }

  const startTimer = setTimeout(() => {
    failed(new Error(`The application did not load its window within ${READY_TIMEOUT_MS} ms${output.trim() ? `\n--- its output ---\n${output.trim()}` : ''}`));
  }, READY_TIMEOUT_MS);
  try {
    await awaiting(started);
    userData = await call<string>('userData', []);
  } catch (thrown) {
    kill(child);
    await awaiting(exited);
    throw thrown;
  } finally {
    clearTimeout(startTimer);
  }

  let closing: Promise<void> | null = null;
  return {
    eval: <T>(js: string) => call<T>('eval', [js]),
    waitFor: (js: string, timeoutMs: number = WAIT_DEFAULT_MS) => call<void>('waitFor', [js, timeoutMs]),
    capture(name: string) {
      if (typeof name !== 'string' || !CAPTURE_NAME.test(name) || name.split('/').some((segment) => segment === '' || /^\.+$/.test(segment))) {
        return Promise.reject(new TypeError(`The name of a capture matches ${String(CAPTURE_NAME)} and has no empty or dotted segment: ${JSON.stringify(name)}`));
      }
      return call<string>('capture', [path.join(outputFolder(), 'ui', `${name}.png`)]);
    },
    show: () => call<void>('show', []),
    errors: () => call<readonly string[]>('errors', []),
    close() {
      closing ??= (async () => {
        let errors: readonly string[] = [];
        let failure: Error | null = null;
        try {
          errors = await call<readonly string[]>('errors', []);
          await call<void>('close', []);
        } catch (thrown) {
          failure = thrown instanceof Error ? thrown : new Error(String(thrown));
          kill(child);
        }
        await ended();
        if (failure) throw failure;
        if (errors.length > 0) throw new Error(`The application reported ${errors.length} error${errors.length === 1 ? '' : 's'}:\n${errors.join('\n')}`);
      })();
      return closing;
    },
  };
}
