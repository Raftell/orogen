// The commands of the viewport panel (runtime.md 8.8): everything its toolbar and its menu do that is not a drag.
// They act on the panel's state (state.ts) and, for the overlay, on the view of the document.

import { setView, type ViewBinding } from '../../../core/runtime.ts';
// The types alone, from their own file and not from the index of src/app/ui/: the panel's unit tests import this
// module, they are checked without JSX (tsconfig.json), and the index names the controls, which are React.
import type { CommandContext, CommandDef, KeyBinding, MenuEntry } from '../../ui/types.ts';
import { DEFAULT_DISPLAY, initialModel, PALETTE_LABELS, PALETTES, SHADING_LABELS, TOP_STYLE_LABELS, type Palette, type Shading, type Terrain, type TopStyle } from './model.ts';
import { BOTH, frame, setDisplay, viewportStore, type Which } from './state.ts';

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

export const SHADING_COMMAND: Readonly<Record<Shading, string>> = { material: 'viewport.shadingMaterial', clay: 'viewport.shadingClay' };
export const TOP_STYLE_COMMAND: Readonly<Record<TopStyle, string>> = { hillshade: 'viewport.topHillshade', grey: 'viewport.topHeight', overlay: 'viewport.topOverlay' };
export const paletteCommand = (palette: Palette): string => `viewport.palette${capital(palette)}`;

export const terrainOf = (ctx: Pick<CommandContext, 'doc'>): Terrain => {
  const { terrainSize, heightRange } = ctx.doc.getState().doc.settings;
  return { terrainSize, heightRange };
};

const viewOf = (ctx: Pick<CommandContext, 'doc'>): ViewBinding | undefined => ctx.doc.getState().doc.ui.view;
const overlayOf = (ctx: Pick<CommandContext, 'doc'>): ViewBinding['overlay'] => viewOf(ctx)?.overlay;

/** Changes the view of the document: a transaction that is not undoable (8.5 rule 5). */
export function changeView(ctx: Pick<CommandContext, 'doc'>, label: string, next: ViewBinding): void {
  ctx.doc.getState().transact(label, (draft) => setView(draft, next), { undoable: false });
}

/** The level of the sea as the picture has it: the project's, while the sea is shown. */
const seaOf = (ctx: Pick<CommandContext, 'doc'>): number | null => (viewportStore.getState().display.showSea ? ctx.doc.getState().doc.settings.seaLevel : null);

/** Ends the wait of the framing before this one for the terrain's heights; null when none waits. */
let stopWaiting: (() => void) | null = null;

/**
 * Frames the terrain, then again around its mean height once the engine can say where that lies: at once when
 * the terrain is shown, and otherwise when it first is. The second framing is the first one's, made finer: it is
 * dropped when the camera was moved meanwhile, when the terrain has another size, and when a newer framing began.
 * `ask` false frames with what is known of the heights and asks the engine nothing: a panel that is being
 * resized frames for every shape it passes through.
 */
export function frameTerrain(ctx: Pick<CommandContext, 'doc' | 'engine'>, which: Which = BOTH, ask = true): void {
  if (!which.orbit && !which.top) return;
  if (ask) {
    stopWaiting?.();
    stopWaiting = null;
  }
  const terrain = terrainOf(ctx);
  frame(viewportStore, terrain, undefined, seaOf(ctx), which);
  const height = viewOf(ctx)?.height;
  // The top view shows the terrain from above whatever its heights are: only the orbit is framed around them.
  if (!ask || !height || !which.orbit) return;
  const framed = viewportStore.getState().orbit;
  let ended = false;
  const current = (): boolean => {
    const now = terrainOf(ctx);
    return !ended && viewportStore.getState().orbit === framed && now.terrainSize === terrain.terrainSize && now.heightRange === terrain.heightRange;
  };
  const refine = (again: boolean): void => {
    ctx.engine.inspect(height).then((stats) => {
      if (!current()) return;
      if (stats && stats.nonFinite === 0) {
        frame(viewportStore, terrain, stats.mean, seaOf(ctx), { orbit: true, top: false });
        return;
      }
      if (!again) return;
      // Nothing of this terrain is shown yet: asked once more when it is.
      const stop = ctx.engine.subscribe((event) => {
        if (event.type !== 'view-updated' || !event.height || event.draft) return;
        stop();
        if (stopWaiting === cancel) stopWaiting = null;
        refine(false);
      });
      const cancel = (): void => {
        ended = true;
        stop();
      };
      stopWaiting = cancel;
    }, () => undefined);
  };
  refine(true);
}

export const commands: readonly CommandDef[] = [
  {
    id: 'viewport.toggleTop',
    title: 'Toggle Top View',
    run: () => viewportStore.setState({ mode: viewportStore.getState().mode === 'top' ? 'orbit' : 'top' }),
  },
  { id: 'viewport.frame', title: 'Frame Terrain', run: (ctx) => frameTerrain(ctx) },
  {
    id: 'viewport.resetView',
    title: 'Reset View',
    // The direction a new session looks from, on the whole terrain: the way back from wherever the camera has got to.
    run: (ctx) => {
      const first = initialModel().orbit;
      viewportStore.setState({ orbit: { ...viewportStore.getState().orbit, yaw: first.yaw, pitch: first.pitch } });
      frameTerrain(ctx);
    },
  },
  ...(Object.keys(SHADING_COMMAND) as Shading[]).map((shading): CommandDef => ({
    id: SHADING_COMMAND[shading], title: `Shading: ${SHADING_LABELS[shading]}`, run: () => setDisplay(viewportStore, { shading }),
  })),
  ...(Object.keys(TOP_STYLE_COMMAND) as TopStyle[]).map((topStyle): CommandDef => ({
    id: TOP_STYLE_COMMAND[topStyle], title: `Top View: ${TOP_STYLE_LABELS[topStyle]}`, run: () => setDisplay(viewportStore, { topStyle }),
  })),
  { id: 'viewport.toggleSea', title: 'Show or Hide Sea', run: () => setDisplay(viewportStore, { showSea: !viewportStore.getState().display.showSea }) },
  { id: 'viewport.resetSun', title: 'Reset Sun', run: () => setDisplay(viewportStore, { sunAzimuth: DEFAULT_DISPLAY.sunAzimuth, sunElevation: DEFAULT_DISPLAY.sunElevation }) },
  { id: 'viewport.resetVerticalScale', title: 'Reset Vertical Scale', run: () => setDisplay(viewportStore, { verticalScale: 1 }) },
  ...PALETTES.map((palette): CommandDef => ({
    id: paletteCommand(palette), title: `Overlay Palette: ${PALETTE_LABELS[palette]}`, run: () => setDisplay(viewportStore, { palette }),
  })),
  {
    id: 'viewport.nextPalette',
    title: 'Next Overlay Palette',
    run: () => setDisplay(viewportStore, { palette: PALETTES[(PALETTES.indexOf(viewportStore.getState().display.palette) + 1) % PALETTES.length]! }),
  },
  {
    id: 'viewport.removeOverlay',
    title: 'Remove Overlay',
    enabled: (ctx) => overlayOf(ctx) !== undefined,
    run: (ctx) => {
      const { overlay: _overlay, ...view } = viewOf(ctx) ?? {};
      changeView(ctx, 'Remove overlay', view);
    },
  },
];

export const keys: readonly KeyBinding[] = [
  { key: 'F', command: 'viewport.frame', scope: 'viewport' },
  { key: 'Home', command: 'viewport.resetView', scope: 'viewport' },
];

const entries = (group: string, ids: readonly string[]): MenuEntry[] => ids.map((command) => ({ menu: 'Viewport', command, group }));

export const menu: readonly MenuEntry[] = [
  { menu: 'View', command: 'viewport.toggleTop', group: 'viewport' },
  ...entries('camera', ['viewport.frame', 'viewport.resetView', 'viewport.toggleTop']),
  ...entries('shading', [...Object.values(SHADING_COMMAND), ...Object.values(TOP_STYLE_COMMAND)]),
  ...entries('display', ['viewport.toggleSea', 'viewport.resetSun', 'viewport.resetVerticalScale']),
  ...entries('overlay', ['viewport.nextPalette', 'viewport.removeOverlay']),
];
