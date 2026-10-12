import { checkBindings, type AnyRunBindings, type BindingEnv, type Lut } from './bindings.ts';
import type { DefaultTextures } from './defaults.ts';
import type { Field } from './field.ts';
import type { AnyKernel } from './kernel.ts';
import type { PipelineCache } from './pipelines.ts';
import type { PoolTexture } from './pool.ts';
import { kernelShape } from './shape.ts';
import type { CommandStream } from './stream.ts';

/** What a run takes from the invocation that makes it. */
export interface RunEnv extends BindingEnv {
  readonly terrainSize: number;
  readonly heightRange: number;
  /** frame.seed. */
  readonly seed: number;
  /** frame.iteration unless the run overrides it: the loop index inside ctx.loop, else 0. */
  readonly iteration: number;
  /** The texture behind a field for which released() is false. */
  texture(field: Field): PoolTexture;
  /** The buffer behind a Lut for which ownsLut() is true. */
  lutBuffer(lut: Lut): GPUBuffer;
}

export interface RunServices {
  readonly stream: CommandStream;
  readonly pipelines: PipelineCache;
  readonly defaults: DefaultTextures;
}

/**
 * ctx.run (engine.md 3.11): checkBindings, then defaults for unbound inputs and sinks for null targets, the
 * Frame of the written grid, and one RunRequest on the stream for its current owner. The kernel is compiled.
 */
export function encodeRun(services: RunServices, kernel: AnyKernel, bindings: AnyRunBindings, env: RunEnv): void {
  checkBindings(kernel, bindings, env);
  const compiled = services.pipelines.get(kernel);
  if (!compiled) throw new Error(`kernel "${kernel.name}" is not compiled; the pipeline cache compiles a node's kernels before evaluate() is called`);
  const shape = kernelShape(kernel.def);

  const resources: (GPUTextureView | GPUBuffer)[] = [];
  let bound = 0;
  shape.inputs.forEach((input, index) => {
    const field = bindings.in?.[input.name] ?? null;
    if (field) {
      bound += 2 ** index;
      resources.push(env.texture(field).view);
    } else {
      resources.push(services.defaults.input(input.default!));
    }
  });
  // The written grid is the first target that is not null (engine.md section 2); checkBindings found one.
  let grid: Field | null = null;
  let target = 0;
  const writable = (field: Field | null | undefined, kind: 'field' | (typeof shape.outputs)[number]['kind']): void => {
    if (field) {
      grid ??= field;
      resources.push(env.texture(field).view);
    } else {
      resources.push(services.defaults.sink(kind, target));
    }
    target++;
  };
  for (const output of shape.outputs) writable(bindings.out?.[output.name], output.kind);
  for (const name of shape.inPlace) writable(bindings.rw?.[name], 'field');
  for (const name of shape.unsafe) writable(bindings.rw?.[name], 'field');
  for (const lut of shape.luts) resources.push(env.lutBuffer(bindings.luts![lut.name]!));
  for (const scopes of services.defaults.takeScopes()) services.stream.track(scopes);

  const { width, height } = grid!;
  services.stream.run({
    kernel: compiled,
    resources,
    frame: {
      res: [width, height],
      terrainSize: env.terrainSize,
      cellSize: env.terrainSize / Math.max(width - 1, 1),
      heightRange: env.heightRange,
      seed: env.seed >>> 0,
      iteration: bindings.iteration ?? env.iteration,
      bound,
    },
    // By value: changing the object after ctx.run() has no effect on this run (engine.md 3.10).
    params: shape.params ? { ...bindings.params } : null,
    cost: bindings.cost ?? shape.cost,
  });
}
