import type { CpuTask } from '../cpu/tasks.ts';
import type { Lut, RunBindings } from '../gpu/bindings.ts';
import type { Field, FieldKind, Rgba } from '../gpu/field.ts';
import type { Kernel } from '../gpu/kernel.ts';
import type { PoolTexture } from '../gpu/pool.ts';
import type { StreamOwner } from '../gpu/stream.ts';
import type { ProjectSettings } from '../graph/doc.ts';
import type { NodeDef, SettingName } from '../graph/node.ts';
import type { EnumNames, ParamDef, ParamsOf, ParamValue } from '../graph/param-types.ts';
import type { InputField, KindOfPortType, PortDef, PortNamed } from '../graph/ports.ts';
import type { EngineParts } from './parts.ts';

export interface AllocOptions {
  readonly size?: number | readonly [number, number];   // default ctx.res; a number n means n × n
  readonly like?: Field;                                 // same size as this field; ignored when size is given
  readonly clear?: number | Rgba;                        // initial contents; default: undefined contents
}
export interface LoopOptions<OutputName extends string = string> {
  readonly label?: string;
  readonly progress?: readonly [from: number, to: number];   // default [0, 1]
  readonly preview?: () => Readonly<Partial<Record<OutputName, Field>>>;
}
export interface FieldStats { readonly min: number; readonly max: number; readonly mean: number; readonly nonFinite: number }

/** The part of the context that does not depend on a node's declarations. Shared ops and helper functions take this. */
export interface OpContext {
  readonly res: number;
  readonly cellSize: number;
  readonly terrainSize: number;
  readonly heightRange: number;
  readonly ladder: readonly number[];
  readonly signal: AbortSignal;

  lengthToPx(length: number, grid?: Field | number): number;
  lengthToMetres(length: number): number;
  heightToMetres(height: number): number;

  alloc<K extends FieldKind>(kind: K, opts?: AllocOptions): Field<K>;
  clone<K extends FieldKind>(field: Field<K>): Field<K>;
  clear(field: Field, value?: number | Rgba): void;
  release(field: Field): void;

  run<KI, KO, KW, KU, KP, KL>(kernel: Kernel<KI, KO, KW, KU, KP, KL>, bindings: NoInfer<RunBindings<KI, KO, KW, KU, KP, KL>>): void;
  loop<R>(iterations: number, body: (i: number) => R extends PromiseLike<unknown> ? 'loop body must be synchronous' : R, opts?: LoopOptions): Promise<void>;
  flush(): Promise<void>;

  lut<T extends 'f32' | 'vec4f'>(data: Float32Array, type: T): Lut<T>;
  read(field: Field, rows?: readonly [y0: number, y1: number]): Promise<Float32Array<ArrayBuffer>>;
  write(field: Field, data: Float32Array, rows?: readonly [y0: number, y1: number]): void;
  stats(field: Field<'field' | 'half' | 'mask8'>): Promise<FieldStats>;

  cpu<A, R>(task: CpuTask<A, R>, args: A, transfer?: readonly ArrayBuffer[]): Promise<Awaited<R>>;
  readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
  progress(fraction: number, label?: string): void;
}

export interface EvalContext<
  P extends readonly ParamDef[] = readonly ParamDef[],
  I extends readonly PortDef[] = readonly PortDef[],
  O extends readonly PortDef[] = readonly PortDef[],
> extends OpContext {
  readonly params: ParamsOf<P>;
  readonly seed: number;
  setting(name: SettingName): number;
  enumIndex(name: EnumNames<P>): number;
  input<N extends I[number]['name']>(name: N): InputField<PortNamed<I, N>>;
  wants(name: O[number]['name']): boolean;
  output<N extends O[number]['name']>(name: N, field: Field<KindOfPortType<PortNamed<O, N>['type']>>): void;
  /** OpContext.loop, with the preview keyed by this node's output names. */
  loop<R>(iterations: number, body: (i: number) => R extends PromiseLike<unknown> ? 'loop body must be synchronous' : R, opts?: LoopOptions<O[number]['name']>): Promise<void>;
}

/** What the evaluator fixes before it calls a node's evaluate() (runtime.md 5.5 step 1). */
export interface InvocationInit {
  readonly nodeId: string;
  readonly def: NodeDef;
  readonly resolution: number;
  readonly settings: ProjectSettings;
  /** normalizeParams(def, instance.params).values. */
  readonly params: Readonly<Record<string, ParamValue>>;
  /** By declared input name: the published texture the input reads, converted where needed; null when unconnected. */
  readonly inputs: Readonly<Record<string, PoolTexture | null>>;
  /** The outputs for which ctx.wants() is true. */
  readonly wanted: ReadonlySet<string>;
  readonly signal: AbortSignal;
  readonly owner: StreamOwner;
  /** ctx.progress, and the progress ctx.loop and ctx.cpu report: the node's fraction, 0..1. */
  readonly onProgress: (fraction: number, label?: string) => void;
  /** The loans of 5.11, by output port, at every batch boundary at which they changed; null withdraws them. */
  readonly onLoans: (loans: Readonly<Record<string, PoolTexture>> | null) => void;
}

/** One call of a node's evaluate(): its context and what the evaluator does with it afterwards. */
export interface Invocation {
  readonly ctx: EvalContext;
  /** The most pool memory the invocation has held as WORKING (runtime.md 5.10 rule 4). */
  readonly peakBytes: number;
  /**
   * After evaluate() has resolved: the texture given to each output port. `alias` is true when it is one of the
   * invocation's inputs (5.6, pass-through). Throws the 'binding' failure `output "<name>" was not produced` for
   * a wanted output that was not given.
   */
  outputs(): ReadonlyMap<string, { readonly texture: PoolTexture; readonly alias: boolean }>;
  /**
   * Ends the invocation: every method of ctx throws from now on, every texture it allocated except those in
   * `keep` returns to FREE, its LUT buffers are destroyed. Idempotent.
   */
  end(keep?: ReadonlySet<PoolTexture>): void;
}

export function createInvocation(parts: EngineParts, init: InvocationInit): Invocation {
  throw new Error('not implemented: createInvocation');
}
