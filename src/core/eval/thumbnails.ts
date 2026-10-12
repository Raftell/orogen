import { defineKernel, type AnyKernel } from '../gpu/kernel.ts';
import { BudgetExceededError, type PoolTexture } from '../gpu/pool.ts';
import { guarded } from '../gpu/scopes.ts';
import type { StreamOwner } from '../gpu/stream.ts';
import type { ProjectSettings } from '../graph/doc.ts';
import type { PortRole } from '../graph/ports.ts';
import { deviceAlive, type EngineParts } from './parts.ts';
import { runKernel } from './service.ts';

export interface Thumbnail {
  readonly nodeId: string;
  readonly contentKey: string;           // 5.4
  readonly resolution: number;           // of the field it was made from
  readonly rgba: Uint8ClampedArray;      // 128 × 128 × 4, row-major, first row = row 0 of the field
}

/** Side of a thumbnail and of an atlas cell (runtime.md 5.12 rule 2). */
const SIZE = 128;
const ATLAS_SIZE = 2048;
const CELLS_PER_ROW = ATLAS_SIZE / SIZE;
const CELLS = CELLS_PER_ROW * CELLS_PER_ROW;
const ATLAS_BYTES = ATLAS_SIZE * ATLAS_SIZE * 4;
/** One row of the atlas in a texture-to-buffer copy: 8192 bytes, a multiple of 256. */
const ATLAS_ROW_BYTES = ATLAS_SIZE * 4;
/** The atlas is read back at most this often during an evaluation (rule 4). */
const READ_INTERVAL_MS = 250;
/** Node ids whose last thumbnail is remembered. Beyond it the oldest are forgotten, which costs one repeated thumbnail each. */
const REMEMBERED = 8192;

// Rule 2: texel (i, j) takes the source texel nearest to uv = (i, j) / 127. The written grid is 128 texels, so uvOf is that uv.
const NEAREST = /* wgsl */ `vec2i(round(uv * (vec2f(src_res()) - vec2f(1.0))))`;

const sampleField = defineKernel({
  name: 'core/thumbnail.sample#field',
  inputs: { src: { kind: 'field', size: 'any' } },
  outputs: { out: 'field' },
  cost: 1,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  let v = src_at(${NEAREST});
  if ((bitcast<u32>(v) & 0x7f800000u) == 0x7f800000u) { return 0.0; }
  return v;
}`,
});

// A colour is finished here: rgb clamped to 0..1 and encoded to sRGB.
const sampleColor = defineKernel({
  name: 'core/thumbnail.sample#color',
  inputs: { src: { kind: 'color', size: 'any' } },
  outputs: { out: 'color' },
  cost: 1,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> vec4f {
  let c = clamp(src_at(${NEAREST}).rgb, vec3f(0.0), vec3f(1.0));
  let encoded = select(1.055 * pow(c, vec3f(1.0 / 2.4)) - vec3f(0.055), c * 12.92, c <= vec3f(0.0031308));
  return vec4f(encoded, 1.0);
}`,
});

// Minimum and maximum of the 128 x 128 samples, for a 'data' field: one texel that reads them all.
const range = defineKernel({
  name: 'core/thumbnail.range',
  inputs: { src: { kind: 'field', size: 'any' } },
  outputs: { out: 'vec2' },
  cost: SIZE * SIZE,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> vec2f {
  var lo = 3.4028234e38;
  var hi = -3.4028234e38;
  for (var y = 0; y < ${SIZE}; y++) {
    for (var x = 0; x < ${SIZE}; x++) {
      let v = src_at(vec2i(x, y));
      lo = min(lo, v);
      hi = max(hi, v);
    }
  }
  return vec2f(lo, hi);
}`,
});

const MODE: Readonly<Record<PortRole, number>> = { height: 0, mask: 1, data: 2 };

// Rule 3, for a field. normalAt takes its cell from the size of the 128 x 128 samples and the Frame's
// terrainSize and heightRange: central differences in metres with a cell of terrainSize / 127. A height is
// shaded as the pictures of testing.md 2.7 are (src/cli/preview.ts): the wrapped term keeps a gradation on the
// slopes that face away from the light, where max(n·L, 0) is 0 above 45 degrees and a steep terrain has two tones.
const shade = defineKernel({
  name: 'core/thumbnail.shade',
  inputs: { src: 'field', bounds: { kind: 'vec2', default: 0 } },
  outputs: { out: 'color' },
  params: { mode: 'u32' },
  cost: 5,
  code: /* wgsl */ `
// Towards the light: normalize(-1, -1, sqrt(2)).
const LIGHT = vec3f(-0.5, -0.5, 0.70710678);

fn compute(px: vec2i, uv: vec2f) -> vec4f {
  var grey = 0.5;
  if (P.mode == 0u) {
    let wrapped = 0.5 + 0.5 * dot(normalAt(src, px), LIGHT);
    grey = 0.10 + 0.80 * wrapped * wrapped;
  } else if (P.mode == 1u) {
    grey = saturate(src_at(px));
  } else {
    let b = bounds_at(vec2i(0));
    if (b.y > b.x) { grey = saturate((src_at(px) - b.x) / (b.y - b.x)); }
  }
  return vec4f(grey, grey, grey, 1.0);
}`,
});

/** The kernels of this module, for createEngine to compile. */
export function thumbnailKernels(): readonly AnyKernel[] {
  return [sampleField, sampleColor, range, shade];
}

// The last pass: one triangle over the viewport of an atlas cell, which copies the shaded 128 x 128 scratch
// into rgba8unorm. The viewport places it, so the pass needs no uniform.
const BLIT_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
struct Corner {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};
@vertex fn vs(@builtin(vertex_index) i: u32) -> Corner {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return Corner(vec4f(p * 2.0 - vec2f(1.0), 0.0, 1.0), vec2f(p.x, 1.0 - p.y));
}
@fragment fn fs(c: Corner) -> @location(0) vec4f {
  let t = vec2i(clamp(floor(c.uv * ${SIZE}.0), vec2f(0.0), vec2f(${SIZE - 1}.0)));
  return vec4f(textureLoad(src, t, 0).rgb, 1.0);
}`;

/** The thumbnail service of runtime.md 5.12: the atlas, its readback and the record of what was last made per node id. */
export interface Thumbnails {
  /** Rule 1: true when a thumbnail of this content at this resolution would be better than the last one made for the node. */
  wanted(nodeId: string, contentKey: string, resolution: number): boolean;
  /** Shades outputs[0] into a cell of the atlas (rules 2 and 3). `role` is null for a color. Never throws for want of memory: a thumbnail is a by-product. */
  add(source: PoolTexture, info: {
    readonly nodeId: string; readonly contentKey: string; readonly resolution: number;
    readonly role: PortRole | null; readonly settings: ProjectSettings;
  }): void;
  /** Rule 4: reads the atlas back when `force` is set (the evaluation has ended), when 250 ms have passed, or when all cells are in use; delivers each thumbnail once. Never delays the caller. */
  poll(force: boolean): void;
  onThumbnail(listener: (t: Thumbnail) => void): () => void;
  /**
   * The budget shrank: an atlas that no longer fits beside what is reserved, working and pinned is given back,
   * after what it stages has been read back (rule 4). It is made again with the first thumbnail it fits for.
   * Called in the evaluations' turn, with no node running.
   */
  fit(): void;
  /** Compiles the pass that writes the atlas, on the device of the current parts. Rejects when it does not compile. */
  prepare(): Promise<void>;
  /** Resolves when every readback under way has delivered or failed. */
  idle(): Promise<void>;
  /** The device is lost: forgets the atlas and what was not yet read back, without calling into the device. */
  forget(): void;
  /** Destroys the atlas. Not called for a lost device. */
  dispose(): void;
}

interface Cell { readonly nodeId: string; readonly contentKey: string; readonly resolution: number }

interface DeviceState {
  readonly parts: EngineParts;
  readonly pipeline: GPURenderPipeline;
  readonly layout: GPUBindGroupLayout;
  readonly groups: WeakMap<GPUTextureView, GPUBindGroup>;
  atlas: { readonly texture: GPUTexture; readonly view: GPUTextureView; readonly reservation: { release(): void } } | null;
  /** The thumbnails in the atlas that are not yet read back, cell by cell, and the owner of their passes. */
  batch: { readonly owner: StreamOwner; readonly cells: Cell[] } | null;
}

export function createThumbnails(parts: () => EngineParts): Thumbnails {
  const listeners = new Set<(t: Thumbnail) => void>();
  /** Per node id, the content and resolution of the last thumbnail made, least recently made first. */
  const latest = new Map<string, Cell>();
  const reading = new Set<Promise<void>>();
  let state: DeviceState | null = null;
  let lastRead = -Infinity;

  function remember(cell: Cell): void {
    latest.delete(cell.nodeId);
    latest.set(cell.nodeId, cell);
    if (latest.size > REMEMBERED) latest.delete(latest.keys().next().value!);
  }

  /** A thumbnail that was made and not delivered is as if it had not been made. */
  function forgetCells(cells: readonly Cell[]): void {
    for (const cell of cells) {
      if (latest.get(cell.nodeId) === cell) latest.delete(cell.nodeId);
    }
  }

  function current(): DeviceState | null {
    return state && state.parts.device === parts().device && deviceAlive(state.parts) ? state : null;
  }

  /** The atlas, made on first use. null when it does not fit the budget beside what cannot be reclaimed: then there are no thumbnails. */
  function atlasOf(s: DeviceState): DeviceState['atlas'] {
    if (!s.atlas) {
      const memory = s.parts.pool.report();
      if (memory.reservedBytes + memory.workingBytes + memory.pinnedBytes + ATLAS_BYTES > memory.budgetBytes) return null;
      const device = s.parts.gpu.device;
      const made = guarded(device, () => {
        const texture = device.createTexture({
          label: 'orogen thumbnail atlas', size: [ATLAS_SIZE, ATLAS_SIZE], format: 'rgba8unorm',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
        return { texture, view: texture.createView() };
      });
      s.parts.stream.track(made.scopes);
      s.atlas = { ...made.value, reservation: s.parts.pool.reserve(ATLAS_BYTES, 'thumbnail atlas') };
    }
    return s.atlas;
  }

  function groupOf(s: DeviceState, view: GPUTextureView): GPUBindGroup {
    let group = s.groups.get(view);
    if (!group) {
      const device = s.parts.gpu.device;
      const made = guarded(device, () => device.createBindGroup({ label: 'orogen thumbnail', layout: s.layout, entries: [{ binding: 0, resource: view }] }));
      s.parts.stream.track(made.scopes);
      group = made.value;
      s.groups.set(view, group);
    }
    return group;
  }

  /** Reads the cells of the batch back and delivers them. The copy is encoded now; the rest happens behind the caller. */
  function flush(s: DeviceState): void {
    const batch = s.batch;
    if (!batch || batch.cells.length === 0) return;
    s.batch = null;
    lastRead = performance.now();
    const { stream, pool, gpu } = s.parts;
    const rows = Math.ceil(batch.cells.length / CELLS_PER_ROW) * SIZE;
    const bytes = rows * ATLAS_ROW_BYTES;
    let buffer: GPUBuffer;
    try {
      stream.use(batch.owner);
      const atlas = s.atlas!;
      const made = guarded(gpu.device, () => gpu.device.createBuffer({
        label: 'orogen thumbnail readback', size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      }));
      stream.track(made.scopes);
      buffer = made.value;
      stream.encode((encoder) => encoder.copyTextureToBuffer(
        { texture: atlas.texture }, { buffer, bytesPerRow: ATLAS_ROW_BYTES, rowsPerImage: rows }, [ATLAS_SIZE, rows, 1],
      ));
      stream.submit();
    } catch {
      batch.owner.close();
      forgetCells(batch.cells);
      return;
    }
    const reservation = pool.reserve(bytes, 'thumbnail readback');

    const deliver = async (): Promise<void> => {
      let mapped = false;
      try {
        await batch.owner.settle();
        await buffer.mapAsync(GPUMapMode.READ, 0, bytes);
        mapped = true;
        const data = new Uint8Array(buffer.getMappedRange(0, bytes));
        const made: Thumbnail[] = batch.cells.map((cell, index) => {
          const x = (index % CELLS_PER_ROW) * SIZE, y = Math.floor(index / CELLS_PER_ROW) * SIZE;
          const rgba = new Uint8ClampedArray(SIZE * SIZE * 4);
          for (let row = 0; row < SIZE; row++) {
            const from = (y + row) * ATLAS_ROW_BYTES + x * 4;
            rgba.set(data.subarray(from, from + SIZE * 4), row * SIZE * 4);
          }
          return { nodeId: cell.nodeId, contentKey: cell.contentKey, resolution: cell.resolution, rgba };
        });
        buffer.unmap();
        mapped = false;
        for (const thumbnail of made) {
          for (const listener of [...listeners]) {
            try {
              listener(thumbnail);
            } catch (thrown) {
              console.error('[orogen] a thumbnail listener threw', thrown);
            }
          }
        }
      } catch {
        // The device was lost, or a pass of the batch failed: these thumbnails are made again when asked for.
        forgetCells(batch.cells);
      } finally {
        batch.owner.close();
        reservation.release();
        if (deviceAlive(s.parts)) {
          if (mapped) buffer.unmap();
          buffer.destroy();
        }
      }
    };
    const done: Promise<void> = deliver().finally(() => { reading.delete(done); });
    reading.add(done);
  }

  return {
    wanted(nodeId, contentKey, resolution) {
      const last = latest.get(nodeId);
      return !last || last.contentKey !== contentKey || resolution > last.resolution;
    },

    add(source, info) {
      const s = current();
      if (!s) return;
      const { stream, pool } = s.parts;
      if (s.batch && s.batch.cells.length >= CELLS) flush(s);
      s.batch ??= { owner: stream.open({ nodeId: null, service: 'thumbnail', mode: 'preview' }), cells: [] };
      const batch = s.batch;
      stream.use(batch.owner);
      const atlas = atlasOf(s);
      if (!atlas) return;
      const held: PoolTexture[] = [];
      const scratch = (kind: 'field' | 'color' | 'vec2', side: number): PoolTexture => {
        const texture = pool.acquire(kind, side, side);
        held.push(texture);
        return texture;
      };
      try {
        const frame = { terrainSize: info.settings.terrainSize, heightRange: info.settings.heightRange };
        const shaded = scratch('color', SIZE);
        if (source.kind === 'color') {
          runKernel(s.parts, 'thumbnail', sampleColor, { in: { src: source }, out: { out: shaded } });
        } else {
          const samples = scratch('field', SIZE);
          runKernel(s.parts, 'thumbnail', sampleField, { in: { src: source }, out: { out: samples } });
          const role = info.role ?? 'height';
          let bounds: PoolTexture | null = null;
          if (role === 'data') {
            bounds = scratch('vec2', 1);
            runKernel(s.parts, 'thumbnail', range, { in: { src: samples }, out: { out: bounds } });
          }
          runKernel(s.parts, 'thumbnail', shade, { in: { src: samples, bounds }, out: { out: shaded }, params: { mode: MODE[role] }, ...frame });
        }
        const cell = batch.cells.length;
        const x = (cell % CELLS_PER_ROW) * SIZE, y = Math.floor(cell / CELLS_PER_ROW) * SIZE;
        const group = groupOf(s, shaded.view);
        stream.encode((encoder) => {
          const pass = encoder.beginRenderPass({ colorAttachments: [{ view: atlas.view, loadOp: 'load', storeOp: 'store' }] });
          pass.setPipeline(s.pipeline);
          pass.setBindGroup(0, group);
          pass.setViewport(x, y, SIZE, SIZE, 0, 1);
          pass.setScissorRect(x, y, SIZE, SIZE);
          pass.draw(3);
          pass.end();
        }, 0.01);
        const made: Cell = { nodeId: info.nodeId, contentKey: info.contentKey, resolution: info.resolution };
        batch.cells.push(made);
        remember(made);
      } catch (thrown) {
        if (!(thrown instanceof BudgetExceededError)) throw thrown;
      } finally {
        // The scratch goes back at once: in queue order its next user writes it after these passes have read it.
        for (const texture of held) pool.release(texture);
      }
    },

    poll(force) {
      const s = current();
      if (!s || !s.batch) return;
      if (force || s.batch.cells.length >= CELLS || performance.now() - lastRead >= READ_INTERVAL_MS) flush(s);
    },

    fit() {
      const s = current();
      if (!s?.atlas) return;
      const memory = s.parts.pool.report();
      // The rule the atlas was made by (atlasOf), with the atlas now among the reserved bytes.
      if (memory.reservedBytes + memory.workingBytes + memory.pinnedBytes <= memory.budgetBytes) return;
      // The copy of what is staged is submitted before the texture goes: in queue order it reads the atlas intact.
      flush(s);
      const atlas = s.atlas;
      s.atlas = null;
      s.parts.stream.submit();
      atlas.texture.destroy();
      atlas.reservation.release();
    },

    onThumbnail(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    async prepare() {
      const p = parts();
      const device = p.gpu.device;
      const made = guarded(device, () => {
        const module = device.createShaderModule({ label: 'orogen thumbnail', code: BLIT_WGSL });
        const layout = device.createBindGroupLayout({
          label: 'orogen thumbnail',
          entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: false } }],
        });
        const pipeline = device.createRenderPipelineAsync({
          label: 'orogen thumbnail',
          layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
          vertex: { module, entryPoint: 'vs' },
          fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
          primitive: { topology: 'triangle-list' },
        });
        // Observed here so that a rejection is never unhandled while the scopes are awaited.
        return { layout, pipeline: pipeline.then((value) => ({ value, error: null }), (error: unknown) => ({ value: null, error })) };
      });
      const [pipeline, ...scopes] = await Promise.all([made.value.pipeline, made.scopes.outOfMemory, made.scopes.validation]);
      const failure = scopes.find((e) => e !== null);
      if (pipeline.value === null || failure) {
        const reason = pipeline.error instanceof Error ? pipeline.error.message : failure ? failure.message : String(pipeline.error);
        throw new Error(`The thumbnail pass does not compile: ${reason.split('\n')[0]}`);
      }
      state = { parts: p, pipeline: pipeline.value, layout: made.value.layout, groups: new WeakMap(), atlas: null, batch: null };
    },

    async idle() {
      while (reading.size > 0) await Promise.all([...reading]);
    },

    forget() {
      if (state?.batch) forgetCells(state.batch.cells);
      state = null;
    },

    dispose() {
      const s = state;
      state = null;
      if (!s) return;
      if (s.batch) {
        s.batch.owner.close();
        forgetCells(s.batch.cells);
      }
      if (s.atlas && deviceAlive(s.parts)) {
        s.atlas.texture.destroy();
        s.atlas.reservation.release();
      }
    },
  };
}
