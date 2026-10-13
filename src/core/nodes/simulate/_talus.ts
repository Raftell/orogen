// src/core/nodes/simulate/_talus.ts
// The talus module of simulation.md 5.3 to 5.6: the pairwise exchange of thermal erosion in gather form.

import { MASK_INPUT, defineKernel } from '../../api.ts';
import { TRANSFER, wgsl } from './_constants.ts';

/** One of the eight pairs a texel forms with its N8 neighbours, as WGSL text over the named values of its 3 x 3 neighbourhood. */
export interface TalusPair {
  /** The offset of the neighbour. */
  readonly dx: number; readonly dy: number;
  /** The two digits that name the neighbour's value: column and row of the neighbourhood, 0..2; the texel itself is 11. */
  readonly at: string;
  /** The run of the pair, in texels: 1, or the square root of 2. */
  readonly steps: string;
  /**
   * The squared slope at the middle of the pair, in height units per texel, of the surface whose nine values are
   * named `<v>00` to `<v>22`. Along the pair it is their difference; across it, the other diagonal of the cell
   * the two share, or for an axial pair the mean of the two central differences beside it. Both texels of a pair
   * get the same number: seen from the other, the sums are the same and the differences only change sign.
   */
  steep2(v: string): string;
}

const sq = (x: string): string => `(${x}) * (${x})`;

/**
 * The eight pairs of a texel. Material moves where the slope at the middle of a pair is above the angle of rest,
 * whatever way that slope faces. Measured between the two texels alone, a slope that faces a row or a column
 * rests on its diagonal pairs however steep it is, so its rows never even out and show as streaks down the fall
 * line; and a heap comes to rest as an octagon.
 */
export const TALUS_PAIRS: readonly TalusPair[] = [-1, 0, 1].flatMap((dy) => [-1, 0, 1].filter((dx) => dx !== 0 || dy !== 0).map((dx): TalusPair => {
  const at = `${dx + 1}${dy + 1}`;
  if (dx !== 0 && dy !== 0) {
    return { dx, dy, at, steps: 'sqrt(2.0)', steep2: (v) => `0.5 * (${sq(`${v}${at} - ${v}11`)} + ${sq(`${v}${dx + 1}1 - ${v}1${dy + 1}`)})` };
  }
  // The unit step across the pair, and the two texels that lie beside the pair on the side `sign` of it.
  const ex = dy !== 0 ? 1 : 0, ey = dx !== 0 ? 1 : 0;
  const beside = (v: string, sign: number): string => `(${v}${1 + sign * ex}${1 + sign * ey} + ${v}${1 + dx + sign * ex}${1 + dy + sign * ey})`;
  return { dx, dy, at, steps: '1.0', steep2: (v) => `${sq(`${v}${at} - ${v}11`)} + ${sq(`0.25 * (${beside(v, 1)} - ${beside(v, -1)})`)}` };
}));

/** WGSL that loads the 3 x 3 neighbourhood of `px` of the surface `read(q)` into the values `<v>00` to `<v>22`. */
export const talusLoad = (v: string, read: (q: string) => string): string =>
  [0, 1, 2].flatMap((y) => [0, 1, 2].map((x) => `  let ${v}${x}${y} = ${read(`px + vec2i(${x - 1}, ${y - 1})`)};`)).join('\n');

/**
 * `simulate/talus.step`: every texel computes its own net change from its N8 neighbourhood and writes only itself.
 * A pair exchanges the share of its height difference by which the slope at its middle is above the talus slope.
 * With `rest` bound, that field is the ground at rest: the slope a pair may keep is the larger of the talus slope
 * and the slope it had there, less the loose material the giver carries above its own rest height. Ground that was
 * steeper than the talus angle to begin with stays as it was; what a simulation steepened slumps. What it laid
 * down, the loose material above the rest height, slides wherever the surface is steeper than `fan`, and no more
 * of it than there is.
 */
export const talusStep = defineKernel({
  name: 'simulate/talus.step',
  inputs: { h: 'field', mask: MASK_INPUT, rest: { kind: 'field', default: 0 } },
  outputs: { next: 'field' },
  params: { talus: 'f32', fan: 'f32', keep: 'f32' },      // talus, fan: tangents of the two angles
  cost: 27,
  code: /* wgsl */ `
const TRANSFER = ${wgsl(TRANSFER)};

// Metres of material that the higher texel of a pair gives the lower. over: the metres by which it stands above
// it. steep: the slope at the middle of the pair. kept: the slope the pair may keep. loose: the metres of loose
// material on the giver. Both texels of a pair call it with the same arguments, so they compute the same number.
fn give(over: f32, steep: f32, kept: f32, loose: f32, steps: f32, gate: f32) -> f32 {
  if (over <= 0.0 || steep <= 0.0) { return 0.0; }
  let slump = over * max(steep - kept, 0.0) / steep;
  let slide = min(over * max(steep - P.fan, 0.0) / steep, loose);
  return TRANSFER * gate * max(slump, slide) / steps;
}

fn compute(px: vec2i, uv: vec2f) -> f32 {
${talusLoad('h', (q) => `h_at(${q})`)}
${talusLoad('r', (q) => `rest_at(${q})`)}
${talusLoad('m', (q) => `mask_at(${q})`)}
  let metres = frame.heightRange;
  let perTexel = frame.heightRange / frame.cellSize;      // a difference of heights between neighbours, as a slope
  let loose = max(h11 - r11, 0.0) * metres;
  var gain = 0.0;
  var loss = 0.0;
${TALUS_PAIRS.map((pair) => `  if (inGrid(px + vec2i(${pair.dx}, ${pair.dy}))) {
    let steps = ${pair.steps};
    let steep = sqrt(${pair.steep2('h')}) * perTexel;
    // Unbound, rest reads 0 everywhere and its slope is 0: the slope a pair may keep is the talus slope.
    let rested = sqrt(${pair.steep2('r')}) * perTexel;
    let theirs = max(h${pair.at} - r${pair.at}, 0.0) * metres;
    let gate = min(m11, m${pair.at});
    gain += give((h${pair.at} - h11) * metres, steep, max(P.talus, rested - theirs / (steps * frame.cellSize)), theirs, steps, gate);
    loss += give((h11 - h${pair.at}) * metres, steep, max(P.talus, rested - loose / (steps * frame.cellSize)), loose, steps, gate);
  }`).join('\n')}
  return h11 + (gain * P.keep - loss) / metres;
}`,
});
