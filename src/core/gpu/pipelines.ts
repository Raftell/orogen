import { deviceLostError, type GpuContext } from './device.ts';
import { generateWgsl, type GeneratedModule } from './generate.ts';
import type { AnyKernel } from './kernel.ts';
import { guarded } from './scopes.ts';
import { kernelShape } from './shape.ts';
import { UNIFORM_SLOT_BYTES, type ParamsLayout } from './uniforms.ts';

export interface WgslDiagnostic {
  readonly origin: 'code' | 'generated' | `library:${string}`;   // author code, generated code, or a library by name
  readonly line: number;                                          // 1-based, within the origin
  readonly column: number;
  readonly length: number;
  readonly message: string;
  readonly excerpt: readonly string[];                            // the line and up to two lines either side
}

/** A kernel that does not compile (runtime.md 5.8, Compilation). The message is `kernel "<name>": <first error>`. */
export class KernelCompileError extends Error {
  override name = 'KernelCompileError';
  readonly kernel: string;
  readonly diagnostic: WgslDiagnostic | null;   // null when pipeline creation failed without a WGSL diagnostic
  readonly detail: string;                      // the full GPU message

  constructor(message: string, info: { readonly kernel: string; readonly diagnostic: WgslDiagnostic | null; readonly detail: string }) {
    super(message);
    this.kernel = info.kernel;
    this.diagnostic = info.diagnostic;
    this.detail = info.detail;
  }
}

export interface CompiledKernel {
  readonly kernel: AnyKernel;
  readonly module: GeneratedModule;
  readonly pipeline: GPUComputePipeline;
  readonly group1Layout: GPUBindGroupLayout;
  readonly paramsLayout: ParamsLayout | null;   // null when the kernel declares no params
}

/** Pipelines by kernel name, for one device (runtime.md 5.8). A new device gets a new cache. */
export interface PipelineCache {
  /** The layout of group 0, shared by all kernels (engine.md 3.2). */
  readonly group0Layout: GPUBindGroupLayout;
  /** Compiles the kernel once; later calls return the same promise. Rejects with KernelCompileError. */
  compile(kernel: AnyKernel): Promise<CompiledKernel>;
  /** The compiled kernel; undefined until compile() has resolved for it. */
  get(kernel: AnyKernel): CompiledKernel | undefined;
}

/** The layout of group 0: `frame` and `P` as 256-byte slots with dynamic offsets (engine.md 3.2). Layouts made from it are interchangeable. */
export function createGroup0Layout(device: GPUDevice): GPUBindGroupLayout {
  const slot: GPUBufferBindingLayout = { type: 'uniform', hasDynamicOffset: true, minBindingSize: UNIFORM_SLOT_BYTES };
  return device.createBindGroupLayout({
    label: 'orogen group 0',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: slot },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: slot },
    ],
  });
}

function group1Layout(device: GPUDevice, kernel: AnyKernel, module: GeneratedModule, formats: GpuContext['caps']['formats']): GPUBindGroupLayout {
  const visibility = GPUShaderStage.COMPUTE;
  return device.createBindGroupLayout({
    label: `${kernel.name} group 1`,
    entries: module.group1.map((entry, binding): GPUBindGroupLayoutEntry => {
      switch (entry.role) {
        case 'input':
          return { binding, visibility, texture: { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: false } };
        case 'output':
          return { binding, visibility, storageTexture: { access: 'write-only', format: formats[entry.kind], viewDimension: '2d' } };
        case 'inPlace':
        case 'unsafeReadWrite':
          return { binding, visibility, storageTexture: { access: 'read-write', format: 'r32float', viewDimension: '2d' } };
        case 'lut':
          return { binding, visibility, buffer: { type: 'read-only-storage' } };
      }
    }),
  });
}

/** Maps a compiler message to the segment of the module it lies in (runtime.md 5.8, Compilation). */
function diagnosticOf(module: GeneratedModule, message: GPUCompilationMessage): WgslDiagnostic {
  const lines = module.wgsl.split('\n');
  const lineNum = Math.max(1, message.lineNum);
  const segment = module.segments.find((s) => lineNum >= s.firstLine && lineNum < s.firstLine + s.lineCount)
    ?? module.segments[module.segments.length - 1]!;
  const first = Math.max(segment.firstLine, lineNum - 2);
  const last = Math.min(segment.firstLine + segment.lineCount - 1, lineNum + 2);
  return {
    origin: segment.origin,
    line: lineNum - segment.firstLine + 1,
    column: message.linePos,
    length: message.length,
    message: message.message,
    excerpt: lines.slice(first - 1, last),
  };
}

const firstLine = (text: string): string => text.split('\n')[0]!;

export function createPipelineCache(gpu: GpuContext): PipelineCache {
  const device = gpu.device;
  const group0Layout = createGroup0Layout(device);
  const pending = new Map<string, Promise<CompiledKernel>>();
  const compiled = new Map<string, CompiledKernel>();

  async function build(kernel: AnyKernel): Promise<CompiledKernel> {
    const fail = (problem: string, diagnostic: WgslDiagnostic | null, detail: string): never => {
      if (gpu.lost) throw deviceLostError(gpu);
      throw new KernelCompileError(`kernel "${kernel.name}": ${problem}`, { kernel: kernel.name, diagnostic, detail });
    };
    const module = generateWgsl(kernel.def, gpu.caps.formats);
    const shader = guarded(device, () => device.createShaderModule({ label: kernel.name, code: module.wgsl }));
    const info = await shader.value.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length > 0) {
      const diagnostic = diagnosticOf(module, errors[0]!);
      fail(firstLine(diagnostic.message), diagnostic, errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('\n'));
    }

    // createComputePipelineAsync reports a failure by rejecting; the scopes catch what the layouts raise.
    const made = guarded(device, () => {
      const layout1 = group1Layout(device, kernel, module, gpu.caps.formats);
      const layout = device.createPipelineLayout({ label: kernel.name, bindGroupLayouts: [group0Layout, layout1] });
      const pipeline = device.createComputePipelineAsync({ label: kernel.name, layout, compute: { module: shader.value, entryPoint: 'main' } });
      // Observed here so that a rejection is never unhandled while the scopes are awaited.
      return { layout1, pipeline: pipeline.then((value) => ({ value, error: null }), (error: unknown) => ({ value: null, error })) };
    });
    const [pipeline, ...scopes] = await Promise.all([
      made.value.pipeline, shader.scopes.outOfMemory, shader.scopes.validation, made.scopes.outOfMemory, made.scopes.validation,
    ]);
    if (gpu.lost) throw deviceLostError(gpu);
    const scopeError = scopes.find((e) => e !== null);
    if (pipeline.value === null) {
      const message = pipeline.error instanceof Error ? pipeline.error.message : String(pipeline.error);
      fail(firstLine(message), null, message);
    }
    if (scopeError) fail(firstLine(scopeError.message), null, scopeError.message);

    const result: CompiledKernel = {
      kernel,
      module,
      pipeline: pipeline.value!,
      group1Layout: made.value.layout1,
      paramsLayout: kernelShape(kernel.def).params,
    };
    compiled.set(kernel.name, result);
    return result;
  }

  return {
    group0Layout,
    compile(kernel) {
      let promise = pending.get(kernel.name);
      if (!promise) {
        promise = build(kernel);
        pending.set(kernel.name, promise);
      }
      return promise;
    },
    get(kernel) {
      const found = compiled.get(kernel.name);
      return found?.kernel === kernel ? found : undefined;
    },
  };
}
