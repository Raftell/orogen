// defineLib: the rules of engine.md 3.7 and the messages of 3.13 (testing.md 8.1).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { KernelDefError } from '../../../src/core/gpu/errors.ts';
import { defineLib, orderLibs, type WgslLib } from '../../../src/core/gpu/lib.ts';
import { hash } from '../../../src/core/wgsl/hash.ts';
import { noise } from '../../../src/core/wgsl/noise.ts';

function rejects(def: { name: string; code: string; deps?: readonly WgslLib[] }, problem: string): void {
  assert.throws(() => defineLib(def), (thrown: unknown) => {
    assert.ok(thrown instanceof KernelDefError, `KernelDefError expected, got ${String(thrown)}`);
    assert.equal(thrown.message, `library "${def.name}": ${problem}`);
    return true;
  });
}

test('a library is returned with its name, code and dependencies', () => {
  const blend = defineLib({ name: 'filterBlend', code: 'fn filterBlend_over(a: f32, b: f32, t: f32) -> f32 { return mix(a, b, t); }' });
  assert.deepEqual({ ...blend }, { name: 'filterBlend', code: 'fn filterBlend_over(a: f32, b: f32, t: f32) -> f32 { return mix(a, b, t); }', deps: [] });
  const shaped = defineLib({ name: 'filterShape', code: 'fn filterShape_soft(x: f32) -> f32 { return filterBlend_over(0.0, 1.0, x); }', deps: [blend] });
  assert.deepEqual(shaped.deps, [blend]);
  assert.ok(Object.isFrozen(shaped) && Object.isFrozen(shaped.deps));
});

test('library names match [a-z][A-Za-z0-9]*', () => {
  for (const name of ['Noise', 'my_lib', 'filter-kernel', '2d', '']) {
    rejects({ name, code: '' }, 'invalid library name; it must match [a-z][A-Za-z0-9]*');
  }
});

test('every module-scope name begins with <name>_', () => {
  rejects({ name: 'noiseTest', code: 'fn fbm(p: vec2f) -> f32 { return 0.0; }' }, '"fbm" must be named "noiseTest_fbm"');
  rejects({ name: 'noiseTest', code: 'fn noiseTest_ok() -> f32 { return 0.0; }\nstruct Sample { v: f32 }' }, '"Sample" must be named "noiseTest_Sample"');
  rejects({ name: 'noiseTest', code: 'const MAX = 16;' }, '"MAX" must be named "noiseTest_MAX"');
  rejects({ name: 'noiseTest', code: 'alias Real = f32;' }, '"Real" must be named "noiseTest_Real"');
  rejects({ name: 'noiseTest', code: 'fn noiseTest_() -> f32 { return 0.0; }' }, '"noiseTest_" must be named "noiseTest_noiseTest_"');
  rejects({ name: 'noise', code: 'fn fbm(p: vec2f) -> f32 { return 0.0; }' }, '"fbm" must be named "noise_fbm"');
  // Locals, parameters and struct members are not module scope; comments are not code.
  assert.doesNotThrow(() => defineLib({
    name: 'scopeTest',
    code: '// fn helper() is not declared here\nstruct scopeTest_S { value: f32, other: vec2f }\n'
      + 'fn scopeTest_f(t: texture_2d<f32>, p: vec2i) -> f32 { let local = ld(t, p); var acc = local; const K = 2.0; return acc * K; }',
  }));
});

test('a library declares no variable, override, binding or entry point, and uses no underscore name', () => {
  rejects({ name: 'badLib', code: 'var<private> badLib_state: f32;' }, 'a library declares no var ("badLib_state")');
  rejects({ name: 'badLib', code: 'override badLib_taps: i32 = 4;' }, 'a library declares no override ("badLib_taps")');
  rejects({ name: 'badLib', code: '@group(1) @binding(0) var badLib_t: texture_2d<f32>;' }, 'a library declares no binding; it takes textures as function parameters');
  rejects({ name: 'badLib', code: '@compute @workgroup_size(8, 8) fn badLib_main() {}' }, 'a library declares no entry point');
  rejects({ name: 'badLib', code: 'fn badLib_f() -> vec2i { return _px; }' }, 'code uses "_px"; names beginning with "_" are reserved');
});

test('dependencies are libraries, and one name is one library', () => {
  rejects({ name: 'depTest', code: '', deps: [{ name: 'plain', code: '', deps: [] }] }, 'deps[0] is not a library made by defineLib');
  const otherHash = defineLib({ name: 'hash', code: 'fn hash_other(x: u32) -> u32 { return x; }' });
  rejects({ name: 'depTest', code: '', deps: [hash, otherHash] }, 'two different libraries are named "hash"');
  rejects({ name: 'depTest', code: '', deps: [noise, otherHash] }, 'two different libraries are named "hash"');
  rejects({ name: 'hash', code: '', deps: [hash] }, 'two different libraries are named "hash"');
  assert.doesNotThrow(() => defineLib({ name: 'depTest', code: '', deps: [hash, noise, hash] }));
});

test('libraries are emitted once, after their dependencies', () => {
  const a = defineLib({ name: 'orderA', code: 'fn orderA_f() -> f32 { return 1.0; }' });
  const b = defineLib({ name: 'orderB', code: 'fn orderB_f() -> f32 { return orderA_f(); }', deps: [a] });
  const c = defineLib({ name: 'orderC', code: 'fn orderC_f() -> f32 { return orderB_f() + orderA_f(); }', deps: [b, a] });
  assert.deepEqual(orderLibs([c, a, b]).ordered.map((l) => l.name), ['orderA', 'orderB', 'orderC']);
  assert.deepEqual(orderLibs([b, c]).ordered.map((l) => l.name), ['orderA', 'orderB', 'orderC']);
  assert.equal(orderLibs([c]).clash, null);
});

test('the core libraries: hash and noise', () => {
  assert.equal(hash.name, 'hash');
  assert.deepEqual(hash.deps, []);
  assert.equal(noise.name, 'noise');
  assert.deepEqual(noise.deps, [hash]);
  for (const fn of ['hash_u32', 'hash_cell', 'hash_unit', 'hash_unit2']) assert.ok(hash.code.includes(`fn ${fn}(`), fn);
  assert.ok(noise.code.includes('fn noise_value(p: vec2f, seed: u32) -> f32'));
  assert.ok(noise.code.includes('fn noise_gradient(p: vec2f, seed: u32) -> f32'));
  assert.ok(noise.code.includes('fn noise_gradientD(p: vec2f, seed: u32) -> vec3f'));
  assert.ok(noise.code.includes('fn noise_worley(p: vec2f, seed: u32) -> vec2f'));
  assert.ok(noise.code.includes('fn noise_fbm(p: vec2f, seed: u32, octaves: i32, lacunarity: f32, gain: f32) -> f32'));
  // engine.md 3.14 rule 4: no hash built on float trigonometry.
  assert.ok(!/\b(sin|cos|tan)\s*\(/.test(noise.code) && !/\b(sin|cos|tan)\s*\(/.test(hash.code));
});
