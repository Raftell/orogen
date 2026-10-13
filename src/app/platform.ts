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
