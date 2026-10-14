// The page's access to the main process (runtime.md 8.6): the object the preload script exposes, typed. Panels
// and the shell call `platform` and nothing else of the bridge. Only the types of ipc.ts are imported (8.4).

import type { PlatformApi, PlatformGlobal, Preferences } from '../platform/electron/ipc.ts';

export type { PlatformApi, Preferences };

/** The member of `window` the preload script defines. The type holds it to the name ipc.ts declares. */
const GLOBAL: keyof PlatformGlobal = 'orogenPlatform';

function bridge(): PlatformApi | undefined {
  return (globalThis as Partial<PlatformGlobal>)[GLOBAL];
}

/** False where no preload script ran: the page opened outside the application, or a window-free test. */
export function hasPlatform(): boolean {
  return bridge() !== undefined;
}

/**
 * The bridge. Every member is read from the preload script's object at the moment it is used, so this module
 * loads where there is no bridge; using a member there throws.
 */
export const platform: PlatformApi = new Proxy({} as PlatformApi, {
  get(_target, member) {
    // Symbols are what a debugger or a promise check asks any object for; none is a member of the bridge.
    if (typeof member !== 'string') return undefined;
    const api = bridge();
    // `then` is asked of whatever an async function returns: without a bridge the answer is still "no promise".
    if (!api && member === 'then') return undefined;
    if (!api) throw new Error(`platform.${member}: the preload bridge is missing (window.${GLOBAL}); the page runs inside the application only`);
    return api[member as keyof PlatformApi];
  },
  has: (_target, member) => typeof member === 'string' && member in (bridge() ?? {}),
  set() {
    throw new TypeError('The platform bridge is read-only');
  },
});

/**
 * What a panel keeps for itself from one run to the next (8.6): its entry of `Preferences.panels`, a value of
 * the panel's own that the bridge does not look at. The entry is read once, some time after it was asked for,
 * and written whole: the bridge replaces that entry and keeps those of the other panels.
 */
export interface PanelKeep {
  /** The entry as the preferences file holds it; null when it holds none, or cannot be read. Never rejects. */
  read(): Promise<unknown>;
  /** Replaces the entry. Several writes in a row are one: the last value is written when they have rested. */
  write(value: unknown): void;
}

/** How long a panel's entry rests before it is written: a divider that is dragged changes it at every step. */
export const PANEL_KEEP_DELAY_MS = 200;

export function panelKeep(
  id: string,
  api: Pick<PlatformApi, 'getPreferences' | 'setPreferences'> = platform,
  delayMs: number = PANEL_KEEP_DELAY_MS,
): PanelKeep {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let waiting: { readonly value: unknown } | null = null;
  const send = (): void => {
    timer = null;
    const held = waiting;
    waiting = null;
    if (held === null) return;
    Promise.resolve()
      .then(() => api.setPreferences({ panels: { [id]: held.value } }))
      .catch((thrown: unknown) => console.warn(`[orogen] what the ${id} panel keeps could not be saved`, thrown));
  };
  return {
    read: () => Promise.resolve()
      .then(() => api.getPreferences())
      .then((preferences) => {
        const panels: unknown = preferences?.panels;
        return typeof panels === 'object' && panels !== null && Object.hasOwn(panels, id) ? (panels as Record<string, unknown>)[id] ?? null : null;
      })
      .catch(() => null),
    write(value) {
      waiting = { value };
      if (delayMs <= 0) send();
      else timer ??= setTimeout(send, delayMs);
    },
  };
}
