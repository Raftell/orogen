// Where the window was (runtime.md 8.2 rule 9): its place and size when it was last closed, kept in a file of
// its own in the user-data folder, and what a new window is given: that place where it still lies on a screen,
// else the middle of the primary screen, never larger than the screen's work area. No Electron import.

import fs from 'node:fs';
import path from 'node:path';

export const WINDOW_FILE = 'window.json';
/** The size a first start asks for, and the least a window has (window.ts). */
export const DEFAULT_SIZE = { width: 1600, height: 1000 } as const;
export const MIN_SIZE = { width: 960, height: 600 } as const;
/** How much of a kept window must lie on a screen for its place to be kept: a title bar to take it by. */
const VISIBLE_MIN = 120;

export interface Bounds { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface WindowState { readonly bounds: Bounds; readonly maximized: boolean }

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** What a file holds, as a window state; null for anything else. */
export function parseWindowState(text: string): WindowState | null {
  try {
    const held = JSON.parse(text) as { readonly bounds?: Partial<Bounds> | null; readonly maximized?: unknown } | null;
    const bounds = held?.bounds;
    if (!bounds || !finite(bounds.x) || !finite(bounds.y) || !finite(bounds.width) || !finite(bounds.height)) return null;
    if (bounds.width < 1 || bounds.height < 1) return null;
    return { bounds: { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) }, maximized: held.maximized === true };
  } catch {
    return null;
  }
}

/**
 * What a new window is given. `workAreas` are the work areas of the screens, the primary first. The size is the
 * kept one, or the default, cut to the work area of the screen it lies on: a window of 1600 × 1000 does not fit
 * a 1920 × 1080 screen scaled to 125 %. A kept place is used while enough of the window lies on some screen;
 * else the window is centred on the primary screen (`x` and `y` are then left out, which centres it).
 */
export function placeWindow(kept: WindowState | null, workAreas: readonly Bounds[]): { readonly width: number; readonly height: number; readonly x?: number; readonly y?: number; readonly maximized: boolean } {
  const primary = workAreas[0] ?? null;
  const fit = (size: { readonly width: number; readonly height: number }, area: Bounds | null): { width: number; height: number } => ({
    width: Math.max(Math.min(MIN_SIZE.width, area?.width ?? MIN_SIZE.width), Math.min(size.width, area?.width ?? size.width)),
    height: Math.max(Math.min(MIN_SIZE.height, area?.height ?? MIN_SIZE.height), Math.min(size.height, area?.height ?? size.height)),
  });
  if (kept !== null) {
    const { bounds } = kept;
    const overlap = (area: Bounds): number => {
      const w = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
      const h = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
      return w >= VISIBLE_MIN && h >= VISIBLE_MIN ? w * h : 0;
    };
    const home = [...workAreas].sort((a, b) => overlap(b) - overlap(a))[0];
    if (home && overlap(home) > 0) {
      const size = fit(bounds, home);
      // Moved back by what hangs over the edge: the whole window is on the screen it was on.
      const x = Math.min(Math.max(bounds.x, home.x), home.x + home.width - size.width);
      const y = Math.min(Math.max(bounds.y, home.y), home.y + home.height - size.height);
      return { ...size, x, y, maximized: kept.maximized };
    }
    return { ...fit(bounds, primary), maximized: kept.maximized };
  }
  return { ...fit(DEFAULT_SIZE, primary), maximized: false };
}

export function readWindowState(userData: string): WindowState | null {
  try {
    return parseWindowState(fs.readFileSync(path.join(userData, WINDOW_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/** Never throws: a window whose place cannot be kept opens in the middle next time. */
export function writeWindowState(userData: string, state: WindowState): void {
  try {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(userData, WINDOW_FILE), `${JSON.stringify(state)}\n`);
  } catch {
    // A folder that cannot be written.
  }
}
