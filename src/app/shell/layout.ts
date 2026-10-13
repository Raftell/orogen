// The dock layout as data (runtime.md 8.7 rules 3 and 7): the order in which the default layout is made from
// the panels' placements, and whether a layout read from the preferences is one this build can restore. No DOM
// and no dockview: Dock.tsx does what this says.

import type { PanelDef, PanelId } from '../ui/types.ts';

/** The schema version a layout is saved with. Raise it when a saved layout of the version before cannot be restored. */
export const LAYOUT_VERSION = 1;

/** What Preferences.layout holds. `dock` is dockview's own serialisation. */
export interface SavedLayout {
  readonly version: number;
  readonly dock: unknown;
}

export type PlacementDirection = 'left' | 'right' | 'above' | 'below' | 'within';

export interface PlacementStep {
  readonly id: PanelId;
  /** Null with a direction: at that edge of the whole layout. Null without: the first panel, which fills it. */
  readonly relativeTo: PanelId | null;
  readonly direction: PlacementDirection | null;
}

/**
 * The panels in an order in which each can be added: a panel follows the one it is placed relative to. Throws
 * for placements that give no such order.
 */
export function placementOrder(panels: readonly Pick<PanelDef, 'id' | 'placement'>[]): PlacementStep[] {
  const ids = new Set(panels.map((panel) => panel.id));
  const steps: PlacementStep[] = [];
  const placed = new Set<PanelId>();
  let waiting = [...panels];
  // Each round places at least one panel or ends: at most as many rounds as there are panels.
  for (let round = 0; round <= panels.length && waiting.length > 0; round++) {
    const next: typeof waiting = [];
    for (const panel of waiting) {
      const { relativeTo, direction } = panel.placement;
      if (relativeTo !== undefined && (!ids.has(relativeTo) || relativeTo === panel.id)) {
        throw new Error(`The panel "${panel.id}" is placed relative to "${relativeTo}", which is no other panel`);
      }
      if (relativeTo === undefined && direction === 'within') throw new Error(`The panel "${panel.id}" is placed within no panel`);
      if (relativeTo !== undefined && !placed.has(relativeTo)) {
        next.push(panel);
        continue;
      }
      steps.push({ id: panel.id, relativeTo: relativeTo ?? null, direction: direction ?? (relativeTo === undefined ? null : 'right') });
      placed.add(panel.id);
    }
    if (next.length === waiting.length) throw new Error(`The panels ${next.map((panel) => `"${panel.id}"`).join(', ')} are placed relative to each other`);
    waiting = next;
  }
  return steps;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The dock part of a layout from the preferences, or null when this build cannot restore it: another schema
 * version, not a dockview layout, or not exactly the panels of the registry. A panel cannot be closed, so a
 * layout that lacks one is from another build.
 */
export function savedDock(value: unknown, panelIds: readonly string[]): Record<string, unknown> | null {
  if (!isRecord(value) || value.version !== LAYOUT_VERSION || !isRecord(value.dock)) return null;
  const { dock } = value;
  if (!isRecord(dock.grid) || !isRecord(dock.panels)) return null;
  const saved = Object.keys(dock.panels);
  if (saved.length !== panelIds.length || !panelIds.every((id) => saved.includes(id))) return null;
  return dock;
}

/** The share of the dock the default layout gives a panel that is placed beside or below another. */
export const DEFAULT_SHARE: Readonly<Partial<Record<PanelId, { readonly width?: number; readonly height?: number }>>> = {
  inspector: { width: 0.23 },
  graph: { height: 0.5 },
};
/** The narrowest and widest a side column starts at, in CSS pixels. */
export const SIDE_COLUMN = { min: 300, max: 440 } as const;

export function initialSize(id: PanelId, dock: { readonly width: number; readonly height: number }): { initialWidth?: number; initialHeight?: number } {
  const share = DEFAULT_SHARE[id];
  if (!share) return {};
  const out: { initialWidth?: number; initialHeight?: number } = {};
  if (share.width !== undefined && dock.width > 0) out.initialWidth = Math.round(Math.min(SIDE_COLUMN.max, Math.max(SIDE_COLUMN.min, dock.width * share.width)));
  if (share.height !== undefined && dock.height > 0) out.initialHeight = Math.round(dock.height * share.height);
  return out;
}
