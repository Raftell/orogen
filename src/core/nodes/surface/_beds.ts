// A sequence of rock beds of uneven thickness, shared by surface/terraces and surface/strata: where each bed
// begins, and which bed a level lies in.
import { defineLib, hash } from '../../api.ts';

/** How far the base of a bed lies from where even beds would put it, at full irregularity, in beds: 0.4 either way. */
export const BED_UNEVEN = 0.8;

export const surfaceBeds = defineLib({
  name: 'surfaceBeds',
  deps: [hash],
  code: /* wgsl */ `
const surfaceBeds_UNEVEN = ${BED_UNEVEN};
// Levels beyond this many beds are clamped before they become integers.
const surfaceBeds_LIMIT = 1.0e6;

// A bed: its number, and the levels of its base and its top, in beds.
struct surfaceBeds_Bed { index: i32, lo: f32, hi: f32 }

// The level at which bed k begins: k, moved by up to 0.4 of a bed either way at full irregularity. Bases
// stay in their order, and no bed is thinner than a fifth of the even thickness.
fn surfaceBeds_base(k: i32, irregularity: f32, seed: u32) -> f32 {
  return f32(k) + surfaceBeds_UNEVEN * irregularity * (hash_unit(hash_cell(vec2i(k, 0), seed)) - 0.5);
}

// The bed the level s lies in: its base is at or below s and its top above.
fn surfaceBeds_find(s: f32, irregularity: f32, seed: u32) -> surfaceBeds_Bed {
  let x = clamp(s, -surfaceBeds_LIMIT, surfaceBeds_LIMIT);
  var k = i32(floor(x));
  var lo = surfaceBeds_base(k, irregularity, seed);
  var hi = surfaceBeds_base(k + 1, irregularity, seed);
  if (x < lo) {
    k -= 1;
    hi = lo;
    lo = surfaceBeds_base(k, irregularity, seed);
  } else if (x >= hi) {
    k += 1;
    lo = hi;
    hi = surfaceBeds_base(k + 1, irregularity, seed);
  }
  return surfaceBeds_Bed(k, lo, hi);
}`,
});
