// Editing a gradient (engine.md 4.3: at least 2 stops, t non-decreasing in 0..1, colours in linear RGB) as pure
// functions: every edit returns a list that is a valid gradient, with the place of the stop that was edited. The
// picture, and the colour of a new stop, come from bakeGradient, the table kernels read (engine.md 4.9).
// No DOM and no React.

import { bakeGradient, type GradientStop } from '../../../core/api.ts';
import { fromHex, linearToSrgb, type Rgb } from '../../ui/color.ts';

export const GRADIENT_MAX_STOPS = 32;

const round = (value: number): number => Number(value.toFixed(4));
const unit = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
/** Six decimals, as the colour control stores a channel. */
const channel = (value: number): number => Number(unit(value).toFixed(6));
const rgb = (color: Rgb): [number, number, number] => [channel(color[0]), channel(color[1]), channel(color[2])];

/**
 * The color of the gradient at `t`, by bakeGradient itself: a table of one sample is the sample at 0, so the
 * gradient is baked with its stops moved until `t` lies there. No second copy of the interpolation exists here.
 */
export function colorAt(stops: readonly GradientStop[], t: number): [number, number, number] {
  const at = unit(t);
  const table = bakeGradient(stops.map((stop) => ({ t: stop.t - at, color: stop.color })), 1);
  return [channel(table[0]!), channel(table[1]!), channel(table[2]!)];
}

export interface StopEdit {
  readonly stops: readonly GradientStop[];
  /** Where the edited stop is now. */
  readonly index: number;
}

/** A new stop at `t`, after the stops already there. Without a colour it takes the gradient's own at that place. Null when the gradient is full. */
export function addStop(stops: readonly GradientStop[], t: number, color?: Rgb): StopEdit | null {
  if (stops.length >= GRADIENT_MAX_STOPS) return null;
  const at = round(unit(t));
  const index = stops.filter((stop) => stop.t <= at).length;
  const stop: GradientStop = { t: at, color: color ? rgb(color) : colorAt(stops, at) };
  return { stops: [...stops.slice(0, index), stop, ...stops.slice(index)], index };
}

/**
 * The stop at `index` moved to `t`. Stops stay in the order of their positions, so a stop that is dragged past
 * another changes its place in the list: it goes behind the stops it reaches moving right, and before them
 * moving left.
 */
export function moveStop(stops: readonly GradientStop[], index: number, t: number): StopEdit {
  const stop = stops[index];
  if (!stop) return { stops, index };
  const at = round(unit(t));
  if (at === stop.t) return { stops, index };
  const rest = stops.filter((_, i) => i !== index);
  let place = at > stop.t ? rest.filter((other) => other.t <= at).length : rest.findIndex((other) => other.t >= at);
  if (place < 0) place = rest.length;
  return { stops: [...rest.slice(0, place), { t: at, color: stop.color }, ...rest.slice(place)], index: place };
}

/** Without the stop at `index`. A gradient keeps two stops. */
export function removeStop(stops: readonly GradientStop[], index: number): readonly GradientStop[] {
  if (stops.length <= 2 || index < 0 || index >= stops.length) return stops;
  return stops.filter((_, i) => i !== index);
}

export function setStopColor(stops: readonly GradientStop[], index: number, color: Rgb): readonly GradientStop[] {
  const stop = stops[index];
  if (!stop) return stops;
  const next = rgb(color);
  if (next.every((c, i) => c === stop.color[i])) return stops;
  return stops.map((other, i) => (i === index ? { t: other.t, color: next } : other));
}

/** The gradient end for end. */
export function reverseStops(stops: readonly GradientStop[]): GradientStop[] {
  return stops.map((stop) => ({ t: round(1 - stop.t), color: stop.color })).reverse();
}

/** The stops at equal distances, in their order. */
export function distributeStops(stops: readonly GradientStop[]): GradientStop[] {
  const last = stops.length - 1;
  return stops.map((stop, i) => ({ t: last > 0 ? round(i / last) : 0, color: stop.color }));
}

/** The gradient as `n` pixels of sRGB bytes, RGBA: bakeGradient's samples as a screen shows them. */
export function gradientPixels(stops: readonly GradientStop[], n: number = 256): Uint8ClampedArray<ArrayBuffer> {
  const count = Math.min(4096, Math.max(1, Math.floor(n)));
  const table = bakeGradient(stops, count);
  const pixels = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < 3; c++) pixels[i * 4 + c] = Math.round(linearToSrgb(table[i * 4 + c]!) * 255);
    pixels[i * 4 + 3] = 255;
  }
  return pixels;
}

export interface Palette {
  readonly id: string;
  readonly label: string;
  readonly stops: readonly GradientStop[];
}

/** Written as a designer reads colours, in sRGB; stored, as every gradient is, in linear RGB. */
function palette(id: string, label: string, stops: readonly (readonly [number, string])[]): Palette {
  return { id, label, stops: stops.map(([t, hex]) => ({ t, color: rgb(fromHex(hex) ?? [0, 0, 0]) })) };
}

/** Terrain palettes, each from the lowest ground at the left to the highest at the right. */
export const PALETTES: readonly Palette[] = [
  palette('grayscale', 'Grayscale', [[0, '#000000'], [1, '#ffffff']]),
  palette('atlas', 'Atlas', [[0, '#0b3d2e'], [0.15, '#3a7d44'], [0.35, '#a8b56a'], [0.5, '#e3d39a'], [0.65, '#c49a6c'], [0.8, '#8c6a55'], [0.92, '#b9b4ae'], [1, '#ffffff']]),
  palette('alpine', 'Alpine', [[0, '#2d3b24'], [0.3, '#56683a'], [0.5, '#7d7a57'], [0.65, '#6f6a63'], [0.82, '#9a9894'], [0.9, '#e8eef2'], [1, '#ffffff']]),
  palette('temperate', 'Temperate', [[0, '#1f3320'], [0.25, '#3f5a2b'], [0.5, '#6f7a3d'], [0.7, '#8a7a55'], [0.88, '#7d756c'], [1, '#bdb8b0']]),
  palette('desert', 'Desert', [[0, '#6b4a2f'], [0.25, '#a8703f'], [0.5, '#cf9c5a'], [0.75, '#e3c489'], [1, '#f3e6c4']]),
  palette('canyon', 'Canyon', [[0, '#4a2c22'], [0.2, '#8c3b23'], [0.4, '#b85c2e'], [0.55, '#d08a4e'], [0.7, '#a9512f'], [0.85, '#e0b07a'], [1, '#f0dcc0']]),
  palette('tundra', 'Tundra', [[0, '#3d4433'], [0.3, '#6b6b47'], [0.55, '#8e8363'], [0.75, '#a39d8c'], [1, '#dfe3e0']]),
  palette('arctic', 'Arctic', [[0, '#1f3a4d'], [0.3, '#5a8199'], [0.55, '#a9c4d1'], [0.8, '#e4eef2'], [1, '#ffffff']]),
  palette('volcanic', 'Volcanic', [[0, '#0d0b0b'], [0.35, '#2b2424'], [0.6, '#4a3a33'], [0.8, '#7a2e1a'], [0.92, '#d9541e'], [1, '#ffd166']]),
  palette('island', 'Island', [[0, '#12355b'], [0.18, '#2a7fa5'], [0.25, '#e6d7a3'], [0.4, '#5d8f3a'], [0.7, '#2e5d2a'], [0.9, '#6b6455'], [1, '#cfcac2']]),
  palette('heat', 'Heat', [[0, '#000004'], [0.25, '#51127c'], [0.5, '#b73779'], [0.75, '#fc8961'], [1, '#fcfdbf']]),
];
