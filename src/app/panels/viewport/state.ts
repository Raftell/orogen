// The viewport panel's own state: the cameras and the display options the engine is told (runtime.md 7.5), and
// the size of the canvas they are framed for. It is the panel's alone and is neither saved nor undone; what the
// viewport shows of the graph is `doc.ui.view`, in the document. The commands of the panel change it here, and
// the component sends every change to the engine.

import { createStore, type StoreApi } from 'zustand/vanilla';

import { cameraOf, frameOrbit, frameTop, initialModel, type DisplayOptions, type Terrain, type ViewportModel } from './model.ts';

export interface ViewportState extends ViewportModel {
  /** The canvas in CSS pixels. */
  readonly width: number;
  readonly height: number;
  /**
   * Whether the engine's last result for the view had a terrain or an overlay in it: a view that names nothing is
   * shown too, as nothing (runtime.md 7.4 rule 5). Kept here and not in the component, which the dock makes anew
   * when a layout is restored while the engine goes on.
   */
  readonly pictured: boolean;
  /**
   * Whether this state was restored from the document it shows (persist.ts). The component is made anew when the
   * dock restores a layout, and the state outlives it: what a hand has made of the view since is not restored away.
   */
  readonly restored: boolean;
}

export function createViewportStore(): StoreApi<ViewportState> {
  return createStore<ViewportState>()(() => ({ ...initialModel(), width: 1600, height: 1000, pictured: false, restored: false }));
}

export const viewportStore: StoreApi<ViewportState> = createViewportStore();

export const aspectOf = (state: Pick<ViewportState, 'width' | 'height'>): number => Math.max(1, state.width) / Math.max(1, state.height);

export function setDisplay(store: StoreApi<ViewportState>, patch: Partial<DisplayOptions>): void {
  const { display } = store.getState();
  if ((Object.keys(patch) as (keyof DisplayOptions)[]).every((key) => display[key] === patch[key])) return;
  store.setState({ display: { ...display, ...patch } });
}

export interface Which { readonly orbit: boolean; readonly top: boolean }
export const BOTH: Which = { orbit: true, top: true };

/** The cameras no hand has moved since they were last framed. Before the first framing, both. */
export function untouched(state: Pick<ViewportState, 'orbit' | 'top' | 'framed' | 'framedOrbit' | 'framedTop'>): Which {
  if (!state.framed) return BOTH;
  return { orbit: state.orbit === state.framedOrbit, top: state.top === state.framedTop };
}

/**
 * The cameras named, on the whole terrain. The orbit keeps the direction it looks from. `middle`: where the
 * terrain's heights lie, as a share of the height range; not given, it is what was last said of this terrain.
 * `sea`: the level of a sea that is shown, normalised.
 */
export function frame(store: StoreApi<ViewportState>, terrain: Terrain, middle?: number, sea: number | null = null, which: Which = BOTH): void {
  const state = store.getState();
  const same = state.framed !== null && state.framed.terrainSize === terrain.terrainSize && state.framed.heightRange === terrain.heightRange;
  const known = middle ?? (same ? state.framedMiddle : null);
  const orbit = which.orbit ? frameOrbit(terrain, state.display.verticalScale, aspectOf(state), state.orbit, known ?? undefined, sea) : state.orbit;
  const top = which.top ? frameTop(aspectOf(state)) : state.top;
  store.setState({
    orbit, top,
    framed: { terrainSize: terrain.terrainSize, heightRange: terrain.heightRange },
    framedOrbit: which.orbit ? orbit : state.framedOrbit,
    framedTop: which.top ? top : state.framedTop,
    framedMiddle: known,
  });
}

export { cameraOf };
