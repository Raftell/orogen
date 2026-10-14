// The light maps: how much of the sun's disc every point of the terrain sees, and how open it lies to the sky.
// Both are baked from the height field into textures of the renderer's own (runtime.md 7.5 rule 4) and refreshed
// progressively: at once on a coarse level, so that a change of the terrain or of the sun is answered in the
// frame that shows it, then on the full grid over the following frames, a bounded share of work per frame (rule 5).
// Where the device has a clock (timestamp-query) that share is what its passes were measured to do in 4 ms; where
// it has none, it begins as a number of texture loads that was measured on one card and follows the time the
// frames that spent it took on this one, from their submission to the GPU's end of them (`nextBakeLoads`).

import { DEG } from './camera.ts';
import { SUN_DISC } from './atmosphere.ts';
import { BAKE_WGSL } from './shaders.ts';

/** The sun's disc is marched in this many strips (ops.shadow of the engine uses four). */
const STRIPS = 3;
/** The coarse level is the finest whose grid is at most this wide. */
export const COARSE_SIZE = 512;
/**
 * Texture loads a frame may spend on refining, beside what must be shown at once, on a device without a clock
 * (profile 'core', and adapters without timestamp-query). Measured on a GTX 1660 Ti
 * (tests/engine/viewport/bench/frames.ts): a frame that spends them takes 2 to 3 ms from its encoding to the
 * GPU's end, the frame of a change 3 to 5 ms, and maps of 2048 texels a side are refined 50 ms after the change,
 * in 23 frames. That is under half the preview slice target (runtime.md 3.5) on that card, whose clock allows
 * about five times as much; a slower adapter without a clock takes longer over each frame.
 */
export const BAKE_LOADS_PER_FRAME = 90e6;
/**
 * With the device's clock (timestamp-query): the GPU time a frame may spend on refining, in milliseconds, half
 * the preview slice target of runtime.md 3.5; and the least and the most loads that may come to.
 */
const BAKE_TARGET_MS = 4;
export const BAKE_LOADS_MIN = 20e6, BAKE_LOADS_MAX = 1500e6;
/**
 * Without the device's clock: how long a frame that refines may take from its submission until the GPU has done
 * it, in milliseconds. That is the whole frame, the picture with the baking, and the wait for whatever the engine
 * had on the queue before it: the preview slice target of runtime.md 3.5.
 */
export const WALL_TARGET_MS = 8;

/**
 * The loads the next frame may spend on refining, after one that was given `loads` took `ms` by the wall clock.
 * Fewer at once when it took too long, in proportion and at most by half: a slow adapter, or an engine at work
 * on the same queue. More by degrees when it was short, and only when it `used` its share: a frame that had
 * little left to do says nothing of what a full one costs.
 */
export function nextBakeLoads(loads: number, ms: number, used: boolean): number {
  if (!Number.isFinite(ms) || ms < 0) return loads;
  let next = loads;
  if (ms > WALL_TARGET_MS) next = loads * Math.max(0.5, WALL_TARGET_MS / ms);
  else if (used && ms < 0.6 * WALL_TARGET_MS) next = loads * 1.15;
  return Math.min(BAKE_LOADS_MAX, Math.max(BAKE_LOADS_MIN, next));
}
const UNIFORM_SLOTS = 512;
const UNIFORM_FLOATS = 16;
const STEEPEST = 1e6;

export type Scoped = <T>(what: string, work: () => T) => T;
export interface Ledger { reserve(bytes: number, label: string): { release(): void } }

export interface BakePipelines {
  readonly layout: GPUBindGroupLayout;
  readonly base: GPURenderPipeline;
  readonly downHeight: GPURenderPipeline;
  readonly downLight: GPURenderPipeline;
  readonly start: GPURenderPipeline;
  readonly march: GPURenderPipeline;
  readonly gather: GPURenderPipeline;
  readonly hidden: GPURenderPipeline;
  readonly occlusion: GPURenderPipeline;
}

export async function createBakePipelines(device: GPUDevice, scoped: Scoped): Promise<BakePipelines> {
  const layout = scoped('the bake layout', () => device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: UNIFORM_FLOATS * 4 } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
    ],
  }));
  const module = device.createShaderModule({ code: BAKE_WGSL });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const make = (entryPoint: string, format: GPUTextureFormat, blend?: GPUBlendState): Promise<GPURenderPipeline> => device.createRenderPipelineAsync({
    layout: pipelineLayout,
    vertex: { module, entryPoint: 'vsBake' },
    fragment: { module, entryPoint, targets: [{ format, ...(blend ? { blend } : {}) }] },
  });
  const add: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };
  const multiply: GPUBlendComponent = { srcFactor: 'dst', dstFactor: 'zero', operation: 'add' };
  const [base, downHeight, downLight, start, march, gather, hidden, occlusion] = await Promise.all([
    make('fsBase', 'r32float'), make('fsDown', 'r32float'), make('fsDown', 'r8unorm'), make('fsStart', 'rg32float'), make('fsMarch', 'rg32float'),
    make('fsGather', 'r8unorm', { color: add, alpha: add }), make('fsHidden', 'r8unorm', { color: multiply, alpha: multiply }), make('fsOcclusion', 'r8unorm'),
  ]);
  return { layout, base, downHeight, downLight, start, march, gather, hidden, occlusion };
}

export interface LightSource {
  readonly view: GPUTextureView;
  readonly width: number;
  readonly height: number;
}
export interface LightParams {
  readonly sunAzimuth: number;      // degrees
  readonly sunElevation: number;    // degrees
  readonly terrainSize: number;     // metres
  readonly zScale: number;          // metres of display height per unit
  /** The normalised level of a sea that is shown, which the light falls on as on level ground; null: none. */
  readonly seaLevel: number | null;
}

export interface Lighting {
  /** Texels along one side of the grid, a power of two. */
  readonly size: number;
  readonly levels: number;
  readonly bytes: number;
  readonly pyramid: GPUTextureView;
  readonly shadow: GPUTextureView;
  readonly occlusion: GPUTextureView;
  /** The finest level of each map that holds the current terrain and sun. */
  readonly shadowLevel: number;
  readonly occlusionLevel: number;
  /** The height field changed: everything is made again. */
  invalidateSource(): void;
  /** The sun moved: the shadows are made again. */
  invalidateSun(): void;
  /** The heights are drawn at another scale: both maps are made again from the pyramid. */
  invalidateRelief(): void;
  /** Encodes what is due into `encoder`. True while more remains for later frames. */
  step(encoder: GPUCommandEncoder, source: LightSource, params: LightParams, budget: number): boolean;
  /** After the submission of the frame that `step` encoded into: asks the device how long the passes took, where it can say. */
  collect(): void;
  /** The loads a frame may spend on refining now: the budget given, or what the measured time of earlier frames allows. */
  readonly loadsPerFrame: number;
  readonly pending: boolean;
  destroy(released: boolean): void;
}

/**
 * `passes`: how many render passes `run` encodes; a task that only notes that a level is complete encodes none.
 * `kind`: what the pass does. A load of the occlusion's passes, far apart on coarse levels, takes longer than a
 * load of the march, so each kind has a rate of its own.
 */
type Kind = 'copy' | 'shadow' | 'occlusion';
interface Task { readonly cost: number; readonly passes: 0 | 1; readonly kind: Kind; run(encoder: GPUCommandEncoder): void }

/** The grid for a field `resolution` vertices wide: the power of two at or above it, at most `cap`. */
export function lightSize(resolution: number, cap: number): number {
  return Math.min(cap, Math.max(64, 2 ** Math.ceil(Math.log2(Math.max(2, resolution)))));
}

export function createLighting(opts: {
  readonly device: GPUDevice; readonly pipelines: BakePipelines; readonly ledger: Ledger; readonly scoped: Scoped;
  readonly size: number; readonly uniformAlignment: number;
  /** The widest grid that is baked in the frame of a change. Default COARSE_SIZE. */
  readonly coarseSize?: number;
  /** The device has timestamp-query: the passes are timed, and the share of a frame follows the time they took. */
  readonly timed?: boolean;
}): Lighting {
  const { device, pipelines, scoped, size } = opts;
  const levels = Math.round(Math.log2(size)) + 1;
  const coarse = Math.max(0, Math.round(Math.log2(size / Math.min(size, opts.coarseSize ?? COARSE_SIZE))));
  const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
  const texture = (label: string, format: GPUTextureFormat, mipLevelCount: number): GPUTexture =>
    scoped(label, () => device.createTexture({ label: `viewport ${label}`, size: [size, size], format, mipLevelCount, usage }));
  const pyramidTexture = texture('height pyramid', 'r32float', levels);
  const shadowTexture = texture('shadow map', 'r8unorm', levels);
  const occlusionTexture = texture('occlusion map', 'r8unorm', levels);
  const states = [texture('shadow state A', 'rg32float', 1), texture('shadow state B', 'rg32float', 1)];
  const chain = (bytesPerTexel: number): number => Math.ceil((size * size * bytesPerTexel * 4) / 3);
  const stride = Math.max(opts.uniformAlignment, UNIFORM_FLOATS * 4);
  const uniforms = scoped('the bake uniforms', () => device.createBuffer({ size: stride * UNIFORM_SLOTS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
  const bytes = chain(4) + 2 * chain(1) + 2 * size * size * 8 + stride * UNIFORM_SLOTS;
  const reservation = opts.ledger.reserve(bytes, `viewport light maps ${size}`);
  const data = new Float32Array((stride / 4) * UNIFORM_SLOTS);
  let used = 0;

  const levelViews = (t: GPUTexture): GPUTextureView[] => Array.from({ length: levels }, (_, level) => t.createView({ baseMipLevel: level, mipLevelCount: 1 }));
  const pyramidLevels = levelViews(pyramidTexture), shadowLevels = levelViews(shadowTexture), occlusionLevels = levelViews(occlusionTexture);
  const stateViews = states.map((t) => t.createView());
  const pyramid = pyramidTexture.createView(), shadow = shadowTexture.createView(), occlusion = occlusionTexture.createView();

  // A view names itself here, so that the bind group of two views is made once.
  const names = new Map<GPUTextureView, number>();
  const nameOf = (view: GPUTextureView): number => {
    let name = names.get(view);
    if (name === undefined) names.set(view, name = names.size);
    return name;
  };
  const groups = new Map<string, GPUBindGroup>();
  const bind = (first: GPUTextureView, second: GPUTextureView, keep: boolean): GPUBindGroup => {
    const make = (): GPUBindGroup => scoped('a bake bind group', () => device.createBindGroup({
      layout: pipelines.layout,
      entries: [{ binding: 0, resource: { buffer: uniforms, size: UNIFORM_FLOATS * 4 } }, { binding: 1, resource: first }, { binding: 2, resource: second }],
    }));
    if (!keep) return make();
    const key = `${nameOf(first)}|${nameOf(second)}`;
    let group = groups.get(key);
    if (!group) groups.set(key, group = make());
    return group;
  };

  // The device's clock, where it has one. One frame is timed at a time, and only a frame whose passes are all of
  // one kind: its first pass writes when it begins and its last when it ends, and the loads it spent over that
  // time are the rate by which the next frames' share of that kind is cut.
  const clock = opts.timed ? scoped('the bake clock', () => ({
    queries: device.createQuerySet({ type: 'timestamp', count: 2 }),
    resolved: device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
    read: device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
  })) : null;
  /** The frame being encoded is timed: the index of its last pass. */
  let timing: { readonly last: number } | null = null;
  /** A timed frame was encoded and its answer is not asked for yet: the loads it spent, and on which kind of pass. */
  let timed: { readonly loads: number; readonly kind: Kind } | null = null;
  /** An answer is on its way: the read buffer is in use. */
  let reading = false;
  /** Loads per millisecond of each kind of pass, as measured; 0: not measured yet. */
  const rates: Record<Kind, number> = { copy: 0, shadow: 0, occlusion: 0 };
  /** Without a clock: the loads a frame may spend, as the wall clock has set them; null: not measured yet, the budget given. */
  let wall: number | null = null;
  /** The frame last encoded, for the wall clock: whether it only refined, and how much of its share it used. */
  let last = { refined: false, share: 0, given: 0 };
  /** Frames that were submitted and whose end the GPU has not said yet. */
  let outstanding = 0;
  /** The loads of a kind a frame may spend: what its measured rate does in the target time, or the budget given. */
  const loadsFor = (kind: Kind, given: number): number => (rates[kind] > 0 ? Math.min(BAKE_LOADS_MAX, Math.max(BAKE_LOADS_MIN, rates[kind] * BAKE_TARGET_MS)) : wall ?? given);
  let lastBudget = 0;

  /** One full-target pass. `extent` is the square written, from the origin; `rows` narrows it to a band. */
  function draw(
    encoder: GPUCommandEncoder, pipeline: GPURenderPipeline, target: GPUTextureView, extent: number,
    first: GPUTextureView, second: GPUTextureView, values: readonly number[],
    more: { readonly clear?: boolean; readonly rows?: readonly [number, number]; readonly keep?: boolean } = {},
  ): void {
    const index = used++;
    const slot = index % UNIFORM_SLOTS;
    data.fill(0, (slot * stride) / 4, (slot * stride) / 4 + UNIFORM_FLOATS);
    data.set(values, (slot * stride) / 4);
    // The first pass of a timed frame writes when it begins, the last when it ends.
    const begins = timing !== null && index === 0, ends = timing !== null && index === timing.last;
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target, loadOp: more.clear ? 'clear' : 'load', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
      ...(clock && (begins || ends) ? { timestampWrites: { querySet: clock.queries, ...(begins ? { beginningOfPassWriteIndex: 0 } : {}), ...(ends ? { endOfPassWriteIndex: 1 } : {}) } } : {}),
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind(first, second, more.keep !== false), [slot * stride]);
    pass.setViewport(0, 0, extent, extent, 0, 1);
    if (more.rows) pass.setScissorRect(0, more.rows[0], extent, more.rows[1]);
    else pass.setScissorRect(0, 0, extent, extent);
    pass.draw(3);
    pass.end();
  }

  let dirtySource = true, dirtySun = false, dirtyRelief = false;
  let tasks: Task[] = [];
  /** How many of the first tasks the next step runs whatever they cost: what must be on screen with the change. */
  let immediate = 0;
  let shadowLevel = coarse, occlusionLevel = coarse;
  let occlusionFine = false;
  let destroyed = false;

  const sizeAt = (level: number): number => size >> level;

  function pyramidTasks(source: LightSource, seaLevel: number | null): Task[] {
    const out: Task[] = [{
      cost: size * size * 16,
      passes: 1,
      kind: 'copy',
      // The source's view is this frame's alone: its bind group is not kept (7.5 rule 2).
      run: (encoder) => draw(encoder, pipelines.base, pyramidLevels[0]!, size, source.view, source.view, [source.width - 1, source.height - 1, size, seaLevel ?? -1e30], { keep: false }),
    }];
    for (let level = 1; level < levels; level++) {
      out.push({ cost: sizeAt(level) ** 2 * 4, passes: 1, kind: 'copy', run: (encoder) => draw(encoder, pipelines.downHeight, pyramidLevels[level]!, sizeAt(level), pyramidLevels[level - 1]!, pyramidLevels[level - 1]!, []) });
    }
    return out;
  }

  function mipTasks(pipeline: GPURenderPipeline, views: readonly GPUTextureView[], from: number): Task[] {
    const out: Task[] = [];
    for (let level = from + 1; level < levels; level++) {
      out.push({ cost: sizeAt(level) ** 2 * 4, passes: 1, kind: 'copy', run: (encoder) => draw(encoder, pipeline, views[level]!, sizeAt(level), views[level - 1]!, views[level - 1]!, []) });
    }
    return out;
  }

  function shadowTasks(level: number, params: LightParams): Task[] {
    const n = sizeAt(level);
    const cell = params.terrainSize / n;
    const elevation = params.sunElevation * DEG, disc = SUN_DISC * DEG;
    const lo = Math.max(elevation - disc, 0), hi = Math.min(elevation + disc, 89.9 * DEG);
    const tangent = (angle: number): number => Math.min(Math.tan(Math.min(angle, 89.99 * DEG)), STEEPEST);
    const edge = (i: number): number => lo + ((hi - lo) * i) / STRIPS;
    // One step towards the sun is a whole texel along the axis the direction mostly runs along; along an axis the
    // other component is exactly 0, or the march would leave the terrain from its first column.
    const exact = (component: number): number => (Math.abs(component) < 1e-9 ? 0 : component);
    const toSun = [exact(Math.cos(params.sunAzimuth * DEG)), exact(Math.sin(params.sunAzimuth * DEG))] as const;
    const major = Math.max(Math.abs(toSun[0]), Math.abs(toSun[1]));
    const step = [toSun[0] / major, toSun[1] / major] as const;
    const run = cell / major;
    const passes = Math.max(1, Math.ceil(Math.log2(n)));
    const out: Task[] = [];
    for (let strip = 0; strip <= STRIPS; strip++) {
      const below = edge(strip);
      out.push({ cost: n * n, passes: 1, kind: 'shadow', run: (encoder) => draw(encoder, pipelines.start, stateViews[0]!, n, pyramidLevels[level]!, pyramidLevels[level]!, [0, 0, n, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, params.zScale, cell, 0]) });
      for (let k = 0; k < passes; k++) {
        const from = k % 2, to = 1 - from;
        out.push({
          cost: n * n * 3,
          passes: 1,
          kind: 'shadow',
          run: (encoder) => draw(encoder, pipelines.march, stateViews[to]!, n, stateViews[from]!, stateViews[from]!, [0, 0, n, 0, step[0], step[1], 2 ** k, run, run * tangent(below), 0, 0, 0, 0, params.zScale, cell, 0]),
        });
      }
      const result = stateViews[passes % 2]!;
      if (strip < STRIPS) {
        const above = edge(strip + 1);
        // The part of the disc below the horizontal is seen by nothing: the shares are of the whole disc.
        const weight = (above - below) / (2 * disc);
        out.push({
          cost: n * n * 2,
          passes: 1,
          kind: 'shadow',
          run: (encoder) => draw(encoder, pipelines.gather, shadowLevels[level]!, n, result, pyramidLevels[level]!, [0, 0, n, 0, 0, 0, 0, 0, 0, tangent(below), below, above, weight, params.zScale, cell, 0], { clear: strip === 0 }),
        });
      } else {
        out.push({ cost: n * n * 2, passes: 1, kind: 'shadow', run: (encoder) => draw(encoder, pipelines.hidden, shadowLevels[level]!, n, result, pyramidLevels[level]!, [0, 0, n, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, params.zScale, cell, 0]) });
      }
    }
    out.push(...mipTasks(pipelines.downLight, shadowLevels, level));
    out.push({ cost: 0, passes: 0, kind: 'shadow', run: () => { shadowLevel = level; } });
    return out;
  }

  function occlusionTasks(level: number, params: LightParams, budget: number): Task[] {
    const n = sizeAt(level);
    // The farthest ground that counts is the same share of the terrain on every level.
    const octaves = Math.max(1, Math.round(Math.log2(size)) - 4 - level);
    const perTexel = 4 * 2 * octaves * 4 + 1;
    const rows = level === coarse ? n : Math.max(8, Math.min(n, Math.floor(budget / 1.5 / (n * perTexel))));
    const out: Task[] = [];
    for (let y = 0; y < n; y += rows) {
      const height = Math.min(rows, n - y);
      out.push({
        cost: n * height * perTexel,
        passes: 1,
        kind: 'occlusion',
        run: (encoder) => draw(encoder, pipelines.occlusion, occlusionLevels[level]!, n, pyramid, pyramid, [0, 0, n, level, 0, 0, 0, 0, 0, 0, 0, 0, 0, params.zScale, params.terrainSize / n, octaves], { rows: [y, height] }),
      });
    }
    out.push(...mipTasks(pipelines.downLight, occlusionLevels, level));
    out.push({ cost: 0, passes: 0, kind: 'occlusion', run: () => { occlusionLevel = level; if (level === 0) occlusionFine = true; } });
    return out;
  }

  return {
    size, levels, bytes, pyramid, shadow, occlusion,
    get shadowLevel() { return shadowLevel; },
    get occlusionLevel() { return occlusionLevel; },
    get pending() { return dirtySource || dirtySun || dirtyRelief || tasks.length > 0; },
    invalidateSource() { dirtySource = true; },
    invalidateSun() { dirtySun = true; },
    invalidateRelief() { dirtyRelief = true; },

    get loadsPerFrame() { return lastBudget; },

    step(encoder, source, params, given) {
      if (destroyed) return false;
      const strip = loadsFor('occlusion', given);
      lastBudget = strip;
      if (dirtySource || dirtyRelief) {
        const head = dirtySource ? pyramidTasks(source, params.seaLevel) : [];
        const now = [...head, ...shadowTasks(coarse, params), ...occlusionTasks(coarse, params, strip)];
        occlusionFine = coarse === 0;
        tasks = coarse === 0 ? now : [...now, ...shadowTasks(0, params), ...occlusionTasks(0, params, strip)];
        immediate = now.length;
      } else if (dirtySun) {
        const now = shadowTasks(coarse, params);
        tasks = coarse === 0 ? now : [...now, ...shadowTasks(0, params), ...(occlusionFine ? [] : occlusionTasks(0, params, strip))];
        immediate = now.length;
      }
      dirtySource = dirtySun = dirtyRelief = false;
      // What this frame does: what must be on screen with the change, then as much of the rest as a frame's share
      // holds, and one task at the least. A task counts as the part of its kind's share that it takes. Bounded by
      // the slots of one frame: what is left waits for the next.
      const batch: Task[] = [];
      const share = (task: Task): number => task.cost / loadsFor(task.kind, given);
      let spent = 0, loads = 0, passes = 0;
      let kind: Kind | null = null, mixed = false;
      while (tasks.length > 0 && passes < UNIFORM_SLOTS - 1 && (batch.length < immediate || spent + share(tasks[0]!) <= 1 || (spent === 0 && batch.length >= immediate))) {
        const task = tasks.shift()!;
        if (batch.length >= immediate) spent += share(task);
        if (task.passes > 0) {
          loads += task.cost;
          passes += task.passes;
          mixed = mixed || (kind !== null && kind !== task.kind);
          kind = task.kind;
        }
        batch.push(task);
      }
      // A frame that had to show a change ran what the change needed, whatever it cost: it says nothing of a share.
      last = { refined: immediate === 0 && passes > 0, share: spent, given };
      immediate = Math.max(0, immediate - batch.length);
      used = 0;
      timing = clock && !reading && timed === null && kind !== null && !mixed ? { last: passes - 1 } : null;
      for (const task of batch) task.run(encoder);
      if (timing && clock && kind !== null) {
        encoder.resolveQuerySet(clock.queries, 0, 2, clock.resolved, 0);
        encoder.copyBufferToBuffer(clock.resolved, 0, clock.read, 0, 16);
        timed = { loads, kind };
      }
      timing = null;
      if (used > 0) device.queue.writeBuffer(uniforms, 0, data, 0, (Math.min(used, UNIFORM_SLOTS) * stride) / 4);
      return tasks.length > 0;
    },

    collect() {
      if (!clock && !destroyed) {
        // No clock on the device: the wall clock, from here, where the frame has just been submitted, to the GPU's
        // end of it. Every frame is watched, and one sets the share that did nothing but refine and was submitted
        // when no frame before it was still being drawn: the time of any other is not its own. The renderer asks
        // for the next frame of refinement when this one's end is known, so that is nearly every one.
        const { refined, share, given } = last;
        const alone = outstanding === 0;
        const began = performance.now();
        outstanding++;
        device.queue.onSubmittedWorkDone().then(() => {
          outstanding--;
          if (alone && refined && !destroyed) wall = nextBakeLoads(wall ?? given, performance.now() - began, share >= 0.5);
        }, () => {
          outstanding--;
        });
      }
      if (!clock || timed === null || reading || destroyed) return;
      const { loads, kind } = timed;
      timed = null;
      reading = true;
      clock.read.mapAsync(GPUMapMode.READ).then(() => {
        reading = false;
        if (destroyed) return;
        const [began, ended] = new BigUint64Array(clock.read.getMappedRange().slice(0));
        clock.read.unmap();
        // Nanoseconds. A frame shorter than a step of the device's timer measures 0 (runtime.md 3.5): it says only
        // that it was short, and a short frame of few loads says nothing of the rate.
        const ms = Number(ended! - began!) / 1e6;
        if (!(ms >= 0) || ms > 10_000 || (ms < 0.2 && loads < BAKE_LOADS_MIN)) return;
        const measured = loads / Math.max(ms, 0.1);
        // Slower at once, faster by degrees: a frame that took too long must not be followed by another.
        rates[kind] = rates[kind] > 0 && measured > rates[kind] ? 0.7 * rates[kind] + 0.3 * measured : measured;
      }, () => {
        // The device went, or the lighting with it.
        reading = false;
      });
    },

    destroy(released) {
      if (destroyed) return;
      destroyed = true;
      tasks = [];
      // On a lost device nothing is called into, and its ledger went with it.
      if (!released) return;
      for (const t of [pyramidTexture, shadowTexture, occlusionTexture, ...states]) t.destroy();
      uniforms.destroy();
      if (clock) {
        clock.queries.destroy();
        clock.resolved.destroy();
        // A buffer whose mapping is pending is destroyed all the same: the mapping is refused, which is heard above.
        clock.read.destroy();
      }
      reservation.release();
    },
  };
}
