import type { GpuProfile } from '../../src/core/runtime.ts';

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

export function launchApp(opts?: {
  readonly open?: string;                        // a project file to open
  readonly profile?: GpuProfile;                 // default: OROGEN_GPU_PROFILE, else 'core'
  readonly gpu?: 'hardware' | 'software';        // default: OROGEN_ELECTRON_GPU, else 'hardware'
}): Promise<AppDriver> {
  throw new Error('not implemented: launchApp');
}
