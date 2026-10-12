// defineKernel: every check of engine.md 3.13 "At module load" and the message it prints (testing.md 8.1).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { KernelDefError } from '../../../src/core/gpu/errors.ts';
import { defineKernel, MASK_INPUT, type KernelDef } from '../../../src/core/gpu/kernel.ts';
import { defineLib } from '../../../src/core/gpu/lib.ts';
import { hash } from '../../../src/core/wgsl/hash.ts';
import { noise } from '../../../src/core/wgsl/noise.ts';

const MAP = 'fn compute(px: vec2i, uv: vec2f) -> f32 { return 0.0; }';
const RAW = `
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (!beginPixel(gid)) { return; }
  out_set(1.0);
}`;

let serial = 0;
/** A fresh valid name: a rejected definition must not be remembered, and an accepted one is. */
const fresh = (): string => `test/k${serial++}`;

type Loose = { [K in keyof KernelDef]?: unknown };
const define = (def: Loose): unknown => defineKernel(def as never);

/** Asserts that the definition is rejected with exactly `kernel "<name>": <problem>`. */
function rejects(def: Loose, problem: string): void {
  const name = (def.name ?? fresh()) as string;
  assert.throws(() => define({ outputs: { out: 'field' }, code: MAP, ...def, name }), (thrown: unknown) => {
    assert.ok(thrown instanceof KernelDefError, `KernelDefError expected, got ${String(thrown)}`);
    assert.equal(thrown.name, 'KernelDefError');
    assert.equal(thrown.message, `kernel "${name}": ${problem}`);
    return true;
  });
}

test('a valid kernel is returned with its name and definition', () => {
  const kernel = defineKernel({
    name: 'test/valid.pass#color',
    inputs: { src: 'color', mask: MASK_INPUT },
    outputs: { out: 'color' },
    params: { dir: 'vec2i' },
    code: 'fn compute(px: vec2i, uv: vec2f) -> out_t { return mix(src_at(px), src_at(px + P.dir), mask_at(px)); }',
  });
  assert.equal(kernel.name, 'test/valid.pass#color');
  assert.equal(kernel.def.name, 'test/valid.pass#color');
  assert.deepEqual(kernel.def.inputs, { src: 'color', mask: { kind: 'field', default: 1, saturate: true } });
  assert.deepEqual(kernel.def.params, { dir: 'vec2i' });
  assert.ok(Object.isFrozen(kernel) && Object.isFrozen(kernel.def));
});

test('MASK_INPUT is an optional saturated field that reads 1', () => {
  assert.deepEqual(MASK_INPUT, { kind: 'field', default: 1, saturate: true });
});

test('kernel names', () => {
  for (const name of ['Blur', 'filter', 'filter/', 'filter/Blur', 'filter/blur.', 'filter/blur.h.v', 'filter/blur#', 'filter/blur#A', 'my_cat/blur', 'filter/1blur', '']) {
    rejects({ name }, 'invalid kernel name');
  }
  for (const name of ['filter/blur', 'filter/blur.h', 'filter/blur.h#color', 'simulate/talus.step', 'ref/box-3#field', 'a/b-c.d-e#1-2']) {
    assert.doesNotThrow(() => define({ name, outputs: { out: 'field' }, code: MAP }), name);
  }
});

test('a name is used once in the process', () => {
  const name = fresh();
  define({ name, outputs: { out: 'field' }, code: MAP });
  rejects({ name }, 'a kernel with this name is already defined');
  rejects({ name, outputs: { other: 'color' } }, 'a kernel with this name is already defined');
});

test('a rejected definition does not take its name', () => {
  const name = fresh();
  rejects({ name, outputs: {} }, 'a kernel needs at least one output, inPlace or unsafeReadWrite target');
  assert.doesNotThrow(() => define({ name, outputs: { out: 'field' }, code: MAP }));
});

test('resource names must match [a-z][A-Za-z0-9]*', () => {
  rejects({ inputs: { Src: 'field' } }, 'input name "Src" must match [a-z][A-Za-z0-9]*');
  rejects({ inputs: { my_src: 'field' } }, 'input name "my_src" must match [a-z][A-Za-z0-9]*');
  rejects({ outputs: { '2nd': 'field' } }, 'output name "2nd" must match [a-z][A-Za-z0-9]*');
  rejects({ inPlace: { Acc: 'field' } }, 'inPlace name "Acc" must match [a-z][A-Za-z0-9]*');
  rejects({ mode: 'raw', raceFree: 'x'.repeat(20), unsafeReadWrite: { g_: 'field' }, code: RAW }, 'unsafeReadWrite name "g_" must match [a-z][A-Za-z0-9]*');
  rejects({ luts: { Ramp: 'f32' } }, 'lut name "Ramp" must match [a-z][A-Za-z0-9]*');
});

test('resource names that WGSL reserves, that shadow a builtin, or that the framework uses', () => {
  for (const name of ['filter', 'target', 'mod', 'smooth', 'type', 'from', 'set', 'ref', 'default', 'var', 'loop']) {
    rejects({ inputs: { [name]: 'field' } }, `input name "${name}" is reserved in WGSL`);
  }
  for (const name of ['min', 'max', 'mix', 'step', 'length', 'distance', 'sign', 'round', 'select', 'abs', 'pow', 'clamp', 'saturate', 'f32', 'vec2f', 'array', 'write', 'storage', 'r32float']) {
    rejects({ outputs: { [name]: 'field' } }, `output name "${name}" would shadow a WGSL builtin`);
  }
  for (const name of ['ld', 'ld4', 'bilinear', 'pixel', 'inGrid', 'uvOf', 'slopeAt', 'mixSeed', 'seedFor', 'beginPixel', 'clampToGrid', 'metresOf', 'ldMask', 'bilinearPx', 'normalAt']) {
    rejects({ inputs: { [name]: 'field' } }, `input name "${name}" is a standard library name`);
  }
  for (const name of ['frame', 'main', 'compute', 'cur', 'px', 'uv']) {
    rejects({ inputs: { [name]: 'field' } }, `input name "${name}" is reserved by the framework`);
  }
  rejects({ luts: { filter: 'f32' } }, 'lut name "filter" is reserved in WGSL');
  rejects({ inPlace: { mix: 'field' } }, 'inPlace name "mix" would shadow a WGSL builtin');
});

test('the names the contract calls usable are accepted', () => {
  const usable = ['src', 'in', 'out', 'mask', 'a', 'b', 'h', 'height', 'flow', 'water', 'sediment', 'deposit', 'next'];
  const inputs = Object.fromEntries(usable.filter((n) => n !== 'out' && n !== 'next').map((n) => [n, 'field']));
  assert.doesNotThrow(() => define({
    name: fresh(), inputs, outputs: { out: 'field', next: 'field' }, code: 'fn compute(px: vec2i, uv: vec2f) -> Out { return Out(0.0, 0.0); }',
  }));
});

test('inputs, outputs, inPlace, unsafeReadWrite and luts share one namespace', () => {
  const twice = (name: string): string => `"${name}" is declared twice (inputs, outputs, inPlace, unsafeReadWrite and luts share one namespace)`;
  rejects({ inputs: { h: 'field' }, outputs: { h: 'field' } }, twice('h'));
  rejects({ inputs: { h: 'field' }, inPlace: { h: 'field' } }, twice('h'));
  rejects({ outputs: { ramp: 'field' }, luts: { ramp: 'f32' } }, twice('ramp'));
  rejects({ mode: 'raw', raceFree: 'x'.repeat(20), outputs: { g: 'field' }, unsafeReadWrite: { g: 'field' }, code: RAW }, twice('g'));
});

test('param names', () => {
  for (const name of ['type', 'filter', 'smooth', 'target', 'from', 'default', 'active', 'pass', 'precision']) {
    rejects({ params: { [name]: 'f32' } }, `param name "${name}" is reserved in WGSL`);
  }
  rejects({ params: { Strength: 'f32' } }, 'param name "Strength" must match [a-z][A-Za-z0-9]*');
  rejects({ params: { my_param: 'f32' } }, 'param name "my_param" must match [a-z][A-Za-z0-9]*');
  rejects({ params: { amount: 'f64' } }, 'param "amount" has the unknown type "f64"');
  // Struct members do not shadow builtins.
  assert.doesNotThrow(() => define({
    name: fresh(), outputs: { out: 'field' }, params: { min: 'f32', max: 'f32', step: 'f32', mix: 'f32', scale: 'f32', mode: 'u32' }, code: MAP,
  }));
});

test('limits of engine.md 3.12', () => {
  rejects(
    { outputs: { a: 'field', b: 'field', c: 'field' }, inPlace: { d: 'field', e: 'field' }, code: 'fn compute(px: vec2i, uv: vec2f, cur: Cur) -> Out { return Out(0.0, 0.0, 0.0, 0.0, 0.0); }' },
    '5 writable textures (outputs + inPlace + unsafeReadWrite); the limit is 4',
  );
  assert.doesNotThrow(() => define({
    name: fresh(), outputs: { a: 'field', b: 'field' }, inPlace: { c: 'field', d: 'field' },
    code: 'fn compute(px: vec2i, uv: vec2f, cur: Cur) -> Out { return Out(0.0, 0.0, cur.c, cur.d); }',
  }));

  const inputs = (count: number): Record<string, string> => Object.fromEntries(Array.from({ length: count }, (_, i) => [`i${i}`, 'field']));
  rejects({ inputs: inputs(17) }, '17 inputs; the limit is 16');
  assert.doesNotThrow(() => define({ name: fresh(), inputs: inputs(16), outputs: { out: 'field' }, code: MAP }));

  const luts = (count: number): Record<string, string> => Object.fromEntries(Array.from({ length: count }, (_, i) => [`t${i}`, 'f32']));
  rejects({ luts: luts(9) }, '9 luts; the limit is 8');
  assert.doesNotThrow(() => define({ name: fresh(), luts: luts(8), outputs: { out: 'field' }, code: MAP }));

  const vec4s = (count: number): Record<string, string> => Object.fromEntries(Array.from({ length: count }, (_, i) => [`v${i}`, 'vec4f']));
  rejects({ params: vec4s(17) }, 'Params is 272 bytes; the limit is 256');
  assert.doesNotThrow(() => define({ name: fresh(), params: vec4s(16), outputs: { out: 'field' }, code: MAP }));

  rejects({ workgroup: [32, 16] }, 'workgroup 32x16 has 512 invocations; the limit is 256');
  rejects({ workgroup: [8, 0] }, 'workgroup must be two positive integers');
  rejects({ workgroup: [8] }, 'workgroup must be two positive integers');
  assert.doesNotThrow(() => define({ name: fresh(), workgroup: [16, 16], outputs: { out: 'field' }, code: MAP }));
});

test('a kernel needs a writable target', () => {
  rejects({ outputs: {}, inputs: { h: 'field' } }, 'a kernel needs at least one output, inPlace or unsafeReadWrite target');
  rejects({ outputs: undefined }, 'a kernel needs at least one output, inPlace or unsafeReadWrite target');
});

test('unsafeReadWrite requires raw mode and a justification of 20 characters', () => {
  const problem = 'unsafeReadWrite requires mode "raw" and a raceFree justification';
  rejects({ outputs: {}, unsafeReadWrite: { g: 'field' }, raceFree: 'x'.repeat(40) }, problem);
  rejects({ outputs: {}, unsafeReadWrite: { g: 'field' }, mode: 'raw', code: RAW }, problem);
  rejects({ outputs: {}, unsafeReadWrite: { g: 'field' }, mode: 'raw', raceFree: 'too short', code: RAW }, problem);
  assert.doesNotThrow(() => define({
    name: fresh(), mode: 'raw', unsafeReadWrite: { g: 'field' }, params: { parity: 'u32' },
    raceFree: 'red-black: an invocation stores only where (x + y + parity) is even and loads only where it is odd',
    code: `
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (!beginPixel(gid)) { return; }
  let px = pixel();
  if (((u32(px.x) + u32(px.y) + P.parity) & 1u) != 0u) { return; }
  let e = textureLoad(g, clampToGrid(px + vec2i(1, 0))).r;
  textureStore(g, px, vec4f(e, 0.0, 0.0, 1.0));
}`,
  }));
});

test('only "field" is updated in place', () => {
  rejects({ outputs: {}, inPlace: { acc: 'color' } }, 'inPlace "acc" is declared "color"; only "field" can be updated in place');
  rejects({ outputs: {}, mode: 'raw', raceFree: 'x'.repeat(20), unsafeReadWrite: { g: 'vec2' }, code: RAW }, 'unsafeReadWrite "g" is declared "vec2"; only "field" can be read and written');
});

test('declarations with unknown kinds, types and options', () => {
  rejects({ inputs: { h: 'float' } }, 'input "h" has the unknown kind "float"');
  rejects({ inputs: { h: { default: 1 } } }, 'input "h" has the unknown kind "undefined"');
  rejects({ outputs: { out: 'rgba' } }, 'output "out" has the unknown kind "rgba"');
  rejects({ luts: { ramp: 'vec3f' } }, 'lut "ramp" has the unknown type "vec3f"; it is "f32" or "vec4f"');
  rejects({ inputs: { h: { kind: 'field', default: [0, 0, 0] } } }, 'input "h" has an invalid default; it is a number or four numbers');
  rejects({ inputs: { h: { kind: 'field', default: Number.NaN } } }, 'input "h" has an invalid default; it is a number or four numbers');
  rejects({ inputs: { h: { kind: 'field', size: 'full' } } }, 'input "h" has an invalid size; it is "grid" or "any"');
  rejects({ mode: 'point' }, 'mode is "point"; it is "map" or "raw"');
  rejects({ cost: 0 }, 'cost must be a positive number');
  rejects({ tiled: 'no' }, 'tiled must be a boolean');
  rejects({ code: 5 }, 'code must be a string of WGSL');
});

test('map mode', () => {
  rejects({ code: 'fn shade(px: vec2i) -> f32 { return 0.0; }' }, 'map mode needs "fn compute("');
  rejects({ code: '// fn compute(px: vec2i, uv: vec2f) -> f32\nfn other() {}' }, 'map mode needs "fn compute("');
  rejects({ code: `${MAP}\n@compute @workgroup_size(8, 8) fn entry() {}` }, 'map mode code may not declare an @compute entry point; write "fn compute(" or use mode "raw"');
  rejects(
    { outputs: { next: 'field' }, code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { next_set(1.0); return 0.0; }' },
    'map mode code may not call next_set(); return the value from compute',
  );
  rejects(
    { outputs: {}, inPlace: { moved: 'field' }, code: 'fn compute(px: vec2i, uv: vec2f, cur: Cur) -> Out { return Out(moved_get()); }' },
    'map mode code may not call moved_get(); return the value from compute',
  );
  rejects(
    { outputs: {}, inPlace: { moved: 'field' }, code: 'fn compute(px: vec2i, uv: vec2f, cur: Cur) -> Out { moved_set(2.0); return Out(cur.moved); }' },
    'map mode code may not call moved_set(); return the value from compute',
  );
});

test('raw mode', () => {
  const start = 'raw mode main must start with "if (!beginPixel(gid)) { return; }"';
  rejects({ mode: 'raw', code: MAP }, 'raw mode needs "fn main("');
  rejects({ mode: 'raw', code: 'fn main(gid: vec3u) { if (!beginPixel(gid)) { return; } out_set(1.0); }' }, 'raw mode main needs "@compute @workgroup_size(8, 8)"');
  rejects({ mode: 'raw', code: RAW.replace('(8, 8)', '(4, 4)') }, 'raw mode @workgroup_size(4, 4) differs from workgroup [8, 8]');
  rejects({ mode: 'raw', workgroup: [16, 4], code: RAW }, 'raw mode @workgroup_size(8, 8) differs from workgroup [16, 4]');
  rejects({ mode: 'raw', code: RAW.replace('(8, 8)', '(8)') }, 'raw mode @workgroup_size(8) differs from workgroup [8, 8]');
  rejects({ mode: 'raw', code: RAW.replace('if (!beginPixel(gid)) { return; }', 'let px = vec2i(gid.xy);') }, start);
  rejects({ mode: 'raw', code: RAW.replace('if (!beginPixel(gid)) { return; }', 'let early = 1; if (!beginPixel(gid)) { return; }') }, start);
  rejects({ mode: 'raw', code: RAW.replace('{ return; }', '{ out_set(0.0); return; }') }, start);
  rejects(
    { mode: 'raw', code: RAW.replace('out_set(1.0);', 'out_set(f32(gid.x));') },
    'raw mode main may use "gid" only in the call to beginPixel; take the texel from pixel()',
  );
  assert.doesNotThrow(() => define({ name: fresh(), mode: 'raw', outputs: { out: 'field' }, code: RAW }));
  assert.doesNotThrow(() => define({ name: fresh(), mode: 'raw', workgroup: [16, 4], outputs: { out: 'field' }, code: RAW.replace('(8, 8)', '(16, 4)') }));
  // Any parameter name, any layout of the first statement.
  assert.doesNotThrow(() => define({
    name: fresh(), mode: 'raw', outputs: { out: 'field' },
    code: '@compute @workgroup_size(8,8,1)\nfn main(@builtin(global_invocation_id) id : vec3u) {\n  if(!beginPixel(id)){return;}\n  out_set(1.0);\n}',
  }));
});

test('rule 1 of 3.2: texture builtins', () => {
  rejects(
    { inputs: { src: 'field' }, code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return textureLoad(src, px, 0).r; }' },
    'author code calls textureLoad on "src"; use src_at(p)',
  );
  rejects(
    { inputs: { src: 'field' }, code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return f32(textureDimensions(src).x); }' },
    'author code calls textureDimensions on "src"; use src_res()',
  );
  rejects(
    { inputs: { src: 'field' }, code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { textureStore(src, px, vec4f(0.0)); return 0.0; }' },
    'author code calls textureStore on "src"; an input is read-only',
  );
  rejects(
    { inputs: { src: 'field' }, code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return f32(textureNumLevels(src)); }' },
    'author code calls textureNumLevels on "src"; a field has one mip level',
  );
  rejects(
    { code: `fn helper(t: texture_2d<f32>, p: vec2i) -> f32 { return textureLoad(t, p, 0).r; }\n${MAP}` },
    'author code calls textureLoad on "t"; only an unsafeReadWrite target is accessed directly',
  );
  rejects(
    { inputs: { src: 'field' }, code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return textureSampleLevel(src, smp, uv, 0.0).r; }' },
    'author code calls textureSampleLevel; fields are read through accessors and are never sampled',
  );
  rejects(
    { inputs: { src: 'field' }, code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return textureGather(0, src, smp, uv).r; }' },
    'author code calls textureGather; fields are read through accessors and are never sampled',
  );
  // A comment is not a call, and library helpers take a texture by name.
  assert.doesNotThrow(() => define({
    name: fresh(), inputs: { src: 'field' }, outputs: { out: 'field' },
    code: '// textureLoad(src, px, 0) is what src_at does\n/* textureStore(_o_out, ...) */\nfn compute(px: vec2i, uv: vec2f) -> f32 { return ld(src, px) + slopeAt(src, px).x; }',
  }));
});

test('rule 2 of 3.2: underscore names', () => {
  rejects({ code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return f32(_px.x); }' }, 'author code uses "_px"; names beginning with "_" are reserved');
  rejects({ code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { let _t = 1.0; return _t; }' }, 'author code uses "_t"; names beginning with "_" are reserved');
  rejects({ code: 'fn _help() -> f32 { return 1.0; }\nfn compute(px: vec2i, uv: vec2f) -> f32 { return _help(); }' }, 'author code uses "_help"; names beginning with "_" are reserved');
  // The phony assignment and an underscore inside a name are legal.
  assert.doesNotThrow(() => define({
    name: fresh(), outputs: { out: 'field' },
    code: 'const MAX_TAPS = 4;\nfn compute(px: vec2i, uv: vec2f) -> f32 { let a_b = 1.0; _ = a_b; return f32(MAX_TAPS) + 1.5e-3; }',
  }));
});

test('rule 3 of 3.2: what belongs to the framework', () => {
  rejects({ code: `@group(1) @binding(9) var extra: texture_2d<f32>;\n${MAP}` }, 'author code contains "@group"; the framework declares every binding');
  rejects({ code: `@binding(9) @group(1) var extra: texture_2d<f32>;\n${MAP}` }, 'author code contains "@binding"; the framework declares every binding');
  rejects({ code: `override taps: i32 = 4;\n${MAP}` }, 'author code contains "override"; a kernel module has no override declaration');
  rejects({ code: `enable f16;\n${MAP}` }, 'author code contains "enable"; a kernel module has no enable declaration');
  rejects({ code: `requires readonly_and_readwrite_storage_textures;\n${MAP}` }, 'author code contains "requires"; a kernel module has no requires declaration');
  rejects({ code: `diagnostic(off, derivative_uniformity);\n${MAP}` }, 'author code contains "diagnostic"; a kernel module has no diagnostic declaration');
  rejects(
    { code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return f32(frame.tileOrigin.y); }' },
    'author code mentions "tileOrigin"; the texel comes from px or pixel() (engine.md 3.15)',
  );
  for (const builtin of ['local_invocation_id', 'local_invocation_index', 'workgroup_id', 'num_workgroups']) {
    rejects(
      { mode: 'raw', code: RAW.replace('gid: vec3u', `gid: vec3u, @builtin(${builtin}) other: vec3u`) },
      `author code mentions "${builtin}"; the texel comes from px or pixel() (engine.md 3.15)`,
    );
  }
});

test('rule 4 of 3.2: names declared at module scope', () => {
  rejects({ code: `fn ld(p: vec2i) -> f32 { return 0.0; }\n${MAP}` }, 'author code declares "ld", a standard library name');
  rejects({ code: `const pixel = 1;\n${MAP}` }, 'author code declares "pixel", a standard library name');
  for (const name of ['Frame', 'Params', 'Out', 'Cur']) {
    rejects({ code: `struct ${name} { v: f32 }\n${MAP}` }, `author code declares "${name}", a generated name`);
  }
  rejects({ code: `const P = 1.0;\n${MAP}` }, 'author code declares "P", a generated name');
  rejects({ code: `alias frame = f32;\n${MAP}` }, 'author code declares "frame", a generated name');
  rejects({ code: `fn main() {}\n${MAP}` }, 'author code declares "main", a generated name');
  rejects({ mode: 'raw', code: `fn compute() {}\n${RAW}` }, 'author code declares "compute", a generated name');
  rejects(
    { inputs: { h: 'field' }, code: `fn h_at2(p: vec2i) -> f32 { return 0.0; }\n${MAP}` },
    'author code declares "h_at2"; names beginning with "h_" belong to the input "h"',
  );
  rejects(
    { outputs: { next: 'field' }, code: `const next_scale = 2.0;\n${MAP}` },
    'author code declares "next_scale"; names beginning with "next_" belong to the output "next"',
  );
  rejects(
    { luts: { ramp: 'f32' }, code: `fn ramp_sample() -> f32 { return 0.0; }\n${MAP}` },
    'author code declares "ramp_sample"; names beginning with "ramp_" belong to the lut "ramp"',
  );
  rejects(
    { includes: [noise], code: `fn noise_ridged(p: vec2f) -> f32 { return 0.0; }\n${MAP}` },
    'author code declares "noise_ridged"; names beginning with "noise_" belong to the library "noise"',
  );
  rejects(
    { includes: [noise], code: `const hash_SALT = 1u;\n${MAP}` },
    'author code declares "hash_SALT"; names beginning with "hash_" belong to the library "hash"',
  );
  // Names inside functions and struct members are not module scope.
  assert.doesNotThrow(() => define({
    name: fresh(), inputs: { h: 'field' }, outputs: { out: 'field' }, includes: [noise],
    code: 'struct Sample { ld: f32, main: f32 }\nfn exchange(hp: f32) -> f32 { let h_local = hp; var noise_local = h_local; return noise_local; }\n'
      + 'fn compute(px: vec2i, uv: vec2f) -> f32 { return exchange(h_at(px)); }',
  }));
});

test('includes', () => {
  rejects({ includes: [{ name: 'fake', code: '', deps: [] }] }, 'includes[0] is not a library made by defineLib');
  const otherHash = defineLib({ name: 'hash', code: 'fn hash_other(x: u32) -> u32 { return x; }' });
  rejects({ includes: [hash, otherHash] }, 'two different libraries are named "hash"');
  rejects({ includes: [noise, otherHash] }, 'two different libraries are named "hash"');
  // One library reached twice is one library.
  assert.doesNotThrow(() => define({ name: fresh(), includes: [hash, noise, hash], outputs: { out: 'field' }, code: MAP }));
});

test('the worked kernels of the contract are accepted', () => {
  assert.doesNotThrow(() => defineKernel({
    name: 'ref/fbm',
    outputs: { out: 'field' },
    params: { cells: 'f32', octaves: 'i32', gain: 'f32' },
    includes: [noise],
    code: /* wgsl */ `
const SPREAD = 1.6;   // fixed normalisation constant; to calibrate against the generator range rule (1.7)

fn compute(px: vec2i, uv: vec2f) -> f32 {
  let n = noise_fbm(uv * P.cells, seedFor(0u), clamp(P.octaves, 1, 16), 2.0, P.gain);
  return 0.5 + 0.5 * SPREAD * n;
}`,
  }));
  assert.doesNotThrow(() => defineKernel({
    name: 'ref/talus.step',
    inputs: { h: 'field' },
    outputs: { next: 'field' },
    inPlace: { moved: 'field' },
    params: { talus: 'f32', rate: 'f32' },
    code: /* wgsl */ `
fn exchange(hp: f32, q: vec2i, dist: f32) -> f32 {
  if (!inGrid(q)) { return 0.0; }
  let d = h_at(q) - hp;
  return sign(d) * max(abs(d) - P.talus * dist, 0.0) * P.rate / dist;
}

fn compute(px: vec2i, uv: vec2f, cur: Cur) -> Out {
  let hp = h_at(px);
  var net = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      if (i != 0 || j != 0) {
        net += exchange(hp, px + vec2i(i, j), length(vec2f(vec2i(i, j))));
      }
    }
  }
  return Out(hp + net, cur.moved + abs(net));
}`,
  }));
  const box3 = (kind: 'field' | 'color') => defineKernel({
    name: `ref/box3#${kind}`,
    inputs: { src: kind, mask: MASK_INPUT },
    outputs: { out: kind },
    params: { dir: 'vec2i' },
    code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> out_t {
  let blurred = (src_at(px - P.dir) + src_at(px) + src_at(px + P.dir)) / 3.0;
  return mix(src_at(px), blurred, mask_at(px));
}`,
  });
  assert.doesNotThrow(() => ({ field: box3('field'), color: box3('color') }));
});
