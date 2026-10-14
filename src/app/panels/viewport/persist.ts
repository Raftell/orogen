// What the viewport keeps between runs, and where (runtime.md 7.5, "What is kept").
//
// With the project, in `doc.ui.viewport`: which view is shown, both cameras once a hand has moved them, the sun,
// the vertical scale and whether the sea is drawn. They are composed for this terrain: where it is looked at
// from, what light shows its relief, how far its heights are raised. Whoever opens the file sees that picture.
//
// With the user, in `Preferences.viewport`: the shading, the style of the top view and the palette of the
// overlays. They are how this user has any terrain drawn; a project brings none of its own.
//
// No DOM and no React: `keepViewport` is what the panel's component starts, and the unit tests run all of it.

import { setViewportState, type GraphDoc } from '../../../core/runtime.ts';
import type { CommandContext } from '../../ui/types.ts';
import { frameTerrain, terrainOf } from './commands.ts';
import {
  DEFAULT_DISPLAY, FOV_Y, initialModel, PALETTES, PITCH_MAX, PITCH_MIN, type DisplayOptions, type OrbitCamera, type Palette, type Shading, type TopCamera, type TopStyle,
} from './model.ts';
import type { ViewportState } from './state.ts';
import type { StoreApi } from 'zustand/vanilla';

export const KEPT_VERSION = 1;

/** `doc.ui.viewport`. A camera that is absent was never moved by hand: it is framed on the terrain when the project opens. */
export interface ProjectView {
  readonly version: typeof KEPT_VERSION;
  readonly mode: 'orbit' | 'top';
  readonly orbit?: OrbitCamera;
  readonly top?: TopCamera;
  /** Azimuth and elevation, degrees. */
  readonly sun: readonly [number, number];
  readonly verticalScale: number;
  readonly showSea: boolean;
}

/** `Preferences.viewport`. */
export interface UserView {
  readonly version: typeof KEPT_VERSION;
  readonly shading: Shading;
  readonly topStyle: TopStyle;
  readonly palette: Palette;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const wrap = (degrees: number): number => ((degrees % 360) + 360) % 360;
const oneOf = <T extends string>(value: unknown, values: readonly T[], fallback: T): T => values.find((v) => v === value) ?? fallback;

function orbitOf(value: unknown): OrbitCamera | undefined {
  if (!isRecord(value) || !Array.isArray(value.target) || value.target.length !== 3 || !value.target.every(number)) return undefined;
  if (!number(value.yaw) || !number(value.pitch) || !number(value.distance) || !(value.distance > 0)) return undefined;
  const [x, y, z] = value.target as number[];
  return {
    kind: 'orbit', target: [x!, y!, z!], yaw: wrap(value.yaw), pitch: clamp(value.pitch, PITCH_MIN, PITCH_MAX), distance: clamp(value.distance, 1e-3, 1e9),
    fovY: number(value.fovY) && value.fovY >= 1 && value.fovY <= 150 ? value.fovY : FOV_Y,
  };
}

function topOf(value: unknown): TopCamera | undefined {
  if (!isRecord(value) || !Array.isArray(value.center) || value.center.length !== 2 || !value.center.every(number) || !number(value.span) || !(value.span > 0)) return undefined;
  const [u, v] = value.center as number[];
  return { kind: 'top', center: [clamp(u!, -1, 2), clamp(v!, -1, 2)], span: clamp(value.span, 0.002, 16) };
}

/**
 * What a document holds of the viewport, read as it is: null for a document that holds nothing, or something this
 * version does not know. Every member that is not what it should be takes its default; a camera that is not one
 * is left out, and so framed.
 */
export function readProjectView(value: unknown): ProjectView | null {
  if (!isRecord(value) || value.version !== KEPT_VERSION) return null;
  const sun = Array.isArray(value.sun) && value.sun.length === 2 && value.sun.every(number) ? value.sun as number[] : [DEFAULT_DISPLAY.sunAzimuth, DEFAULT_DISPLAY.sunElevation];
  const orbit = orbitOf(value.orbit), top = topOf(value.top);
  return {
    version: KEPT_VERSION,
    mode: value.mode === 'top' ? 'top' : 'orbit',
    ...(orbit ? { orbit } : {}),
    ...(top ? { top } : {}),
    sun: [wrap(sun[0]!), clamp(sun[1]!, 0, 90)],
    verticalScale: number(value.verticalScale) ? clamp(value.verticalScale, 0.01, 100) : DEFAULT_DISPLAY.verticalScale,
    showSea: typeof value.showSea === 'boolean' ? value.showSea : DEFAULT_DISPLAY.showSea,
  };
}

export function readUserView(value: unknown): UserView | null {
  if (!isRecord(value) || value.version !== KEPT_VERSION) return null;
  return {
    version: KEPT_VERSION,
    shading: oneOf(value.shading, ['material', 'clay'] as const, DEFAULT_DISPLAY.shading),
    topStyle: oneOf(value.topStyle, ['hillshade', 'grey', 'overlay'] as const, DEFAULT_DISPLAY.topStyle),
    palette: oneOf(value.palette, PALETTES, DEFAULT_DISPLAY.palette),
  };
}

type Kept = Pick<ViewportState, 'mode' | 'orbit' | 'top' | 'display' | 'framed' | 'framedOrbit' | 'framedTop'>;

/** What the state has for the project: the cameras only when a hand has moved them since they were framed. */
export function projectViewOf(state: Kept): ProjectView {
  const moved = { orbit: state.framed !== null && state.orbit !== state.framedOrbit, top: state.framed !== null && state.top !== state.framedTop };
  return {
    version: KEPT_VERSION,
    mode: state.mode,
    ...(moved.orbit ? { orbit: state.orbit } : {}),
    ...(moved.top ? { top: state.top } : {}),
    sun: [state.display.sunAzimuth, state.display.sunElevation],
    verticalScale: state.display.verticalScale,
    showSea: state.display.showSea,
  };
}

export function userViewOf(display: DisplayOptions): UserView {
  return { version: KEPT_VERSION, shading: display.shading, topStyle: display.topStyle, palette: display.palette };
}

/** What a project that holds nothing is shown with. */
export const DEFAULT_PROJECT_VIEW: ProjectView = {
  version: KEPT_VERSION, mode: 'orbit', sun: [DEFAULT_DISPLAY.sunAzimuth, DEFAULT_DISPLAY.sunElevation], verticalScale: DEFAULT_DISPLAY.verticalScale, showSea: DEFAULT_DISPLAY.showSea,
};

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The viewport's member of a document's interface state; undefined when it has none. */
export const keptIn = (doc: GraphDoc): unknown => doc.ui.viewport;

/** How long the state rests before it is written: a camera that is dragged changes sixty times a second. */
export const KEEP_DELAY_MS = 300;

export interface Keeper {
  /** Writes at once what waits to be written. */
  flush(): void;
  stop(): void;
}

/**
 * Keeps the panel's state: restores it from the document now and whenever another project is opened, and from
 * the preferences once they are read; and writes what changes of it, to the document and to the preferences,
 * when it has rested for `delayMs`.
 */
export function keepViewport(
  ctx: Pick<CommandContext, 'doc' | 'engine' | 'platform'>, store: StoreApi<ViewportState>,
  opts: { readonly delayMs?: number } = {},
): Keeper {
  const delayMs = opts.delayMs ?? KEEP_DELAY_MS;
  let stopped = false;
  let pending: ReturnType<typeof setTimeout> | null = null;
  /** The user's choices as the preferences last held them; null until they are read. */
  let keptUser: UserView | null = null;
  let userRead = false;

  /** The state as the project has it: `view` null is a project that holds nothing. */
  function restore(view: ProjectView | null): void {
    const state = store.getState();
    const kept = view ?? DEFAULT_PROJECT_VIEW;
    const display: DisplayOptions = { ...state.display, sunAzimuth: kept.sun[0], sunElevation: kept.sun[1], verticalScale: kept.verticalScale, showSea: kept.showSea };
    const first = initialModel().orbit;
    // The direction a new session looks from, for a camera the project does not hold: it is framed below.
    store.setState({
      mode: kept.mode,
      display: same(display, state.display) ? state.display : display,
      orbit: kept.orbit ?? { ...state.orbit, yaw: first.yaw, pitch: first.pitch },
    });
    frameTerrain(ctx, { orbit: kept.orbit === undefined, top: kept.top === undefined });
    // A camera of the project is the user's: it is not the framed one, and so is neither framed again nor forgotten.
    const framed = store.getState();
    store.setState({
      ...(kept.top ? { top: kept.top } : {}),
      framed: framed.framed ?? terrainOf(ctx),
      framedOrbit: kept.orbit ? null : framed.framedOrbit,
      framedTop: kept.top ? null : framed.framedTop,
      restored: true,
    });
  }

  function write(): void {
    pending = null;
    if (stopped) return;
    const state = store.getState();
    const view = projectViewOf(state);
    // What the document holds, as this file reads it: a project that holds nothing, or nothing that can be read,
    // is one that is shown by the defaults. A document that was only opened and looked at stays as it is.
    const held = readProjectView(keptIn(ctx.doc.getState().doc)) ?? DEFAULT_PROJECT_VIEW;
    if (!same(view, held)) // `GraphDoc.ui.viewport` is the viewport's own, a value the core carries without looking at it (runtime.md
    // 4.1, 4.6), in a transaction that is not undoable, as every change of the interface state is (8.5 rule 5).
    if (!same(view, held)) ctx.doc.getState().transact('Viewport', (draft) => setViewportState(draft, view), { undoable: false });
    const user = userViewOf(state.display);
    if (userRead && !same(user, keptUser ?? userViewOf(DEFAULT_DISPLAY))) {
      keptUser = user;
      try {
        ctx.platform.setPreferences({ viewport: user }).catch(() => undefined);
      } catch {
        // No bridge: the page runs outside the application, and keeps nothing.
      }
    }
  }
  const schedule = (): void => {
    if (stopped) return;
    if (pending !== null) clearTimeout(pending);
    pending = setTimeout(write, delayMs);
  };

  // Once for a state: a panel that the dock makes anew finds its state as it left it, and leaves it so.
  if (!store.getState().restored) restore(readProjectView(keptIn(ctx.doc.getState().doc)));

  const stopDoc = ctx.doc.subscribe((next, previous) => {
    if (next.doc === previous.doc) return;
    // A transaction changes the interface state or the graph, never both (8.5 rule 5): a document in which both
    // are other objects is another document, which `load` brought.
    const loaded = next.doc.ui !== previous.doc.ui && next.doc.nodes !== previous.doc.nodes;
    if (!loaded) return;
    if (pending !== null) clearTimeout(pending);
    pending = null;
    restore(readProjectView(keptIn(next.doc)));
  });

  const stopStore = store.subscribe((next, previous) => {
    if (next.mode !== previous.mode || next.orbit !== previous.orbit || next.top !== previous.top || next.display !== previous.display
      || next.framedOrbit !== previous.framedOrbit || next.framedTop !== previous.framedTop) schedule();
  });

  try {
    ctx.platform.getPreferences().then((preferences) => {
      if (stopped) return;
      const user = readUserView(preferences.viewport);
      keptUser = user;
      userRead = true;
      if (!user) return;
      const { display } = store.getState();
      // What the user changed while the preferences were read stands.
      if (!same(userViewOf(display), userViewOf(DEFAULT_DISPLAY))) return;
      store.setState({ display: { ...display, shading: user.shading, topStyle: user.topStyle, palette: user.palette } });
    }, () => {
      userRead = true;
    });
  } catch {
    // No bridge.
  }

  return {
    flush() {
      if (pending === null) return;
      clearTimeout(pending);
      write();
    },
    stop() {
      if (pending !== null) {
        clearTimeout(pending);
        write();
      }
      stopped = true;
      stopDoc();
      stopStore();
    },
  };
}
