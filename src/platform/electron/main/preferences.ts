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
  viewport: null,
  panels: {},
};

/** A panel id is a short word; a longer key is no panel's. */
const PANEL_ID_MAX = 64;

/** The entries of a `panels` record that can be kept: a short name of its own and a value JSON has a word for. */
function panelEntries(value: unknown): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  if (!isRecord(value)) return kept;
  for (const [id, entry] of Object.entries(value)) {
    if (id === '' || id.length > PANEL_ID_MAX || id === '__proto__' || entry === undefined) continue;
    kept[id] = entry;
  }
  return kept;
}

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
    viewport: stored.viewport === undefined ? DEFAULTS.viewport : stored.viewport,
    panels: panelEntries(stored.panels),
  };
}

export interface PreferenceStore {
  get(): Promise<Preferences>;
  /**
   * Replaces the members the patch names and writes the file. Of `panels` it replaces the entries the patch
   * names and keeps the others: each panel writes its own, and none drops another's. Calls are applied in the order made.
   */
  set(patch: Partial<Preferences>): Promise<void>;
}

/** The copy kept of a preferences file that is not JSON: it is replaced by one that is, and the user's own is not lost with it. */
export const BAD_SUFFIX = '.bad';

export function createPreferenceStore(folder: string): PreferenceStore {
  const file = path.join(folder, PREFERENCES_FILE);
  let loaded: Promise<Preferences> | null = null;
  let current: Preferences = DEFAULTS;
  let writing: Promise<void> = Promise.resolve();

  /** What the file holds now; null when there is none, and when it is not JSON, which is then kept beside it. */
  async function readFile(): Promise<Preferences | null> {
    let text: string;
    try {
      text = await fs.promises.readFile(file, 'utf8');
    } catch {
      return null;
    }
    try {
      return sanitize(JSON.parse(text));
    } catch {
      // Damaged (a write cut short by a power loss, an edit by hand): the next set() writes a good file over
      // it, so what it held is kept under another name first. The copy of an earlier damage is not replaced.
      await fs.promises.copyFile(file, `${file}${BAD_SUFFIX}`, fs.constants.COPYFILE_EXCL).catch(() => {});
      return null;
    }
  }

  function load(): Promise<Preferences> {
    loaded ??= (async () => {
      current = (await readFile()) ?? DEFAULTS;
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
        // The file as it is now, not as it was read at start-up: where a second application writes the same
        // file (test mode has no lock, and a lock can fail), what it wrote of the members this patch does not
        // name stays. A file that is gone or damaged leaves what this process holds.
        const base = (await readFile()) ?? current;
        const named: Record<string, unknown> = {};
        for (const key of ['gpu', 'keymap', 'layout', 'recent', 'viewport'] as const) {
          if (isRecord(patch) && Object.hasOwn(patch, key)) named[key] = patch[key];
        }
        if (isRecord(patch) && Object.hasOwn(patch, 'panels')) named.panels = { ...base.panels, ...panelEntries(patch.panels) };
        current = sanitize({ ...base, ...named });
        await fs.promises.mkdir(folder, { recursive: true });
        await writeTextFile(file, `${JSON.stringify(current, null, 2)}\n`);
      });
      // A failed write fails its own call and not the calls after it.
      writing = applied.catch(() => {});
      return applied;
    },
  };
}
