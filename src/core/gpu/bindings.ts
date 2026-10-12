import { KernelBindingError } from './errors.ts';
import { CHANNELS, type Field, type FieldKind, type Rgba, type SameShape } from './field.ts';
import type { AnyKernel } from './kernel.ts';
import { kernelShape } from './shape.ts';
import { UNIFORM_SHAPE } from './uniforms.ts';

export interface Lut<T extends 'f32' | 'vec4f' = 'f32' | 'vec4f'> {
  readonly type: T;
  readonly length: number;      // elements
}

export type UniformValue<T> =
  T extends 'f32' ? number
  : T extends 'i32' | 'u32' ? number | boolean
  : T extends 'vec2f' | 'vec2i' | 'vec2u' ? readonly [number, number]
  : T extends 'vec3f' ? readonly [number, number, number]
  : T extends 'vec4f' ? Rgba
  : never;

export type KindOfInput<D> = D extends FieldKind ? D : D extends { kind: infer K extends FieldKind } ? K : never;
export type OptionalInputs<I> = { [K in keyof I]: I[K] extends { default: number | Rgba } ? K : never }[keyof I];
export type InBindings<I> =
  & { [K in Exclude<keyof I, OptionalInputs<I>>]: Field<SameShape<KindOfInput<I[K]>>> }
  & { [K in OptionalInputs<I>]?: Field<SameShape<KindOfInput<I[K]>>> | null };
/** `Key` is required when the kernel declares anything for it and forbidden otherwise. */
export type Slot<Decl, Key extends string, Body> = [keyof Decl] extends [never] ? { [K in Key]?: undefined } : { [K in Key]: Body };

export type RunBindings<I, O, W, U, P, L> =
  & Slot<I, 'in', InBindings<I>>
  & Slot<O, 'out', { [K in keyof O]: Field<O[K] & FieldKind> | null }>
  & Slot<W & U, 'rw', { [K in keyof W]: Field<'field'> | null } & { [K in keyof U]: Field<'field'> }>
  & Slot<P, 'params', { [K in keyof P]: UniformValue<P[K]> }>
  & Slot<L, 'luts', { [K in keyof L]: Lut<L[K] & ('f32' | 'vec4f')> }>
  & { iteration?: number; cost?: number };

/** The bindings of any run, as the run-time checks see them. Every RunBindings<...> has this shape. */
export interface AnyRunBindings {
  readonly in?: Readonly<Record<string, Field | null | undefined>>;
  readonly out?: Readonly<Record<string, Field | null>>;
  readonly rw?: Readonly<Record<string, Field | null>>;
  readonly params?: Readonly<Record<string, number | boolean | readonly number[]>>;
  readonly luts?: Readonly<Record<string, Lut>>;
  readonly iteration?: number;
  readonly cost?: number;
}

/** What the checks of a run need to know beyond the kernel and the bindings. */
export interface BindingEnv {
  /** For the message prefix `kernel "<kernel>" (node <node id>, <node type>): `. */
  readonly nodeId: string;
  readonly nodeType: string;
  /** False gives `is not listed in NodeDef.kernels`. True for the node's kernels and for the engine's own. */
  listed(kernel: AnyKernel): boolean;
  /** True when the field was released, or does not belong to the running invocation. */
  released(field: Field): boolean;
  /** True when the Lut was created by ctx.lut() in the running invocation. */
  ownsLut(lut: Lut): boolean;
}

const SLOTS: ReadonlySet<string> = new Set(['in', 'out', 'rw', 'params', 'luts', 'iteration', 'cost']);
const channelsText = (kind: FieldKind): string => `${CHANNELS[kind]} channel${CHANNELS[kind] === 1 ? '' : 's'}`;
const sizeText = (field: Field): string => `${field.width}x${field.height}`;
const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null;
const isField = (value: unknown): value is Field => isObject(value) && typeof value.id === 'number' && typeof value.kind === 'string';

/** How a value that is not what a param needs is shown in a message. */
function shown(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(shown).join(', ')}]`;
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/** True when `value` is what one component of the scalar type holds. A boolean is 0 or 1 of an integer type. */
function fits(scalar: 'f32' | 'i32' | 'u32', value: unknown, component: boolean): boolean {
  if (typeof value === 'boolean') return scalar !== 'f32' && !component;
  if (typeof value !== 'number') return false;
  if (scalar === 'f32') return Number.isFinite(value) && Math.abs(value) <= 3.4028234663852886e38;
  if (!Number.isInteger(value)) return false;
  return scalar === 'i32' ? value >= -2147483648 && value <= 2147483647 : value >= 0 && value <= 4294967295;
}

/** Every check of engine.md 3.13 "At ctx.run()", in the order of that table. Throws KernelBindingError; encodes nothing. */
export function checkBindings(kernel: AnyKernel, bindings: AnyRunBindings, env: BindingEnv): void {
  const fail = (problem: string): never => {
    throw new KernelBindingError(`kernel "${kernel.name}" (node ${env.nodeId}, ${env.nodeType}): ${problem}`);
  };
  if (!env.listed(kernel)) fail('is not listed in NodeDef.kernels');

  const shape = kernelShape(kernel.def);
  const given = (isObject(bindings) ? bindings : {}) as Readonly<Record<string, unknown>>;
  const slot = (name: string): Readonly<Record<string, unknown>> => (isObject(given[name]) ? given[name] : {}) as Readonly<Record<string, unknown>>;
  const inSlot = slot('in'), outSlot = slot('out'), rwSlot = slot('rw'), paramSlot = slot('params'), lutSlot = slot('luts');
  const rwNames = [...shape.inPlace, ...shape.unsafe];

  // ---- unknown names -------------------------------------------------------------------------------------------
  for (const name of Object.keys(given)) {
    if (!SLOTS.has(name)) fail(`unknown slot "${name}"; a run has in, out, rw, params, luts, iteration and cost`);
  }
  const unknown = (slotName: string, entries: Readonly<Record<string, unknown>>, declared: readonly string[], what: string): void => {
    for (const name of Object.keys(entries)) {
      if (!declared.includes(name)) {
        fail(`unknown binding ${slotName}.${name}; the kernel declares ${declared.length > 0 ? `${what}: ${declared.join(', ')}` : `no ${what}`}`);
      }
    }
  };
  unknown('in', inSlot, shape.inputs.map((i) => i.name), 'inputs');
  unknown('out', outSlot, shape.outputs.map((o) => o.name), 'outputs');
  unknown('rw', rwSlot, rwNames, 'rw targets');
  unknown('luts', lutSlot, shape.luts.map((l) => l.name), 'luts');

  // ---- missing entries -----------------------------------------------------------------------------------------
  for (const input of shape.inputs) {
    const value = inSlot[input.name];
    if (input.default === null && (value === undefined || value === null)) {
      fail(`missing binding in.${input.name}. The input has no default; pass a field`);
    }
    if (value !== undefined && value !== null && !isField(value)) fail(`binding in.${input.name} is not a field`);
  }
  for (const output of shape.outputs) {
    const value = outSlot[output.name];
    if (value === undefined) fail(`missing binding out.${output.name}. Pass a field, or null to discard the output`);
    if (value !== null && !isField(value)) fail(`binding out.${output.name} is not a field`);
  }
  for (const name of shape.inPlace) {
    const value = rwSlot[name];
    if (value === undefined) fail(`missing binding rw.${name}. Pass a field, or null to discard the target`);
    if (value !== null && !isField(value)) fail(`binding rw.${name} is not a field`);
  }
  for (const name of shape.unsafe) {
    const value = rwSlot[name];
    if (value === undefined || value === null) fail(`missing binding rw.${name}. An unsafeReadWrite target cannot be discarded; pass a field`);
    if (!isField(value)) fail(`binding rw.${name} is not a field`);
  }
  for (const lut of shape.luts) {
    if (!isObject(lutSlot[lut.name])) fail(`missing binding luts.${lut.name}. Pass a Lut made by ctx.lut()`);
  }

  // ---- the fields ----------------------------------------------------------------------------------------------
  const inputs = shape.inputs.map((decl) => ({ decl, label: `input "${decl.name}"`, field: (inSlot[decl.name] ?? null) as Field | null }));
  const targets = [
    ...shape.outputs.map((o) => ({ label: `output "${o.name}"`, kind: o.kind, field: outSlot[o.name] as Field | null })),
    ...rwNames.map((name) => ({ label: `rw "${name}"`, kind: 'field' as FieldKind, field: rwSlot[name] as Field | null })),
  ];
  for (const { label, field } of [...inputs, ...targets]) {
    if (field && env.released(field)) fail(`field #${field.id} bound to ${label} was released`);
  }
  for (const { decl, label, field } of inputs) {
    if (field && CHANNELS[field.kind] !== decl.channels) {
      fail(`${label} is declared "${decl.kind}" (${channelsText(decl.kind)}) but field #${field.id} is "${field.kind}" (${channelsText(field.kind)})`);
    }
  }
  for (const { label, kind, field } of targets) {
    if (field && field.kind !== kind) fail(`${label} is declared "${kind}" but field #${field.id} is "${field.kind}"`);
  }
  for (const { label, field } of targets) {
    if (field?.readOnly) {
      fail(`${label} is bound to field #${field.id}, which is read-only (a node input, or already passed to ctx.output()). Use ctx.clone()`);
    }
  }
  const written = new Map<number, string>();
  for (const { label, field } of targets) {
    if (!field) continue;
    const other = written.get(field.id);
    if (other !== undefined) {
      fail(`field #${field.id} is bound to ${other} and ${label}. One run cannot write the same texture twice; bind another field`);
    }
    written.set(field.id, label);
  }
  for (const { label, field } of inputs) {
    const target = field ? written.get(field.id) : undefined;
    if (field && target !== undefined) {
      fail(`field #${field.id} is bound to ${label} and ${target}. One run cannot read and write the same texture; write to another field and swap`);
    }
  }
  const bound = targets.filter((t) => t.field !== null) as { readonly label: string; readonly field: Field }[];
  const grid = bound[0];
  for (const target of bound) {
    if (target.field.width !== grid!.field.width || target.field.height !== grid!.field.height) {
      fail(`${grid!.label} is ${sizeText(grid!.field)} but ${target.label} is ${sizeText(target.field)}. All writable targets of a run have the same size`);
    }
  }
  for (const target of bound) {
    if (target.field.width !== target.field.height) fail(`${target.label} is ${sizeText(target.field)}. Kernels write square grids`);
  }
  if (grid) {
    for (const { decl, label, field } of inputs) {
      if (!field || decl.size === 'any' || (field.width === 1 && field.height === 1)) continue;
      if (field.width !== grid.field.width || field.height !== grid.field.height) {
        fail(`${label} is ${sizeText(field)} but the run writes ${sizeText(grid.field)}. Declare the input with size: "any" and read it with ${decl.name}_uv(uv), or resample it first`);
      }
    }
  } else {
    fail('every writable target is null. Skip the run');
  }

  // ---- params --------------------------------------------------------------------------------------------------
  const fields = shape.params?.fields ?? [];
  for (const name of Object.keys(paramSlot)) {
    if (!fields.some((f) => f.name === name)) {
      fail(`unknown param "${name}"; the kernel declares ${fields.length > 0 ? fields.map((f) => f.name).join(', ') : 'no params'}`);
    }
  }
  for (const { name, type } of fields) {
    const value = paramSlot[name];
    if (value === undefined) fail(`missing param "${name}"`);
    const { count, scalar } = UNIFORM_SHAPE[type];
    if (count === 1) {
      if (typeof value === 'number' && Number.isNaN(value)) fail(`param "${name}" is NaN`);
      if (!fits(scalar, value, false)) fail(`param "${name}" (${type}) is ${shown(value)}`);
    } else {
      if (!Array.isArray(value)) fail(`param "${name}" needs ${count} numbers, got ${value === null ? 'null' : `a ${typeof value}`}`);
      const list = value as readonly unknown[];
      if (list.length !== count) fail(`param "${name}" needs ${count} numbers, got ${list.length}`);
      if (list.some((v) => typeof v === 'number' && Number.isNaN(v))) fail(`param "${name}" is NaN`);
      if (!list.every((v) => fits(scalar, v, true))) fail(`param "${name}" (${type}) is ${shown(list)}`);
    }
  }

  // ---- luts ----------------------------------------------------------------------------------------------------
  for (const { name, type } of shape.luts) {
    const lut = lutSlot[name] as unknown as Lut;
    if (lut.type !== type) fail(`lut "${name}" is declared ${type} but the Lut is ${String(lut.type)}`);
    if (!env.ownsLut(lut)) fail(`lut "${name}" was not created in this evaluation`);
  }

  // ---- the run's own values ------------------------------------------------------------------------------------
  const { iteration, cost } = given;
  if (iteration !== undefined && !fits('u32', iteration, true)) fail(`iteration is ${shown(iteration)}; it is an integer 0 .. 4294967295`);
  if (cost !== undefined && !(typeof cost === 'number' && Number.isFinite(cost) && cost > 0)) fail(`cost is ${shown(cost)}; it is a positive number`);
}
