// The profile of an impact crater, shared by the crater and the crater field: the WGSL library
// `generateLandCrater`.
import { defineLib } from '../../api.ts';
import { generateLand } from './_land.ts';

const code = /* wgsl */ `
// The height an impact adds at the distance r from its centre, in units of the crater's radius, for a crater of
// depth 1: a bowl below the old ground inside the rim, a raised rim at r = 1 and a blanket of ejecta that
// thins out beyond it and ends at reach. rim is the height of the rim and peak that of the central peak, both
// as parts of the depth. A crater with a central peak also has a flat floor and steep walls, as large craters do.
fn generateLandCrater_profile(r: f32, rim: f32, peak: f32, reach: f32) -> f32 {
  // Inside: -1 at the centre, the rim's height at r = 1. The exponent flattens the floor.
  let floorPower = mix(2.0, 5.0, saturate(peak * 2.5));
  let bowl = -1.0 + (1.0 + rim) * pow(max(r, 1.0e-6), floorPower);
  // Outside: the blanket falls with the cube of the distance.
  let x = max(r, 0.5);
  let blanket = rim / (x * x * x) * (1.0 - smoothstep(0.6 * reach, reach, r));
  // The rim is where the two meet; the smooth minimum rounds its crest.
  return generateLand_smin(bowl, blanket, 0.15 * rim + 0.02);
}

// The central peak: a mound in the middle of the floor, as a part of the depth.
fn generateLandCrater_mound(r: f32, peak: f32) -> f32 { return peak * exp(-r * r / 0.04); }

// How much of what stood there before an impact is left at r: nothing inside the rim, everything from a little
// way outside it.
fn generateLandCrater_keep(r: f32) -> f32 { return smoothstep(0.9, 1.6, r); }
`;

/** The radial profile of an impact crater. */
export const generateLandCrater = defineLib({ name: 'generateLandCrater', code, deps: [generateLand] });
