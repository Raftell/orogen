// The generated module of engine.md 3.2, compared with the text the contract prints. GPU-free: generateWgsl is
// pure. tests/engine/gpu/kernels.test.ts compiles and runs what is generated.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { FieldKind } from '../../../src/core/gpu/field.ts';
import { generateWgsl } from '../../../src/core/gpu/generate.ts';
import { defineKernel, MASK_INPUT } from '../../../src/core/gpu/kernel.ts';
import { defineLib } from '../../../src/core/gpu/lib.ts';
import { hash } from '../../../src/core/wgsl/hash.ts';
import { noise } from '../../../src/core/wgsl/noise.ts';
import { FRAME_WGSL, STDLIB_WGSL } from '../../../src/core/wgsl/stdlib.ts';

const CORE: Readonly<Record<FieldKind, GPUTextureFormat>> = {
  field: 'r32float', vec2: 'rg32float', color: 'rgba16float', aux: 'rgba32float', half: 'r32float', half2: 'rg32float', mask8: 'r32float',
};
const COMPACT: Readonly<Record<FieldKind, GPUTextureFormat>> = { ...CORE, half: 'r16float', half2: 'rg16float', mask8: 'r8unorm' };

const engineMd = readFileSync(new URL('../../../docs/contract/engine.md', import.meta.url), 'utf8');
/** The one ```wgsl block of engine.md that contains `needle`. */
function printed(needle: string): string {
  const blocks = [...engineMd.matchAll(/^```wgsl\n([\s\S]*?)^```/gm)].map((m) => m[1]!).filter((b) => b.includes(needle));
  assert.equal(blocks.length, 1, `one wgsl block with ${JSON.stringify(needle)}`);
  return blocks[0]!.trimEnd();
}
const lines = (text: string): string[] => text.split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0);

const TALUS_CODE = /* wgsl */ `
fn exchange(hp: f32, q: vec2i, dist: f32) -> f32 {
  if (!inGrid(q)) { return 0.0; }
  let d = h_at(q) - hp;
  return sign(d) * max(abs(d) - P.talus * dist, 0.0) * P.rate / dist;
}

fn compute(px: vec2i, uv: vec2f, cur: Cur) -> Out {
  let hp = h_at(px);
  return Out(hp, cur.moved);
}`;
const talus = defineKernel({
  name: 'ref/talus.step',
  inputs: { h: 'field' },
  outputs: { next: 'field' },
  inPlace: { moved: 'field' },
  params: { talus: 'f32', rate: 'f32' },
  code: TALUS_CODE,
});

test('the normative WGSL of the contract is the WGSL of the engine', () => {
  assert.equal(FRAME_WGSL, printed('struct Frame {\n  res: vec2u'), 'struct Frame, engine.md section 2');
  assert.equal(STDLIB_WGSL, printed('var<private> _px: vec2i;'), 'the standard library, engine.md 3.8');
  assert.equal(hash.code, printed('fn hash_u32(x: u32) -> u32'), 'the library hash, engine.md 3.9');
});

test('the module of ref/talus.step is the one engine.md 3.2 prints', () => {
  const module = generateWgsl(talus.def, CORE);
  const expected = printed('struct Frame { /* section 2 */ };');
  const actual = module.wgsl
    .replace(FRAME_WGSL, 'struct Frame { /* section 2 */ };\n@group(0) @binding(0) var<uniform> frame: Frame;')
    .replace(STDLIB_WGSL, '/* standard library, section 3.8 */')
    .replace(TALUS_CODE, '/* author code: fn exchange(...), fn compute(px, uv, cur) -> Out */');
  assert.deepEqual(lines(actual), lines(expected));
  assert.deepEqual(module.group1, [
    { role: 'input', name: 'h', kind: 'field' }, { role: 'output', name: 'next', kind: 'field' }, { role: 'inPlace', name: 'moved' },
  ]);
});

test('one output and no in-place target: no Out, no Cur, and the body the contract prints', () => {
  const kernel = defineKernel({
    name: 'test/single', inputs: { src: 'color' }, outputs: { out: 'color' },
    code: 'fn compute(px: vec2i, uv: vec2f) -> vec4f { return src_at(px); }',
  });
  const { wgsl } = generateWgsl(kernel.def, CORE);
  assert.ok(!wgsl.includes('struct Out') && !wgsl.includes('struct Cur') && !wgsl.includes('struct Params') && !wgsl.includes('var<uniform> P'));
  assert.ok(wgsl.endsWith([
    '@compute @workgroup_size(8, 8)',
    'fn main(@builtin(global_invocation_id) _gid: vec3u) {',
    '  if (!beginPixel(_gid)) { return; }',
    '  out_set(compute(_px, uvOf(_px)));',
    '}',
    '',
  ].join('\n')));
});

test('the order of the module: declarations, standard library, accessors, libraries, code, entry point', () => {
  const lib = defineLib({ name: 'orderLib', code: 'fn orderLib_f(x: f32) -> f32 { return hash_unit(hash_u32(u32(x))); }', deps: [hash] });
  const kernel = defineKernel({
    name: 'test/order', inputs: { src: 'field' }, outputs: { a: 'field', b: 'vec2' }, params: { k: 'f32' }, luts: { ramp: 'f32' },
    includes: [lib, noise],
    code: 'fn compute(px: vec2i, uv: vec2f) -> Out { return Out(orderLib_f(src_at(px)), vec2f(noise_value(uv, 1u))); }',
  });
  const { wgsl, segments } = generateWgsl(kernel.def, CORE);
  const order = [
    'struct Frame {', 'struct Params {', '@group(1) @binding(0) var src', 'struct Out {', 'var<private> _px: vec2i;', 'fn src_at(',
    'fn hash_u32(', 'fn orderLib_f(', 'fn noise_value(', 'fn compute(', '@compute @workgroup_size(8, 8)',
  ].map((needle) => wgsl.indexOf(needle));
  assert.ok(order.every((at) => at >= 0), 'every part is present');
  assert.deepEqual([...order].sort((x, y) => x - y), order, 'in the order of engine.md 3.2');
  assert.equal(wgsl.split('fn hash_u32(').length - 1, 1, 'a library reached twice is emitted once');
  assert.deepEqual(segments.map((s) => s.origin), ['generated', 'generated', 'generated', 'library:hash', 'library:orderLib', 'library:noise', 'code', 'generated']);
});

test('segments cover every line, and the author code keeps its line numbers', () => {
  const code = '\n// line 2\nfn compute(px: vec2i, uv: vec2f) -> f32 {\n  return 1.0;   // line 4\n}';
  const kernel = defineKernel({ name: 'test/segments', outputs: { out: 'field' }, includes: [noise], code });
  const { wgsl, segments } = generateWgsl(kernel.def, CORE);
  const moduleLines = wgsl.split('\n');
  assert.equal(moduleLines.pop(), '', 'the module ends with a newline');
  let next = 1;
  for (const segment of segments) {
    assert.equal(segment.firstLine, next, 'segments follow one another');
    next += segment.lineCount;
  }
  assert.equal(next - 1, moduleLines.length, 'together they cover every line');
  const author = segments.find((s) => s.origin === 'code')!;
  assert.equal(author.lineCount, code.split('\n').length);
  code.split('\n').forEach((line, i) => assert.equal(moduleLines[author.firstLine - 1 + i], line, `line ${i + 1} of the code`));
  const library = segments.find((s) => s.origin === 'library:noise')!;
  assert.equal(moduleLines[library.firstLine - 1], noise.code.split('\n')[0]);
});

test('bindings are numbered from 0 in the order inputs, outputs, inPlace, unsafeReadWrite, luts', () => {
  const kernel = defineKernel({
    name: 'test/bindings', mode: 'raw',
    inputs: { a: 'field', b: { kind: 'color', size: 'any' }, m: MASK_INPUT },
    outputs: { o: 'vec2', q: 'aux' },
    inPlace: { acc: 'field' },
    unsafeReadWrite: { g: 'field' },
    raceFree: 'the test stores to g only at its own texel and never loads g',
    luts: { ramp: 'vec4f', taps: 'f32' },
    code: '@compute @workgroup_size(8, 8)\nfn main(@builtin(global_invocation_id) gid: vec3u) {\n  if (!beginPixel(gid)) { return; }\n}',
  });
  const { wgsl, group1 } = generateWgsl(kernel.def, CORE);
  const declared = [
    '@group(1) @binding(0) var a: texture_2d<f32>;',
    '@group(1) @binding(1) var b: texture_2d<f32>;',
    '@group(1) @binding(2) var m: texture_2d<f32>;',
    '@group(1) @binding(3) var _o_o: texture_storage_2d<rg32float, write>;',
    '@group(1) @binding(4) var _o_q: texture_storage_2d<rgba32float, write>;',
    '@group(1) @binding(5) var _ip_acc: texture_storage_2d<r32float, read_write>;',
    '@group(1) @binding(6) var g: texture_storage_2d<r32float, read_write>;',
    '@group(1) @binding(7) var<storage, read> _lut_ramp: array<vec4f>;',
    '@group(1) @binding(8) var<storage, read> _lut_taps: array<f32>;',
  ];
  for (const line of declared) assert.ok(wgsl.includes(`${line}\n`), line);
  assert.deepEqual(group1.map((e) => `${e.role}:${e.name}`), [
    'input:a', 'input:b', 'input:m', 'output:o', 'output:q', 'inPlace:acc', 'unsafeReadWrite:g', 'lut:ramp', 'lut:taps',
  ]);
  // Raw mode: no entry point, no Out, no Cur; x_set and x_get exist for the author's main.
  assert.ok(!wgsl.includes('_gid') && !wgsl.includes('struct Out') && !wgsl.includes('struct Cur'));
  for (const fn of ['fn o_set(v: vec2f)', 'fn q_set(v: vec4f)', 'fn acc_get() -> f32', 'fn acc_set(v: f32)']) assert.ok(wgsl.includes(fn), fn);
});

test('accessors by channel count, with saturate and the bound bit', () => {
  const kernel = defineKernel({
    name: 'test/accessors',
    inputs: { one: 'half', two: 'half2', four: 'aux', m: MASK_INPUT, sat: { kind: 'color', saturate: true } },
    outputs: { out: 'field' },
    code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return 0.0; }',
  });
  const { wgsl } = generateWgsl(kernel.def, CORE);
  const expected = [
    'alias one_t = f32;',
    'fn one_at(p: vec2i) -> f32 { return ld(one, p); }',
    'fn one_uv(uv: vec2f) -> f32 { return bilinear(one, uv); }',
    'fn one_lerp(t: vec2f) -> f32 { return bilinearPx(one, t); }',
    'fn one_res() -> vec2u { return textureDimensions(one); }',
    'fn one_bound() -> bool { return (frame.bound & 1u) != 0u; }',
    'alias two_t = vec2f;',
    'fn two_at(p: vec2i) -> vec2f { return ld2(two, p); }',
    'fn two_uv(uv: vec2f) -> vec2f { return bilinear2(two, uv); }',
    'fn two_lerp(t: vec2f) -> vec2f { return bilinearPx2(two, t); }',
    'fn two_bound() -> bool { return (frame.bound & 2u) != 0u; }',
    'alias four_t = vec4f;',
    'fn four_at(p: vec2i) -> vec4f { return ld4(four, p); }',
    'fn four_uv(uv: vec2f) -> vec4f { return bilinear4(four, uv); }',
    'fn four_lerp(t: vec2f) -> vec4f { return bilinearPx4(four, t); }',
    'fn four_bound() -> bool { return (frame.bound & 4u) != 0u; }',
    'fn m_at(p: vec2i) -> f32 { return saturate(ld(m, p)); }',
    'fn m_uv(uv: vec2f) -> f32 { return saturate(bilinear(m, uv)); }',
    'fn m_lerp(t: vec2f) -> f32 { return saturate(bilinearPx(m, t)); }',
    'fn m_bound() -> bool { return (frame.bound & 8u) != 0u; }',
    'fn sat_at(p: vec2i) -> vec4f { return saturate(ld4(sat, p)); }',
    'fn sat_bound() -> bool { return (frame.bound & 16u) != 0u; }',
    'alias out_t = f32;',
    'fn out_set(v: f32) { textureStore(_o_out, _px, vec4f(v, 0.0, 0.0, 1.0)); }',
  ];
  for (const line of expected) assert.ok(wgsl.includes(`${line}\n`), line);
});

test('x_set stores f32 as (v, 0, 0, 1), vec2f as (v, 0, 1) and vec4f unchanged', () => {
  const kernel = defineKernel({
    name: 'test/stores', outputs: { a: 'mask8', b: 'half2', c: 'color' },
    code: 'fn compute(px: vec2i, uv: vec2f) -> Out { return Out(0.0, vec2f(0.0), vec4f(0.0)); }',
  });
  const core = generateWgsl(kernel.def, CORE).wgsl;
  assert.ok(core.includes('var _o_a: texture_storage_2d<r32float, write>;'));
  assert.ok(core.includes('var _o_b: texture_storage_2d<rg32float, write>;'));
  assert.ok(core.includes('fn a_set(v: f32) { textureStore(_o_a, _px, vec4f(v, 0.0, 0.0, 1.0)); }'));
  assert.ok(core.includes('fn b_set(v: vec2f) { textureStore(_o_b, _px, vec4f(v, 0.0, 1.0)); }'));
  assert.ok(core.includes('fn c_set(v: vec4f) { textureStore(_o_c, _px, v); }'));
  assert.ok(core.includes('struct Out {\n  a: f32,\n  b: vec2f,\n  c: vec4f,\n};'));
  assert.ok(core.includes('  let _o = compute(_px, uvOf(_px));\n  a_set(_o.a);\n  b_set(_o.b);\n  c_set(_o.c);\n}'));

  // The format follows the device (engine.md 1.2); the value types do not.
  const compact = generateWgsl(kernel.def, COMPACT).wgsl;
  assert.ok(compact.includes('var _o_a: texture_storage_2d<r8unorm, write>;'));
  assert.ok(compact.includes('var _o_b: texture_storage_2d<rg16float, write>;'));
  assert.ok(compact.includes('var _o_c: texture_storage_2d<rgba16float, write>;'));
  assert.ok(compact.includes('fn a_set(v: f32)') && compact.includes('fn b_set(v: vec2f)'));
});

test('LUT accessors are the text the contract prints', () => {
  const kernel = defineKernel({
    name: 'test/luts', outputs: { out: 'field' }, luts: { x: 'vec4f' },
    code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return x_at(uv.x).r; }',
  });
  const { wgsl } = generateWgsl(kernel.def, CORE);
  const text = printed('fn x_len() -> u32 { return arrayLength(&_lut_x); }').replaceAll('-> T', '-> vec4f');
  assert.ok(wgsl.includes(`${text}\n`), text);
});

test('several in-place targets: Cur is built from x_get in declaration order', () => {
  const kernel = defineKernel({
    name: 'test/in-place', inPlace: { a: 'field', b: 'field' },
    code: 'fn compute(px: vec2i, uv: vec2f, cur: Cur) -> Out { return Out(cur.b, cur.a); }',
  });
  const { wgsl } = generateWgsl(kernel.def, CORE);
  assert.ok(wgsl.includes('struct Out {\n  a: f32,\n  b: f32,\n};\nstruct Cur {\n  a: f32,\n  b: f32,\n};'));
  assert.ok(wgsl.includes('  let _o = compute(_px, uvOf(_px), Cur(a_get(), b_get()));\n  a_set(_o.a);\n  b_set(_o.b);\n}'));
});

test('the workgroup size of the definition is the workgroup size of the entry point', () => {
  const kernel = defineKernel({ name: 'test/workgroup', workgroup: [16, 4], outputs: { out: 'field' }, code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return 0.0; }' });
  assert.ok(generateWgsl(kernel.def, CORE).wgsl.includes('@compute @workgroup_size(16, 4)\nfn main('));
});
