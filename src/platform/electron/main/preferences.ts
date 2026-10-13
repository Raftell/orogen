// The preferences file (runtime.md 8.6): one JSON file in the folder main.ts names, which is the user-data
// folder, or a temporary one in test mode. No Electron import.

import fs from 'node:fs';
import path from 'node:path';
import type { Preferences } from '../ipc.ts';
import { writeTextFile } from './files.ts';

export const PREFERENCES_FILE = 'preferences.json';
/** Paths kept in `recent`. */
export const RECENT_MAX = 20;

/**
 * `gpu` repeats DEFAULT_PREFERENCES of src/core/session/budget.ts: importing the engine's entry module here
 * would put the engine into the main process's bundle. tests/ui/platform/unit/preferences.test.ts holds the two equal.
 */
export const DEFAULTS: Preferences = {
  gpu: { vramBytes: null, budgetFraction: 0.6 },
  keymap: {},
  layout: null,
  recent: [],
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A stored or patched value as Preferences: every member that is not of its type takes its default. */
export function sanitize(value: unknown): Preferences {
  const stored = isRecord(value) ? value : {};
  const gpu = isRecord(stored.gpu) ? stored.gpu : {};
  const vram = gpu.vramBytes;
  const fraction = gpu.budgetFraction;
  const keymap: Record<string, string> = {};
  if (isRecord(stored.keymap)) {
    for (const [command, key] of Object.entries(stored.keymap)) if (typeof key === 'string') keymap[command] = key;
  }
  const recent = Array.isArray(stored.recent) ? stored.recent.filter((entry): entry is string => typeof entry === 'string' && entry !== '') : [];
  return {
    gpu: {
      vramBytes: typeof vram === 'number' && Number.isFinite(vram) && vram > 0 ? vram : DEFAULTS.gpu.vramBytes,
      budgetFraction: typeof fraction === 'number' && Number.isFinite(fraction) ? fraction : DEFAULTS.gpu.budgetFraction,
    },
    keymap,
    layout: stored.layout === undefined ? DEFAULTS.layout : stored.layout,
    recent: [...new Set(recent)].slice(0, RECENT_MAX),
  };
}

export interface PreferenceStore {
  get(): Promise<Preferences>;
  /** Replaces the members the patch names and writes the file. Calls are applied in the order made. */
  set(patch: Partial<Preferences>): Promise<void>;
}

export function createPreferenceStore(folder: string): PreferenceStore {
  const file = path.join(folder, PREFERENCES_FILE);
  let loaded: Promise<Preferences> | null = null;
  let current: Preferences = DEFAULTS;
  let writing: Promise<void> = Promise.resolve();

  function load(): Promise<Preferences> {
    loaded ??= (async () => {
      try {
        current = sanitize(JSON.parse(await fs.promises.readFile(file, 'utf8')));
      } catch {
        // No file yet, or one that is not JSON: the defaults, and the next set() writes a good file.
        current = DEFAULTS;
      }
      return current;
    })();
    return loaded;
  }

  return {
    async get(): Promise<Preferences> {
      await load();
      return current;
    },
    set(patch: Partial<Preferences>): Promise<void> {
      const applied = writing.then(async () => {
        await load();
        const named: Record<string, unknown> = {};
        for (const key of ['gpu', 'keymap', 'layout', 'recent'] as const) {
          if (isRecord(patch) && Object.hasOwn(patch, key)) named[key] = patch[key];
        }
        current = sanitize({ ...current, ...named });
        await fs.promises.mkdir(folder, { recursive: true });
        await writeTextFile(file, `${JSON.stringify(current, null, 2)}\n`);
      });
      // A failed write fails its own call and not the calls after it.
      writing = applied.catch(() => {});
      return applied;
    },
  };
}
