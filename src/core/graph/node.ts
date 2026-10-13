import type { AnyCpuTask } from '../cpu/tasks.ts';
import type { EvalContext } from '../eval/context.ts';
import type { ExportContext, ExportHook, ExportItem } from '../export-decl.ts';
import { NodeDefError } from '../gpu/errors.ts';
import type { AnyKernel } from '../gpu/kernel.ts';
import type { WgslLib } from '../gpu/lib.ts';
import { assertUnsealed } from '../gpu/seal.ts';
import type { ParamDef, ParamsOf } from './param-types.ts';
import { TEXT_MAX_LENGTH } from './params.ts';
import { canBypass, type PortDef } from './ports.ts';

export type Category = 'generate' | 'adjust' | 'filter' | 'simulate' | 'select' | 'color' | 'surface' | 'io' | 'ref';

export type SettingName = 'seaLevel';

export interface ExternalKeyContext<P extends readonly ParamDef[] = readonly ParamDef[]> {
  readonly params: ParamsOf<P>;
  stat(path: string): Promise<{ readonly size: number; readonly mtimeMs: number } | null>;   // null: no such file
}

export interface NodeDef {
  readonly type: string;
  readonly title: string;
  readonly category: Category;
  readonly description: string;
  readonly keywords?: readonly string[];
  readonly inputs: readonly PortDef[];
  readonly outputs: readonly PortDef[];
  readonly params: readonly ParamDef[];
  readonly kernels: readonly AnyKernel[];
  readonly cpuTasks?: readonly AnyCpuTask[];
  readonly maskable?: boolean;
  readonly resolutionDependent?: boolean;
  readonly uses?: readonly SettingName[];
  readonly version?: number;
  migrate?(params: Record<string, unknown>, from: number): Record<string, unknown>;
  externalKey?(env: ExternalKeyContext): string | Promise<string>;
  evaluate(ctx: EvalContext): void | Promise<void>;
  readonly export?: ExportHook;                      // export nodes only; export-unreal.md 2.1
}

/** Makes a non-literal name a compile error on the offending element of a port or param list. */
export type LiteralNames<T extends readonly { readonly name: string }[], W extends string> =
  number extends T['length']
    ? (T extends readonly [...infer _H, infer _L] | readonly [infer _F, ...infer _R] ? LiteralNamesOf<T, W> : unknown)
    : LiteralNamesOf<T, W>;
export type LiteralNamesOf<T extends readonly { readonly name: string }[], W extends string> = {
  readonly [K in keyof T]: T[K] extends { readonly name: infer N extends string }
    ? (string extends N
        ? { readonly name: `${W} names must be string literals: write the definition inline, add "as const satisfies ...", or return Named<..., "name"> from the helper` }
        : unknown)
    : unknown;
};

export const CATEGORIES: readonly Category[] = ['generate', 'adjust', 'filter', 'simulate', 'select', 'color', 'surface', 'io', 'ref'];
export const SETTING_NAMES: readonly SettingName[] = ['seaLevel'];

const TYPE_PATTERN = /^[a-z]+\/[a-z][a-z0-9-]*$/;
const PORT_NAME = /^[a-z][A-Za-z0-9]{0,23}$/;
const PARAM_NAME = /^[a-z][A-Za-z0-9]*$/;
const FILTER = /^[a-z0-9]+$/;
const UNITS: readonly string[] = ['length', 'height', 'angle', 'ratio', 'none'];
const VEC2_UNITS: readonly string[] = ['length', 'ratio', 'none'];
const ROLES: readonly string[] = ['height', 'mask', 'data'];
const SEED_MAX = 2 ** 32 - 1;

/** engine.md 4.4: the names defineNode rejects, and the canonical name to use instead. */
const SYNONYMS: Readonly<Record<string, string>> = {
  scale: 'size', frequency: 'size',
  amount: 'strength', intensity: 'strength', opacity: 'strength',
  blur: 'radius',
  rotation: 'angle', rotate: 'angle',
};

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const unit01 = (v: unknown): boolean => finite(v) && v >= 0 && v <= 1;
const sameAsOf = (port: PortDef): string | null => (typeof port.type === 'object' && port.type !== null ? port.type.sameAs : null);

/** Whether the code of a kernel, or of a library it includes directly or through `deps`, reads the seed. */
function readsSeed(kernel: AnyKernel): boolean {
  const mentions = (code: string): boolean => code.includes('frame.seed') || code.includes('seedFor(');
  const seen = new Set<WgslLib>();
  const inLib = (lib: WgslLib): boolean => {
    if (seen.has(lib)) return false;
    seen.add(lib);
    return mentions(lib.code) || lib.deps.some(inLib);
  };
  return mentions(kernel.def.code) || (kernel.def.includes ?? []).some(inLib);
}

/** engine.md 4.2: the primary input; the first of two of equal rank; the first of the channels of a colour (r, g, b, a). */
const FIRST_INPUT_NAMES: readonly string[] = ['in', 'a', 'r'];

function checkPorts(inputs: readonly PortDef[], outputs: readonly PortDef[], fail: (problem: string) => never): void {
  for (const [side, ports] of [['input', inputs], ['output', outputs]] as const) {
    const seen = new Set<string>();
    for (const port of ports) {
      if (typeof port.name !== 'string' || !PORT_NAME.test(port.name)) fail(`${side} name "${port.name}" must match [a-z][A-Za-z0-9]{0,23}`);
      if (seen.has(port.name)) fail(`${side} "${port.name}" is declared twice`);
      seen.add(port.name);
    }
  }

  let optionalSeen = false;
  for (const port of inputs) {
    const at = `input "${port.name}"`;
    if (sameAsOf(port) !== null) fail(`${at}: sameAs is allowed only on outputs`);
    if (port.type !== 'field' && port.type !== 'color' && port.type !== 'any') fail(`${at}: unknown port type "${String(port.type)}"`);
    if (port.role !== undefined && port.type !== 'field') fail(`${at}: a role is allowed only on a port of type "field"`);
    if (port.role !== undefined && !ROLES.includes(port.role)) fail(`${at}: unknown role "${port.role}"`);
    if (port.optional) optionalSeen = true;
    else if (optionalSeen) fail(`${at}: a required input cannot follow an optional one`);
    if (port.name === 'mask' && !(port.type === 'field' && port.role === 'mask' && port.optional === true)) {
      fail('input "mask" must be an optional field with role "mask"');
    }
  }
  for (const port of outputs) {
    const at = `output "${port.name}"`;
    const sameAs = sameAsOf(port);
    if (port.type === 'any') fail(`${at}: type "any" is allowed only on inputs`);
    if (sameAs === null && port.type !== 'field' && port.type !== 'color') fail(`${at}: unknown port type "${String(port.type)}"`);
    if (port.role !== undefined && port.type !== 'field') fail(`${at}: a role is allowed only on a port of type "field"`);
    if (port.role !== undefined && !ROLES.includes(port.role)) fail(`${at}: unknown role "${port.role}"`);
    if (port.optional !== undefined) fail(`${at}: optional is allowed only on inputs`);
    if (sameAs !== null && !inputs.some((i) => i.name === sameAs && i.type === 'any' && !i.optional)) {
      fail(`${at}: sameAs names "${sameAs}", which is not a required input of type "any"`);
    }
  }
  if (outputs.length > 0 && outputs[0]!.name !== 'out') fail(`the first output must be named "out", not "${outputs[0]!.name}"`);
  if (inputs.length > 0 && !FIRST_INPUT_NAMES.includes(inputs[0]!.name)) {
    fail(`the first input must be named "in", "a" or "r", not "${inputs[0]!.name}"`);
  }
}

function checkRange(p: { readonly min: number; readonly max: number }, fail: (problem: string) => never): void {
  if (!finite(p.min) || !finite(p.max)) fail('min and max must be finite numbers');
  if (p.min >= p.max) fail(`min ${p.min} must be below max ${p.max}`);
}

function checkParam(p: ParamDef, params: readonly ParamDef[], fail: (problem: string) => never): void {
  if (typeof p.help !== 'string' || p.help.trim() === '') fail('help is empty');
  if (p.name in SYNONYMS) fail(`the name "${p.name}" is not allowed; use "${SYNONYMS[p.name]}"`);
  if (p.kind === 'seed' && p.name !== 'seed') fail('a seed param must be named "seed"');
  if (p.kind !== 'seed' && p.name === 'seed') fail('the name "seed" is reserved for the param of kind "seed"');

  switch (p.kind) {
    case 'float':
      if (!UNITS.includes(p.unit)) fail(p.unit === undefined ? 'a float needs a unit' : `unknown unit "${p.unit}"`);
      checkRange(p, fail);
      if (!finite(p.default) || p.default < p.min || p.default > p.max) fail(`default ${p.default} is outside ${p.min}..${p.max}`);
      if (p.scale !== undefined && p.scale !== 'linear' && p.scale !== 'log') fail(`unknown scale "${p.scale}"`);
      if (p.scale === 'log' && p.min <= 0) fail(`log scale needs min > 0; min is ${p.min}`);
      if (p.step !== undefined && !(finite(p.step) && p.step > 0)) fail(`step ${p.step} must be above 0`);
      break;
    case 'int':
      if (![p.min, p.max, p.default].every(Number.isInteger)) fail('min, max and default of an int must be integers');
      checkRange(p, fail);
      if (p.default < p.min || p.default > p.max) fail(`default ${p.default} is outside ${p.min}..${p.max}`);
      break;
    case 'bool':
      if (typeof p.default !== 'boolean') fail('the default of a bool must be true or false');
      break;
    case 'enum': {
      if (!Array.isArray(p.options) || p.options.length < 2) fail('an enum needs at least two options');
      const values = new Set<string>();
      for (const option of p.options) {
        if (typeof option.value !== 'string' || typeof option.label !== 'string') fail('an option needs a value and a label');
        if (values.has(option.value)) fail(`option value "${option.value}" is listed twice`);
        values.add(option.value);
      }
      if (!values.has(p.default)) fail(`default "${p.default}" is not among the options`);
      break;
    }
    case 'seed':
      if (!Number.isInteger(p.default) || p.default < 0 || p.default > SEED_MAX) fail(`default ${p.default} is not an integer in 0..${SEED_MAX}`);
      break;
    case 'vec2':
      if (!VEC2_UNITS.includes(p.unit)) fail(p.unit === undefined ? 'a vec2 needs a unit' : `unknown unit "${p.unit}" for a vec2`);
      checkRange(p, fail);
      if (!Array.isArray(p.default) || p.default.length !== 2 || !p.default.every((c) => finite(c) && c >= p.min && c <= p.max)) {
        fail(`default ${JSON.stringify(p.default)} is outside ${p.min}..${p.max}`);
      }
      break;
    case 'color':
      if (!Array.isArray(p.default) || p.default.length !== 3 || !p.default.every(unit01)) {
        fail(`default ${JSON.stringify(p.default)} is not three numbers in 0..1`);
      }
      break;
    case 'curve': {
      const points = p.default;
      if (!Array.isArray(points) || points.length < 2) fail('the default of a curve needs at least 2 points');
      if (!points.every((q) => unit01(q.x) && unit01(q.y))) fail('the default of a curve has x and y in 0..1');
      if (!points.every((q, i) => i === 0 || q.x > points[i - 1]!.x)) fail('the default of a curve has strictly increasing x');
      break;
    }
    case 'gradient': {
      const stops = p.default;
      if (!Array.isArray(stops) || stops.length < 2) fail('the default of a gradient needs at least 2 stops');
      if (!stops.every((s) => unit01(s.t) && Array.isArray(s.color) && s.color.length === 3 && s.color.every(unit01))) {
        fail('the default of a gradient has t and colours in 0..1');
      }
      if (!stops.every((s, i) => i === 0 || s.t >= stops[i - 1]!.t)) fail('the default of a gradient has non-decreasing t');
      break;
    }
    case 'file':
      if (p.default !== '') fail("the default of a file param is ''");
      if (!Array.isArray(p.filters) || !p.filters.every((f) => typeof f === 'string' && FILTER.test(f))) {
        fail('filters are lower-case extensions without the dot');
      }
      break;
    case 'text': {
      const max = p.maxLength ?? TEXT_MAX_LENGTH;
      if (!Number.isInteger(max) || max < 1) fail(`maxLength ${max} must be an integer above 0`);
      if (typeof p.default !== 'string' || p.default.length > max) fail(`the default is longer than ${max} characters`);
      break;
    }
    default:
      fail(`unknown kind "${String((p as { kind?: unknown }).kind)}"`);
  }

  const when = p.visibleWhen;
  if (when !== undefined) {
    const other = params.find((q) => q.name === when.param);
    if (!other || other === p || (other.kind !== 'bool' && other.kind !== 'enum' && other.kind !== 'int')) {
      fail(`visibleWhen names "${when.param}", which is not another bool, enum or int param of the node`);
    }
    const possible = (value: unknown): boolean => (other.kind === 'bool' ? typeof value === 'boolean'
      : other.kind === 'int' ? Number.isInteger(value) && (value as number) >= other.min && (value as number) <= other.max
      : other.options.some((o) => o.value === value));
    // One value, or a list of them: the control shows while the param has any of the list.
    const values: readonly unknown[] = Array.isArray(when.equals) ? when.equals : [when.equals];
    if (values.length === 0) fail(`visibleWhen compares "${when.param}" with an empty list, which never shows the control`);
    for (const value of values) {
      if (!possible(value)) fail(`visibleWhen compares "${when.param}" with ${JSON.stringify(value)}, a value it never has`);
    }
    if (new Set(values).size !== values.length) fail(`visibleWhen lists a value of "${when.param}" twice`);
  }
}

/** Throws NodeDefError for the first rule of engine.md 4.6 the definition breaks, in the order of its list. */
function validate(def: NodeDef): void {
  const fail = (problem: string): never => {
    throw new NodeDefError(`node "${def.type}": ${problem}`);
  };

  // 1. Patterns and duplicate names.
  if (typeof def.type !== 'string' || !TYPE_PATTERN.test(def.type)) fail('invalid node type; it is <category>/<name> with a lower-case name of letters, digits and hyphens');
  if (!CATEGORIES.includes(def.category)) fail(`unknown category "${def.category}"`);
  if (!def.type.startsWith(`${def.category}/`)) fail(`the type must begin with its category, "${def.category}/"`);
  if (!Array.isArray(def.inputs) || !Array.isArray(def.outputs) || !Array.isArray(def.params) || !Array.isArray(def.kernels)) {
    fail('inputs, outputs, params and kernels are lists');
  }
  for (const member of ['title', 'description'] as const) {
    if (typeof def[member] !== 'string' || def[member].trim() === '') fail(`${member} is empty`);
  }
  if (typeof def.evaluate !== 'function') fail('evaluate must be a function');
  const names = new Set<string>();
  for (const p of def.params) {
    if (typeof p.name !== 'string' || !PARAM_NAME.test(p.name)) fail(`param name "${p.name}" must match [a-z][A-Za-z0-9]*`);
    if (names.has(p.name)) fail(`param "${p.name}" is declared twice`);
    names.add(p.name);
  }

  // 2. Ports. Its name checks are part of rule 1.
  checkPorts(def.inputs, def.outputs, fail);

  // 3. Params.
  if (def.params.filter((p) => p.kind === 'seed').length > 1) fail('a node has at most one seed param');
  for (const p of def.params) checkParam(p, def.params, (problem) => fail(`param "${p.name}": ${problem}`));

  // 4. maskable.
  if (def.maskable) {
    if (def.inputs.some((i) => i.name === 'mask')) fail('maskable is set but the node declares its own input "mask"');
    if (!canBypass(def)) fail('maskable needs inputs[0] and outputs[0] of the same type');
  }

  // 5. Kernels and tasks listed twice.
  if (def.cpuTasks !== undefined && !Array.isArray(def.cpuTasks)) fail('cpuTasks is a list');
  for (const [what, member, list] of [['kernel', 'kernels', def.kernels], ['CPU task', 'cpuTasks', def.cpuTasks ?? []]] as const) {
    const seen = new Set<string>();
    for (const [i, item] of list.entries()) {
      const made = typeof item === 'object' && item !== null && typeof item.name === 'string'
        && (what === 'kernel' ? typeof (item as AnyKernel).def?.code === 'string' : typeof (item as AnyCpuTask).run === 'function');
      if (!made) fail(`${member}[${i}] is not a ${what}`);
      if (seen.has(item.name)) fail(`${what} "${item.name}" is listed twice`);
      seen.add(item.name);
    }
  }

  // 6. The seed.
  if (!def.params.some((p) => p.kind === 'seed')) {
    const reader = def.kernels.find(readsSeed);
    if (reader) fail(`kernel "${reader.name}" reads the seed (frame.seed or seedFor) but the node has no seed param; add param.seed()`);
  }

  // 7. Version and settings.
  const version = def.version ?? 1;
  if (!Number.isInteger(version) || version < 1) fail(`version ${version} must be an integer of at least 1`);
  if (version > 1 && typeof def.migrate !== 'function') fail(`version ${version} needs a migrate function`);
  for (const name of def.uses ?? []) {
    if (!SETTING_NAMES.includes(name)) fail(`uses names an unknown setting "${name}"`);
  }
}

export function defineNode<
  const P extends readonly ParamDef[],
  const I extends readonly PortDef[],
  const O extends readonly PortDef[],
>(def: Omit<NodeDef, 'inputs' | 'outputs' | 'params' | 'evaluate' | 'externalKey' | 'export'> & {
  inputs: I & LiteralNames<I, 'input'>;
  outputs: O & LiteralNames<O, 'output'>;
  params: P & LiteralNames<P, 'param'>;
  externalKey?(env: ExternalKeyContext<P>): string | Promise<string>;
  evaluate(ctx: EvalContext<P, I, O>): void | Promise<void>;
  export?(ctx: ExportContext<P, I>): readonly ExportItem[];
}): NodeDef {
  assertUnsealed('defineNode');
  // The members typed by P, I and O accept the untyped context: a node's own context is assignable to it (engine.md 4.7).
  const node = { ...def } as unknown as NodeDef;
  validate(node);
  return Object.freeze(node);
}
