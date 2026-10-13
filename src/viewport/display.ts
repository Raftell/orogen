// What the viewport is told to draw beside the camera: the display options of runtime.md 7.5 and the palettes of
// a mask or data overlay. Pure data and arithmetic.

import type { ViewportDisplay } from '../core/runtime.ts';

/** What the terrain is made of in the 3D view where no colour is draped: the default material, or one matte clay. */
export type Shading = 'material' | 'clay';
/** The top view: shaded relief, the heights as grey, or the overlay alone as the image it is. */
export type TopStyle = 'hillshade' | 'grey' | 'overlay';
export const PALETTES = ['red', 'blue', 'green', 'grey', 'viridis', 'magma', 'turbo'] as const;
export type Palette = (typeof PALETTES)[number];

/** `ViewportDisplay` with the members runtime.md 7.5 adds for the renderer of src/viewport/. */
export interface DisplayOptions extends ViewportDisplay {
  readonly shading?: Shading;
  readonly topStyle?: TopStyle;
  readonly palette?: Palette;
}

export type ResolvedDisplay = Required<DisplayOptions>;

/** The sun stands to the left of the top view and over the left shoulder of the panel's first 3D camera: relief reads in both. */
export const DEFAULT_DISPLAY: ResolvedDisplay = {
  verticalScale: 1, showSea: true, sunAzimuth: 195, sunElevation: 38, shading: 'material', topStyle: 'hillshade', palette: 'red',
};

const finite = (value: unknown, fallback: number, min: number, max: number): number =>
  (typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback);
const oneOf = <T extends string>(value: unknown, values: readonly T[], fallback: T): T => values.find((v) => v === value) ?? fallback;

/** The options as the renderer uses them: every member present and in range, whatever was sent. */
export function resolveDisplay(display: ViewportDisplay | null | undefined): ResolvedDisplay {
  const d = (display ?? {}) as Partial<DisplayOptions>;
  const azimuth = finite(d.sunAzimuth, DEFAULT_DISPLAY.sunAzimuth, -1e6, 1e6);
  return {
    verticalScale: finite(d.verticalScale, 1, 0.01, 100),
    showSea: typeof d.showSea === 'boolean' ? d.showSea : DEFAULT_DISPLAY.showSea,
    sunAzimuth: ((azimuth % 360) + 360) % 360,
    sunElevation: finite(d.sunElevation, DEFAULT_DISPLAY.sunElevation, 0, 90),
    shading: oneOf(d.shading, ['material', 'clay'] as const, 'material'),
    topStyle: oneOf(d.topStyle, ['hillshade', 'grey', 'overlay'] as const, 'hillshade'),
    palette: oneOf(d.palette, PALETTES, 'red'),
  };
}

// ---- palettes --------------------------------------------------------------------------------------------------------
// Stops in sRGB, 0..1, evenly spaced. A mask is tinted with the colour at its value; a data field is drawn with
// the colour at its place between its lowest and highest value.
const STOPS: Readonly<Record<Palette, readonly (readonly [number, number, number])[]>> = {
  red: [[0.45, 0.05, 0.03], [0.86, 0.16, 0.1], [1, 0.42, 0.26]],
  blue: [[0.04, 0.16, 0.5], [0.12, 0.42, 0.9], [0.42, 0.72, 1]],
  green: [[0.03, 0.3, 0.1], [0.2, 0.66, 0.24], [0.6, 0.94, 0.42]],
  grey: [[0, 0, 0], [1, 1, 1]],
  viridis: [[0.267, 0.005, 0.329], [0.283, 0.141, 0.458], [0.254, 0.265, 0.53], [0.207, 0.372, 0.553], [0.164, 0.471, 0.558], [0.128, 0.567, 0.551], [0.135, 0.659, 0.518], [0.267, 0.749, 0.441], [0.478, 0.821, 0.318], [0.741, 0.873, 0.15], [0.993, 0.906, 0.144]],
  magma: [[0.001, 0, 0.014], [0.078, 0.054, 0.211], [0.232, 0.06, 0.438], [0.39, 0.1, 0.502], [0.55, 0.161, 0.506], [0.716, 0.215, 0.475], [0.868, 0.288, 0.409], [0.967, 0.441, 0.36], [0.995, 0.624, 0.427], [0.996, 0.813, 0.573], [0.987, 0.991, 0.75]],
  turbo: [[0.19, 0.072, 0.232], [0.271, 0.341, 0.814], [0.243, 0.607, 0.997], [0.097, 0.838, 0.803], [0.2, 0.972, 0.494], [0.555, 0.996, 0.232], [0.836, 0.886, 0.191], [0.989, 0.682, 0.2], [0.964, 0.4, 0.086], [0.812, 0.165, 0.014], [0.48, 0.016, 0.011]],
};

export const PALETTE_SIZE = 256;

/** The palette as PALETTE_SIZE texels of rgba8, sRGB-coded. */
export function paletteTexels(palette: Palette): Uint8Array<ArrayBuffer> {
  const stops = STOPS[palette];
  const out = new Uint8Array(PALETTE_SIZE * 4);
  for (let i = 0; i < PALETTE_SIZE; i++) {
    const at = (i / (PALETTE_SIZE - 1)) * (stops.length - 1);
    const a = stops[Math.min(stops.length - 1, Math.floor(at))]!, b = stops[Math.min(stops.length - 1, Math.floor(at) + 1)]!;
    const f = at - Math.floor(at);
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(255 * (a[c]! + f * (b[c]! - a[c]!)));
    out[i * 4 + 3] = 255;
  }
  return out;
}
