// src/core/nodes/simulate/_layer.ts
// The layer module of simulation.md 5.9: a loose layer that slides over a fixed bed. The exchange is that of
// thermal erosion on the surface bed + layer; a texel cannot give more than it has, so a first pass computes
// the share of its gifts it can afford and a second pass moves the material.

import { defineKernel, defineLib } from '../../api.ts';
import { TRANSFER, wgsl } from './_constants.ts';
import { TALUS_PAIRS, talusLoad } from './_talus.ts';

/** WGSL that loads the layer around `px` into the values l00 to l22 and the surface bed + layer into s00 to s22. */
const surface = [
  talusLoad('l', (q) => `ld(layer, ${q})`),
  talusLoad('s', (q) => { const at = /vec2i\((-?\d), (-?\d)\)/.exec(q)!; return `ld(bed, ${q}) + l${Number(at[1]) + 1}${Number(at[2]) + 1}`; }),
].join('\n');

/** The exchange of a layer, shared by `simulate/layer.limit`, `simulate/layer.move` and `simulate/snow.move`. */
export const simulateLayer = defineLib({
  name: 'simulateLayer',
  code: /* wgsl */ `
const simulateLayer_TRANSFER = ${wgsl(TRANSFER)};

// Metres of material that the higher texel of a pair gives the lower. over: the metres by which its surface
// stands above the other's. steep: the slope of the surface at the middle of the pair. steps: the run of the
// pair in texels. Both texels of a pair call it with the same arguments, so they compute the same number.
// creep: the share of the height difference the giver's layer evens out on any slope (simulateLayer_creep), 0
// for a layer that only slides.
fn simulateLayer_give(over: f32, steep: f32, repose: f32, steps: f32, creep: f32) -> f32 {
  if (over <= 0.0 || steep <= 0.0) { return 0.0; }
  return simulateLayer_TRANSFER * over * max(max(steep - repose, 0.0) / steep, creep) / steps;
}

// How readily a layer \`thickness\` thick, as a height, creeps: in full from the thickness \`full\` on, and a thin
// layer by its share of that. A film would otherwise run ahead of the layer it left, at a texel per iteration.
fn simulateLayer_creep(thickness: f32, creep: f32, full: f32) -> f32 {
  return creep * saturate(thickness / max(full, 1.0e-20));
}

// Everything texel px would give its neighbours if it had it, in metres.
fn simulateLayer_gifts(bed: texture_2d<f32>, layer: texture_2d<f32>, px: vec2i, repose: f32, creep: f32, full: f32) -> f32 {
${surface}
  let perTexel = frame.heightRange / frame.cellSize;
  let ease = simulateLayer_creep(l11, creep, full);
  var sum = 0.0;
${TALUS_PAIRS.map((pair) => `  if (inGrid(px + vec2i(${pair.dx}, ${pair.dy}))) {
    sum += simulateLayer_give((s11 - s${pair.at}) * frame.heightRange, sqrt(${pair.steep2('s')}) * perTexel, repose, ${pair.steps}, ease);
  }`).join('\n')}
  return sum;
}

// The share of its gifts a texel can afford: all of them, or what its layer holds.
fn simulateLayer_limit(bed: texture_2d<f32>, layer: texture_2d<f32>, px: vec2i, repose: f32, creep: f32, full: f32) -> f32 {
  return min(1.0, ld(layer, px) * frame.heightRange / max(simulateLayer_gifts(bed, layer, px, repose, creep, full), 1e-20));
}

// What texel px gains from its neighbours less what it gives them, in metres, each gift scaled by its giver's limit.
fn simulateLayer_net(bed: texture_2d<f32>, layer: texture_2d<f32>, lim: texture_2d<f32>, px: vec2i, repose: f32, creep: f32, full: f32) -> f32 {
${surface}
  let perTexel = frame.heightRange / frame.cellSize;
  let own = ld(lim, px);
  let ease = simulateLayer_creep(l11, creep, full);
  var net = 0.0;
${TALUS_PAIRS.map((pair) => `  if (inGrid(px + vec2i(${pair.dx}, ${pair.dy}))) {
    let steep = sqrt(${pair.steep2('s')}) * perTexel;
    net += ld(lim, px + vec2i(${pair.dx}, ${pair.dy})) * simulateLayer_give((s${pair.at} - s11) * frame.heightRange, steep, repose, ${pair.steps}, simulateLayer_creep(l${pair.at}, creep, full))
      - own * simulateLayer_give((s11 - s${pair.at}) * frame.heightRange, steep, repose, ${pair.steps}, ease);
  }`).join('\n')}
  return net;
}`,
});

/** `simulate/layer.limit`: the share of its gifts every texel can afford (pass 1). `repose` is the tangent of the angle. */
export const layerLimit = defineKernel({
  name: 'simulate/layer.limit',
  inputs: { bed: 'field', layer: 'field' },
  outputs: { lim: 'field' },
  // creep: the share of a height difference the layer evens out on any slope. full: the thickness, as a height, from which it does so in full.
  params: { repose: 'f32', creep: 'f32', full: 'f32' },
  includes: [simulateLayer],
  cost: 18,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 { return simulateLayer_limit(bed, layer, px, P.repose, P.creep, P.full); }`,
});

/** `simulate/layer.move`: the layer after one exchange, plus `source`, the height it gains or loses per iteration (pass 2). */
export const layerMove = defineKernel({
  name: 'simulate/layer.move',
  inputs: { bed: 'field', layer: 'field', lim: 'field', source: { kind: 'field', default: 0 } },
  outputs: { next: 'field' },
  params: { repose: 'f32', creep: 'f32', full: 'f32' },
  includes: [simulateLayer],
  cost: 28,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  let net = simulateLayer_net(bed, layer, lim, px, P.repose, P.creep, P.full);
  return max(0.0, layer_at(px) + net / frame.heightRange + source_at(px));
}`,
});
