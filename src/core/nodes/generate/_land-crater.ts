// What the crater and the crater field share: the WGSL library `generateLandCrater` with the profile of an
// impact, and the ground an impact struck, read from a connected terrain.
import { defineLib, ops, type Field, type OpContext } from '../../api.ts';
import { generateLand } from './_land.ts';

const code = /* wgsl */ `
// Slumped terraces in the wall of a crater with a central peak: how many, and how far the wall is stepped.
const generateLandCrater_TERRACES = 3.0;
const generateLandCrater_STEPPED = 0.85;
// How far an impact can move the old ground up or down, in its own depths.
const generateLandCrater_MOVES = 3.0;

// The height an impact adds at the distance r from its centre, in units of the crater's radius, for a crater of
// depth 1: a bowl below the old ground inside the rim, a raised rim at r = 1 and a blanket of ejecta that
// thins out beyond it and ends at reach. rim is the height of the rim and peak that of the central peak, both
// as parts of the depth. A crater with a central peak also has a flat floor and steep walls that step down in
// slumped terraces, as large craters do; uneven moves those steps, differently around the crater.
fn generateLandCrater_profile(r: f32, rim: f32, peak: f32, reach: f32, uneven: f32) -> f32 {
  // Inside: -1 at the centre, the rim's height at r = 1. The exponent flattens the floor.
  let large = saturate(peak * 2.5);
  let floorPower = mix(2.0, 5.0, large);
  let wall = (1.0 + rim) * pow(max(r, 1.0e-6), floorPower);       // 0 at the centre, 1 + rim at the rim
  // The terraces: the wall climbs steeply and gently in turn. The steps are taken out of the climb itself and
  // come to nothing at its two ends, so the wall still rises all the way from the same floor to the same rim.
  let turns = generateLandCrater_TERRACES * wall / (1.0 + rim) + uneven;
  let steps = (sin(generateLand_TAU * turns) - sin(generateLand_TAU * uneven)) / (generateLand_TAU * generateLandCrater_TERRACES);
  let stepped = wall - generateLandCrater_STEPPED * large * (1.0 + rim) * steps * smoothstep(0.0, 0.15, wall) * (1.0 - smoothstep(0.9, 1.0, r));
  let bowl = -1.0 + stepped;
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

// The hyperbolic tangent of x, from the exponential of a number that is never above 0: it cannot overflow, and
// from 20 on it is 1 exactly. The builtin is not held to that: on Microsoft's software adapter it gives 1.08 at
// 8.2 and no number at 1e5, which a crater of no depth on a connected terrain asks for.
fn generateLandCrater_tanh(x: f32) -> f32 {
  let e = exp(-2.0 * min(abs(x), 20.0));
  return sign(x) * (1.0 - e) / (1.0 + e);
}

// The old terrain after an impact of the given depth, where keep of it is left: inside the rim it gives way to
// plane, the ground the impact struck, as far as flatten says. An impact moves the ground by a few of its own
// depths at the most: what stood higher above the plane than that, or lay deeper below it, is still there.
fn generateLandCrater_strike(old: f32, plane: f32, depth: f32, keep: f32, flatten: f32) -> f32 {
  let most = max(generateLandCrater_MOVES * depth, 1.0e-6);
  return old - most * generateLandCrater_tanh((old - plane) * flatten * (1.0 - keep) / most);
}
`;

/** The radial profile of an impact crater. */
export const generateLandCrater = defineLib({ name: 'generateLandCrater', code, deps: [generateLand] });

/**
 * The ground an impact struck: its height under the centre of the crater, its slope there per unit of uv, and
 * how well it is known, 0..1.
 */
export interface Ground { readonly height: number; readonly slopeX: number; readonly slopeY: number; readonly known: number }

/** Level ground at `height`. */
export function levelGround(height: number): Ground {
  return { height, slopeX: 0, slopeY: 0, known: 1 };
}

/** A terrain on the coarsest level of the ladder, row by row. */
export interface CoarseTerrain { readonly data: Float32Array; readonly size: number }

/**
 * The connected terrain on the coarsest level of the ladder. That level is the same grid at every level of one
 * ladder and the nearest filter takes its vertices as they are, so what a node derives from it is the same in a
 * preview and in the build (engine.md 1.9 rule 1).
 */
export async function readCoarse(ctx: OpContext, src: Field<'field'>): Promise<CoarseTerrain> {
  const size = ctx.ladder[ctx.ladder.length - 1] ?? ctx.res;
  if (size === ctx.res) return { data: await ctx.read(src), size };
  const coarse = ops.resample(ctx, src, { size, filter: 'nearest' });
  const data = await ctx.read(coarse);
  ctx.release(coarse);
  return { data, size };
}

/** Vertices per axis, to either side of the centre, that a plane is fitted through: 169 at the most, whatever the radius. */
const FIT_REACH = 6;

/**
 * The plane that fits `terrain` best within `radius` of (x, y): the ground a crater of that radius lies on.
 * The relief of the terrain that is smaller than the crater is no part of it. The plane tilts by no more than
 * `tilt` from the centre to the rim, so that a crater on a cliff is not stood on its edge. A crater smaller
 * than the cells of the coarse grid lies between its vertices, on ground they do not show: `known` falls to 0
 * for it, and such a crater is added to the terrain as it is.
 */
export function groundAt(terrain: CoarseTerrain, x: number, y: number, radius: number, tilt: number): Ground {
  const { data, size } = terrain;
  const last = Math.max(size - 1, 1);
  // At least the vertices around the centre, also for a crater smaller than a cell of the coarse grid.
  const reach = Math.max(radius * last, 1.5);
  const stride = Math.max(1, Math.ceil(reach / FIT_REACH));
  // A crater whose centre lies beyond the border is fitted around the nearest point of the terrain, and the plane
  // is carried out to the centre.
  const nx = Math.min(Math.max(x, 0), 1), ny = Math.min(Math.max(y, 0), 1);
  const cx = Math.round(nx * last), cy = Math.round(ny * last);
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sz = 0, sxz = 0, syz = 0;
  for (let j = -FIT_REACH; j <= FIT_REACH; j++) {
    for (let i = -FIT_REACH; i <= FIT_REACH; i++) {
      const vx = cx + i * stride, vy = cy + j * stride;
      if (vx < 0 || vy < 0 || vx >= size || vy >= size) continue;
      if (Math.hypot(vx / last - nx, vy / last - ny) * last > reach + 0.5 * stride) continue;
      const dx = vx / last - x, dy = vy / last - y;
      const z = data[vy * size + vx]!;
      n++;
      sx += dx; sy += dy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
      sz += z; sxz += dx * z; syz += dy * z;
    }
  }
  const cells = radius * last;
  const known = Math.min(Math.max((cells - 0.5) / 1.5, 0), 1) ** 2 * (3 - 2 * Math.min(Math.max((cells - 0.5) / 1.5, 0), 1));
  if (n === 0) return { height: data[cy * size + cx]!, slopeX: 0, slopeY: 0, known };
  // Least squares for z = height + slopeX dx + slopeY dy, solved about the mean of the vertices.
  const mx = sx / n, my = sy / n, mz = sz / n;
  const a = sxx - n * mx * mx, b = sxy - n * mx * my, c = syy - n * my * my;
  const p = sxz - n * mx * mz, q = syz - n * my * mz;
  const det = a * c - b * b;
  // Vertices on one line fit no plane: the ground is then level at their mean.
  if (!(det > 1e-12 * Math.max(a * c, 1e-30))) return { height: mz, slopeX: 0, slopeY: 0, known };
  let slopeX = (p * c - q * b) / det, slopeY = (q * a - p * b) / det;
  const steep = Math.hypot(slopeX, slopeY) * radius;
  if (steep > tilt) {
    slopeX *= tilt / steep;
    slopeY *= tilt / steep;
  }
  return { height: mz - slopeX * mx - slopeY * my, slopeX, slopeY, known };
}
