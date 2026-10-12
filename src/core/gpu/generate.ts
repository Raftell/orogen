import { FRAME_WGSL, STDLIB_WGSL } from '../wgsl/stdlib.ts';
import type { FieldKind } from './field.ts';
import type { KernelDef } from './kernel.ts';
import { kernelShape } from './shape.ts';

/** Where a line of an assembled module comes from (runtime.md 5.8). */
export type WgslOrigin = 'code' | 'generated' | `library:${string}`;

export interface WgslSegment {
  readonly origin: WgslOrigin;
  readonly firstLine: number;     // 1-based line of the assembled module at which the segment begins
  readonly lineCount: number;
}

/** One group-1 binding, in binding order: inputs, outputs, inPlace, unsafeReadWrite, luts (engine.md 3.2). */
export type Group1Entry =
  | { readonly role: 'input'; readonly name: string; readonly kind: FieldKind }
  | { readonly role: 'output'; readonly name: string; readonly kind: FieldKind }
  | { readonly role: 'inPlace'; readonly name: string }
  | { readonly role: 'unsafeReadWrite'; readonly name: string }
  | { readonly role: 'lut'; readonly name: string; readonly type: 'f32' | 'vec4f' };

export interface GeneratedModule {
  readonly wgsl: string;
  readonly segments: readonly WgslSegment[];     // in module order; together they cover every line
  readonly group1: readonly Group1Entry[];
}

const VALUE_TYPE = { 1: 'f32', 2: 'vec2f', 4: 'vec4f' } as const;
const LOAD_SUFFIX = { 1: '', 2: '2', 4: '4' } as const;
const STORED = { 1: 'vec4f(v, 0.0, 0.0, 1.0)', 2: 'vec4f(v, 0.0, 1.0)', 4: 'v' } as const;

/** Assembles the module of engine.md 3.2 for a definition that defineKernel has accepted. Pure. */
export function generateWgsl(def: KernelDef, formats: Readonly<Record<FieldKind, GPUTextureFormat>>): GeneratedModule {
  const shape = kernelShape(def);
  const group1: Group1Entry[] = [];
  const declarations: string[] = [FRAME_WGSL];
  const accessors: string[] = [];

  if (shape.params) {
    declarations.push('struct Params {', ...shape.params.fields.map((f) => `  ${f.name}: ${f.type},`), '};');
    declarations.push('@group(0) @binding(1) var<uniform> P: Params;');
  }

  shape.inputs.forEach((input, index) => {
    const { name } = input;
    const type = VALUE_TYPE[input.channels];
    const suffix = LOAD_SUFFIX[input.channels];
    const read = (call: string): string => (input.saturate ? `saturate(${call})` : call);
    declarations.push(`@group(1) @binding(${group1.length}) var ${name}: texture_2d<f32>;`);
    group1.push({ role: 'input', name, kind: input.kind });
    accessors.push(
      `alias ${name}_t = ${type};`,
      `fn ${name}_at(p: vec2i) -> ${type} { return ${read(`ld${suffix}(${name}, p)`)}; }`,
      `fn ${name}_uv(uv: vec2f) -> ${type} { return ${read(`bilinear${suffix}(${name}, uv)`)}; }`,
      `fn ${name}_lerp(t: vec2f) -> ${type} { return ${read(`bilinearPx${suffix}(${name}, t)`)}; }`,
      `fn ${name}_res() -> vec2u { return textureDimensions(${name}); }`,
      `fn ${name}_bound() -> bool { return (frame.bound & ${2 ** index}u) != 0u; }`,
    );
  });
  for (const { name, kind, channels } of shape.outputs) {
    const type = VALUE_TYPE[channels];
    declarations.push(`@group(1) @binding(${group1.length}) var _o_${name}: texture_storage_2d<${formats[kind]}, write>;`);
    group1.push({ role: 'output', name, kind });
    accessors.push(
      `alias ${name}_t = ${type};`,
      `fn ${name}_set(v: ${type}) { textureStore(_o_${name}, _px, ${STORED[channels]}); }`,
    );
  }
  for (const name of shape.inPlace) {
    declarations.push(`@group(1) @binding(${group1.length}) var _ip_${name}: texture_storage_2d<r32float, read_write>;`);
    group1.push({ role: 'inPlace', name });
    accessors.push(
      `fn ${name}_get() -> f32 { return textureLoad(_ip_${name}, _px).r; }`,
      `fn ${name}_set(v: f32) { textureStore(_ip_${name}, _px, vec4f(v, 0.0, 0.0, 1.0)); }`,
    );
  }
  for (const name of shape.unsafe) {
    declarations.push(`@group(1) @binding(${group1.length}) var ${name}: texture_storage_2d<r32float, read_write>;`);
    group1.push({ role: 'unsafeReadWrite', name });
  }
  for (const { name, type } of shape.luts) {
    declarations.push(`@group(1) @binding(${group1.length}) var<storage, read> _lut_${name}: array<${type}>;`);
    group1.push({ role: 'lut', name, type });
    accessors.push(
      `fn ${name}_len() -> u32 { return arrayLength(&_lut_${name}); }`,
      `fn ${name}_item(i: u32) -> ${type} { return _lut_${name}[min(i, ${name}_len() - 1u)]; }`,
      `fn ${name}_at(t: f32) -> ${type} {`,
      `  let _x = saturate(t) * f32(${name}_len() - 1u);`,
      `  let _i = u32(floor(_x));`,
      `  return mix(${name}_item(_i), ${name}_item(_i + 1u), _x - floor(_x));`,
      '}',
    );
  }

  const single = shape.outputs.length === 1 && shape.inPlace.length === 0;
  let entry: string[] = [];
  if (shape.mode === 'map') {
    if (!single) {
      declarations.push(
        'struct Out {',
        ...shape.outputs.map((o) => `  ${o.name}: ${VALUE_TYPE[o.channels]},`),
        ...shape.inPlace.map((name) => `  ${name}: f32,`),
        '};',
      );
      if (shape.inPlace.length > 0) {
        declarations.push('struct Cur {', ...shape.inPlace.map((name) => `  ${name}: f32,`), '};');
      }
    }
    const call = shape.inPlace.length > 0
      ? `compute(_px, uvOf(_px), Cur(${shape.inPlace.map((name) => `${name}_get()`).join(', ')}))`
      : 'compute(_px, uvOf(_px))';
    entry = [
      `@compute @workgroup_size(${shape.workgroup[0]}, ${shape.workgroup[1]})`,
      'fn main(@builtin(global_invocation_id) _gid: vec3u) {',
      '  if (!beginPixel(_gid)) { return; }',
      ...(single
        ? [`  ${shape.outputs[0]!.name}_set(${call});`]
        : [`  let _o = ${call};`, ...[...shape.outputs.map((o) => o.name), ...shape.inPlace].map((name) => `  ${name}_set(_o.${name});`)]),
      '}',
    ];
  }

  // Each part ends its last line, so a part's line count is the number of newlines it holds and the
  // author's code keeps its own line numbers within its segment.
  const parts: { readonly origin: WgslOrigin; readonly text: string }[] = [
    { origin: 'generated', text: declarations.join('\n') },
    { origin: 'generated', text: STDLIB_WGSL },
    { origin: 'generated', text: accessors.join('\n') },
    ...shape.libs.map((lib) => ({ origin: `library:${lib.name}` as const, text: lib.code })),
    { origin: 'code' as const, text: def.code },
    { origin: 'generated' as const, text: entry.join('\n') },
  ];
  const segments: WgslSegment[] = [];
  let wgsl = '';
  let line = 1;
  for (const part of parts) {
    if (part.text.length === 0) continue;
    const text = `${part.text}\n`;
    const lineCount = text.split('\n').length - 1;
    segments.push({ origin: part.origin, firstLine: line, lineCount });
    wgsl += text;
    line += lineCount;
  }
  return { wgsl, segments, group1 };
}
