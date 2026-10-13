// How the surface nodes grade an effect by the steepness of the ground: a band of slope angles, passed to a
// kernel as tangents and in radians (engine.md 4.5).
import { defineLib } from '../../api.ts';

/** A tangent no slope reaches: an angle of 90 degrees or more, as a finite kernel param. */
const NEVER = 1e30;

/** The two ends of a band of slope angles as a kernel takes them: (tangent of the lower, of the upper, the lower in radians, the upper). */
export type SlopeBand = readonly [number, number, number, number];

/** The band from `from` to `to` degrees. Angles are clamped to 0..90, and the upper end is never below the lower. */
export function slopeBand(from: number, to: number): SlopeBand {
  const lo = (Math.min(Math.max(from, 0), 90) * Math.PI) / 180;
  const hi = (Math.min(Math.max(to, from, 0), 90) * Math.PI) / 180;
  const tangent = (angle: number): number => (angle >= Math.PI / 2 - 1e-9 ? NEVER : Math.tan(angle));
  return [tangent(lo), tangent(hi), lo, hi];
}

export const surfaceSlope = defineLib({
  name: 'surfaceSlope',
  code: /* wgsl */ `
// How far a slope, as a tangent, lies into a band of angles: 0 at its lower end and below, 1 at its upper end
// and above, both exactly, and eased over the angle between. band is (tangent of the lower end, of the upper,
// the lower end in radians, the upper). Only a slope inside the band needs its angle.
fn surfaceSlope_above(slope: f32, band: vec4f) -> f32 {
  if (slope <= band.x) { return 0.0; }
  if (slope >= band.y) { return 1.0; }
  let t = saturate((atan(slope) - band.z) / max(band.w - band.z, 1.0e-6));
  return t * t * (3.0 - 2.0 * t);
}
// The same from the other side: 1 at the lower end and below, 0 at the upper end and above.
fn surfaceSlope_below(slope: f32, band: vec4f) -> f32 { return 1.0 - surfaceSlope_above(slope, band); }`,
});
