// The viewport renderer (runtime.md 7.5): it draws the shown terrain on the session's device, straight from the
// engine's textures, and implements the ViewportRenderer the session drives.
//
// A frame is drawn only when something changed (rule 6), from the worker's animation frame or, 250 ms later at
// the latest, from a timer (7.8 rule 6). The first frame is confirmed before the window is trusted to present
// (rule 9). Everything derived from the content lives in textures of the renderer's own (rule 4): the light maps
// of lighting.ts, the grids of minima and maxima, the lit picture before tone mapping. How much of that there is
// follows the adapter (lightCapFor, multisampleLimitFor, pixelLimitFor; rule 13). A content the session steps
// back to is not drawn at once (rule 2, setContent below). From near, the picture is of a smooth surface through
// the field, which the pointer does not read (rule 12).

import type {
  CameraState, GpuCaps, GpuContext, PickResult, TextureRef, ViewportContent, ViewportDisplay, ViewportRenderer, ViewportSize,
} from '../core/runtime.ts';
import { exposureFor, skyLight, whiteBalance, type SkyLight } from './atmosphere.ts';
import { DEG, frustumPlanes, pixelRay, viewOf, type View } from './camera.ts';
import { DEFAULT_DISPLAY, PALETTE_SIZE, paletteTexels, resolveDisplay, type ResolvedDisplay } from './display.ts';
import { BAKE_LOADS_PER_FRAME, createBakePipelines, createLighting, lightSize, type BakePipelines, type Lighting } from './lighting.ts';
import {
  buildBounds, createSelection, gridRange, INSTANCE_FLOATS, levelZeroRange, lodSetup, MAX_INSTANCES, patchMesh, selectPatches, slabDistance, SUB_LEVELS,
  UNKNOWN_BOUNDS, type HeightBounds, type LodSetup, type MinMaxGrid,
} from './lod.ts';
import { BACKGROUND, FRAME, FRAME_FLOATS, PICK_WGSL, POST_WGSL, REDUCE_WGSL, SCENE_WGSL, SKY_FLOATS, SKY_MAP_WGSL, TOP_WGSL } from './shaders.ts';

export interface RendererOptions {
  /** The format of the canvas; default what the platform prefers. */
  readonly canvasFormat?: GPUTextureFormat;
  /** How wide a quad of the mesh is on screen, in pixels of the canvas. Default 2.5. */
  readonly quadPixels?: number;
  /** The widest grid of the light maps, a power of two. Default: by the adapter's memory (`lightCapFor`). */
  readonly lightSize?: number;
  /** The most pixels the canvas is given. Default: by the adapter's memory (`pixelLimitFor`). */
  readonly pixelLimit?: number;
  /** How long the picture is kept when the session steps back to an earlier content (`setContent`), in milliseconds. Default 400. */
  readonly holdMs?: number;
  /** Whether the passes that bake the light maps are timed, and their share of a frame set by that. Default: where the device has timestamp-query. */
  readonly timeBakes?: boolean;
  /**
   * False: the picture is of the field's bilinear patches at every distance, with no vertex between the texels.
   * Default true: from near, a smooth surface through the same field (shaders.ts, `shownHeight`).
   */
  readonly smooth?: boolean;
}

/** A card with this much memory is a large one: 8 GB and more, as its largest heap reports it. */
const LARGE_VRAM = 7.5 * 2 ** 30;
/** And one that reports less than this a tiny one: 3 GB and less. */
const TINY_VRAM = 3.5 * 2 ** 30;

/** What the renderer holds of an adapter's memory, in three sizes; an adapter that does not say how much it has is a small one. */
function cardOf(caps: Pick<GpuCaps, 'vramBytes' | 'software'>): 'software' | 'tiny' | 'small' | 'large' {
  if (caps.software) return 'software';
  const bytes = caps.vramBytes;
  if (bytes === null || !(bytes > 0)) return 'small';
  return bytes >= LARGE_VRAM ? 'large' : bytes < TINY_VRAM ? 'tiny' : 'small';
}

/**
 * The widest grid of the light maps for an adapter, a power of two. At 4096 the maps and the state of their march
 * hold 384 MiB, a 16th of what a 10 GB card's budget is; at 2048, 96 MiB; at 1024, 24 MiB. An adapter that does
 * not say how much memory it has is taken for a small one, and a CPU rasteriser bakes a grid it can bake in a frame.
 */
export function lightCapFor(caps: Pick<GpuCaps, 'vramBytes' | 'software'>): number {
  return { software: 512, tiny: 1024, small: 2048, large: 4096 }[cardOf(caps)];
}

/** Above this many pixels the lit picture is drawn without multisampling: its samples alone are 48 bytes a pixel. */
export function multisampleLimitFor(caps: Pick<GpuCaps, 'vramBytes' | 'software'>): number {
  return { software: 0, tiny: 2_400_000, small: 4_500_000, large: 9_000_000 }[cardOf(caps)];
}

/**
 * The most pixels the picture is drawn with: a panel that asks for more (a screen of 8K, a device pixel ratio of
 * 3) gets a canvas of this many, of its own shape, which the page stretches. Everything the renderer holds by
 * the pixel is so bounded by the adapter: 240 MiB on a small card (4.5 million pixels with their samples, 56
 * bytes each, or these 8.3 million at 12), 481 MiB on a large one, 24 MiB on a CPU rasteriser.
 */
export function pixelLimitFor(caps: Pick<GpuCaps, 'vramBytes' | 'software'>): number {
  return { software: 1920 * 1080, tiny: 2560 * 1440, small: 3840 * 2160, large: 5120 * 2880 }[cardOf(caps)];
}

/** The canvas for a panel of `width` × `height` CSS pixels at a device pixel ratio: its backing size, each side within `side` and the whole within `pixels`. */
export function backingSize(width: number, height: number, dpr: number, side: number, pixels: number): readonly [number, number] {
  const css = (length: number): number => (Number.isFinite(length) && length > 1 ? length : 1);
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  let w = css(width) * ratio, h = css(height) * ratio;
  const shrink = Math.min(1, side / w, side / h, Math.sqrt(pixels / (w * h)));
  w *= shrink;
  h *= shrink;
  return [Math.min(side, Math.max(1, Math.round(w))), Math.min(side, Math.max(1, Math.round(h)))];
}

/** What a test or a measurement reads of a renderer. */
export interface RendererState {
  readonly frames: number;
  /** Triangles of the terrain mesh in the last frame. */
  readonly triangles: number;
  readonly patches: number;
  /** Bytes registered with the ledger now. */
  readonly reservedBytes: number;
  readonly lightSize: number;
  /** The lowest and highest normalised height of the shown field; null until it is known. */
  readonly heightRange: readonly [number, number] | null;
  /** The range a data overlay is drawn with. */
  readonly overlayRange: readonly [number, number];
  /** True when the device was lost with the first frame, and nothing is drawn any more (7.5 rule 9). */
  readonly blocked: boolean;
  /** Texture loads a frame may spend on refining the light maps of what is shown; 0 before a frame has drawn it. */
  readonly bakeLoads: number;
  /** The canvas's backing size, in pixels; [0, 0] without a canvas. */
  readonly canvas: readonly [number, number];
}

export interface Viewport extends ViewportRenderer {
  readonly state: RendererState;
  /** Resolves when no frame is due and the light maps are complete: the picture is the final one. */
  whenIdle(): Promise<void>;
}

/** A requested frame is drawn after this long at the latest (7.8 rule 6). */
const FRAME_BACKSTOP_MS = 250;
/** How long the picture is kept when the session steps back to a content it showed before, or to none (`setContent`). */
const HOLD_MS = 400;
/**
 * A CPU rasteriser bakes a grid this wide in the frame of a change. What it refines after that is not cut into
 * smaller shares than a GPU's: every frame of it draws the whole picture again, which is what costs it most.
 */
const SOFTWARE_COARSE = 128;
const SKY_WIDTH = 256, SKY_HEIGHT = 128;
/** The slab the terrain stands on, below its lowest point, as a share of its width. */
const SLAB = 0.035;
const PICK_STEPS = 200_000;

/**
 * What the renderer uses of a canvas and of its surroundings, named here so that this file reads the same under
 * a worker's types and under Node's, where the tests run it with a texture for a canvas.
 */
interface Surface { width: number; height: number; getContext(kind: 'webgpu'): GPUCanvasContext | null }
const surfaceOf = (canvas: OffscreenCanvas): Surface => canvas as unknown as Surface;
const globals = globalThis as { readonly requestAnimationFrame?: (callback: () => void) => unknown; readonly navigator?: { readonly gpu?: GPU } };

type Reservation = { release(): void };
type Ledger = { reserve(bytes: number, label: string): Reservation };

function report(what: string): (error: GPUError | null) => void {
  return (error) => {
    if (error) console.error(`[orogen] viewport: ${what}: ${error.message}`);
  };
}

/** One synchronous pair of error scopes around `work` (runtime.md 5.8, error scopes rule 2). */
function scopedOn<T>(device: GPUDevice, what: string, work: () => T): T {
  device.pushErrorScope('validation');
  device.pushErrorScope('out-of-memory');
  try {
    return work();
  } finally {
    // A lost device answers nothing useful, and nothing is to be reported for it.
    device.popErrorScope().then(report(what), () => {});
    device.popErrorScope().then(report(what), () => {});
  }
}

interface ScenePipelines { readonly sky: GPURenderPipeline; readonly terrain: GPURenderPipeline; readonly wall: GPURenderPipeline; readonly sea: GPURenderPipeline }
interface Pipelines {
  readonly scene: Readonly<Record<1 | 4, ScenePipelines>>;
  readonly top: GPURenderPipeline;
  readonly post: GPURenderPipeline;
  readonly skyMap: GPURenderPipeline;
  readonly reduce: GPUComputePipeline;
  readonly pick: GPUComputePipeline;
  readonly bake: BakePipelines;
}

/** The lowest and highest values of one field, on the GPU and back (two passes of 8 × 8 and a readback of the small grid). */
interface Reducer {
  /** Encodes the reduction of `source` when one is asked for and none is on its way. */
  encode(encoder: GPUCommandEncoder, source: TextureRef): void;
  /** After the frame's submission: asks for the result. */
  collect(): void;
  request(): void;
  readonly bytes: number;
  destroy(released: boolean): void;
}

/** Everything that lives on one device. Replaced as a whole when the device is. */
interface DeviceState {
  readonly gpu: GpuContext;
  readonly device: GPUDevice;
  readonly ledger: Ledger;
  pipelines: Pipelines | null;
  readonly frameLayout: GPUBindGroupLayout;
  readonly postLayout: GPUBindGroupLayout;
  readonly reduceLayout: GPUBindGroupLayout;
  readonly pickLayout: GPUBindGroupLayout;
  readonly frameUniforms: GPUBuffer;
  readonly postUniforms: GPUBuffer;
  readonly skyUniforms: GPUBuffer;
  readonly pickUniforms: GPUBuffer;
  readonly pickResult: GPUBuffer;
  readonly patchVertices: GPUBuffer;
  readonly fullIndices: GPUBuffer;
  readonly halfIndices: GPUBuffer;
  readonly fullInstances: GPUBuffer;
  readonly halfInstances: GPUBuffer;
  readonly fullIndexCount: number;
  readonly halfIndexCount: number;
  readonly skyTexture: GPUTexture;
  readonly skyView: GPUTextureView;
  readonly paletteTexture: GPUTexture;
  readonly paletteView: GPUTextureView;
  readonly zeroField: GPUTextureView;
  readonly whiteLight: GPUTextureView;
  readonly lightSampler: GPUSampler;
  readonly skySampler: GPUSampler;
  readonly lightings: Map<number, Lighting>;
  targets: { readonly width: number; readonly height: number; readonly samples: 1 | 4; readonly color: GPUTextureView; readonly resolve: GPUTextureView; readonly depth: GPUTextureView;
    readonly textures: GPUTexture[]; readonly reservation: Reservation; readonly bytes: number; readonly postGroup: GPUBindGroup } | null;
  heightReducer: Reducer | null;
  overlayReducer: Reducer | null;
  readonly fixed: Reservation;
  readonly fixedBytes: number;
  /** The elevation the sky map holds; NaN: none. */
  skyElevation: number;
  paletteName: string;
}

function defaultCamera(content: ViewportContent, display: ResolvedDisplay): CameraState {
  const size = content.terrainSize;
  return { kind: 'orbit', target: [size / 2, size / 2, 0.3 * content.heightRange * display.verticalScale], yaw: 300, pitch: 32, distance: 1.75 * size, fovY: 35 };
}

export function createViewportRenderer(options: RendererOptions = {}): Viewport {
  const quadPixels = options.quadPixels ?? 2.5;
  const smooth = options.smooth !== false;
  /** The mesh of a field: with vertices between the texels where the picture is smooth. */
  const meshOf = (resolution: number): LodSetup => lodSetup(resolution, smooth ? SUB_LEVELS : 0);
  const holdMs = options.holdMs ?? HOLD_MS;
  const lightCapOf = (gpu: GpuContext): number => options.lightSize ?? lightCapFor(gpu.caps);
  const canvasFormat = (): GPUTextureFormat => options.canvasFormat ?? globals.navigator?.gpu?.getPreferredCanvasFormat() ?? 'bgra8unorm';

  let dev: DeviceState | null = null;
  let canvas: Surface | null = null;
  let context: GPUCanvasContext | null = null;
  let size: ViewportSize = { width: 1, height: 1, dpr: 1 };
  let content: ViewportContent | null = null;
  let camera: CameraState | null = null;
  let display: ResolvedDisplay = DEFAULT_DISPLAY;
  let scheduled = false;
  let disposed = false;
  // What follows the content: set when it changes, used up by the frame that draws it.
  let heightChanged = false;
  let overlayChanged = false;
  /** Counts the contents; what comes back from the GPU for an earlier one is dropped. */
  let generation = 0;
  let setup: LodSetup = lodSetup(2, 0);
  let bounds: HeightBounds | null = null;
  /** Whether `bounds` is of the field as it is now. One of its last state says where the heights lie, and not node by node. */
  let boundsExact = false;
  /** Answers of the GPU that are still to come and will ask for a frame. */
  let awaiting = 0;
  let overlayRange: readonly [number, number] = [0, 1];
  const selection = createSelection();
  const frameData = new Float32Array(FRAME_FLOATS);
  let light: { readonly elevation: number; readonly value: SkyLight; readonly exposure: number; readonly gain: Float32Array<ArrayBuffer> } | null = null;
  let frames = 0;
  let triangles = 0;
  let pending = false;
  const afterFrame: (() => void)[] = [];
  const idleWaiters: (() => void)[] = [];
  // A step back (setContent): the contents that were given, and the timer of the picture that is kept meanwhile.
  const given = new WeakSet<ViewportContent>();
  let hold: ReturnType<typeof setTimeout> | null = null;
  function endHold(): void {
    if (hold === null) return;
    clearTimeout(hold);
    hold = null;
  }

  // Whether this window can present at all (7.5 rule 9). Measured under a virtual display: the first frame of a
  // WebGPU canvas costs the device. A device that is lost before any frame was confirmed is taken for that, and
  // nothing is drawn any more: drawing again would lose every device recovery opens.
  let tried = false;
  let confirmed = false;
  let probing = false;
  let blocked = false;

  /**
   * Confirms that the device outlived the frame just submitted. Mapping is the one call a lost device refuses
   * (5.9), and the GPU process answers in the order asked, so a mapping asked for after the frame and granted
   * says that the frame did no harm.
   */
  function confirm(device: GPUDevice): void {
    if (confirmed || probing) return;
    probing = true;
    const probe = scopedOn(device, 'the probe buffer', () => device.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }));
    probe.mapAsync(GPUMapMode.READ).then(() => {
      confirmed = true;
      probing = false;
      probe.destroy();
    }, () => {
      probing = false;
    });
  }

  // ---- the device's own resources ------------------------------------------------------------------------------------

  function createDeviceState(gpu: GpuContext, ledger: Ledger): DeviceState {
    const device = gpu.device;
    const make = <T>(what: string, work: () => T): T => scopedOn(device, what, work);
    const field: GPUTextureBindingLayout = { sampleType: 'unfilterable-float' };
    const both = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const frameLayout = make('the frame layout', () => device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: both, buffer: { type: 'uniform' } },
        { binding: 1, visibility: both, texture: field },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: field },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: field },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 8, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 9, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    }));
    const postLayout = make('the post layout', () => device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: field },
      ],
    }));
    const reduceLayout = make('the reduce layout', () => device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: field },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rg32float' } },
      ],
    }));
    const pickLayout = make('the pick layout', () => device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: field },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    }));

    const mesh = patchMesh();
    let fixedBytes = 0;
    const buffer = (what: string, bytes: number, usage: number, data?: Float32Array | Uint32Array): GPUBuffer => {
      const made = make(what, () => device.createBuffer({ label: `viewport ${what}`, size: bytes, usage: usage | GPUBufferUsage.COPY_DST }));
      if (data) device.queue.writeBuffer(made, 0, data);
      fixedBytes += bytes;
      return made;
    };
    const instanceBytes = MAX_INSTANCES * INSTANCE_FLOATS * 4;
    const patchVertices = buffer('patch vertices', mesh.vertices.byteLength, GPUBufferUsage.VERTEX, mesh.vertices);
    const fullIndices = buffer('patch indices', mesh.full.byteLength, GPUBufferUsage.INDEX, mesh.full);
    const halfIndices = buffer('quarter indices', mesh.half.byteLength, GPUBufferUsage.INDEX, mesh.half);
    const fullInstances = buffer('patch instances', instanceBytes, GPUBufferUsage.VERTEX);
    const halfInstances = buffer('quarter instances', instanceBytes, GPUBufferUsage.VERTEX);
    const frameUniforms = buffer('frame uniforms', FRAME_FLOATS * 4, GPUBufferUsage.UNIFORM);
    const postUniforms = buffer('post uniforms', 16, GPUBufferUsage.UNIFORM);
    const skyUniforms = buffer('sky uniforms', SKY_FLOATS * 4, GPUBufferUsage.UNIFORM);
    const pickUniforms = buffer('pick uniforms', 64, GPUBufferUsage.UNIFORM);
    const pickResult = buffer('pick result', 32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);

    const small = (what: string, format: GPUTextureFormat, width: number, height: number, bytesPerTexel: number, usage: number): GPUTexture => {
      fixedBytes += width * height * bytesPerTexel;
      return make(what, () => device.createTexture({ label: `viewport ${what}`, size: [width, height], format, usage: usage | GPUTextureUsage.TEXTURE_BINDING }));
    };
    const skyTexture = small('sky map', 'rgba16float', SKY_WIDTH, SKY_HEIGHT, 8, GPUTextureUsage.RENDER_ATTACHMENT);
    const paletteTexture = small('palette', 'rgba8unorm-srgb', PALETTE_SIZE, 1, 4, GPUTextureUsage.COPY_DST);
    const zero = small('flat ground', 'r32float', 1, 1, 4, GPUTextureUsage.COPY_DST);
    const white = small('full light', 'r8unorm', 1, 1, 1, GPUTextureUsage.COPY_DST);
    device.queue.writeTexture({ texture: zero }, new Float32Array([0]), {}, [1, 1]);
    device.queue.writeTexture({ texture: white }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);

    const lightSampler = make('the light sampler', () => device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' }));
    const skySampler = make('the sky sampler', () => device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'clamp-to-edge' }));

    return {
      gpu, device, ledger, pipelines: null, frameLayout, postLayout, reduceLayout, pickLayout,
      frameUniforms, postUniforms, skyUniforms, pickUniforms, pickResult,
      patchVertices, fullIndices, halfIndices, fullInstances, halfInstances, fullIndexCount: mesh.full.length, halfIndexCount: mesh.half.length,
      skyTexture, skyView: skyTexture.createView(), paletteTexture, paletteView: paletteTexture.createView(),
      zeroField: zero.createView(), whiteLight: white.createView(), lightSampler, skySampler,
      lightings: new Map(), targets: null, heightReducer: null, overlayReducer: null,
      fixed: ledger.reserve(fixedBytes, 'viewport buffers'), fixedBytes, skyElevation: NaN, paletteName: '',
    };
  }

  async function createPipelines(d: DeviceState): Promise<Pipelines> {
    const { device } = d;
    const frame = device.createPipelineLayout({ bindGroupLayouts: [d.frameLayout] });
    const sceneModule = device.createShaderModule({ code: SCENE_WGSL });
    const topModule = device.createShaderModule({ code: TOP_WGSL });
    const postModule = device.createShaderModule({ code: POST_WGSL });
    const skyModule = device.createShaderModule({ code: SKY_MAP_WGSL });
    const lit: GPUTextureFormat = 'rgba16float';
    const depth = (write: boolean, compare: GPUCompareFunction): GPUDepthStencilState => ({ format: 'depth32float', depthWriteEnabled: write, depthCompare: compare });
    const scene = (samples: 1 | 4): Promise<ScenePipelines> => {
      const multisample: GPUMultisampleState = { count: samples };
      return Promise.all([
        device.createRenderPipelineAsync({
          layout: frame, multisample, depthStencil: depth(false, 'always'),
          vertex: { module: sceneModule, entryPoint: 'vsSky' }, fragment: { module: sceneModule, entryPoint: 'fsSky', targets: [{ format: lit }] },
        }),
        device.createRenderPipelineAsync({
          layout: frame, multisample, depthStencil: depth(true, 'greater'), primitive: { topology: 'triangle-list', cullMode: 'none' },
          vertex: {
            module: sceneModule, entryPoint: 'vsTerrain',
            buffers: [
              { arrayStride: 8, stepMode: 'vertex', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
              { arrayStride: INSTANCE_FLOATS * 4, stepMode: 'instance', attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x4' }] },
            ],
          },
          fragment: { module: sceneModule, entryPoint: 'fsTerrain', targets: [{ format: lit }] },
        }),
        device.createRenderPipelineAsync({
          layout: frame, multisample, depthStencil: depth(true, 'greater'),
          vertex: { module: sceneModule, entryPoint: 'vsWall' }, fragment: { module: sceneModule, entryPoint: samples === 4 ? 'fsWallSamples' : 'fsWall', targets: [{ format: lit }] },
        }),
        device.createRenderPipelineAsync({
          layout: frame, multisample, depthStencil: depth(false, 'greater'),
          vertex: { module: sceneModule, entryPoint: 'vsSea' },
          fragment: {
            module: sceneModule, entryPoint: 'fsSea',
            targets: [{ format: lit, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }],
          },
        }),
      ]).then(([sky, terrain, wall, sea]) => ({ sky, terrain, wall, sea }));
    };
    const [one, four, top, post, skyMap, reduce, pick, bake] = await Promise.all([
      scene(1), scene(4),
      device.createRenderPipelineAsync({
        layout: frame, vertex: { module: topModule, entryPoint: 'vsTop' }, fragment: { module: topModule, entryPoint: 'fsTop', targets: [{ format: canvasFormat() }] },
      }),
      device.createRenderPipelineAsync({
        layout: device.createPipelineLayout({ bindGroupLayouts: [d.postLayout] }),
        vertex: { module: postModule, entryPoint: 'vsPost' }, fragment: { module: postModule, entryPoint: 'fsPost', targets: [{ format: canvasFormat() }] },
      }),
      device.createRenderPipelineAsync({
        layout: 'auto', vertex: { module: skyModule, entryPoint: 'vsMap' }, fragment: { module: skyModule, entryPoint: 'fsMap', targets: [{ format: 'rgba16float' }] },
      }),
      device.createComputePipelineAsync({
        layout: device.createPipelineLayout({ bindGroupLayouts: [d.reduceLayout] }), compute: { module: device.createShaderModule({ code: REDUCE_WGSL }), entryPoint: 'reduce' },
      }),
      device.createComputePipelineAsync({
        layout: device.createPipelineLayout({ bindGroupLayouts: [d.pickLayout] }), compute: { module: device.createShaderModule({ code: PICK_WGSL }), entryPoint: 'pick' },
      }),
      createBakePipelines(device, (what, work) => scopedOn(device, what, work)),
    ]);
    return { scene: { 1: one, 4: four }, top, post, skyMap, reduce, pick, bake };
  }

  function createReducer(d: DeviceState, width: number, height: number, isHeight: boolean, onGrid: (grid: MinMaxGrid, generation: number) => void): Reducer {
    const { device } = d;
    const w1 = Math.ceil(width / 8), h1 = Math.ceil(height / 8), w2 = Math.ceil(w1 / 8), h2 = Math.ceil(h1 / 8);
    const target = (w: number, h: number): GPUTexture => scopedOn(device, 'a range grid', () => device.createTexture({
      label: 'viewport range grid', size: [w, h], format: 'rg32float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    }));
    const first = target(w1, h1), second = target(w2, h2);
    const firstView = first.createView(), secondView = second.createView();
    const bytesPerRow = Math.ceil((w2 * 8) / 256) * 256;
    const readback = scopedOn(device, 'the range readback', () => device.createBuffer({ size: bytesPerRow * h2, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }));
    const uniforms = [0, 1].map(() => scopedOn(device, 'the range uniforms', () => device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })));
    device.queue.writeBuffer(uniforms[0]!, 0, new Int32Array([width - 1, height - 1, 1, 0]));
    device.queue.writeBuffer(uniforms[1]!, 0, new Int32Array([w1 - 1, h1 - 1, 0, 0]));
    const bytes = (w1 * h1 + w2 * h2) * 8 + bytesPerRow * h2 + 32;
    const reservation = d.ledger.reserve(bytes, isHeight ? 'viewport height range' : 'viewport overlay range');
    const secondGroup = scopedOn(device, 'a range bind group', () => device.createBindGroup({
      layout: d.reduceLayout, entries: [{ binding: 0, resource: { buffer: uniforms[1]! } }, { binding: 1, resource: firstView }, { binding: 2, resource: secondView }],
    }));
    let wanted = false, busy = false, encoded = false, destroyed = false;
    let of = 0;
    return {
      bytes,
      request() { wanted = true; },
      encode(encoder, source) {
        if (!wanted || busy || destroyed || !d.pipelines) return;
        wanted = false;
        busy = true;
        encoded = true;
        of = generation;
        // The source's view is this frame's alone (7.5 rule 2).
        const group = scopedOn(device, 'a range bind group', () => device.createBindGroup({
          layout: d.reduceLayout, entries: [{ binding: 0, resource: { buffer: uniforms[0]! } }, { binding: 1, resource: source.view }, { binding: 2, resource: firstView }],
        }));
        const pass = encoder.beginComputePass();
        pass.setPipeline(d.pipelines.reduce);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(Math.ceil(w1 / 8), Math.ceil(h1 / 8));
        pass.setBindGroup(0, secondGroup);
        pass.dispatchWorkgroups(Math.ceil(w2 / 8), Math.ceil(h2 / 8));
        pass.end();
        encoder.copyTextureToBuffer({ texture: second }, { buffer: readback, bytesPerRow }, [w2, h2]);
      },
      collect() {
        if (!encoded) return;
        encoded = false;
        const from = of;
        awaiting++;
        // An answer for a device that is gone is counted with that device, which nobody waits for.
        const answered = (): void => { if (dev === d) awaiting--; };
        readback.mapAsync(GPUMapMode.READ).then(() => {
          answered();
          if (destroyed) { settle(); return; }
          const mapped = new Float32Array(readback.getMappedRange());
          const data = new Float32Array(w2 * h2 * 2);
          for (let y = 0; y < h2; y++) data.set(mapped.subarray((y * bytesPerRow) / 4, (y * bytesPerRow) / 4 + w2 * 2), y * w2 * 2);
          readback.unmap();
          busy = false;
          onGrid({ cellsX: w2, cellsY: h2, cellTexels: 64, data }, from);
          // One that was asked for meanwhile is made by the next frame.
          if (wanted) schedule();
          settle();
        }, () => {
          answered();
          busy = false;
          settle();
        });
      },
      destroy(released) {
        if (destroyed) return;
        destroyed = true;
        if (!released) return;
        for (const t of [first, second]) t.destroy();
        for (const b of [readback, ...uniforms]) b.destroy();
        reservation.release();
      },
    };
  }

  /** The reducer for a field of this size, made anew when the size is another. */
  function reducerFor(d: DeviceState, which: 'heightReducer' | 'overlayReducer', ref: TextureRef, sizes: { height: string; overlay: string }): Reducer {
    const key = `${ref.width}x${ref.height}`;
    const name = which === 'heightReducer' ? 'height' : 'overlay';
    if (d[which] && sizes[name] === key) return d[which]!;
    d[which]?.destroy(true);
    sizes[name] = key;
    const reducer = which === 'heightReducer'
      ? createReducer(d, ref.width, ref.height, true, (grid, from) => {
        const heights = content?.height;
        if (!heights || `${heights.width}x${heights.height}` !== reducerSizes.height) return;
        // Of the field as it was a moment ago, when it has changed since: its own grid is asked for already.
        bounds = buildBounds(meshOf(Math.max(heights.width, heights.height)), heights.width, heights.height, grid);
        boundsExact = from === generation;
        schedule();
      })
      : createReducer(d, ref.width, ref.height, false, (grid, from) => {
        if (content?.overlay?.as !== 'heat') return;
        overlayRange = gridRange(grid);
        schedule();
      });
    d[which] = reducer;
    return reducer;
  }
  const reducerSizes = { height: '', overlay: '' };

  function lightingFor(d: DeviceState, ref: TextureRef): Lighting {
    const wanted = lightSize(Math.max(ref.width, ref.height), lightCapOf(d.gpu));
    let lighting = d.lightings.get(wanted);
    if (lighting) {
      // Most recently used last.
      d.lightings.delete(wanted);
      d.lightings.set(wanted, lighting);
      return lighting;
    }
    // A preview and its draft levels alternate while a value is dragged: their grids are kept, and no third.
    while (d.lightings.size >= 2) {
      const [oldest, old] = d.lightings.entries().next().value!;
      old.destroy(true);
      d.lightings.delete(oldest);
    }
    lighting = createLighting({
      device: d.device, pipelines: d.pipelines!.bake, ledger: d.ledger, scoped: (what, work) => scopedOn(d.device, what, work),
      size: wanted, uniformAlignment: d.gpu.caps.limits.minUniformBufferOffsetAlignment,
      ...(d.gpu.caps.software ? { coarseSize: SOFTWARE_COARSE } : {}),
      timed: d.gpu.caps.timestampQuery && options.timeBakes !== false,
    });
    d.lightings.set(wanted, lighting);
    return lighting;
  }

  function targetsFor(d: DeviceState, width: number, height: number): NonNullable<DeviceState['targets']> {
    const samples: 1 | 4 = width * height > multisampleLimitFor(d.gpu.caps) ? 1 : 4;
    if (d.targets && d.targets.width === width && d.targets.height === height && d.targets.samples === samples) return d.targets;
    if (d.targets) {
      for (const t of d.targets.textures) t.destroy();
      d.targets.reservation.release();
    }
    const { device } = d;
    const texture = (what: string, format: GPUTextureFormat, sampleCount: number, usage: number): GPUTexture => scopedOn(device, what, () => device.createTexture({
      label: `viewport ${what}`, size: [width, height], format, sampleCount, usage,
    }));
    const resolve = texture('lit picture', 'rgba16float', 1, GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING);
    const color = samples === 4 ? texture('lit samples', 'rgba16float', 4, GPUTextureUsage.RENDER_ATTACHMENT) : resolve;
    const depth = texture('depth', 'depth32float', samples, GPUTextureUsage.RENDER_ATTACHMENT);
    const bytes = width * height * (8 + (samples === 4 ? 32 : 0) + 4 * samples);
    const resolveView = resolve.createView();
    const postGroup = scopedOn(device, 'the post bind group', () => device.createBindGroup({
      layout: d.postLayout, entries: [{ binding: 0, resource: { buffer: d.postUniforms } }, { binding: 1, resource: resolveView }],
    }));
    d.targets = {
      width, height, samples, color: color.createView(), resolve: resolveView, depth: depth.createView(),
      textures: samples === 4 ? [resolve, color, depth] : [resolve, depth], reservation: d.ledger.reserve(bytes, 'viewport picture'), bytes, postGroup,
    };
    return d.targets;
  }

  // ---- frames --------------------------------------------------------------------------------------------------------

  function configure(): void {
    if (!dev || dev.gpu.lost || !canvas) return;
    context ??= canvas.getContext('webgpu');
    if (!context) {
      console.error('[orogen] viewport: the canvas gives no WebGPU context');
      return;
    }
    context.configure({ device: dev.device, format: canvasFormat(), alphaMode: 'opaque' });
  }

  function setSize(next: ViewportSize): void {
    size = { width: Math.max(1, next.width), height: Math.max(1, next.height), dpr: next.dpr > 0 ? next.dpr : 1 };
    if (!canvas) return;
    // Before there is a device, as for the smallest: a canvas grows when it is known what it may be.
    const [width, height] = backingSize(size.width, size.height, size.dpr, dev?.gpu.caps.limits.maxTextureDimension2D ?? 8192,
      options.pixelLimit ?? (dev ? pixelLimitFor(dev.gpu.caps) : pixelLimitFor({ vramBytes: null, software: true })));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
  }

  /**
   * On demand (7.5 rule 6): one frame per change, drawn from the worker's animation frame. The timer is the
   * backstop for an animation frame that never comes: measured, after the GPU process has been restarted the
   * worker's requestAnimationFrame stops firing (7.8 rule 6). Where there is no animation frame at all, as in
   * Node, the timer is all there is.
   */
  function schedule(): void {
    if (scheduled || disposed) return;
    scheduled = true;
    const animate = globals.requestAnimationFrame;
    const animated = typeof animate === 'function';
    const draw = (): void => {
      if (!scheduled) return;
      scheduled = false;
      clearTimeout(backstop);
      frame();
    };
    const backstop = setTimeout(draw, animated ? FRAME_BACKSTOP_MS : 0);
    if (animated) animate(draw);
  }

  const busy = (): boolean => scheduled || pending || hold !== null || awaiting > 0 || (dev !== null && !dev.gpu.lost && dev.pipelines === null);
  function settle(): void {
    if (busy()) return;
    for (const wake of idleWaiters.splice(0)) wake();
  }

  function frame(): void {
    const waiting = afterFrame.splice(0);
    if (hold !== null) {
      // The picture is kept: the frame that was due, of the light maps' refinement, is asked for again when the hold ends.
      pending = false;
      for (const wake of waiting) wake();
      return;
    }
    try {
      pending = draw();
    } catch (thrown) {
      pending = false;
      // A device that is lost in mid-frame is the session's to report (7.8); anything else is this file's fault.
      if (!dev?.gpu.lost) console.error('[orogen] viewport: the frame failed', thrown);
    }
    if (pending) afterTheGpu(schedule);
    for (const wake of waiting) wake();
    settle();
  }

  /** When the GPU has done the frame last submitted; null before any. */
  let lastSubmitted: Promise<unknown> | null = null;
  /**
   * Runs `next` when the GPU has done what the last frame gave it, and after FRAME_BACKSTOP_MS at the latest, for
   * a device that is lost and answers nothing. The frames that only refine the light maps follow one another this
   * way: one that was drawn while the one before it was still in the queue would be no sooner on screen, and
   * where frames are not paced by a display (Node) they would pile up without end.
   */
  function afterTheGpu(next: () => void): void {
    let ran = false;
    const once = (): void => {
      if (ran) return;
      ran = true;
      clearTimeout(backstop);
      next();
    };
    const backstop = setTimeout(once, FRAME_BACKSTOP_MS);
    if (lastSubmitted) lastSubmitted.then(once, once);
    else once();
  }

  const cameraNow = (shown: ViewportContent): CameraState => camera ?? defaultCamera(shown, display);

  /** Bounds nothing visible lies outside of: the field's own, or wide ones while only its last state is known. */
  function cullBounds(): HeightBounds {
    if (!bounds) return UNKNOWN_BOUNDS;
    if (boundsExact) return bounds;
    const span = bounds.max - bounds.min + 0.25;
    return { min: bounds.min - span, max: bounds.max + span, nodes: null };
  }

  function lightFor(elevation: number): NonNullable<typeof light> {
    if (!light || light.elevation !== elevation) {
      const value = skyLight(elevation);
      const exposure = exposureFor(value, elevation);
      const balance = whiteBalance(value, elevation);
      light = { elevation, value, exposure, gain: new Float32Array([exposure * balance[0], exposure * balance[1], exposure * balance[2], 0]) };
    }
    return light;
  }

  /** Draws one frame. True when more work is due without any further change: the light maps are still being refined. */
  function draw(): boolean {
    const d = dev;
    if (disposed || blocked || !d || d.gpu.lost || !canvas || !context || !d.pipelines) return false;
    const { device } = d;
    const pipelines = d.pipelines;
    const width = canvas.width, height = canvas.height;
    const shown = content;
    const target = context;
    let more = false;
    /** The light maps this frame baked into, to be asked afterwards how long that took. */
    const baked: { lighting: Lighting | null } = { lighting: null };

    scopedOn(device, 'the frame', () => {
      const encoder = device.createCommandEncoder();
      const canvasView = target.getCurrentTexture().createView();
      if (!shown) {
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: canvasView, loadOp: 'clear', storeOp: 'store', clearValue: { r: BACKGROUND, g: BACKGROUND, b: BACKGROUND, a: 1 } }] });
        pass.end();
        device.queue.submit([encoder.finish()]);
        return;
      }

      const heights = shown.height;
      const zScale = shown.heightRange * display.verticalScale;
      const view: View = viewOf(cameraNow(shown), { width, height });

      // What follows the height field: the mesh's levels, the range of its heights, the light maps.
      let lighting: Lighting | null = null;
      if (heights) {
        setup = meshOf(Math.max(heights.width, heights.height));
        const reducer = reducerFor(d, 'heightReducer', heights, reducerSizes);
        lighting = lightingFor(d, heights);
        if (heightChanged) {
          reducer.request();
          lighting.invalidateSource();
        }
        reducer.encode(encoder, heights);
        baked.lighting = lighting;
        more = lighting.step(encoder, heights, {
          sunAzimuth: display.sunAzimuth, sunElevation: display.sunElevation, terrainSize: shown.terrainSize, zScale,
          seaLevel: display.showSea ? shown.seaLevel : null,
        }, BAKE_LOADS_PER_FRAME);
      } else {
        setup = lodSetup(2, 0);
      }
      heightChanged = false;
      const overlay = shown.overlay;
      if (overlay?.as === 'heat') {
        const reducer = reducerFor(d, 'overlayReducer', overlay.texture, reducerSizes);
        if (overlayChanged) reducer.request();
        reducer.encode(encoder, overlay.texture);
      }
      overlayChanged = false;

      // The sky map holds the sky for one elevation of the sun; its azimuth only turns the map.
      const sun = lightFor(display.sunElevation);
      if (d.skyElevation !== display.sunElevation) {
        d.skyElevation = display.sunElevation;
        const sky = new Float32Array(SKY_FLOATS);
        sky.set([display.sunElevation * DEG, 0, SKY_WIDTH, SKY_HEIGHT, ...sun.value.up, 0]);
        sky.set(sun.value.table, 8);
        device.queue.writeBuffer(d.skyUniforms, 0, sky);
        const group = scopedOn(device, 'the sky bind group', () => device.createBindGroup({ layout: pipelines.skyMap.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: d.skyUniforms } }] }));
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: d.skyView, loadOp: 'clear', storeOp: 'store' }] });
        pass.setPipeline(pipelines.skyMap);
        pass.setBindGroup(0, group);
        pass.draw(3);
        pass.end();
      }
      if (d.paletteName !== display.palette) {
        d.paletteName = display.palette;
        device.queue.writeTexture({ texture: d.paletteTexture }, paletteTexels(display.palette), { bytesPerRow: PALETTE_SIZE * 4 }, [PALETTE_SIZE, 1]);
      }

      // ---- the uniforms of the frame ----
      const known = heights ? bounds : { min: 0, max: 0, nodes: null };
      const cull = heights ? cullBounds() : { min: 0, max: 0, nodes: null };
      const low = known ? known.min : 0, high = known ? Math.max(known.max, known.min + 1e-6) : 1;
      const f = frameData;
      f.fill(0);
      let eye: readonly [number, number, number] = [shown.terrainSize / 2, shown.terrainSize / 2, shown.terrainSize];
      if (view.kind === 'orbit') {
        eye = view.eye;
        f.set(view.viewProj, FRAME.viewProj);
        f.set([view.eye[0], view.eye[1], view.eye[2], view.near], FRAME.eye);
        f.set(view.right.map((v) => (v * view.aspect) / view.focal), FRAME.right);
        f.set(view.up.map((v) => v / view.focal), FRAME.up);
        f.set(view.forward, FRAME.forward);
        const lodView = {
          eye: view.eye, planes: frustumPlanes(view), terrainSize: shown.terrainSize, zScale,
          r0: levelZeroRange(setup, shown.terrainSize, height, view.focal, quadPixels),
        };
        selectPatches(setup, cull, lodView, selection);
        const dz = slabDistance(lodView, cull);
        f.set([view.eye[0], view.eye[1], dz * dz, lodView.r0], FRAME.lod);
        f.set([setup.levels - 1, 1 / setup.fine], FRAME.lod2);
      } else {
        f.set([eye[0], eye[1], eye[2], 1], FRAME.eye);
        f.set([view.center[0], view.center[1], view.span, view.aspect], FRAME.top);
      }
      const azimuth = display.sunAzimuth * DEG, elevation = display.sunElevation * DEG;
      f.set([Math.cos(elevation) * Math.cos(azimuth), Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation), azimuth], FRAME.sunDir);
      f.set([...sun.value.sun, sun.exposure], FRAME.sunColor);
      f.set(sun.value.up, FRAME.skyUp);
      f.set(sun.value.side, FRAME.skySide);
      // How many texels of the height field a pixel covers at a metre's distance: what the smooth surface is shown by (shaders.ts).
      const texelsPerPixel = smooth && view.kind === 'orbit' && heights ? (2 * (Math.max(heights.width, heights.height) - 1)) / (shown.terrainSize * view.focal * height) : 0;
      f.set([lighting ? 1 : 0, 0, texelsPerPixel, smooth && heights ? 1 : 0], FRAME.misc);
      f.set([width, height, 1 / width, 1 / height], FRAME.canvas);
      f.set([shown.terrainSize, zScale, shown.heightRange, shown.seaLevel], FRAME.terrain);
      f.set(heights ? [heights.width - 1, heights.height - 1, 1] : [0, 0, 0], FRAME.heightTex);
      const kind = overlay ? { color: 1, mask: 2, heat: 3 }[overlay.as] : 0;
      f.set(overlay ? [overlay.texture.width - 1, overlay.texture.height - 1, Math.min(1, Math.max(0, overlay.opacity)), kind] : [0, 0, 0, 0], FRAME.overlayTex);
      f.set([overlayRange[0], 1 / Math.max(overlayRange[1] - overlayRange[0], 1e-12)], FRAME.overlayRange);
      f.set(lighting ? [lighting.shadowLevel, lighting.occlusionLevel, lighting.size, lighting.levels] : [0, 0, 1, 1], FRAME.light);
      // A sea no texel reaches is not drawn: it would lie under the slab.
      const sea = display.showSea && (!known || shown.seaLevel > low) ? 1 : 0;
      f.set([display.shading === 'clay' ? 1 : 0, sea, { hillshade: 0, grey: 1, overlay: 2 }[display.topStyle]], FRAME.flags);
      f.set([low, high, low * zScale - SLAB * shown.terrainSize], FRAME.bounds);
      device.queue.writeBuffer(d.frameUniforms, 0, f);

      const group = scopedOn(device, 'the frame bind group', () => device.createBindGroup({
        layout: d.frameLayout,
        entries: [
          { binding: 0, resource: { buffer: d.frameUniforms } },
          { binding: 1, resource: heights?.view ?? d.zeroField },
          { binding: 2, resource: overlay?.texture.view ?? d.zeroField },
          { binding: 3, resource: lighting?.pyramid ?? d.zeroField },
          { binding: 4, resource: lighting?.shadow ?? d.whiteLight },
          { binding: 5, resource: lighting?.occlusion ?? d.whiteLight },
          { binding: 6, resource: d.skyView },
          { binding: 7, resource: d.paletteView },
          { binding: 8, resource: d.lightSampler },
          { binding: 9, resource: d.skySampler },
        ],
      }));

      if (view.kind === 'top') {
        triangles = 0;
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: canvasView, loadOp: 'clear', storeOp: 'store', clearValue: { r: BACKGROUND, g: BACKGROUND, b: BACKGROUND, a: 1 } }] });
        pass.setPipeline(pipelines.top);
        pass.setBindGroup(0, group);
        pass.draw(3);
        pass.end();
      } else {
        const targets = targetsFor(d, width, height);
        const scene = pipelines.scene[targets.samples];
        device.queue.writeBuffer(d.fullInstances, 0, selection.full, 0, selection.fullCount * INSTANCE_FLOATS);
        device.queue.writeBuffer(d.halfInstances, 0, selection.half, 0, selection.halfCount * INSTANCE_FLOATS);
        device.queue.writeBuffer(d.postUniforms, 0, sun.gain);
        triangles = (selection.fullCount * d.fullIndexCount + selection.halfCount * d.halfIndexCount) / 3;
        const pass = encoder.beginRenderPass({
          colorAttachments: [{
            view: targets.color, ...(targets.samples === 4 ? { resolveTarget: targets.resolve } : {}),
            loadOp: 'clear', storeOp: targets.samples === 4 ? 'discard' : 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 },
          }],
          depthStencilAttachment: { view: targets.depth, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'discard' },
        });
        pass.setBindGroup(0, group);
        pass.setPipeline(scene.sky);
        pass.draw(3);
        pass.setPipeline(scene.terrain);
        pass.setVertexBuffer(0, d.patchVertices);
        if (selection.fullCount > 0) {
          pass.setVertexBuffer(1, d.fullInstances);
          pass.setIndexBuffer(d.fullIndices, 'uint32');
          pass.drawIndexed(d.fullIndexCount, selection.fullCount);
        }
        if (selection.halfCount > 0) {
          pass.setVertexBuffer(1, d.halfInstances);
          pass.setIndexBuffer(d.halfIndices, 'uint32');
          pass.drawIndexed(d.halfIndexCount, selection.halfCount);
        }
        pass.setPipeline(scene.wall);
        pass.draw(24);
        if (sea) {
          pass.setPipeline(scene.sea);
          pass.draw(6);
        }
        pass.end();
        const post = encoder.beginRenderPass({ colorAttachments: [{ view: canvasView, loadOp: 'clear', storeOp: 'store' }] });
        post.setPipeline(pipelines.post);
        post.setBindGroup(0, targets.postGroup);
        post.draw(3);
        post.end();
      }
      device.queue.submit([encoder.finish()]);
    });
    // Handled here: when the GPU process goes, this rejects, and the frame after it, which alone would look at
    // it (afterTheGpu), may never be asked for.
    lastSubmitted = device.queue.onSubmittedWorkDone().catch(() => undefined);
    d.heightReducer?.collect();
    d.overlayReducer?.collect();
    baked.lighting?.collect();
    frames++;
    tried = true;
    confirm(device);
    return more;
  }

  // ---- picking -------------------------------------------------------------------------------------------------------

  /** Resolves when the frame that is due has been drawn: a pick answers for the picture of the camera last set. */
  const frameDrawn = (): Promise<void> => (scheduled ? new Promise((resolve) => afterFrame.push(resolve)) : Promise.resolve());

  async function pick(x: number, y: number): Promise<PickResult | null> {
    await frameDrawn();
    const d = dev;
    const shown = content;
    if (disposed || !d || d.gpu.lost || !d.pipelines || !shown || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    const extent = { width: size.width, height: size.height };
    if (x < 0 || y < 0 || x > extent.width || y > extent.height) return null;
    const terrain = shown.terrainSize;
    const zScale = shown.heightRange * display.verticalScale;
    const ray = pixelRay(viewOf(cameraNow(shown), extent), extent, x, y, terrain);
    const [ox, oy, oz] = ray.origin, [dx, dy, dz] = ray.direction;

    // The part of the ray inside the terrain's box.
    const known = shown.height ? cullBounds() : { min: 0, max: 0 };
    const margin = 1e-3 * Math.max(1, Math.abs(zScale));
    const zLow = Math.min(known.min * zScale, known.max * zScale) - margin, zHigh = Math.max(known.min * zScale, known.max * zScale) + margin;
    let t0 = 0, t1 = Infinity;
    for (const [o, v, lo, hi] of [[ox, dx, 0, terrain], [oy, dy, 0, terrain], [oz, dz, zLow, zHigh]] as const) {
      if (Math.abs(v) < 1e-12) {
        if (o < lo || o > hi) return null;
        continue;
      }
      const a = (lo - o) / v, b = (hi - o) / v;
      t0 = Math.max(t0, Math.min(a, b));
      t1 = Math.min(t1, Math.max(a, b));
    }
    if (!(t1 > t0)) return null;

    const heights = shown.height;
    if (!heights) {
      // The flat plane an overlay alone is drawn on.
      const u = (ox + t0 * dx) / terrain, v = (oy + t0 * dy) / terrain;
      return { uv: [u, v], height: 0, position: [u * terrain, v * terrain, 0] };
    }
    const cell = terrain / Math.max(1, Math.max(heights.width, heights.height) - 1);
    const across = Math.hypot(dx, dy);
    const reach = t1 - t0;
    const stride = across < 1e-9 ? reach : (0.5 * cell) / across;
    const steps = Math.min(PICK_STEPS, Math.max(1, Math.ceil(reach / stride)));
    const { device } = d;
    const readback = scopedOn(device, 'the pick readback', () => device.createBuffer({ size: 32, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }));
    // The march begins where the ray enters the terrain's box, and the GPU is given that point: it counts in 32
    // bits, and from an eye far away (the top view's is 10^9 m up) a height of metres is below what it can tell apart.
    device.queue.writeBuffer(d.pickUniforms, 0, new Float32Array([
      ox + t0 * dx, oy + t0 * dy, oz + t0 * dz, 0, dx, dy, dz, 0, terrain, zScale, heights.width - 1, heights.height - 1, 0, reach, reach / steps, steps,
    ]));
    scopedOn(device, 'the pick', () => {
      const group = device.createBindGroup({
        layout: d.pickLayout,
        entries: [{ binding: 0, resource: { buffer: d.pickUniforms } }, { binding: 1, resource: heights.view }, { binding: 2, resource: { buffer: d.pickResult } }],
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(d.pipelines!.pick);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(d.pickResult, 0, readback, 0, 32);
      device.queue.submit([encoder.finish()]);
    });
    try {
      await readback.mapAsync(GPUMapMode.READ);
    } catch {
      // The device went: there is nothing under the pointer any more.
      return null;
    }
    const [hit, u, v, h] = new Float32Array(readback.getMappedRange().slice(0));
    readback.unmap();
    readback.destroy();
    if (!(hit! >= 0) || !Number.isFinite(h!)) return null;
    return { uv: [u!, v!], height: h!, position: [u! * terrain, v! * terrain, h! * shown.heightRange] };
  }

  // ---- the renderer --------------------------------------------------------------------------------------------------

  function reservedBytes(): number {
    const d = dev;
    if (!d) return 0;
    let sum = d.fixedBytes + (d.targets?.bytes ?? 0) + (d.heightReducer?.bytes ?? 0) + (d.overlayReducer?.bytes ?? 0);
    for (const lighting of d.lightings.values()) sum += lighting.bytes;
    return sum;
  }

  /** Lets go of everything on the device. `released`: the device lives, and what was registered is given back. */
  function dropDevice(released: boolean): void {
    const d = dev;
    dev = null;
    if (!d) return;
    for (const lighting of d.lightings.values()) lighting.destroy(released);
    d.heightReducer?.destroy(released);
    d.overlayReducer?.destroy(released);
    if (!released) return;
    if (d.targets) {
      for (const t of d.targets.textures) t.destroy();
      d.targets.reservation.release();
    }
    for (const b of [d.frameUniforms, d.postUniforms, d.skyUniforms, d.pickUniforms, d.pickResult, d.patchVertices, d.fullIndices, d.halfIndices, d.fullInstances, d.halfInstances]) b.destroy();
    for (const t of [d.skyTexture, d.paletteTexture]) t.destroy();
    d.fixed.release();
  }

  return {
    init(next, ledger): void {
      if (disposed) return;
      if (tried && !confirmed && !blocked) {
        blocked = true;
        console.warn('[orogen] the viewport stays empty: the GPU device was lost with the first frame drawn to the window, as it is where the desktop composites without a GPU');
      }
      // What belonged to the previous device went with it, and with its ledger; only what is made below is this device's.
      dropDevice(false);
      endHold();
      probing = false;
      bounds = null;
      awaiting = 0;
      reducerSizes.height = reducerSizes.overlay = '';
      const made = createDeviceState(next, ledger);
      dev = made;
      setSize(size);
      createPipelines(made).then((pipelines) => {
        if (dev !== made || disposed) return;
        made.pipelines = pipelines;
        heightChanged = overlayChanged = true;
        schedule();
      }, (thrown: unknown) => {
        if (!next.lost) console.error('[orogen] viewport: the pipelines were not created', thrown);
        settle();
      });
      configure();
    },

    attach(next: OffscreenCanvas, attached: ViewportSize): void {
      if (disposed) return;
      canvas = surfaceOf(next);
      context = null;
      setSize(attached);
      configure();
      endHold();
      schedule();
    },
    detach(): void {
      context?.unconfigure();
      context = null;
      canvas = null;
    },
    resize(next: ViewportSize): void {
      setSize(next);
      endHold();
      schedule();
    },
    setCamera(next: CameraState): void {
      camera = next;
      endHold();
      schedule();
    },
    setDisplay(next: ViewportDisplay): void {
      const before = display;
      display = resolveDisplay(next);
      if (dev) {
        const moved = before.sunAzimuth !== display.sunAzimuth || before.sunElevation !== display.sunElevation;
        for (const lighting of dev.lightings.values()) {
          if (before.showSea !== display.showSea) lighting.invalidateSource();
          else if (before.verticalScale !== display.verticalScale) lighting.invalidateRelief();
          else if (moved) lighting.invalidateSun();
        }
      }
      endHold();
      schedule();
    },
    pick,

    // Synchronous (7.5 rule 2): a frame binds the content that is current when it is drawn, and nothing made
    // from a view outlives the frame that made it.
    //
    // A step back keeps the picture for a moment. When a node that lent its state settles, the session withdraws
    // the loans by giving the content it showed before them, the very object, or none when it showed none; the
    // node's result follows when its evaluation ends. Measured in a session: a frame is drawn in between, and it
    // is the earlier terrain flashing up after the last step of an erosion. So that frame waits: for the content
    // that follows, for a change of the camera, the display or the size, or the time of RendererOptions.holdMs,
    // after which what the session gave is what is drawn (5.11 rule 5).
    setContent(next: ViewportContent | null): void {
      const previous = content;
      const back = frames > 0 && (next === null ? previous !== null : given.has(next));
      if (next) given.add(next);
      content = next;
      generation++;
      heightChanged = true;
      overlayChanged = true;
      // The range of another field says nothing of this one; that of the same field's last state is near enough
      // to draw with until its own arrives, which keeps a running simulation from flickering.
      if (!next?.height || previous?.height?.width !== next.height.width || previous?.height?.height !== next.height.height) bounds = null;
      boundsExact = false;
      if (next?.overlay?.as !== 'heat') overlayRange = [0, 1];
      endHold();
      if (!back || disposed) {
        schedule();
        return;
      }
      hold = setTimeout(() => {
        hold = null;
        schedule();
      }, holdMs);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      endHold();
      content = null;
      context?.unconfigure();
      context = null;
      canvas = null;
      dropDevice(dev !== null && !dev.gpu.lost);
      for (const wake of [...afterFrame.splice(0), ...idleWaiters.splice(0)]) wake();
    },

    get state(): RendererState {
      return {
        frames, triangles, patches: selection.fullCount + selection.halfCount, reservedBytes: reservedBytes(),
        lightSize: content?.height && dev ? lightSize(Math.max(content.height.width, content.height.height), lightCapOf(dev.gpu)) : 0,
        heightRange: bounds ? [bounds.min, bounds.max] : null, overlayRange, blocked, canvas: canvas ? [canvas.width, canvas.height] : [0, 0],
        bakeLoads: content?.height && dev ? dev.lightings.get(lightSize(Math.max(content.height.width, content.height.height), lightCapOf(dev.gpu)))?.loadsPerFrame ?? 0 : 0,
      };
    },
    whenIdle(): Promise<void> {
      if (disposed || !busy()) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
  };
}
