// What a hidden-window test reaches beside `orogenTest.ctx` (testing.md 2.9): the shell's own state, the dock's
// layout, and the answers of the file dialogs, which test mode never opens.

import type { StoreApi } from 'zustand/vanilla';

import type { PlatformApi } from '../platform.ts';
import type { DockHandle } from './Dock.tsx';
import type { GalleryState } from './Gallery.tsx';
import type { SavedLayout } from './layout.ts';
import type { ShellState } from './shell.ts';

/** The answers the next dialogs give, first in, first out; a dialog with no answer waiting answers as the bridge does. */
export interface DialogAnswers {
  readonly openProjectDialog: (string | null)[];
  readonly saveProjectDialog: (string | null)[];
  readonly openFileDialog: (string | null)[];
  readonly chooseFolder: (string | null)[];
}

export const emptyAnswers = (): DialogAnswers => ({ openProjectDialog: [], saveProjectDialog: [], openFileDialog: [], chooseFolder: [] });

/** The bridge with its four dialogs answered from `answers` while it holds any. Everything else is the bridge's own. */
export function answeringPlatform(platform: PlatformApi, answers: DialogAnswers): PlatformApi {
  return new Proxy(platform, {
    get(target, member) {
      if (typeof member === 'string' && Object.hasOwn(answers, member)) {
        const waiting = answers[member as keyof DialogAnswers];
        return (...args: unknown[]): Promise<string | null> => {
          if (waiting.length > 0) return Promise.resolve(waiting.shift() ?? null);
          return (target[member as keyof DialogAnswers] as (...given: unknown[]) => Promise<string | null>)(...args);
        };
      }
      return Reflect.get(target, member) as unknown;
    },
  });
}

export interface ShellTestHooks {
  /** The palette, the dialog, the notices, the preferences as the shell holds them. */
  readonly state: StoreApi<ShellState>;
  readonly answers: DialogAnswers;
  /** The values of the control gallery (the command `view.controlGallery`). */
  readonly gallery: StoreApi<GalleryState>;
  /** The dock's layout as it would be saved; null before the dock is there. */
  layout(): SavedLayout | null;
  /** Applies Preferences.layout as start-up does. */
  restoreLayout(): Promise<'restored' | 'default'>;
  /**
   * Set by the dock when it is ready. `dock.setSize(id, { width, height })` gives a panel a size as dragging its
   * dividers does: the way a test makes a panel narrow or low, in place of resizing a window that is not shown.
   */
  dock: DockHandle | null;
  /** The engine worker of the moment. A test ends it with terminate(), as nothing in the application does, to see the application without one. */
  engineWorker(): Worker;
}
