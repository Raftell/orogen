// src/core/nodes/simulate/sea.ts
import { defineCpuTask, defineKernel, defineNode, param, type CpuEnv, type Field } from '../../api.ts';
import { COAST_FLAT, COAST_SWEEPS, COAST_TALUS, COAST_TRANSFER } from './_water-constants.ts';
import { jumpKernels, nearestSites } from './_water-jump.ts';

interface ConnectArgs {
  readonly height: Float32Array;     // res × res; consumed, and returned as `water`
  readonly res: number;
  readonly seaLevel: number;
}

// The sea that the border reaches: from the texels of the border ring at or below the sea level, through N4
// neighbours at or below it. Breadth first, so the list of texels still to visit stays as long as the front.
// Pure: the result depends on the arguments only.
const connect = defineCpuTask({
  name: 'simulate/sea.connect',
  run({ height, res, seaLevel }: ConnectArgs, env: CpuEnv): { water: Float32Array } {
    const n = res * res;
    if (height.length !== n) throw new Error(`simulate/sea.connect: height holds ${height.length} values, not ${res} x ${res}`);
    const sea = Math.fround(seaLevel);   // the value a kernel compares with
    // A texel the flood has reached holds this, which is above every sea level: it is not reached twice.
    const REACHED = Infinity;
    let ring = new Int32Array(1 << 12), head = 0, count = 0;
    const visit = (i: number): void => {
      if (!(height[i] <= sea)) return;
      height[i] = REACHED;
      if (count === ring.length) {
        const grown = new Int32Array(count * 2);
        for (let k = 0; k < count; k++) grown[k] = ring[(head + k) % ring.length];
        ring = grown; head = 0;
      }
      ring[(head + count++) % ring.length] = i;
    };
    const last = res - 1;
    for (let x = 0; x < res; x++) { visit(x); visit(last * res + x); }
    for (let y = 1; y < last; y++) { visit(y * res); visit(y * res + last); }
    let done = 0;
    while (count > 0) {
      const i = ring[head];
      head = (head + 1) % ring.length; count--;
      const x = i % res;
      if (x < last) visit(i + 1);
      if (i + res < n) visit(i + res);
      if (x > 0) visit(i - 1);
      if (i >= res) visit(i - res);
      if ((++done & 0xfffff) === 0) env.progress(done / n);
    }
    for (let i = 0; i < n; i++) height[i] = height[i] === REACHED ? 1 : 0;
    return { water: height };
  },
});

const everywhere = defineKernel({
  name: 'simulate/sea.mask',
  inputs: { height: 'field' },
  outputs: { water: 'field' },
  params: { sea: 'f32' },
  cost: 1,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 { return select(0.0, 1.0, height_at(px) <= P.sea); }`,
});

// The shoreline as sites: the sea texels with an N4 neighbour that is not sea.
const shore = defineKernel({
  name: 'simulate/sea.shore',
  inputs: { water: 'field' },
  outputs: { site: 'vec2' },
  cost: 5,
  code: /* wgsl */ `
fn dry(q: vec2i) -> bool { return inGrid(q) && water_at(q) < 0.5; }

fn compute(px: vec2i, uv: vec2f) -> vec2f {
  let onShore = water_at(px) >= 0.5 && (dry(px + vec2i(1, 0)) || dry(px + vec2i(0, 1)) || dry(px - vec2i(1, 0)) || dry(px - vec2i(0, 1)));
  return select(vec2f(-1.0), vec2f(px), onShore);
}`,
});

// The beach and the shelf: within the band, the terrain is drawn towards a ramp through the shoreline.
const reshape = defineKernel({
  name: 'simulate/sea.reshape',
  inputs: { height: 'field', water: 'field', site: 'vec2' },
  outputs: { out: 'field', band: 'field' },
  // size: the width of the band to each side of the shoreline, in texels. rise: shoreHeight. dry: the lowest land.
  params: { sea: 'f32', dry: 'f32', strength: 'f32', size: 'f32', rise: 'f32' },
  cost: 3,
  code: /* wgsl */ `
const COAST_FLAT = ${COAST_FLAT};

fn compute(px: vec2i, uv: vec2f) -> Out {
  let h = height_at(px);
  let s = site_at(px);
  if (s.x < 0.0) { return Out(h, 0.0); }
  let wet = water_at(px) >= 0.5;
  // The shoreline lies half-way between a sea texel and its neighbour on land: the distance to it is positive
  // on land and negative under the sea.
  let d = length(vec2f(px) - s);
  let x = select(d - 0.5, -(d + 0.5), wet) / P.size;
  if (abs(x) >= 1.0) { return Out(h, 0.0); }
  let ramp = P.sea + P.rise * x;
  // In full over the inner part of the band; from there the weight and its slope fall to 0 at the band's edge.
  let weight = P.strength * (1.0 - smoothstep(COAST_FLAT, 1.0, abs(x)));
  let drawn = h + (ramp - h) * weight;
  var v = drawn;
  if (wet) {
    // The sea bed stays at or below the sea level.
    v = min(drawn, P.sea);
  } else {
    // Land is only cut back, and what stood above the sea still does: the shoreline does not move.
    v = min(h, drawn);
    if (h > P.sea) { v = max(v, min(h, P.dry)); }
  }
  return Out(v, 1.0 - abs(x));
}`,
});

// One sweep of the talus relaxation of simulation.md 5.3, in gather form, gated by the band: the scarp that the
// cut leaves behind a beach slumps to the talus angle. A sea texel stays at or below the sea level and land
// above it stays above it.
const relax = defineKernel({
  name: 'simulate/sea.relax',
  inputs: { h: 'field', band: 'field', water: 'field' },
  outputs: { next: 'field' },
  params: { talus: 'f32', sea: 'f32', dry: 'f32' },   // talus: the tangent of the angle
  cost: 19,
  code: /* wgsl */ `
const TRANSFER = ${COAST_TRANSFER};

// Metres of material that the texel with height hFrom gives to the one with height hTo.
// Both texels of a pair call it with the same arguments, so they compute the same number.
fn give(hFrom: f32, hTo: f32, run: f32, gate: f32) -> f32 {
  return TRANSFER * gate * (frame.cellSize / run) * max((hFrom - hTo) * frame.heightRange - P.talus * run, 0.0);
}

fn compute(px: vec2i, uv: vec2f) -> f32 {
  let hp = h_at(px);
  let mp = band_at(px);
  if (mp <= 0.0) { return hp; }
  var gain = 0.0;
  var loss = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let q = px + vec2i(i, j);
      if ((i == 0 && j == 0) || !inGrid(q)) { continue; }
      let run = frame.cellSize * length(vec2f(vec2i(i, j)));
      let hq = h_at(q);
      let gate = min(mp, band_at(q));
      gain += give(hq, hp, run, gate);
      loss += give(hp, hq, run, gate);
    }
  }
  let v = hp + (gain - loss) / frame.heightRange;
  if (water_at(px) >= 0.5) { return min(v, P.sea); }
  if (hp > P.sea) { return max(v, min(hp, P.dry)); }
  return v;
}`,
});

const maps = defineKernel({
  name: 'simulate/sea.maps',
  inputs: { height: 'field', water: 'field' },
  outputs: { depth: 'field', surface: 'field' },
  params: { sea: 'f32' },
  cost: 2,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> Out {
  let h = height_at(px);
  let wet = water_at(px) >= 0.5;
  return Out(select(0.0, max(P.sea - h, 0.0), wet), select(h, P.sea, wet));
}`,
});

export default defineNode({
  type: 'simulate/sea',
  title: 'Sea',
  category: 'simulate',
  description: 'Marks the sea at the project\'s sea level, with its depth and surface, and shapes the coast into a beach and a shelf.',
  keywords: ['ocean', 'water', 'coast', 'shore', 'beach', 'sea level', 'bathymetry'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [
    { name: 'out', type: 'field' },
    { name: 'water', type: 'field', role: 'mask' },
    { name: 'depth', type: 'field', role: 'data', label: 'Water depth' },
    { name: 'surface', type: 'field', label: 'Water surface' },
  ],
  params: [
    {
      kind: 'enum', name: 'mode', label: 'Mode', default: 'connected',
      // Stored in documents: values are never renamed or reordered, and new ones are appended.
      options: [
        { value: 'connected', label: 'Connected' },
        { value: 'global', label: 'Global' },
      ],
      help: 'Connected floods only what the sea reaches from the border and leaves inland basins dry; global floods everything below sea level.',
    },
    param.strength({
      label: 'Coast shaping',
      help: 'Larger values cut the coast back into a beach that rises from the waterline and a shelf that falls away under it; 0 leaves the terrain as it is.',
    }),
    {
      kind: 'float', name: 'shoreSize', label: 'Shore width', unit: 'length', default: 0.02, min: 0.0005, max: 0.1, scale: 'log',
      help: 'Larger values shape a broader band of beach and shelf along the waterline.',
    },
    {
      kind: 'float', name: 'shoreHeight', label: 'Shore height', unit: 'height', default: 0.005, min: 0, max: 0.05,
      help: 'How far the beach rises above the waterline at the inland edge of the band, and the shelf falls below it at the seaward edge.',
    },
  ],
  kernels: [everywhere, shore, reshape, relax, maps, ...jumpKernels],
  cpuTasks: [connect],
  uses: ['seaLevel'],
  async evaluate(ctx) {
    const { mode, strength, shoreSize, shoreHeight } = ctx.params;
    const input = ctx.input('in');
    const seaLevel = ctx.setting('seaLevel');
    // What a kernel compares with: the float32 nearest to the setting.
    const sea = Math.fround(seaLevel);
    const shaped = strength > 0;
    const wants = { water: ctx.wants('water'), depth: ctx.wants('depth'), surface: ctx.wants('surface') };
    if (!shaped && !wants.water && !wants.depth && !wants.surface) {
      ctx.output('out', input);
      return;
    }

    // All the state the node holds at its peak before the CPU works: a node that does not fit the budget fails here.
    const water = ctx.alloc('field');
    const shaping = shaped ? { h: ctx.alloc('field'), band: ctx.alloc('field'), sites: ctx.alloc('vec2'), spare: ctx.alloc('vec2') } : null;
    // The sea mask, found on the terrain as it arrives.
    if (mode === 'global') ctx.run(everywhere, { in: { height: input }, out: { water }, params: { sea } });
    else {
      const height = await ctx.read(input);
      const reached = await ctx.cpu(connect, { height, res: ctx.res, seaLevel }, [height.buffer]);
      ctx.write(water, reached.water);
    }

    let out: Field<'field'> = input;
    if (shaping) {
      let h = shaping.h;
      const { band, sites, spare: spareSites } = shaping;
      ctx.run(shore, { in: { water }, out: { site: sites } });
      const reach = ctx.lengthToPx(shoreSize);
      const [site, spent] = await nearestSites(ctx, sites, spareSites, reach, [0.3, 0.6], 'Coast');
      ctx.release(spent);
      // Land that stands above the sea keeps a few float32 steps above it, so that it is land to every reader.
      const dry = Math.fround(sea + Math.max(Math.abs(sea) * 1e-6, 1e-7));
      ctx.run(reshape, { in: { height: input, water, site }, out: { out: h, band }, params: { sea, dry, strength, size: reach, rise: shoreHeight } });
      ctx.release(site);
      let spare = ctx.alloc('field');
      const params = { talus: Math.tan((COAST_TALUS * Math.PI) / 180), sea, dry };
      await ctx.loop(COAST_SWEEPS, () => {
        ctx.run(relax, { in: { h, band, water }, out: { next: spare }, params });
        [h, spare] = [spare, h];
      }, { progress: [0.6, 1], label: 'Coast', preview: () => ({ out: h }) });
      ctx.release(band);
      ctx.release(spare);
      out = h;
    }
    ctx.output('out', out);

    if (wants.depth || wants.surface) {
      const depth = wants.depth ? ctx.alloc('field') : null;
      const surface = wants.surface ? ctx.alloc('field') : null;
      ctx.run(maps, { in: { height: out, water }, out: { depth, surface }, params: { sea } });
      if (depth) ctx.output('depth', depth);
      if (surface) ctx.output('surface', surface);
    }
    if (wants.water) ctx.output('water', water);
    else ctx.release(water);
  },
});
