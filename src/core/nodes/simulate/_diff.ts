// src/core/nodes/simulate/_diff.ts
// The diff module of simulation.md 5.5: what a simulation took from a terrain and what it added.

import { defineKernel } from '../../api.ts';

/** `simulate/diff`: what a simulation took from a terrain and what it added, from the terrain before and after. Either output may be null. */
export const diff = defineKernel({
  name: 'simulate/diff',
  inputs: { before: 'field', after: 'field' },
  outputs: { wear: 'field', deposit: 'field' },
  cost: 2,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> Out {
  let d = after_at(px) - before_at(px);
  return Out(max(-d, 0.0), max(d, 0.0));
}`,
});
