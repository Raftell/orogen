import type { CpuTask } from '../cpu/tasks.ts';
import type { AnyRunBindings, Lut, RunBindings } from '../gpu/bindings.ts';
import { deviceLostError } from '../gpu/device.ts';
import { FieldAccessError } from '../gpu/errors.ts';
import { CHANNELS, type Field, type FieldKind, type Rgba } from '../gpu/field.ts';
import { mixSeed } from '../gpu/hash.ts';
import type { AnyKernel, Kernel } from '../gpu/kernel.ts';
import { createLutBuffer, lutBytes } from '../gpu/lut.ts';
import type { PoolTexture } from '../gpu/pool.ts';
import { encodeRun } from '../gpu/run.ts';
import type { StreamOwner } from '../gpu/stream.ts';
import type { ProjectSettings } from '../graph/doc.ts';
import { ladder as ladderOf } from '../graph/ladder.ts';
import type { NodeDef, SettingName } from '../graph/node.ts';
import type { EnumNames, ParamDef, ParamsOf, ParamValue } from '../graph/param-types.ts';
import type { InputField, KindOfPortType, PortDef, PortNamed } from '../graph/ports.ts';
import { byContext, ContextError } from './errors.ts';
import type { EngineParts } from './parts.ts';
import { nextFieldId } from './service.ts';
import { fieldStats } from './stats.ts';

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
   * Ends the invocation: every method of ctx throws from now on, its loans are withdrawn, its owner is closed,
   * every texture it allocated except those in `keep` returns to FREE, its LUT buffers are destroyed. Idempotent.
   */
  end(keep?: ReadonlySet<PoolTexture>): void;
}

/** engine.md 3.12. */
const MAX_SIDE = 8192;

/** A field of one invocation. `readOnly` is true for an input and from ctx.output() on. */
interface Entry {
  readonly field: Field;
  readonly texture: PoolTexture;
  readonly input: boolean;
  readOnly: boolean;
  released: boolean;
  /** Reads of the field that have not settled: its contents must not change while one copies them (runtime.md 5.7). */
  reading: number;
}

const noop = (): void => undefined;
const isThenable = (value: unknown): boolean =>
  (typeof value === 'object' || typeof value === 'function') && value !== null && typeof (value as { then?: unknown }).then === 'function';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const member of Object.values(value)) deepFreeze(member);
  }
  return value;
}

export function createInvocation(parts: EngineParts, init: InvocationInit): Invocation {
  const { def, nodeId, signal, owner, settings } = init;
  const { stream, pool } = parts;
  const res = init.resolution;
  const seedParam = def.params.some((p) => p.kind === 'seed');
  const frameSeed = mixSeed(settings.seed, seedParam ? Number(init.params.seed ?? 0) : 0);
  const ladder: readonly number[] = Object.freeze(ladderOf(res));
  const params = deepFreeze({ ...init.params });

  const entries = new Map<number, Entry>();
  const inputFields = new Map<string, Field | null>();
  const outputs = new Map<string, Entry>();
  const luts = new Map<Lut, { readonly buffer: GPUBuffer; readonly reservation: { release(): void } }>();
  let workingBytes = 0;
  let peakBytes = 0;
  let settled = false;
  let inBody = false;
  let iteration = 0;
  /** By output port, the field lent to the viewer (runtime.md 5.11). */
  let loans: ReadonlyMap<string, Entry> | null = null;

  function newEntry<K extends FieldKind>(texture: PoolTexture, kind: K, input: boolean): Entry & { readonly field: Field<K> } {
    const entry = {
      field: {
        kind, width: texture.width, height: texture.height, id: nextFieldId(),
        get readOnly(): boolean { return entry.readOnly; },
      },
      texture, input, readOnly: input, released: false, reading: 0,
    };
    entries.set(entry.field.id, entry);
    return entry;
  }

  for (const port of def.inputs) {
    const texture = init.inputs[port.name] ?? null;
    inputFields.set(port.name, texture ? newEntry(texture, texture.kind, true).field : null);
  }

  // ---- the checks every method begins with (runtime.md 3.7) ------------------------------------------------------
  /** Throws when the invocation has ended, the device is lost or the evaluation is cancelled. */
  function alive(): void {
    if (settled) throw new ContextError('The evaluation context was used after evaluate() had settled');
    if (parts.gpu.lost) throw deviceLostError(parts.gpu);
    if (signal.aborted) throw signal.reason;
  }
  /** On entry to a method that encodes or allocates: the node's owner is current again, whatever ran since. */
  function enter(): void {
    alive();
    stream.use(owner);
  }
  function outsideBody(method: string): void {
    if (inBody) throw new ContextError(`ctx.${method}() cannot be called inside a ctx.loop body`);
  }
  /** A promise a node did not await must not end the process when it rejects; whoever awaits it still sees the rejection. */
  function guard<T>(promise: Promise<T>): Promise<T> {
    promise.catch(noop);
    return promise;
  }

  function entryOf(field: Field, use: string): Entry {
    const entry = field !== null && typeof field === 'object' ? entries.get(field.id) : undefined;
    if (!entry || entry.field !== field) throw new FieldAccessError(`${use}: the value is not a field of this evaluation`);
    if (entry.released) throw new FieldAccessError(`${use}: field #${field.id} was released`);
    return entry;
  }
  function writable(field: Field, use: string): Entry {
    const entry = entryOf(field, use);
    if (entry.readOnly) {
      throw new FieldAccessError(`${use}: field #${field.id} is read-only (a node input, or already passed to ctx.output()). Use ctx.clone()`);
    }
    if (entry.reading > 0) throw new ContextError(`${use}: field #${field.id} is being read; await ctx.read() before changing it`);
    return entry;
  }

  function acquire<K extends FieldKind>(kind: K, width: number, height: number): Entry & { readonly field: Field<K> } {
    const texture = pool.acquire(kind, width, height);
    workingBytes += texture.bytes;
    peakBytes = Math.max(peakBytes, workingBytes);
    return newEntry(texture, kind, false);
  }

  function clearValue(value: number | Rgba, use: string): Rgba {
    const rgba: readonly number[] = typeof value === 'number' ? [value, value, value, value] : value;
    if (!Array.isArray(rgba) || rgba.length !== 4 || !rgba.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      throw byContext(new TypeError(`${use}: the value is a finite number or four of them`));
    }
    return rgba as unknown as Rgba;
  }

  function sizeOf(opts: AllocOptions | undefined): readonly [number, number] {
    const size = opts?.size;
    if (size !== undefined) return typeof size === 'number' ? [size, size] : [size[0], size[1]];
    if (opts?.like !== undefined) {
      const like = entryOf(opts.like, 'ctx.alloc');
      return [like.texture.width, like.texture.height];
    }
    return [res, res];
  }

  function withdrawLoans(): void {
    if (!loans) return;
    loans = null;
    init.onLoans(null);
  }

  /** 5.11 rule 1: what preview() returns becomes the loans; a change is reported before the next call of body. */
  function refreshLoans(preview: () => Readonly<Partial<Record<string, Field>>>): void {
    const lent = preview();
    const next = new Map<string, Entry>();
    for (const [name, field] of Object.entries(lent ?? {})) {
      if (field === undefined || field === null) continue;
      const port = def.outputs.find((p) => p.name === name);
      if (!port) throw new ContextError(`ctx.loop: preview() returned "${name}", which is not an output of ${def.type}`);
      const entry = entryOf(field, `ctx.loop: preview "${name}"`);
      const kind = portKind(port);
      if (entry.field.kind !== kind) {
        throw new FieldAccessError(`ctx.loop: preview "${name}" is field #${field.id} of kind "${field.kind}"; the output is "${kind}"`);
      }
      next.set(name, entry);
    }
    const same = loans !== null && loans.size === next.size && [...next].every(([name, entry]) => loans!.get(name) === entry);
    if (same) return;
    if (next.size === 0) {
      withdrawLoans();
      return;
    }
    loans = next;
    const lentTextures: Record<string, PoolTexture> = {};
    for (const [name, entry] of next) lentTextures[name] = entry.texture;
    init.onLoans(lentTextures);
  }

  /** The kind an output port carries: for `sameAs`, the kind of that input's field. */
  function portKind(port: PortDef): 'field' | 'color' {
    if (port.type === 'field' || port.type === 'color') return port.type;
    const source = typeof port.type === 'object' ? inputFields.get(port.type.sameAs) : null;
    return source?.kind === 'color' ? 'color' : 'field';
  }

  let progressed = 0;
  function report(fraction: number, label: string | undefined): void {
    if (!Number.isFinite(fraction)) return;
    // Fractions are in 0..1 and do not decrease (runtime.md 5.10 rule 3).
    progressed = Math.max(progressed, Math.min(1, Math.max(0, fraction)));
    init.onProgress(progressed, label);
  }

  async function runLoop(iterations: number, body: (i: number) => unknown, opts: LoopOptions | undefined): Promise<void> {
    const [from, to] = opts?.progress ?? [0, 1];
    let mark = stream.submitted;
    for (let i = 0; i < iterations; i++) {
      enter();
      inBody = true;
      iteration = i;
      let returned: unknown;
      try {
        returned = body(i);
      } finally {
        inBody = false;
        iteration = 0;
      }
      if (isThenable(returned)) {
        (returned as Promise<unknown>).then(noop, noop);
        throw new ContextError('ctx.loop: the body returned a promise; a loop body must be synchronous');
      }
      const last = i === iterations - 1;
      if (stream.submitted === mark && !last) continue;
      // A batch boundary (runtime.md 3.6). Nothing is left unsubmitted, so what is lent holds complete iterations
      // while the wait below lets the viewer draw.
      stream.use(owner);
      stream.submit();
      if (opts?.preview) refreshLoans(opts.preview as () => Readonly<Partial<Record<string, Field>>>);
      await stream.boundary(last);
      enter();
      mark = stream.submitted;
      report(from + (to - from) * ((i + 1) / iterations), opts?.label);
    }
  }

  const ctx: EvalContext = {
    res,
    cellSize: settings.terrainSize / Math.max(res - 1, 1),
    terrainSize: settings.terrainSize,
    heightRange: settings.heightRange,
    ladder,
    signal,
    params,

    get seed(): number {
      if (!seedParam) throw new ContextError(`ctx.seed: ${def.type} has no seed param; declare param.seed() to read the seed`);
      return frameSeed;
    },

    setting(name) {
      alive();
      if (!(def.uses ?? []).includes(name)) {
        throw new ContextError(`ctx.setting("${name}"): ${def.type} does not declare the setting in "uses"`);
      }
      return settings[name];
    },

    enumIndex(name) {
      alive();
      const param = def.params.find((p) => p.name === name);
      if (!param || param.kind !== 'enum') throw new ContextError(`ctx.enumIndex("${String(name)}"): ${def.type} has no enum param of that name`);
      return param.options.findIndex((o) => o.value === params[param.name]);
    },

    input(name: string) {
      alive();
      if (!inputFields.has(name)) throw new ContextError(`ctx.input("${name}"): ${def.type} has no input of that name`);
      return inputFields.get(name) as never;
    },

    wants(name) {
      alive();
      if (!def.outputs.some((p) => p.name === name)) throw new ContextError(`ctx.wants("${name}"): ${def.type} has no output of that name`);
      return init.wanted.has(name);
    },

    output(name: string, field: Field) {
      alive();
      outsideBody('output');
      const port = def.outputs.find((p) => p.name === name);
      if (!port) throw new ContextError(`ctx.output("${name}"): ${def.type} has no output of that name`);
      if (outputs.has(name)) throw new FieldAccessError(`ctx.output("${name}"): the output was already given`);
      const entry = entryOf(field, `ctx.output("${name}")`);
      const kind = portKind(port);
      if (field.kind !== kind) {
        throw new FieldAccessError(`ctx.output("${name}"): field #${field.id} is "${field.kind}"; the output is "${kind}"`);
      }
      if (field.width !== res || field.height !== res) {
        throw new FieldAccessError(`ctx.output("${name}"): field #${field.id} is ${field.width}x${field.height}; an output is ${res}x${res}`);
      }
      entry.readOnly = true;
      outputs.set(name, entry);
    },

    lengthToPx(length, grid) {
      const n = grid === undefined ? res : typeof grid === 'number' ? grid : grid.width;
      return length * (n - 1);
    },
    lengthToMetres: (length) => length * settings.terrainSize,
    heightToMetres: (height) => height * settings.heightRange,

    alloc(kind, opts) {
      enter();
      if (!Object.hasOwn(CHANNELS, kind)) throw byContext(new TypeError(`ctx.alloc: "${String(kind)}" is not a field kind`));
      const [width, height] = sizeOf(opts);
      for (const side of [width, height]) {
        if (!Number.isInteger(side) || side < 1 || side > MAX_SIDE) {
          throw byContext(new RangeError(`ctx.alloc: a field side is 1 to ${MAX_SIDE} texels; ${width} x ${height} was requested`));
        }
      }
      const clear = opts?.clear === undefined ? null : clearValue(opts.clear, 'ctx.alloc');
      const entry = acquire(kind, width, height);
      if (clear) stream.clear(entry.texture, clear);
      return entry.field;
    },

    clone(field) {
      enter();
      const source = entryOf(field, 'ctx.clone');
      const copy = acquire(field.kind, source.texture.width, source.texture.height);
      stream.copy(source.texture, copy.texture);
      return copy.field;
    },

    clear(field, value = 0) {
      enter();
      const entry = writable(field, 'ctx.clear');
      stream.clear(entry.texture, clearValue(value, 'ctx.clear'));
    },

    release(field) {
      alive();
      const entry = entryOf(field, 'ctx.release');
      if (entry.input) throw new FieldAccessError(`ctx.release: field #${field.id} is an input of the node`);
      if (entry.readOnly) throw new FieldAccessError(`ctx.release: field #${field.id} was passed to ctx.output()`);
      if (entry.reading > 0) throw new ContextError(`ctx.release: field #${field.id} is being read; await ctx.read() before releasing it`);
      // A lent field must not reach the viewer after another owner has taken its texture.
      if (loans && [...loans.values()].includes(entry)) withdrawLoans();
      entry.released = true;
      workingBytes -= entry.texture.bytes;
      pool.release(entry.texture);
    },

    run(kernel: AnyKernel, bindings: unknown) {
      enter();
      const given = bindings as AnyRunBindings | null | undefined;
      for (const slot of [given?.out, given?.rw]) {
        for (const field of Object.values(slot ?? {})) {
          const entry = field !== null && typeof field === 'object' ? entries.get(field.id) : undefined;
          if (entry && entry.field === field && entry.reading > 0) {
            throw new ContextError(`ctx.run: field #${field.id} is being read; await ctx.read() before writing it`);
          }
        }
      }
      encodeRun(parts, kernel, given as AnyRunBindings, {
        nodeId,
        nodeType: def.type,
        listed: (k) => def.kernels.includes(k) || parts.isEngineKernel(k),
        released: (field) => {
          const entry = field !== null && typeof field === 'object' ? entries.get(field.id) : undefined;
          return !entry || entry.field !== field || entry.released;
        },
        ownsLut: (lut) => luts.has(lut),
        terrainSize: settings.terrainSize,
        heightRange: settings.heightRange,
        seed: frameSeed,
        iteration,
        texture: (field) => entries.get(field.id)!.texture,
        lutBuffer: (lut) => luts.get(lut)!.buffer,
      });
    },

    loop(iterations: number, body: (i: number) => unknown, opts?: LoopOptions) {
      enter();
      outsideBody('loop');
      if (!Number.isInteger(iterations) || iterations < 0) {
        throw byContext(new RangeError(`ctx.loop: ${String(iterations)} iterations; the count is an integer of at least 0`));
      }
      if (typeof body !== 'function') throw byContext(new TypeError('ctx.loop: the body is a function'));
      return guard(runLoop(iterations, body, opts));
    },

    flush() {
      enter();
      outsideBody('flush');
      return guard((async () => {
        await stream.flush();
        alive();
      })());
    },

    lut(data, type) {
      enter();
      outsideBody('lut');
      if (!(data instanceof Float32Array)) throw byContext(new TypeError('ctx.lut: the data is a Float32Array'));
      let made: ReturnType<typeof createLutBuffer>;
      try {
        made = createLutBuffer(parts.gpu.device, data, type);
      } catch (thrown) {
        throw thrown instanceof Error ? byContext(thrown) : thrown;
      }
      stream.track(made.scopes);
      const lut: Lut<typeof type> = Object.freeze({ type, length: type === 'vec4f' ? data.length / 4 : data.length });
      luts.set(lut, { buffer: made.buffer, reservation: pool.reserve(lutBytes(type, lut.length), 'lut') });
      return lut;
    },

    read(field, rows) {
      enter();
      outsideBody('read');
      const entry = entryOf(field, 'ctx.read');
      const [y0, y1] = rows ?? [0, entry.texture.height];
      if (!Number.isInteger(y0) || !Number.isInteger(y1) || y0 < 0 || y1 > entry.texture.height || y0 >= y1) {
        throw byContext(new RangeError(`ctx.read: rows [${y0}, ${y1}) are not rows of field #${field.id}, which is ${entry.texture.height} high`));
      }
      entry.reading++;
      return guard((async () => {
        try {
          const data = await parts.readback.read(entry.texture, [y0, y1], signal);
          alive();
          return data;
        } finally {
          entry.reading--;
        }
      })());
    },

    write(field, data, rows) {
      enter();
      outsideBody('write');
      const entry = writable(field, 'ctx.write');
      if (!(data instanceof Float32Array)) throw byContext(new TypeError('ctx.write: the data is a Float32Array'));
      try {
        stream.write(entry.texture, data, rows ?? [0, entry.texture.height]);
      } catch (thrown) {
        throw thrown instanceof RangeError ? byContext(thrown) : thrown;
      }
    },

    stats(field) {
      enter();
      outsideBody('stats');
      const entry = entryOf(field, 'ctx.stats');
      if (CHANNELS[entry.field.kind] !== 1) {
        throw new FieldAccessError(`ctx.stats: field #${field.id} is "${field.kind}"; statistics need a field of one channel`);
      }
      return guard((async () => {
        const result = await fieldStats(parts, entry.texture, signal);
        alive();
        return result;
      })());
    },

    cpu<A, R>(task: CpuTask<A, R>, args: A, transfer?: readonly ArrayBuffer[]) {
      alive();
      outsideBody('cpu');
      if (!(def.cpuTasks ?? []).includes(task)) {
        throw new ContextError(`ctx.cpu: the task "${String(task?.name)}" is not listed in NodeDef.cpuTasks of ${def.type}`);
      }
      return guard((async (): Promise<Awaited<R>> => {
        const result = await parts.cpu.run(task.name, args, transfer ?? [], { signal, onProgress: (fraction) => { if (!settled) report(fraction, undefined); } });
        alive();
        return result as Awaited<R>;
      })());
    },

    readFile(path) {
      alive();
      outsideBody('readFile');
      if (!def.externalKey && !def.params.some((p) => p.kind === 'file')) {
        throw new ContextError(`ctx.readFile: ${def.type} has neither a file param nor externalKey, so the file would not be part of its cache key`);
      }
      return guard((async () => {
        const bytes = await parts.files.read(path);
        alive();
        return bytes;
      })());
    },

    progress(fraction, label) {
      alive();
      outsideBody('progress');
      report(fraction, label);
    },
  };

  return {
    ctx,
    get peakBytes() { return peakBytes; },

    outputs() {
      for (const name of init.wanted) {
        if (!outputs.has(name)) throw new ContextError(`output "${name}" was not produced`);
      }
      const given = new Map<string, { readonly texture: PoolTexture; readonly alias: boolean }>();
      for (const [name, entry] of outputs) given.set(name, { texture: entry.texture, alias: entry.input });
      return given;
    },

    end(keep) {
      if (settled) return;
      settled = true;
      // 5.11 rule 4: withdrawn before the fields return to the pool.
      withdrawLoans();
      owner.close();
      for (const entry of entries.values()) {
        if (entry.input || entry.released) continue;
        entry.released = true;
        if (!keep?.has(entry.texture)) pool.release(entry.texture);
      }
      workingBytes = 0;
      for (const { buffer, reservation } of luts.values()) {
        if (!parts.gpu.lost) buffer.destroy();
        reservation.release();
      }
      luts.clear();
    },
  };
}
