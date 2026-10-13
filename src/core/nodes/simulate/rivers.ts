// src/core/nodes/simulate/rivers.ts
import { defineKernel, defineNode, mixSeed, param, type Field } from '../../api.ts';
import { route, routeEps, routeWeight, routeWeightKernels } from './_route.ts';
import { BANK_RISE, COURSE_REFINE, RIVER_WIDTH_EXPONENT, VALLEY_REACH } from './_water-constants.ts';
import { course, COURSE_WGSL, PLACE_STEPS, VALLEY_WGSL } from './_water-course.ts';
import { jumpKernels, nearestSites } from './_water-jump.ts';

// A site lies in the texel that holds a share above 0, where the course task put it.
const sites = defineKernel({
  name: 'simulate/rivers.site',
  inputs: { share: 'field', place: 'field' },
  outputs: { site: 'vec2' },
  cost: 2,
  code: /* wgsl */ `
const PLACE_STEPS = ${PLACE_STEPS}u;

fn compute(px: vec2i, uv: vec2f) -> vec2f {
  if (!(share_at(px) > 0.0)) { return vec2f(-1.0); }
  let packed = u32(place_at(px));
  return vec2f(px) + vec2f(f32(packed % PLACE_STEPS), f32(packed / PLACE_STEPS)) / f32(PLACE_STEPS - 1u) - 0.5;
}`,
});

// One step along the river towards the site whose river's edge is nearest. The flood gives a texel the river
// whose valley is deepest at it, by a site that need not be the nearest of that river: a site down the river has
// the deeper valley. A site a few places up or down a river is as near as makes no difference, but on a steep
// river its level is another, and the valley side would be cut in ribs.
const along = defineKernel({
  name: 'simulate/rivers.along',
  inputs: { site: 'vec2', share: 'field', place: 'field', course: 'field' },
  outputs: { next: 'vec2' },
  // half: half the width, in texels, of a river that drains the whole terrain.
  params: { half: 'f32' },
  cost: 9,
  code: /* wgsl */ `${COURSE_WGSL}
const WIDTH_EXPONENT = ${RIVER_WIDTH_EXPONENT};

// How far the texel lies from the edge of the river at the site in the texel q, in texels; below 0 inside it.
// A texel whose share is not above 0 holds no site a texel may take: it is as far as can be.
fn edge(here: vec2f, q: vec2i) -> f32 {
  let a = share_at(q);
  if (!(a > 0.0)) { return 1.0e30; }
  return length(placeAt(q) - here) - P.half * pow(min(a, 1.0), WIDTH_EXPONENT);
}

fn compute(px: vec2i, uv: vec2f) -> vec2f {
  let s = site_at(px);
  if (s.x < 0.0) { return s; }
  let here = vec2f(px);
  let q = vec2i(round(s));
  // The texel a site lies in is that river's, however thin its channel.
  if (all(q == px)) { return s; }
  let own = courseAt(q);
  var best = q;
  var nearest = edge(here, q);
  if (any(own.down != vec2i(0))) {
    let d = edge(here, q + own.down);
    if (d < nearest) { nearest = d; best = q + own.down; }
  }
  if (any(own.up != vec2i(0))) {
    let d = edge(here, q + own.up);
    if (d < nearest) { nearest = d; best = q + own.up; }
  }
  if (all(best == q)) { return s; }
  return placeAt(best);
}`,
});

// The valley of the river whose valley is deepest at the texel, cut into the terrain: a parabolic bed under a
// level water surface, and beside it ground lowered by the depth of the valley, less with the distance. The river is the
// line through its sites: the texel is measured to the nearer of the two stretches that meet at its site, and the
// river's level and width are those of the point on it, between the two sites. Taken from the site alone they
// would change from one texel to the next abreast of a river, and a steep river's valley would be cut in rungs.
const carve = defineKernel({
  name: 'simulate/rivers.carve',
  inputs: { height: 'field', site: 'vec2', water: 'field', share: 'field', place: 'field', course: 'field' },
  outputs: { out: 'field', river: 'field', depth: 'field', surface: 'field' },
  // width, depth: metres, of a river that drains the whole terrain. rise: metres, the most a river lies below
  // the routing surface. bank: the tangent of the bank's angle.
  params: { width: 'f32', depth: 'f32', rise: 'f32', bank: 'f32' },
  cost: 14,
  code: /* wgsl */ `${COURSE_WGSL}${VALLEY_WGSL}

// The river at one point of its line: how far the texel lies from its edge, in texels and below 0 inside it;
// its level; half its width, in texels; and how far it lies below the routing surface, in metres.
struct Reach { edge: f32, level: f32, half: f32, rise: f32 }

// The river at the site in the texel q, which lies at \`place\`. The share of a site no texel may take is stored below 0.
fn reachAt(here: vec2f, q: vec2i, place: vec2f, rise: f32) -> Reach {
  let half = 0.5 * P.width / frame.cellSize * pow(min(abs(share_at(q)), 1.0), VALLEY_WIDTH_EXPONENT);
  return Reach(length(here - place) - half, water_at(q), half, P.rise * rise);
}

// The point of the stretch from the site at \`start\` to the site in the texel n whose edge is nearest to the
// texel. The river widens evenly along the stretch, so its edge is a line that leaves the middle line at an
// angle: the point lies where the way to the texel stands at that angle to the stretch.
fn stretch(here: vec2f, start: vec2f, own: Reach, n: vec2i) -> Reach {
  let end = placeAt(n);
  let other = reachAt(here, n, end, courseAt(n).rise);
  let along = end - start;
  let span = length(along);
  var t = 0.0;
  if (span > 0.0) {
    let to = here - start;
    let run = dot(to, along) / span;
    let off = length(to - run * along / span);
    let widening = clamp((other.half - own.half) / span, -0.9, 0.9);
    t = saturate((run + off * widening / sqrt(1.0 - widening * widening)) / span);
  }
  let half = own.half + t * (other.half - own.half);
  return Reach(
    length(here - (start + t * along)) - half,
    own.level + t * (other.level - own.level),
    half,
    own.rise + t * (other.rise - own.rise));
}

fn compute(px: vec2i, uv: vec2f) -> Out {
  let h = height_at(px);
  let s = site_at(px);
  if (s.x < 0.0) { return Out(h, 0.0, 0.0, h); }
  let here = vec2f(px);
  let q = vec2i(round(s));
  let own = courseAt(q);
  let place = placeAt(q);
  let alone = reachAt(here, q, place, own.rise);
  var at = alone;
  if (any(own.down != vec2i(0))) {
    let other = stretch(here, place, alone, q + own.down);
    if (other.edge < at.edge) { at = other; }
  }
  if (any(own.up != vec2i(0))) {
    let other = stretch(here, place, alone, q + own.up);
    if (other.edge < at.edge) { at = other; }
  }
  let w = 2.0 * at.half * frame.cellSize;                               // metres
  let r = (at.edge + at.half) * frame.cellSize;                         // metres to the middle of the river
  // Heights are compared before they are scaled. A cut of 0 leaves the texel as it is, bit for bit.
  let cut = riverCut((h - at.level) * frame.heightRange, r, w, channelDepth(w, P.width, P.depth), at.rise, P.bank);
  let out = h - cut / frame.heightRange;

  let river = saturate(min((0.5 * w - r) / frame.cellSize + 0.5, w / frame.cellSize));
  var depth = 0.0;
  var surface = out;
  if (river > 0.0) {
    depth = max(at.level - out, 0.0);
    surface = max(at.level, out);
  }
  return Out(out, river, depth, surface);
}`,
});

export default defineNode({
  type: 'simulate/rivers',
  title: 'Rivers',
  category: 'simulate',
  description: 'Finds where the terrain\'s water gathers into rivers and cuts their valleys and channels, larger the more ground they drain.',
  keywords: ['river', 'stream', 'channel', 'creek', 'valley', 'drainage', 'water', 'network'],
  inputs: [
    { name: 'in', type: 'field' },
    { name: 'headwaters', type: 'field', role: 'mask', optional: true },
  ],
  outputs: [
    { name: 'out', type: 'field' },
    { name: 'river', type: 'field', role: 'mask' },
    { name: 'depth', type: 'field', role: 'data', label: 'Water depth' },
    { name: 'surface', type: 'field', label: 'Water surface' },
  ],
  params: [
    {
      kind: 'float', name: 'catchment', label: 'Catchment', unit: 'ratio', default: 0.001, min: 0.00001, max: 0.5, scale: 'log',
      help: 'The share of the terrain that must drain through a point for a river to begin there: smaller values give more and finer tributaries.',
    },
    {
      kind: 'float', name: 'valleyDepth', label: 'Valley depth', unit: 'height', default: 0.2, min: 0, max: 0.5,
      help: 'How deep a river that drained the whole terrain would cut its valley into the ground; smaller rivers cut shallower ones, and 0 leaves only the channel.',
    },
    {
      kind: 'float', name: 'riverWidth', label: 'River width', unit: 'length', default: 0.05, min: 0, max: 0.25,
      help: 'The width a river would have that drained the whole terrain; a river is narrower by the square root of its share.',
    },
    {
      kind: 'float', name: 'riverDepth', label: 'River depth', unit: 'height', default: 0.03, min: 0, max: 0.25,
      help: 'The depth of the water in a river that drained the whole terrain; smaller rivers are shallower.',
    },
    param.slope('bank', { label: 'Bank slope', default: 30, min: 5, max: 80, help: 'Steeper banks keep the valley narrow; gentler ones cut its sides further back.' }),
    param.seed({ help: 'Changes which lower neighbor each point drains to, and with it the course of the small rivers.' }),
  ],
  kernels: [sites, along, carve, ...jumpKernels, ...routeWeightKernels],
  cpuTasks: [route, course],
  uses: ['seaLevel'],
  async evaluate(ctx) {
    const { catchment, valleyDepth, riverWidth, riverDepth, bank } = ctx.params;
    const input = ctx.input('in');
    const headwaters = ctx.input('headwaters');
    const seaLevel = ctx.setting('seaLevel');
    // The weights first: the field they are read from is gone again before the node's own state is taken.
    const weight = headwaters ? await routeWeight(ctx, headwaters) : undefined;
    // All of that state before the CPU works: a node that does not fit the budget fails here.
    const out = ctx.alloc('field');
    const river = ctx.wants('river') ? ctx.alloc('field') : null;
    const depth = ctx.wants('depth') ? ctx.alloc('field') : null;
    const surface = ctx.wants('surface') ? ctx.alloc('field') : null;
    const water = ctx.alloc('field');
    const share = ctx.alloc('field');
    const place = ctx.alloc('field');
    const site: Field<'vec2'> = ctx.alloc('vec2');
    const spare = ctx.alloc('vec2');

    const height = await ctx.read(input);
    const routed = await ctx.cpu(route, {
      height, res: ctx.res, eps: routeEps(ctx.heightRange), seaLevel, routing: 'single', seed: mixSeed(ctx.seed, 0), weight, receivers: true, sea: 'connected',
    }, weight ? [height.buffer, weight.buffer] : [height.buffer]);
    // The router consumed its copy of the terrain: the input is read a second time.
    const terrain = await ctx.read(input);
    const width = ctx.lengthToMetres(riverWidth), deep = ctx.heightToMetres(riverDepth), valley = ctx.heightToMetres(valleyDepth);
    const tanBank = Math.tan((bank * Math.PI) / 180);
    const rivers = await ctx.cpu(course, {
      height: terrain, filled: routed.filled, area: routed.area!, receivers: routed.receivers!,
      res: ctx.res, seaLevel, catchment, cell: ctx.cellSize, range: ctx.heightRange, width, depth: deep, valley, bank: tanBank,
      // What a task returns arrives in buffers of its own, which move on to the next task.
    }, [terrain.buffer, routed.filled.buffer as ArrayBuffer, routed.area!.buffer as ArrayBuffer, routed.receivers!.buffer as ArrayBuffer]);
    ctx.write(water, rivers.level);
    ctx.write(share, rivers.share);
    ctx.write(place, rivers.place);
    // What the course task says of each site lies in the plane of the terrain the node gives, until that is written.
    ctx.write(out, rivers.course);
    ctx.run(sites, { in: { share, place }, out: { site } });

    // The farthest a river lowers the terrain: half the widest river and the reach of its valley's side, in texels.
    const reach = (0.5 * width + (VALLEY_REACH * (deep + BANK_RISE * rivers.deepest)) / tanBank) / ctx.cellSize + 1;
    const measures = { width, depth: deep, rise: rivers.deepest, bank: tanBank };
    const planes = { share, place, course: out };
    let [nearest, other] = await nearestSites(ctx, site, spare, reach, [0.7, 0.9], 'Rivers', { planes, params: measures });
    await ctx.loop(COURSE_REFINE, () => {
      ctx.run(along, { in: { site: nearest, ...planes }, out: { next: other }, params: { half: (0.5 * width) / ctx.cellSize } });
      [nearest, other] = [other, nearest];
    }, { progress: [0.9, 1], label: 'Rivers' });
    ctx.release(other);
    // A plane of its own for that takes the place of the spare sites: the node's terrain is written next.
    const texels = ctx.clone(out);
    ctx.run(carve, {
      in: { height: input, site: nearest, water, share, place, course: texels },
      out: { out, river, depth, surface },
      params: measures,
    });
    ctx.release(nearest);
    ctx.release(texels);
    ctx.release(water);
    ctx.release(share);
    ctx.release(place);
    ctx.output('out', out);
    if (river) ctx.output('river', river);
    if (depth) ctx.output('depth', depth);
    if (surface) ctx.output('surface', surface);
  },
});
