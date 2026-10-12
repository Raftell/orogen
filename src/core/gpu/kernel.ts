import { STDLIB_WGSL } from '../wgsl/stdlib.ts';
import { KernelDefError } from './errors.ts';
import { CHANNELS, type FieldKind, type Rgba } from './field.ts';
import { isDefinedLib, orderLibs, type WgslLib } from './lib.ts';
import { findSequence, follows, moduleDeclarations, tokenize, type Token } from './scan.ts';
import { assertUnsealed } from './seal.ts';
import { packLayout, WGSL_LAYOUT } from './uniforms.ts';
import { FRAMEWORK_NAMES, GENERATED_NAMES, NAME_PATTERN, WGSL_PREDECLARED, WGSL_RESERVED } from './wgsl-names.ts';

export type UniformType = 'f32' | 'i32' | 'u32' | 'vec2f' | 'vec3f' | 'vec4f' | 'vec2i' | 'vec2u';

export interface InputOptions {
  readonly kind: FieldKind;
  readonly default?: number | Rgba;   // presence makes the input optional; an unbound input reads this value
  readonly saturate?: boolean;        // accessors return saturate(value); default false
  readonly size?: 'grid' | 'any';     // default 'grid'
}
export type InputDecl = FieldKind | InputOptions;            // a bare kind is { kind } : required, size 'grid'

/** The declaration of a mask input: optional, reads 1 when unbound, saturated on read. */
export const MASK_INPUT: { readonly kind: 'field'; readonly default: 1; readonly saturate: true } = {
  kind: 'field', default: 1, saturate: true,
};

export interface KernelDef {
  readonly name: string;
  readonly inputs?: Readonly<Record<string, InputDecl>>;
  readonly outputs?: Readonly<Record<string, FieldKind>>;
  readonly inPlace?: Readonly<Record<string, 'field'>>;
  readonly unsafeReadWrite?: Readonly<Record<string, 'field'>>;
  readonly raceFree?: string;
  readonly params?: Readonly<Record<string, UniformType>>;
  readonly luts?: Readonly<Record<string, 'f32' | 'vec4f'>>;
  readonly includes?: readonly WgslLib[];
  readonly mode?: 'map' | 'raw';
  readonly workgroup?: readonly [number, number];
  readonly tiled?: boolean;
  readonly cost?: number;
  readonly code: string;
}

export interface Kernel<I = {}, O = {}, W = {}, U = {}, P = {}, L = {}> {
  readonly name: string;
  readonly def: KernelDef;
  /** Type-level only: the declared inputs, outputs, inPlace, unsafeReadWrite, params and luts. */
  readonly __shape?: { i: I; o: O; w: W; u: U; p: P; l: L };
}
export type AnyKernel = Kernel<any, any, any, any, any, any>;

const KERNEL_NAME = /^[a-z]+\/[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)?(#[a-z0-9-]+)?$/;
const TEXTURE_BUILTINS: ReadonlySet<string> = new Set(['textureLoad', 'textureStore', 'textureDimensions', 'textureNumLevels']);
const FORBIDDEN_WORDS: ReadonlySet<string> = new Set(['override', 'enable', 'requires', 'diagnostic']);
const FORBIDDEN_MENTIONS: ReadonlySet<string> = new Set([
  'tileOrigin', 'local_invocation_id', 'local_invocation_index', 'workgroup_id', 'num_workgroups',
]);

/** The names the standard library declares, read from its text so that the two cannot drift apart. */
const STDLIB_NAMES: ReadonlySet<string> = new Set(moduleDeclarations(tokenize(STDLIB_WGSL)).map((d) => d.name));

/** The table of the process: every kernel name defineKernel has been given (engine.md, Module scope). */
const table = new Map<string, AnyKernel>();

type Role = 'input' | 'output' | 'inPlace' | 'unsafeReadWrite' | 'lut';

const isPositiveInteger = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

function validDefault(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  return Array.isArray(value) && value.length === 4 && value.every((v) => typeof v === 'number' && Number.isFinite(v));
}

/** The index of the brace that closes the one at `open`. */
function closingBrace(tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i]!.text === '{') depth++;
    else if (tokens[i]!.text === '}' && --depth === 0) return i;
  }
  return tokens.length;
}

export function defineKernel<
  const I extends Record<string, InputDecl> = {},
  const O extends Record<string, FieldKind> = {},
  const W extends Record<string, 'field'> = {},
  const U extends Record<string, 'field'> = {},
  const P extends Record<string, UniformType> = {},
  const L extends Record<string, 'f32' | 'vec4f'> = {},
>(def: {
  name: string; inputs?: I; outputs?: O; inPlace?: W; unsafeReadWrite?: U; raceFree?: string; params?: P; luts?: L;
  includes?: readonly WgslLib[]; mode?: 'map' | 'raw'; workgroup?: readonly [number, number]; tiled?: boolean; cost?: number;
  code: string;
}): Kernel<I, O, W, U, P, L> {
  assertUnsealed('defineKernel');
  const fail: (problem: string) => never = (problem) => { throw new KernelDefError(`kernel "${def.name}": ${problem}`); };

  if (typeof def.name !== 'string' || !KERNEL_NAME.test(def.name)) fail('invalid kernel name');
  if (table.has(def.name)) fail('a kernel with this name is already defined');
  if (typeof def.code !== 'string') fail('code must be a string of WGSL');

  const inputs: Readonly<Record<string, InputDecl>> = def.inputs ?? {};
  const outputs: Readonly<Record<string, FieldKind>> = def.outputs ?? {};
  const inPlace: Readonly<Record<string, string>> = def.inPlace ?? {};
  const unsafe: Readonly<Record<string, string>> = def.unsafeReadWrite ?? {};
  const luts: Readonly<Record<string, string>> = def.luts ?? {};
  const params: Readonly<Record<string, UniformType>> = def.params ?? {};
  const mode = def.mode ?? 'map';
  const workgroup = def.workgroup ?? [8, 8];

  // ---- resource names: one namespace ---------------------------------------------------------------------------
  const resources: { readonly role: Role; readonly name: string }[] = [
    ...Object.keys(inputs).map((name) => ({ role: 'input' as const, name })),
    ...Object.keys(outputs).map((name) => ({ role: 'output' as const, name })),
    ...Object.keys(inPlace).map((name) => ({ role: 'inPlace' as const, name })),
    ...Object.keys(unsafe).map((name) => ({ role: 'unsafeReadWrite' as const, name })),
    ...Object.keys(luts).map((name) => ({ role: 'lut' as const, name })),
  ];
  for (const { role, name } of resources) {
    if (!NAME_PATTERN.test(name)) fail(`${role} name "${name}" must match [a-z][A-Za-z0-9]*`);
  }
  for (const { role, name } of resources) {
    if (WGSL_RESERVED.has(name)) fail(`${role} name "${name}" is reserved in WGSL`);
    if (WGSL_PREDECLARED.has(name)) fail(`${role} name "${name}" would shadow a WGSL builtin`);
    if (STDLIB_NAMES.has(name)) fail(`${role} name "${name}" is a standard library name`);
    if (FRAMEWORK_NAMES.has(name)) fail(`${role} name "${name}" is reserved by the framework`);
  }
  const seen = new Set<string>();
  for (const { name } of resources) {
    if (seen.has(name)) fail(`"${name}" is declared twice (inputs, outputs, inPlace, unsafeReadWrite and luts share one namespace)`);
    seen.add(name);
  }

  // ---- params --------------------------------------------------------------------------------------------------
  for (const [name, type] of Object.entries(params)) {
    if (!NAME_PATTERN.test(name)) fail(`param name "${name}" must match [a-z][A-Za-z0-9]*`);
    if (WGSL_RESERVED.has(name)) fail(`param name "${name}" is reserved in WGSL`);
    if (!Object.hasOwn(WGSL_LAYOUT, type)) fail(`param "${name}" has the unknown type "${String(type)}"`);
  }

  // ---- declarations --------------------------------------------------------------------------------------------
  for (const [name, decl] of Object.entries(inputs)) {
    const kind = typeof decl === 'string' ? decl : decl?.kind;
    if (!Object.hasOwn(CHANNELS, kind)) fail(`input "${name}" has the unknown kind "${String(kind)}"`);
    if (typeof decl === 'object') {
      if (decl.default !== undefined && !validDefault(decl.default)) fail(`input "${name}" has an invalid default; it is a number or four numbers`);
      if (decl.size !== undefined && decl.size !== 'grid' && decl.size !== 'any') fail(`input "${name}" has an invalid size; it is "grid" or "any"`);
    }
  }
  for (const [name, kind] of Object.entries(outputs)) {
    if (!Object.hasOwn(CHANNELS, kind)) fail(`output "${name}" has the unknown kind "${String(kind)}"`);
  }
  for (const [name, kind] of Object.entries(inPlace)) {
    if (kind !== 'field') fail(`inPlace "${name}" is declared "${kind}"; only "field" can be updated in place`);
  }
  for (const [name, kind] of Object.entries(unsafe)) {
    if (kind !== 'field') fail(`unsafeReadWrite "${name}" is declared "${kind}"; only "field" can be read and written`);
  }
  for (const [name, type] of Object.entries(luts)) {
    if (type !== 'f32' && type !== 'vec4f') fail(`lut "${name}" has the unknown type "${type}"; it is "f32" or "vec4f"`);
  }
  if (mode !== 'map' && mode !== 'raw') fail(`mode is "${String(mode)}"; it is "map" or "raw"`);
  if (def.tiled !== undefined && typeof def.tiled !== 'boolean') fail('tiled must be a boolean');
  if (def.cost !== undefined && !(typeof def.cost === 'number' && Number.isFinite(def.cost) && def.cost > 0)) fail('cost must be a positive number');

  // ---- limits (engine.md 3.12) -----------------------------------------------------------------------------------
  const writable = Object.keys(outputs).length + Object.keys(inPlace).length + Object.keys(unsafe).length;
  if (writable > 4) fail(`${writable} writable textures (outputs + inPlace + unsafeReadWrite); the limit is 4`);
  if (Object.keys(inputs).length > 16) fail(`${Object.keys(inputs).length} inputs; the limit is 16`);
  if (Object.keys(luts).length > 8) fail(`${Object.keys(luts).length} luts; the limit is 8`);
  const paramsBytes = packLayout(params).size;
  if (paramsBytes > 256) fail(`Params is ${paramsBytes} bytes; the limit is 256`);
  if (!Array.isArray(workgroup) || workgroup.length !== 2 || !isPositiveInteger(workgroup[0]) || !isPositiveInteger(workgroup[1])) {
    fail('workgroup must be two positive integers');
  }
  if (workgroup[0] * workgroup[1] > 256) {
    fail(`workgroup ${workgroup[0]}x${workgroup[1]} has ${workgroup[0] * workgroup[1]} invocations; the limit is 256`);
  }
  if (writable === 0) fail('a kernel needs at least one output, inPlace or unsafeReadWrite target');
  if (Object.keys(unsafe).length > 0 && (mode !== 'raw' || typeof def.raceFree !== 'string' || def.raceFree.length < 20)) {
    fail('unsafeReadWrite requires mode "raw" and a raceFree justification');
  }

  // ---- author code -----------------------------------------------------------------------------------------------
  const tokens = tokenize(def.code);
  const declarations = moduleDeclarations(tokens);
  const declared = (keyword: string, name: string): number => declarations.find((d) => d.keyword === keyword && d.name === name)?.at ?? -1;
  const hasEntryPoint = findSequence(tokens, ['@', 'compute']) >= 0;

  if (mode === 'map') {
    const compute = declared('fn', 'compute');
    if (compute < 0 || tokens[compute + 1]?.text !== '(') fail('map mode needs "fn compute("');
    if (hasEntryPoint) fail('map mode code may not declare an @compute entry point; write "fn compute(" or use mode "raw"');
    const accessors = new Set<string>([
      ...Object.keys(outputs).map((name) => `${name}_set`),
      ...Object.keys(inPlace).flatMap((name) => [`${name}_set`, `${name}_get`]),
    ]);
    for (let i = 0; i < tokens.length; i++) {
      if (accessors.has(tokens[i]!.text) && tokens[i + 1]?.text === '(') {
        fail(`map mode code may not call ${tokens[i]!.text}(); return the value from compute`);
      }
    }
  } else {
    const main = declared('fn', 'main');
    if (main < 0 || tokens[main + 1]?.text !== '(') fail('raw mode needs "fn main("');
    if (!hasEntryPoint) fail(`raw mode main needs "@compute @workgroup_size(${workgroup[0]}, ${workgroup[1]})"`);
    const size = findSequence(tokens, ['@', 'workgroup_size', '(']);
    const sizeArgs: string[] = [];
    for (let i = size + 3; size >= 0 && i < tokens.length && tokens[i]!.text !== ')'; i++) {
      if (tokens[i]!.text !== ',') sizeArgs.push(tokens[i]!.text);
    }
    const dims = [sizeArgs[0] ?? '', sizeArgs[1] ?? '1', sizeArgs[2] ?? '1'].map((text) => Number(text.replace(/[iu]$/, '')));
    if (size < 0 || sizeArgs.length > 3 || dims[0] !== workgroup[0] || dims[1] !== workgroup[1] || dims[2] !== 1) {
      fail(`raw mode @workgroup_size(${sizeArgs.join(', ')}) differs from workgroup [${workgroup[0]}, ${workgroup[1]}]`);
    }
    // main's parameter list ends at the parenthesis that matches the one after the name; its body follows.
    let close = main + 1, depth = 0;
    for (; close < tokens.length; close++) {
      if (tokens[close]!.text === '(') depth++;
      else if (tokens[close]!.text === ')' && --depth === 0) break;
    }
    const body = close + 1;
    const gid = tokens[body + 6];
    const first = '{ if ( ! beginPixel ('.split(' ');
    if (!follows(tokens, body, first) || !gid?.ident || !follows(tokens, body + 7, ') ) { return ; }'.split(' '))) {
      fail('raw mode main must start with "if (!beginPixel(gid)) { return; }"');
    }
    const end = closingBrace(tokens, body);
    for (let i = body + 7; i < end; i++) {
      if (tokens[i]!.text === gid!.text) fail(`raw mode main may use "${gid!.text}" only in the call to beginPixel; take the texel from pixel()`);
    }
  }

  // Rule 1 of engine.md 3.2: texture builtins.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (!t.ident || tokens[i + 1]?.text !== '(') continue;
    if (t.text.startsWith('textureSample') || t.text.startsWith('textureGather')) {
      fail(`author code calls ${t.text}; fields are read through accessors and are never sampled`);
    }
    if (!TEXTURE_BUILTINS.has(t.text)) continue;
    const arg = tokens[i + 2]?.text === '&' ? tokens[i + 3] : tokens[i + 2];
    const target = arg?.ident ? arg.text : '';
    if (Object.hasOwn(unsafe, target)) continue;
    const remedy = !Object.hasOwn(inputs, target) ? 'only an unsafeReadWrite target is accessed directly'
      : t.text === 'textureLoad' ? `use ${target}_at(p)`
      : t.text === 'textureDimensions' ? `use ${target}_res()`
      : t.text === 'textureStore' ? 'an input is read-only'
      : 'a field has one mip level';
    fail(`author code calls ${t.text} on "${target}"; ${remedy}`);
  }
  // Rule 2: underscore names. A lone "_" is the phony assignment, not an identifier.
  for (const t of tokens) {
    if (t.ident && t.text.length > 1 && t.text.startsWith('_')) fail(`author code uses "${t.text}"; names beginning with "_" are reserved`);
  }
  // Rule 3: what belongs to the framework.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.text === '@' && (tokens[i + 1]?.text === 'group' || tokens[i + 1]?.text === 'binding')) {
      fail(`author code contains "@${tokens[i + 1]!.text}"; the framework declares every binding`);
    }
    if (FORBIDDEN_WORDS.has(t.text)) fail(`author code contains "${t.text}"; a kernel module has no ${t.text} declaration`);
    if (FORBIDDEN_MENTIONS.has(t.text)) fail(`author code mentions "${t.text}"; the texel comes from px or pixel() (engine.md 3.15)`);
  }
  // Rule 4: names declared at module scope.
  const includes = def.includes ?? [];
  includes.forEach((lib, i) => {
    if (!isDefinedLib(lib)) fail(`includes[${i}] is not a library made by defineLib`);
  });
  const { ordered: libs, clash } = orderLibs(includes);
  const generated = new Set<string>([...GENERATED_NAMES, mode === 'map' ? 'main' : 'compute']);
  for (const { name } of declarations) {
    if (STDLIB_NAMES.has(name)) fail(`author code declares "${name}", a standard library name`);
    if (generated.has(name)) fail(`author code declares "${name}", a generated name`);
    const resource = resources.find((r) => name.startsWith(`${r.name}_`));
    if (resource) fail(`author code declares "${name}"; names beginning with "${resource.name}_" belong to the ${resource.role} "${resource.name}"`);
    const lib = libs.find((l) => name.startsWith(`${l.name}_`));
    if (lib) fail(`author code declares "${name}"; names beginning with "${lib.name}_" belong to the library "${lib.name}"`);
  }
  if (clash !== null) fail(`two different libraries are named "${clash}"`);

  const frozen: KernelDef = Object.freeze({
    ...def,
    inputs: Object.freeze({ ...inputs }),
    outputs: Object.freeze({ ...outputs }),
    inPlace: Object.freeze({ ...def.inPlace }),
    unsafeReadWrite: Object.freeze({ ...def.unsafeReadWrite }),
    params: Object.freeze({ ...params }),
    luts: Object.freeze({ ...def.luts }),
    includes: Object.freeze([...includes]),
    workgroup: Object.freeze([workgroup[0], workgroup[1]] as const),
  });
  const kernel: Kernel<I, O, W, U, P, L> = Object.freeze({ name: def.name, def: frozen });
  table.set(def.name, kernel);
  return kernel;
}
