// The kernel behind the mountain and the mountain range: a massif raised over a skeleton of crest segments laid
// out on the CPU, and carved by gullies that follow its slopes.
import { defineKernel, type Field, type OpContext } from '../../api.ts';
import { generateLand, type SegmentList } from './_land.ts';

/** The constant bound of the kernel's loops over the crest segments. */
export const MAX_SEGMENTS = 160;
const GULLY_OCTAVES = 7;

export const massif = defineKernel({
  name: 'generate/land-massif',
  outputs: { out: 'field' },
  params: {
    center: 'vec2f', axis: 'vec2f', invRadius: 'f32', height: 'f32', pin: 'f32',
    flank: 'f32', crisp: 'f32', round: 'f32', bias: 'f32', apron: 'f32', power: 'f32', crown: 'f32', warp: 'f32', erosion: 'f32', sharp: 'f32',
  },
  luts: { crest: 'vec4f' },
  includes: [generateLand],
  code: /* wgsl */ `
const MAX_SEGMENTS = ${MAX_SEGMENTS}u;
const GULLY_OCTAVES = ${GULLY_OCTAVES};
const WARP_BROAD = 1.3;
const WARP_FINE = 4.1;
const WARP_FINE_SHARE = 0.35;
const GROUND = 0.004;

// The massif before erosion, in its own frame, where the highest crest is at height 1 and a flank is about 1
// wide. Every crest segment is the ridge of a roof that falls away at the flank slope, and the massif is the
// smooth maximum of the roofs: valleys lie where two of them meet. Returns (height, gradient, how far the texel
// lies on one roof alone): the gradient is analytic, so it is defined on either side of a crest and never
// straddles one.
fn massifAt(q0: vec2f) -> vec4f {
  // The warp bends crests and flanks. Pinned, it fades towards the origin, where a summit then stays.
  let r = length(q0);
  let rr = r * r + 0.03;
  let fade = 1.0 - P.pin * 0.03 / rr;
  let dfade = P.pin * 0.06 * r / (rr * rr);
  let ax = generateLand_fbmD(q0 * WARP_BROAD, seedFor(1u), 2, 0.5);
  let ay = generateLand_fbmD(q0 * WARP_BROAD + vec2f(37.19, 11.73), seedFor(2u), 2, 0.5);
  let bx = generateLand_fbmD(q0 * WARP_FINE, seedFor(3u), 2, 0.5);
  let by = generateLand_fbmD(q0 * WARP_FINE + vec2f(5.41, 23.7), seedFor(4u), 2, 0.5);
  let shift = vec2f(ax.x + WARP_FINE_SHARE * bx.x, ay.x + WARP_FINE_SHARE * by.x);
  let shiftX = WARP_BROAD * ax.yz + WARP_FINE_SHARE * WARP_FINE * bx.yz;   // the gradient of shift.x
  let shiftY = WARP_BROAD * ay.yz + WARP_FINE_SHARE * WARP_FINE * by.yz;
  let q = q0 + P.warp * fade * shift;

  let n = min(crest_len() / 2u, MAX_SEGMENTS);
  var top = -1.0e6;
  for (var i = 0u; i < MAX_SEGMENTS; i++) {
    if (i >= n) { break; }
    let ends = crest_item(2u * i);
    let heights = crest_item(2u * i + 1u);
    top = max(top, generateLand_roof(q, ends.xy, ends.zw, heights.x, heights.y, P.flank, P.round).x);
  }
  // The smooth maximum, taken relative to the highest roof so that no exponential overflows or all vanish.
  var total = 0.0;
  var slope = vec2f(0.0);
  var steepness = 0.0;
  for (var i = 0u; i < MAX_SEGMENTS; i++) {
    if (i >= n) { break; }
    let ends = crest_item(2u * i);
    let heights = crest_item(2u * i + 1u);
    let roof = generateLand_roof(q, ends.xy, ends.zw, heights.x, heights.y, P.flank, P.round);
    let w = exp(P.crisp * (roof.x - top));
    total += w;
    slope += w * roof.yz;
    steepness += w * roof.w;
  }
  // Where several crests meet the smooth maximum stands above them all; the bias takes that off at the summit.
  let level = top + log(total) / P.crisp - P.bias;
  let dq = slope / total;

  // The foot: the roofs run on below the ground, and the massif meets it in a concave apron instead of an edge.
  // Far below the ground level + root would cancel to nothing: there the same value is written as a quotient.
  let root = sqrt(level * level + P.apron * P.apron);
  let below = 0.5 * P.apron * P.apron / (root + abs(level));
  let foot = select(below, 0.5 * (level + root), level > 0.0);
  let dfoot = select(below / root, 0.5 * (1.0 + level / root), level > 0.0);
  // P.crown is what a crest at height 1 comes to here, so that the highest point of the massif is at 1.
  let h = pow(foot, P.power) / P.crown;
  let dh = P.power * pow(foot, P.power - 1.0) * dfoot / P.crown;
  // The gradient with respect to q0, through the warp.
  let dq0 = dq + P.warp * (dfade * dot(shift, dq) * q0 / max(r, 1.0e-6) + fade * (shiftX * dq.x + shiftY * dq.y));
  // On a crest and where roofs meet in a valley floor, slopes oppose each other and no single way is down.
  let oneWay = smoothstep(0.7, 0.93, length(slope) / max(steepness, 1.0e-6));
  return vec4f(h, dh * dq0, oneWay);
}

fn compute(px: vec2i, uv: vec2f) -> f32 {
  let d = uv - P.center;
  let q = vec2f(dot(d, P.axis), dot(d, vec2f(-P.axis.y, P.axis.x))) * P.invRadius;
  let m = massifAt(q);
  let carved = generateLand_erode(q, m.x, m.yz, 0.24, P.erosion * m.w, GULLY_OCTAVES, P.sharp, 0.5, seedFor(5u));
  // The apron never quite reaches the ground: it is cut off where it is GROUND high, which leaves level ground
  // at exactly 0 around the massif.
  return P.height * clamp((carved.x - GROUND) / (1.0 - GROUND), 0.0, 1.0);
}`,
});

export interface MassifShape {
  /** The crests in the massif's own frame, the highest at height 1; flanks are about 1 wide. */
  readonly crests: SegmentList;
  /** Where the origin of that frame lies on the terrain, and the direction of its x axis in degrees. */
  readonly center: readonly [number, number];
  readonly angle: number;
  /** The length of one unit of the frame, as a fraction of the terrain width. */
  readonly radius: number;
  readonly height: number;
  /** How many crest segments meet at the highest point. */
  readonly meeting: number;
  /** Whether a summit stands at the origin and must stay there. */
  readonly pinned: boolean;
  /** 0..1 each. */
  readonly sharpness: number;
  readonly ridges: number;
  readonly erosion: number;
}

/** A new field holding the massif of `shape`. */
export function runMassif(ctx: OpContext, shape: MassifShape): Field<'field'> {
  const { crests, sharpness } = shape;
  const turn = (shape.angle * Math.PI) / 180;
  const crisp = 25 + 55 * sharpness;
  const apron = 0.14;
  const power = 1 + 0.6 * sharpness;
  const out = ctx.alloc('field');
  ctx.run(massif, {
    out: { out },
    params: {
      center: shape.center,
      axis: [Math.cos(turn), Math.sin(turn)],
      invRadius: 1 / Math.max(shape.radius, 0.0005),
      height: shape.height,
      pin: shape.pinned ? 1 : 0,
      flank: 1.2 + 1.3 * shape.ridges,
      crisp,
      round: 0.2 / crisp,
      bias: Math.log(Math.max(shape.meeting, 1)) / crisp,
      apron,
      power,
      crown: (0.5 * (1 + Math.sqrt(1 + apron * apron))) ** power,
      warp: 0.16,
      erosion: shape.erosion,
      sharp: 0.4 * sharpness,
    },
    luts: { crest: ctx.lut(crests.table(), 'vec4f') },
    // Two passes over the crest table at two reads a segment, four two-octave noises of the warp, and the gullies.
    cost: 4 * Math.min(crests.count, MAX_SEGMENTS) + 64 + 30 * GULLY_OCTAVES,
  });
  return out;
}
