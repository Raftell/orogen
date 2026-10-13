// PLACEHOLDER, to be deleted by the viewport owner together with its one use in engine-worker.ts, when
// src/viewport/ exists. It proves the path from the engine's texture to the window and nothing more: the bound
// height field, seen from above, as a lit grey image that fits the canvas. No camera, no overlay, no sea, no pick.
//
// Two things in it are not the placeholder's own and belong in the renderer that replaces it, because the
// window demands them of any renderer (runtime.md 7.5 rule 9, 7.8 rule 6): a frame is confirmed before the
// window is trusted to present, and a requested frame does not wait for an animation frame alone.

import type {
  CameraState, GpuContext, PickResult, ViewportContent, ViewportDisplay, ViewportRenderer, ViewportSize,
} from '../../../core/runtime.ts';

/** Behind the terrain: --og-bg-canvas of src/app/shell/theme.css (#161616), the colour of the panel around the canvas. */
const BACKGROUND = 22 / 255;

const SHADER = /* wgsl */ `
struct Uniforms {
  canvas: vec2f,      // backing size of the canvas, pixels
  field: vec2f,       // size of the height texture, texels
  light: vec3f,       // unit vector from the terrain towards the sun, +Z up
  relief: f32,        // metres of height per texel of distance, for a height difference of 1
}
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var heights: texture_2d<f32>;

fn texel(p: vec2i) -> f32 {
  return textureLoad(heights, clamp(p, vec2i(0), vec2i(u.field) - 1), 0).r;
}
// Bilinear by hand: a field is never bound with a filtering sampler (runtime.md 7.5 rule 3).
fn height(t: vec2f) -> f32 {
  let base = floor(t);
  let f = t - base;
  let p = vec2i(base);
  let top = texel(p) + f.x * (texel(p + vec2i(1, 0)) - texel(p));
  let bottom = texel(p + vec2i(0, 1)) + f.x * (texel(p + vec2i(1, 1)) - texel(p + vec2i(0, 1)));
  return top + f.y * (bottom - top);
}

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let corners = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[i], 0.0, 1.0);
}

@fragment fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  // The square terrain, centred, as large as the canvas allows: texel (0, 0) at the top left (engine.md 1.8).
  let side = min(u.canvas.x, u.canvas.y);
  let uv = (position.xy - 0.5 * (u.canvas - vec2f(side))) / side;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) {
    return vec4f(vec3f(${BACKGROUND}), 1.0);
  }
  let t = uv * (u.field - vec2f(1.0));
  let slope = vec2f(height(t + vec2f(1.0, 0.0)) - height(t - vec2f(1.0, 0.0)), height(t + vec2f(0.0, 1.0)) - height(t - vec2f(0.0, 1.0))) * 0.5 * u.relief;
  let normal = normalize(vec3f(-slope, 1.0));
  let lit = 0.12 + 0.88 * max(dot(normal, u.light), 0.0);
  return vec4f(vec3f(pow(lit, 1.0 / 2.2)), 1.0);
}
`;

const UNIFORM_BYTES = 32;
/** The buffer whose mapping confirms that the device outlived a frame. */
const PROBE_BYTES = 4;
/** A requested frame is drawn after this long at the latest. */
const FRAME_BACKSTOP_MS = 250;
const DEFAULT_DISPLAY: ViewportDisplay = { verticalScale: 1, showSea: false, sunAzimuth: 225, sunElevation: 40 };

function report(what: string): (error: GPUError | null) => void {
  return (error) => {
    if (error) console.error(`[orogen] placeholder viewport: ${what}: ${error.message}`);
  };
}

/** One synchronous pair of error scopes around `work` (runtime.md 5.8, error scopes rule 2). */
function scoped<T>(device: GPUDevice, what: string, work: () => T): T {
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

export function createPlaceholderViewport(): ViewportRenderer {
  let gpu: GpuContext | null = null;
  let pipeline: GPURenderPipeline | null = null;
  let layout: GPUBindGroupLayout | null = null;
  let uniforms: GPUBuffer | null = null;
  let reservation: { release(): void } | null = null;
  let canvas: OffscreenCanvas | null = null;
  let context: GPUCanvasContext | null = null;
  let content: ViewportContent | null = null;
  let display = DEFAULT_DISPLAY;
  let scheduled = false;
  let disposed = false;
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
    const probe = scoped(device, 'the probe buffer', () => device.createBuffer({ size: PROBE_BYTES, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }));
    probe.mapAsync(GPUMapMode.READ).then(() => {
      confirmed = true;
      probing = false;
      probe.destroy();
    }, () => {
      probing = false;
    });
  }

  function configure(): void {
    if (!gpu || gpu.lost || !canvas) return;
    context ??= canvas.getContext('webgpu');
    if (!context) {
      console.error('[orogen] placeholder viewport: the canvas gives no WebGPU context');
      return;
    }
    context.configure({ device: gpu.device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: 'opaque' });
  }

  function setSize(size: ViewportSize): void {
    if (!canvas) return;
    const limit = gpu?.caps.limits.maxTextureDimension2D ?? 8192;
    const pixels = (css: number): number => Math.min(limit, Math.max(1, Math.round(css * size.dpr)));
    const width = pixels(size.width);
    const height = pixels(size.height);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
  }

  /**
   * On demand (7.5 rule 6): one frame per change, drawn from the worker's animation frame. The timer is the
   * backstop for an animation frame that never comes: measured, after the GPU process has been restarted the
   * worker's requestAnimationFrame stops firing (7.8 rule 6).
   */
  function schedule(): void {
    if (scheduled || disposed) return;
    scheduled = true;
    const draw = (): void => {
      if (!scheduled) return;
      scheduled = false;
      clearTimeout(backstop);
      frame();
    };
    const backstop = setTimeout(draw, FRAME_BACKSTOP_MS);
    requestAnimationFrame(draw);
  }

  function frame(): void {
    if (disposed || blocked || !gpu || gpu.lost || !canvas || !context || !pipeline || !layout || !uniforms) return;
    const device = gpu.device;
    const shown = content;
    const heights = shown?.height ?? null;
    const buffer = uniforms;
    const bindLayout = layout;
    const drawPipeline = pipeline;
    const target = context;

    let bindGroup: GPUBindGroup | null = null;
    if (shown && heights) {
      const azimuth = (display.sunAzimuth * Math.PI) / 180;
      const elevation = (display.sunElevation * Math.PI) / 180;
      const cell = shown.terrainSize / Math.max(1, heights.width - 1);
      const data = new Float32Array(UNIFORM_BYTES / 4);
      data.set([canvas.width, canvas.height, heights.width, heights.height]);
      data.set([Math.cos(elevation) * Math.cos(azimuth), Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation)], 4);
      data[7] = (shown.heightRange * display.verticalScale) / cell;
      device.queue.writeBuffer(buffer, 0, data);
      bindGroup = scoped(device, 'the bind group', () => device.createBindGroup({
        layout: bindLayout,
        entries: [{ binding: 0, resource: { buffer } }, { binding: 1, resource: heights.view }],
      }));
    }
    scoped(device, 'the frame', () => {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: target.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: BACKGROUND, g: BACKGROUND, b: BACKGROUND, a: 1 },
        }],
      });
      if (bindGroup) {
        pass.setPipeline(drawPipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
      }
      pass.end();
      device.queue.submit([encoder.finish()]);
    });
    tried = true;
    confirm(device);
  }

  return {
    init(next, ledger): void {
      if (tried && !confirmed && !blocked) {
        blocked = true;
        console.warn('[orogen] the viewport stays empty: the GPU device was lost with the first frame drawn to the window, as it is where the desktop composites without a GPU');
      }
      // What belonged to the previous device went with it; only what is created below is this device's.
      gpu = next;
      pipeline = null;
      probing = false;
      const device = next.device;
      layout = scoped(device, 'the bind group layout', () => device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        ],
      }));
      uniforms = scoped(device, 'the uniform buffer', () => device.createBuffer({ size: UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
      reservation = ledger.reserve(UNIFORM_BYTES + PROBE_BYTES, 'placeholder viewport');
      const module = device.createShaderModule({ code: SHADER });
      device.createRenderPipelineAsync({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }] },
      }).then((made) => {
        if (gpu !== next || disposed) return;
        pipeline = made;
        schedule();
      }, (thrown: unknown) => {
        if (!next.lost) console.error('[orogen] placeholder viewport: the pipeline was not created', thrown);
      });
      configure();
    },

    attach(next: OffscreenCanvas, size: ViewportSize): void {
      canvas = next;
      context = null;
      setSize(size);
      configure();
      schedule();
    },
    detach(): void {
      context?.unconfigure();
      context = null;
      canvas = null;
    },
    resize(size: ViewportSize): void {
      setSize(size);
      schedule();
    },
    setCamera(_camera: CameraState): void {},
    setDisplay(next: ViewportDisplay): void {
      display = next;
      schedule();
    },
    pick(_x: number, _y: number): Promise<PickResult | null> {
      return Promise.resolve(null);
    },

    // Synchronous (7.5 rule 2): a frame takes the content that is current when it is drawn and keeps no view.
    setContent(next: ViewportContent | null): void {
      content = next;
      schedule();
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      content = null;
      context?.unconfigure();
      context = null;
      canvas = null;
      if (gpu && !gpu.lost) {
        uniforms?.destroy();
        reservation?.release();
      }
      uniforms = null;
      reservation = null;
      pipeline = null;
    },
  };
}
