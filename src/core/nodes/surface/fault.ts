// src/core/nodes/surface/fault.ts
import { defineKernel, defineNode, hashCell, hashUnit, ops, param } from '../../api.ts';

/** The hard maximum of `count`: the constant bound of the kernel's loop over the faults. */
const MAX_FAULTS = 32;

/** The constants of the node, which the tests read. */
export const FAULT = {
  /** Half the length of a fault, least and most, in terrain widths: most faults cross the whole terrain, and some end on it. */
  half: [0.5, 1.2],
  /** The part of its half length, from the middle, over which a fault has its whole throw: beyond it the throw dies out to the end. */
  whole: 0.6,
  /** The throw of the smallest fault, as a part of the height. */
  least: 0.5,
  /** The plane of a fault cuts the ground where the terrain smoothed over this length lies along the fault line. */
  ground: 0.04,
  /** How steep the plane of a fault stands, in degrees: its scarp is as wide as it is tall, over the tangent of this. */
  scarp: 60,
} as const;

/** One fault: a point on its line, the unit vector along it, half its length, and its throw: how far the ground on its left stands above that on its right. */
export interface FaultLine { readonly x: number; readonly y: number; readonly dx: number; readonly dy: number; readonly half: number; readonly throw: number }

/**
 * The faults of a seed. Fault `i` depends on the seed and on `i` alone: more faults leave the first ones as they
 * are. Each runs within `spread` degrees of `angle`, through a point anywhere on the terrain; which of its sides
 * is thrown up is even odds.
 */
export function faultLines(seed: number, count: number, height: number, angle: number, spread: number): FaultLine[] {
  const lines: FaultLine[] = [];
  for (let i = 0; i < Math.min(count, MAX_FAULTS); i++) {
    const u = (k: number): number => hashUnit(hashCell(i, k, seed));
    const turn = ((angle + spread * (2 * u(2) - 1)) * Math.PI) / 180;
    lines.push({
      x: u(0), y: u(1), dx: Math.cos(turn), dy: Math.sin(turn),
      half: FAULT.half[0] + (FAULT.half[1] - FAULT.half[0]) * u(3),
      throw: height * (FAULT.least + (1 - FAULT.least) * u(4)) * (u(5) < 0.5 ? -1 : 1),
    });
  }
  return lines;
}

const fault = defineKernel({
  name: 'surface/fault',
  // src: the terrain. ground: the terrain smoothed, whose height along a fault is where its plane cuts the ground.
  inputs: { src: 'field', ground: 'field' },
  outputs: { out: 'field' },
  // reach: how far from a fault the ground is moved, a length. run: how far across the plane of a fault climbs
  // one height, a length.
  params: { reach: 'f32', run: 'f32' },
  luts: { lines: 'vec4f' },
  code: /* wgsl */ `
const MAX_FAULTS = ${MAX_FAULTS}u;
const WHOLE = ${FAULT.whole};

fn compute(px: vec2i, uv: vec2f) -> f32 {
  let z = src_at(px);
  let n = min(lines_len() / 2u, MAX_FAULTS);
  var moved = 0.0;
  for (var i = 0u; i < MAX_FAULTS; i++) {
    if (i >= n) { break; }
    let line = lines_item(2u * i);
    let form = lines_item(2u * i + 1u);        // half the length, the throw
    let d = uv - line.xy;
    let across = dot(d, vec2f(-line.w, line.z));
    if (abs(across) >= P.reach) { continue; }
    // The throw is whole along the middle part of the fault and dies out towards its two ends.
    let along = dot(d, line.zw);
    let thrown = abs(form.y) * (1.0 - smoothstep(WHOLE, 1.0, abs(along) / form.x));
    // The block on one side is lifted by half the throw and the one on the other dropped by half. Next to the
    // fault both keep their shape, and further out they tilt back to their own level, which they reach at the reach.
    let half = 0.5 * thrown * (1.0 - smoothstep(0.0, P.reach, abs(across)));
    // Between the two blocks the fault itself lies bare: a plane as steep as a rock face stands, through the
    // broad shape of the ground along the fault line. The lifted block ends where the plane cuts it off, and
    // the dropped one begins where it comes out from under the plane: a spur of the lifted block that runs up
    // to the fault ends in a flat face. The plane is a function of the place alone, so every grid has the same.
    let foot = clamp(line.xy + along * line.zw, vec2f(0.0), vec2f(1.0));
    let plane = ground_uv(foot) + sign(form.y) * across / P.run;
    moved += clamp(plane - z, -half, half);
  }
  return z + moved;
}`,
});

export default defineNode({
  type: 'surface/fault',
  title: 'Faults',
  category: 'surface',
  description: 'Breaks the ground along straight faults: one side is thrown up against the other across a flat scarp, and both tilt back to their level.',
  keywords: ['fault', 'scarp', 'fracture', 'tectonic', 'rift', 'graben', 'horst', 'offset', 'shear'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    { kind: 'int', name: 'count', label: 'Count', default: 6, min: 1, max: MAX_FAULTS, help: 'How many faults break the ground. More faults leave the first ones where they are.' },
    param.height({ label: 'Throw', default: 0.25, help: 'How far the ground on one side of the largest fault stands above the other side. Smaller faults throw half as much or more.' }),
    param.angle({ label: 'Direction', default: 20, help: 'The direction the fault lines run in. Larger values turn it clockwise in the top view.' }),
    {
      kind: 'float', name: 'spread', label: 'Spread', unit: 'angle', default: 20, min: 0, max: 90,
      help: 'How far a fault may be turned off the direction, to either side. At 0 all faults are parallel.',
    },
    {
      kind: 'float', name: 'reach', label: 'Reach', unit: 'length', default: 0.6, min: 0.01, max: 4, scale: 'log', soft: true,
      help: 'How far from a fault the ground is moved. Larger values tilt broader blocks; smaller ones leave a ridge and a trench along the scarp.',
    },
    param.seed(),
  ],
  kernels: [fault],
  maskable: true,
  evaluate(ctx) {
    const { count, angle, spread } = ctx.params;
    const src = ctx.input('in');
    // Soft parameters: any finite number can arrive.
    const height = Math.min(Math.max(ctx.params.height, 0), 4);
    const reach = Math.min(Math.max(ctx.params.reach, 0), 1000);
    if (height <= 0 || reach <= 0) {
      ctx.output('out', src);
      return;
    }
    const table = new Float32Array(8 * count);
    faultLines(ctx.seed, count, height, angle, spread).forEach((line, i) => table.set([line.x, line.y, line.dx, line.dy, line.half, line.throw, 0, 0], 8 * i));
    // The planes of the faults go through the terrain without what is smaller than a scarp is wide. Smoothed
    // without anything assumed beyond the border, so a fault that leaves the terrain keeps its plane there.
    const ground = ops.smooth(ctx, src, FAULT.ground);
    const out = ctx.alloc('field');
    ctx.run(fault, {
      in: { src, ground },
      out: { out },
      params: {
        reach,
        // One height is heightRange metres, and a plane at the angle of a scarp climbs that over its tangent as far across.
        run: ctx.heightRange / (Math.tan((FAULT.scarp * Math.PI) / 180) * ctx.terrainSize),
      },
      luts: { lines: ctx.lut(table, 'vec4f') },
      // The terrain, and for every fault two table reads and the ground on its line, read between four texels.
      cost: 1 + 6 * count,
    });
    ctx.release(ground);
    ctx.output('out', out);
  },
});
