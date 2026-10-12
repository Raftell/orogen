// Generated WGSL on the device: accessors, stores, both modes, in-place access, LUTs, variants, params, the
// Frame, compile errors, and the two worked kernels of engine.md section 6 (testing.md 8.1).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defineKernel, MASK_INPUT } from '../../../src/core/gpu/kernel.ts';
import { defineLib } from '../../../src/core/gpu/lib.ts';
import { mixSeed } from '../../../src/core/gpu/hash.ts';
import { KernelCompileError } from '../../../src/core/gpu/pipelines.ts';
import { createRig, firstDifference, HEIGHT_RANGE, maxDifference, SEED, TERRAIN_SIZE, texel, texels } from './rig.ts';
import { box3Kernels, fbm, relax, step } from './worked.ts';

// ---- the kernels of this file ----------------------------------------------------------------------------------

const shift = defineKernel({
  name: 'test/shift',
  inputs: { src: 'field' },
  outputs: { out: 'field' },
  params: { offset: 'vec2i' },
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return src_at(px + P.offset); }',
});

const probe = defineKernel({
  name: 'test/probe',
  inputs: { a: 'field', m: MASK_INPUT, c: { kind: 'color', default: [0.125, 0.25, 0.5, 0.75] }, k: { kind: 'vec2', default: 3 } },
  outputs: { sizes: 'aux', bound: 'aux', values: 'aux' },
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> Out {
  let sizes = vec4f(f32(a_res().x), f32(m_res().x), f32(c_res().y), f32(k_res().x));
  let bound = vec4f(f32(a_bound()), f32(m_bound()), f32(c_bound()), f32(k_bound()));
  return Out(sizes, bound, vec4f(m_at(px + vec2i(50, -50)), c_at(px).b, c_uv(uv).a, k_lerp(vec2f(px)).y));
}`,
});

const saturated = defineKernel({
  name: 'test/saturated',
  inputs: { plain: 'field', sat: { kind: 'field', saturate: true }, tint: { kind: 'color', saturate: true } },
  outputs: { out: 'aux' },
  code: 'fn compute(px: vec2i, uv: vec2f) -> vec4f { return vec4f(plain_at(px), sat_at(px), sat_uv(uv), tint_lerp(vec2f(px)).g); }',
});

const resample = defineKernel({
  name: 'test/resample',
  inputs: { src: { kind: 'field', size: 'any' } },
  outputs: { out: 'vec2' },
  params: { at: 'vec2f' },
  code: 'fn compute(px: vec2i, uv: vec2f) -> vec2f { return vec2f(src_uv(uv), src_lerp(P.at + vec2f(px) * 0.25)); }',
});

const kinds = defineKernel({
  name: 'test/kinds',
  outputs: { a: 'field', b: 'vec2', c: 'color', d: 'aux' },
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> Out {
  let v = f32(px.x) + 0.5 * f32(px.y);
  return Out(v, vec2f(v, -v), vec4f(v, 2.0, 0.25, 0.5), vec4f(-v, v, 1.0e-3, 1.0e6));
}`,
});

const compact = defineKernel({
  name: 'test/compact',
  inputs: { h: 'half', v: 'half2', m: 'mask8' },
  outputs: { h2: 'half', v2: 'half2', m2: 'mask8' },
  code: 'fn compute(px: vec2i, uv: vec2f) -> Out { return Out(h_at(px) * 2.0, v_at(px).yx, 1.0 - m_at(px)); }',
});

const checker = defineKernel({
  name: 'test/checker',
  mode: 'raw',
  inputs: { src: 'field' },
  outputs: { out: 'field' },
  inPlace: { count: 'field' },
  code: /* wgsl */ `
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (!beginPixel(gid)) { return; }
  let px = pixel();
  if (((px.x + px.y) & 1) != 0) { return; }
  out_set(src_at(px) * 10.0);
  count_set(count_get() + 1.0);
}`,
});

const lookup = defineKernel({
  name: 'test/lookup',
  outputs: { scalar: 'aux', colour: 'aux', item: 'aux' },
  luts: { curve: 'f32', ramp: 'vec4f' },
  params: { scale: 'f32', bias: 'f32' },
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> Out {
  let t = uv.x * P.scale + P.bias;
  return Out(
    vec4f(curve_at(t), f32(curve_len()), f32(ramp_len()), curve_item(u32(px.x))),
    ramp_at(t),
    ramp_item(u32(px.x)),
  );
}`,
});

const packed = defineKernel({
  name: 'test/packed',
  outputs: { p0: 'aux', p1: 'aux', p2: 'aux', p3: 'aux' },
  params: { a: 'f32', b: 'vec3f', c: 'i32', d: 'vec2u', e: 'u32', f: 'vec4f', g: 'vec2i', h: 'vec2f', on: 'u32', n: 'i32' },
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> Out {
  return Out(
    vec4f(P.a, P.b),
    vec4f(f32(P.c), vec2f(P.d), f32(P.e >> 16u)),
    P.f,
    vec4f(vec2f(P.g), P.h) + vec4f(0.0, 0.0, f32(P.on), f32(P.n)),
  );
}`,
});

const frameProbe = defineKernel({
  name: 'test/frame',
  outputs: { geometry: 'aux', numbers: 'aux' },
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> Out {
  return Out(
    vec4f(vec2f(frame.res), frame.terrainSize, frame.cellSize),
    vec4f(frame.heightRange, f32(frame.seed & 0xffffu), f32(frame.seed >> 16u), f32(frame.iteration)),
  );
}`,
});

// engine.md 3.13, "Common trap": the resource names it calls usable, and the param names of 3.10 that are WGSL builtins.
const usableNames = defineKernel({
  name: 'test/usable-names',
  inputs: { src: 'field', in: 'field', mask: MASK_INPUT, a: 'field', b: 'field', h: 'field', height: 'field', flow: 'field', water: 'field', sediment: 'field', deposit: 'field' },
  outputs: { out: 'field', next: 'field' },
  params: { min: 'f32', max: 'f32', step: 'f32', mix: 'f32', scale: 'f32', mode: 'u32' },
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> Out {
  let sum = src_at(px) + in_at(px) + a_at(px) + b_at(px) + h_at(px) + height_at(px) + flow_at(px) + water_at(px) + sediment_at(px) + deposit_at(px);
  // The builtins are still the builtins beside the members of the same name.
  let shaped = mix(P.min, P.max, step(P.step, sum * P.scale)) + P.mix + f32(P.mode);
  return Out(min(sum, 100.0) * mask_at(px), max(shaped, -100.0));
}`,
});

const brokenLib = defineLib({ name: 'testBroken', code: '// a library\nfn testBroken_f(x: f32) -> f32 {\n  return x + missing;\n}' });
const brokenCode = defineKernel({
  name: 'test/broken-code', outputs: { out: 'field' },
  code: '\n// line 2\nfn compute(px: vec2i, uv: vec2f) -> f32 {\n  let value = undeclared * 2.0;\n  return value;\n}',
});
const brokenInclude = defineKernel({ name: 'test/broken-include', outputs: { out: 'field' }, includes: [brokenLib], code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return 0.0; }' });
const brokenSignature = defineKernel({ name: 'test/broken-signature', outputs: { out: 'field' }, code: 'fn compute(px: vec2i, uv: vec2f) -> vec4f { return vec4f(0.0); }' });

const rig = await createRig();
await rig.compile(shift, probe, saturated, resample, kinds, compact, checker, relax, lookup, box3Kernels.field, box3Kernels.color, packed, frameProbe, fbm, step, usableNames);

const ramp = (n: number): Float32Array => texels(n, n, (x, y) => x + 100 * y);

// ---- inputs ----------------------------------------------------------------------------------------------------

test('x_at reads the texel and clamps to the input\'s own size', async () => {
  const n = 20;
  const src = rig.field('field', n, ramp(n));
  for (const [dx, dy] of [[0, 0], [1, 0], [0, -1], [-3, 2], [40, 40], [-40, 7]] as const) {
    const out = rig.field('field', n);
    rig.run(shift, { in: { src }, out: { out }, params: { offset: [dx, dy] } });
    const got = await rig.read(out);
    const clamp = (v: number): number => Math.min(Math.max(v, 0), n - 1);
    assert.equal(firstDifference(got, texels(n, n, (x, y) => clamp(x + dx) + 100 * clamp(y + dy))), -1, `offset ${dx},${dy}`);
    rig.release(out);
  }
  rig.release(src);
});

test('an unbound input reads its default everywhere, has size 1 x 1 and is not bound', async () => {
  const n = 16;
  const a = rig.field('field', n, 0);
  const outputs = () => ({ sizes: rig.field('aux', n), bound: rig.field('aux', n), values: rig.field('aux', n) });

  const unbound = outputs();
  rig.run(probe, { in: { a }, out: unbound });
  assert.deepEqual(texel(await rig.read(unbound.sizes), n, 5, 9, 4), [n, 1, 1, 1]);
  assert.deepEqual(texel(await rig.read(unbound.bound), n, 5, 9, 4), [1, 0, 0, 0]);
  const values = await rig.read(unbound.values);
  for (const [x, y] of [[0, 0], [15, 15], [3, 12]] as const) {
    assert.deepEqual(texel(values, n, x, y, 4), [1, 0.5, 0.75, 3], `a mask reads 1, a colour its default, a number fills every channel (${x}, ${y})`);
  }

  // null is the same as leaving the input out; a bound input is seen as bound.
  const m = rig.field('field', n, 0.25);
  const c = rig.field('color', n, [1, 2, 3, 4]);
  const some = outputs();
  rig.run(probe, { in: { a, m, c, k: null }, out: some });
  assert.deepEqual(texel(await rig.read(some.sizes), n, 0, 0, 4), [n, n, n, 1]);
  assert.deepEqual(texel(await rig.read(some.bound), n, 0, 0, 4), [1, 1, 1, 0]);
  assert.deepEqual(texel(await rig.read(some.values), n, 7, 7, 4), [0.25, 3, 4, 3]);
});

test('saturate: true saturates x_at, x_uv and x_lerp; a plain input does not', async () => {
  const n = 8;
  const values = texels(n, n, (x) => (x - 3) * 0.5);                // -1.5 .. 2
  const plain = rig.field('field', n, values);
  const tint = rig.field('color', n, texels(n, n, (x) => [0, (x - 3) * 0.5, 0, 1]));
  const out = rig.field('aux', n);
  rig.run(saturated, { in: { plain, sat: plain, tint }, out: { out } });
  const got = await rig.read(out);
  for (let x = 0; x < n; x++) {
    const v = (x - 3) * 0.5, s = Math.min(Math.max(v, 0), 1);
    const [plainAt, satAt, satUv, tintLerp] = texel(got, n, x, 2, 4);
    assert.deepEqual([plainAt, satAt, tintLerp], [v, s, s], `x = ${x}`);
    assert.ok(Math.abs(satUv! - s) < 1e-6 && satUv! >= 0 && satUv! <= 1, `sat_uv at x = ${x}`);
  }
});

test('MASK_INPUT accessors return saturate(value)', async () => {
  const n = 8;
  const src = rig.field('field', n, texels(n, n, (x) => x));
  const mask = rig.field('field', n, texels(n, n, (x, y) => (y === 0 ? -5 : y === 1 ? 0.5 : 7)));
  const out = rig.field('field', n);
  rig.run(box3Kernels.field, { in: { src, mask }, out: { out }, params: { dir: [1, 0] } });
  const got = await rig.read(out);
  const blurred = (x: number): number => (Math.max(x - 1, 0) + x + Math.min(x + 1, n - 1)) / 3;
  for (let x = 0; x < n; x++) {
    assert.equal(texel(got, n, x, 0)[0], x, 'mask -5 is 0: unaffected');
    assert.ok(Math.abs(texel(got, n, x, 1)[0]! - (x + blurred(x)) / 2) < 1e-6, 'mask 0.5');
    assert.ok(Math.abs(texel(got, n, x, 2)[0]! - blurred(x)) < 1e-6, 'mask 7 is 1: fully affected');
  }
});

test('x_uv and x_lerp are bilinear in the input\'s own texels, for an input of any size', async () => {
  // A 5 x 3 input spans the terrain; the 9 x 9 output samples it at uv = px / 8.
  const w = 5, h = 3, n = 9;
  const f = (x: number, y: number): number => 2 * x + 10 * y;      // linear: bilinear interpolation is exact
  const src = rig.field('field', [w, h], texels(w, h, f));
  const out = rig.field('vec2', n);
  rig.run(resample, { in: { src }, out: { out }, params: { at: [1, 0.5] } });
  const got = await rig.read(out);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const [uv, lerp] = texel(got, n, x, y, 2);
      assert.ok(Math.abs(uv! - f((x / 8) * (w - 1), (y / 8) * (h - 1))) < 1e-5, `x_uv at (${x}, ${y}): texel position = uv * (size - 1)`);
      const tx = Math.min(1 + x * 0.25, w - 1), ty = Math.min(0.5 + y * 0.25, h - 1);
      assert.ok(Math.abs(lerp! - f(tx, ty)) < 1e-5, `x_lerp at (${x}, ${y}) clamps to [0, size - 1]`);
    }
  }
  // At an integer position x_lerp returns that texel exactly; at the corners x_uv returns the corner texels.
  assert.equal(texel(got, n, 0, 0, 2)[0], f(0, 0));
  assert.equal(texel(got, n, 8, 8, 2)[0], f(w - 1, h - 1));
  assert.equal(texel(got, n, 4, 2, 2)[1], f(2, 1));
});

// ---- targets ---------------------------------------------------------------------------------------------------

test('outputs of 1, 2 and 4 channels: x_set stores (v, 0, 0, 1), (v, 0, 1) and v', async () => {
  const n = 12;
  const a = rig.field('field', n), b = rig.field('vec2', n), c = rig.field('color', n), d = rig.field('aux', n);
  rig.run(kinds, { out: { a, b, c, d } });
  const [ra, rb, rc, rd] = [await rig.read(a), await rig.read(b), await rig.read(c), await rig.read(d)];
  assert.deepEqual([ra.length, rb.length, rc.length, rd.length], [n * n, n * n * 2, n * n * 4, n * n * 4], '1, 2 and 4 floats per texel');
  for (const [x, y] of [[0, 0], [11, 11], [5, 7]] as const) {
    const v = x + 0.5 * y;
    assert.deepEqual(texel(ra, n, x, y), [v]);
    assert.deepEqual(texel(rb, n, x, y, 2), [v, -v]);
    assert.deepEqual(texel(rc, n, x, y, 4), [v, 2, 0.25, 0.5], 'rgba16float holds these exactly');
    assert.deepEqual(texel(rd, n, x, y, 4), [-v, v, Math.fround(1e-3), 1e6]);
  }
  // The same kernel with two targets discarded gives the same values in the others.
  const a2 = rig.field('field', n), d2 = rig.field('aux', n);
  rig.run(kinds, { out: { a: a2, b: null, c: null, d: d2 } });
  assert.equal(firstDifference(await rig.read(a2), ra), -1);
  assert.equal(firstDifference(await rig.read(d2), rd), -1);
});

test('half, half2 and mask8 work with the format the device gives them', async () => {
  const n = 8;
  const formats = rig.gpu.caps.formats;
  assert.deepEqual([formats.half, formats.half2, formats.mask8], rig.gpu.caps.compactFormats ? ['r16float', 'rg16float', 'r8unorm'] : ['r32float', 'rg32float', 'r32float']);
  // Values every format holds exactly: small dyadic numbers, and multiples of 1/255 that are already in 0..1.
  const h = rig.field('half', n, texels(n, n, (x, y) => x * 0.25 - y));
  const v = rig.field('half2', n, texels(n, n, (x, y) => [x, -0.5 * y]));
  const m = rig.field('mask8', n, texels(n, n, (x, y) => (x * 8 + y) / 255));
  const h2 = rig.field('half', n), v2 = rig.field('half2', n), m2 = rig.field('mask8', n);
  rig.run(compact, { in: { h, v, m }, out: { h2, v2, m2 } });
  assert.equal(firstDifference(await rig.read(h2), texels(n, n, (x, y) => 2 * (x * 0.25 - y))), -1);
  assert.equal(firstDifference(await rig.read(v2), texels(n, n, (x, y) => [-0.5 * y, x])), -1);
  assert.ok(maxDifference(await rig.read(m2), texels(n, n, (x, y) => 1 - (x * 8 + y) / 255)) < 1e-6);
  assert.equal(firstDifference(await rig.read(m), texels(n, n, (x, y) => Math.fround((x * 8 + y) / 255))), -1, 'a write and a read round-trip');
  // A field of another kind with the same channel count is a legal input.
  const h3 = rig.field('half', n), v3 = rig.field('half2', n), m3 = rig.field('mask8', n);
  const f = rig.field('field', n, texels(n, n, (x, y) => x * 0.25 - y));
  rig.run(compact, { in: { h: f, v, m: h }, out: { h2: h3, v2: v3, m2: m3 } });
  assert.equal(firstDifference(await rig.read(h3), await rig.read(h2)), -1);
});

test('raw mode: a texel that is not stored keeps its contents; in-place targets load and store their own texel', async () => {
  const n = 13;                                                    // not a multiple of the workgroup
  const src = rig.field('field', n, ramp(n));
  const out = rig.field('field', n, 7);
  const count = rig.field('field', n, 0);
  rig.run(checker, { in: { src }, out: { out }, rw: { count } });
  rig.run(checker, { in: { src }, out: { out }, rw: { count } });
  rig.run(checker, { in: { src }, out: { out: null }, rw: { count } });
  const [gotOut, gotCount] = [await rig.read(out), await rig.read(count)];
  assert.equal(firstDifference(gotOut, texels(n, n, (x, y) => ((x + y) % 2 === 0 ? (x + 100 * y) * 10 : 7))), -1);
  assert.equal(firstDifference(gotCount, texels(n, n, (x, y) => ((x + y) % 2 === 0 ? 3 : 0))), -1);
});

test('unsafeReadWrite: a red-black relaxation reads neighbours of the texture it writes', async () => {
  const n = 17;
  const start = texels(n, n, (x, y) => ((x * 7 + y * 13) % 11) / 4);
  const g = rig.field('field', n, start);
  rig.run(relax, { rw: { g }, params: { parity: 0 } });
  rig.run(relax, { rw: { g }, params: { parity: 1 } });
  const got = await rig.read(g);

  const expected = Float32Array.from(start);
  const at = (x: number, y: number): number => expected[Math.min(Math.max(y, 0), n - 1) * n + Math.min(Math.max(x, 0), n - 1)]!;
  for (const parity of [0, 1]) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if ((x + y + parity) % 2 === 0) {
          expected[y * n + x] = Math.fround(0.25 * Math.fround(Math.fround(Math.fround(at(x + 1, y) + at(x - 1, y)) + at(x, y + 1)) + at(x, y - 1)));
        }
      }
    }
  }
  assert.ok(maxDifference(got, expected) < 1e-6);
});

test('a null in-place target is discarded and does not change the other targets', async () => {
  const n = 24;
  const h = rig.field('field', n, texels(n, n, (x, y) => ((x * 31 + y * 17) % 23) / 23));
  const withMoved = rig.field('field', n), without = rig.field('field', n), moved = rig.field('field', n, 0);
  const params = { talus: 0.01, rate: 0.1 };
  rig.run(step, { in: { h }, out: { next: withMoved }, rw: { moved }, params });
  rig.run(step, { in: { h }, out: { next: without }, rw: { moved: null }, params });
  assert.equal(firstDifference(await rig.read(withMoved), await rig.read(without)), -1);
  assert.ok((await rig.read(moved)).some((v) => v > 0));
});

// ---- LUTs ------------------------------------------------------------------------------------------------------

test('LUT accessors: x_len, x_item clamped, x_at interpolated at saturate(t) * (n - 1)', async () => {
  const n = 9;                                                     // uv.x = 0, 1/8 .. 1
  const curveData = new Float32Array([0, 10, 20, 50, 40]);
  const rampData = new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0.5]);
  const curve = rig.lut(curveData, 'f32');
  const ramp4 = rig.lut(rampData, 'vec4f');
  assert.deepEqual([curve.type, curve.length, ramp4.type, ramp4.length], ['f32', 5, 'vec4f', 3]);

  const lerp = (table: readonly number[], t: number): number => {
    const x = Math.min(Math.max(t, 0), 1) * (table.length - 1);
    const i = Math.floor(x);
    return table[i]! + (table[Math.min(i + 1, table.length - 1)]! - table[i]!) * (x - i);
  };
  for (const [scale, bias] of [[1, 0], [3, -1], [0, 0.5]] as const) {
    const scalar = rig.field('aux', n), colour = rig.field('aux', n), item = rig.field('aux', n);
    rig.run(lookup, { out: { scalar, colour, item }, luts: { curve, ramp: ramp4 }, params: { scale, bias } });
    const [s, c, it] = [await rig.read(scalar), await rig.read(colour), await rig.read(item)];
    for (let x = 0; x < n; x++) {
      const t = (x / 8) * scale + bias;
      const [value, curveLen, rampLen, curveItem] = texel(s, n, x, 0, 4);
      assert.ok(Math.abs(value! - lerp([...curveData], t)) < 1e-4, `curve_at(${t})`);
      assert.deepEqual([curveLen, rampLen], [5, 3]);
      assert.equal(curveItem, curveData[Math.min(x, 4)], 'x_item returns element min(i, n - 1)');
      const got = texel(c, n, x, 0, 4);
      for (let k = 0; k < 4; k++) {
        assert.ok(Math.abs(got[k]! - lerp([rampData[k]!, rampData[4 + k]!, rampData[8 + k]!], t)) < 1e-5, `ramp_at(${t}).${'rgba'[k]}`);
      }
      assert.deepEqual(texel(it, n, x, 0, 4), [...rampData.subarray(Math.min(x, 2) * 4, Math.min(x, 2) * 4 + 4)]);
    }
  }
  // A table of one element is a constant.
  const one = rig.lut(new Float32Array([42]), 'f32');
  const scalar = rig.field('aux', n);
  rig.run(lookup, { out: { scalar, colour: null, item: null }, luts: { curve: one, ramp: ramp4 }, params: { scale: 1, bias: 0 } });
  const s = await rig.read(scalar);
  for (let x = 0; x < n; x++) assert.deepEqual(texel(s, n, x, 3, 4), [42, 1, 3, 42]);
});

// ---- variants and params ---------------------------------------------------------------------------------------

test('variants: one body serves a field and a colour through x_t', async () => {
  const n = 10;
  const src = rig.field('field', n, texels(n, n, (x, y) => x * x + y));
  const out = rig.field('field', n);
  rig.run(box3Kernels[src.kind], { in: { src }, out: { out }, params: { dir: [0, 1] } });
  const expectedField = texels(n, n, (x, y) => (x * x + Math.max(y - 1, 0) + x * x + y + x * x + Math.min(y + 1, n - 1)) / 3);
  assert.ok(maxDifference(await rig.read(out), expectedField) < 1e-4);

  const colour = rig.field('color', n, texels(n, n, (x, y) => [x, y, 1, 0.5]));
  const colourOut = rig.field('color', n);
  rig.run(box3Kernels[colour.kind], { in: { src: colour }, out: { out: colourOut }, params: { dir: [1, 0] } });
  const got = await rig.read(colourOut);
  const blurred = (x: number): number => (Math.max(x - 1, 0) + x + Math.min(x + 1, n - 1)) / 3;
  for (let x = 0; x < n; x++) {
    const [r, g, b, a] = texel(got, n, x, 4, 4);
    // rgba16float: 11 significant bits.
    assert.ok(Math.abs(r! - blurred(x)) < 5e-3 && g === 4 && b === 1 && a === 0.5, `x = ${x}`);
  }
});

test('params reach the shader at the offsets the WGSL compiler gives the struct', async () => {
  const outputs = { p0: rig.field('aux', 8), p1: rig.field('aux', 8), p2: rig.field('aux', 8), p3: rig.field('aux', 8) };
  rig.run(packed, {
    out: outputs,
    params: { a: 1.5, b: [2, 3, 4], c: -7, d: [8, 16777215], e: 0xabcd0000, f: [0.25, 0.5, 0.75, 1], g: [-1, 65536], h: [9.5, -10.5], on: true, n: false },
  });
  assert.deepEqual(texel(await rig.read(outputs.p0), 8, 3, 3, 4), [1.5, 2, 3, 4]);
  assert.deepEqual(texel(await rig.read(outputs.p1), 8, 3, 3, 4), [-7, 8, 16777215, 0xabcd]);
  assert.deepEqual(texel(await rig.read(outputs.p2), 8, 3, 3, 4), [0.25, 0.5, 0.75, 1]);
  assert.deepEqual(texel(await rig.read(outputs.p3), 8, 3, 3, 4), [-1, 65536, 10.5, -10.5]);
});

test('the resource names the contract calls usable, and params named like builtins, compile and run', async () => {
  const n = 8;
  const one = rig.field('field', n, 1);
  const out = rig.field('field', n), next = rig.field('field', n);
  rig.run(usableNames, {
    in: { src: one, in: one, a: one, b: one, h: one, height: one, flow: one, water: one, sediment: one, deposit: one },
    out: { out, next },
    params: { min: 2, max: 6, step: 5, mix: 0.5, scale: 1, mode: 3 },
  });
  assert.ok((await rig.read(out)).every((v) => v === 10), 'ten inputs of 1, an unbound mask of 1');
  assert.ok((await rig.read(next)).every((v) => v === 9.5), 'mix(2, 6, step(5, 10)) + 0.5 + 3');
});

test('params are captured when the run is made', async () => {
  const n = 8;
  const src = rig.field('field', n, ramp(n));
  const first = rig.field('field', n), second = rig.field('field', n);
  const offset: [number, number] = [1, 0];
  const params = { offset };
  rig.run(shift, { in: { src }, out: { out: first }, params });
  offset[0] = 3;
  rig.run(shift, { in: { src }, out: { out: second }, params });
  assert.equal(texel(await rig.read(first), n, 0, 0)[0], 1);
  assert.equal(texel(await rig.read(second), n, 0, 0)[0], 3);
});

// ---- the Frame -------------------------------------------------------------------------------------------------

test('frame describes the written grid, the project and the run', async () => {
  for (const n of [1, 33, 129]) {
    const geometry = rig.field('aux', n), numbers = rig.field('aux', n);
    rig.run(frameProbe, { out: { geometry, numbers } }, { iteration: 5 });
    const cell = TERRAIN_SIZE / Math.max(n - 1, 1);
    assert.deepEqual(texel(await rig.read(geometry), n, n - 1, 0, 4), [n, n, TERRAIN_SIZE, cell], `the grid of ${n}: res and cellSize are the written grid's`);
    assert.deepEqual(texel(await rig.read(numbers), n, 0, n - 1, 4), [HEIGHT_RANGE, SEED & 0xffff, SEED >>> 16, 5]);
  }
  // The run overrides frame.iteration; the seed is the invocation's.
  const geometry = rig.field('aux', 8), numbers = rig.field('aux', 8);
  const seed = mixSeed(123456789, 42);
  rig.run(frameProbe, { out: { geometry, numbers }, iteration: 4000000 }, { iteration: 5, seed, terrainSize: 1000, heightRange: 50 });
  assert.deepEqual(texel(await rig.read(geometry), 8, 0, 0, 4), [8, 8, 1000, Math.fround(1000 / 7)]);
  assert.deepEqual(texel(await rig.read(numbers), 8, 0, 0, 4), [50, seed & 0xffff, seed >>> 16, 4000000]);
});

// ---- compilation -----------------------------------------------------------------------------------------------

test('a WGSL error in the author\'s code is reported with its line in KernelDef.code', async () => {
  await assert.rejects(rig.pipelines.compile(brokenCode), (thrown: unknown) => {
    assert.ok(thrown instanceof KernelCompileError);
    assert.equal(thrown.kernel, 'test/broken-code');
    assert.ok(thrown.message.startsWith('kernel "test/broken-code": '), thrown.message);
    assert.ok(thrown.message.includes('undeclared'), thrown.message);
    const diagnostic = thrown.diagnostic!;
    assert.equal(diagnostic.origin, 'code');
    assert.equal(diagnostic.line, 4, 'the line within the code, which starts with an empty line');
    assert.equal(diagnostic.column, 15);
    assert.deepEqual(diagnostic.excerpt, [
      '// line 2', 'fn compute(px: vec2i, uv: vec2f) -> f32 {', '  let value = undeclared * 2.0;', '  return value;', '}',
    ]);
    assert.ok(thrown.detail.includes('undeclared'));
    return true;
  });
  assert.equal(rig.pipelines.get(brokenCode), undefined);
  // The failure is remembered: the kernel is compiled once per device.
  await assert.rejects(rig.pipelines.compile(brokenCode), KernelCompileError);
});

test('an error in a library names the library; an error in generated code says so', async () => {
  await assert.rejects(rig.pipelines.compile(brokenInclude), (thrown: unknown) => {
    assert.ok(thrown instanceof KernelCompileError);
    assert.equal(thrown.diagnostic!.origin, 'library:testBroken');
    assert.equal(thrown.diagnostic!.line, 3);
    assert.deepEqual(thrown.diagnostic!.excerpt, ['// a library', 'fn testBroken_f(x: f32) -> f32 {', '  return x + missing;', '}']);
    return true;
  });
  // compute returns vec4f for a 1-channel output: the mistake is the author's, the error is in the generated entry point.
  await assert.rejects(rig.pipelines.compile(brokenSignature), (thrown: unknown) => {
    assert.ok(thrown instanceof KernelCompileError);
    assert.equal(thrown.diagnostic!.origin, 'generated');
    assert.ok(thrown.diagnostic!.excerpt.some((line) => line.includes('out_set(compute(_px, uvOf(_px)));')));
    return true;
  });
});

test('a kernel is compiled once and found by get()', async () => {
  const first = rig.pipelines.compile(fbm);
  assert.equal(rig.pipelines.compile(fbm), first, 'the same promise');
  const compiled = await first;
  assert.equal(rig.pipelines.get(fbm), compiled);
  assert.equal(compiled.kernel, fbm);
  assert.deepEqual(compiled.paramsLayout?.fields.map((f) => f.name), ['cells', 'octaves', 'gain']);
  assert.equal((await rig.pipelines.compile(kinds)).paramsLayout, null);
});

// ---- the worked kernels of engine.md section 6 -----------------------------------------------------------------

test('ref/fbm: a function of uv, the params and the seed; within the generator range', async () => {
  const render = async (n: number, seed = SEED): Promise<Float32Array> => {
    const out = rig.field('field', n);
    rig.run(fbm, { out: { out }, params: { cells: 1 / 0.25, octaves: 8, gain: 0.5 }, cost: 8 * 8 }, { seed });
    const data = await rig.read(out);
    rig.release(out);
    return data;
  };
  const fine = await render(257);
  let min = Infinity, max = -Infinity, sum = 0;
  for (const v of fine) { min = Math.min(min, v); max = Math.max(max, v); sum += v; }
  assert.ok(fine.every(Number.isFinite));
  assert.ok(min >= -0.05 && max <= 1.05, `range ${min} .. ${max}`);
  assert.ok(max - min >= 0.5, `span ${max - min}`);
  assert.ok(sum / fine.length > 0.25 && sum / fine.length < 0.75, `mean ${sum / fine.length}`);

  // Ladder levels agree at shared vertices (engine.md 1.5).
  const coarse = await render(129);
  let worst = 0;
  for (let y = 0; y < 129; y++) {
    for (let x = 0; x < 129; x++) worst = Math.max(worst, Math.abs(coarse[y * 129 + x]! - fine[2 * y * 257 + 2 * x]!));
  }
  assert.ok(worst < 1e-5, `largest difference at a shared vertex ${worst}`);
  // Another seed is another field.
  assert.ok(maxDifference(await render(129, mixSeed(2, 0)), coarse) > 0.05);
});

test('ref/talus.step: a ping-pong inside one batch conserves the total and accumulates in place', async () => {
  const n = 65;
  const start = texels(n, n, (x, y) => (Math.hypot(x - 32, y - 32) < 10 ? 1 : 0));
  let a = rig.field('field', n, start);
  let b = rig.field('field', n);
  const moved = rig.field('field', n, 0);
  const params = { talus: Math.tan((35 * Math.PI) / 180) * (TERRAIN_SIZE / (n - 1)) / HEIGHT_RANGE, rate: 0.1 };
  for (let i = 0; i < 40; i++) {
    rig.run(step, { in: { h: a }, out: { next: b }, rw: { moved }, params }, { iteration: i });
    [a, b] = [b, a];
  }
  const [end, total] = [await rig.read(a), await rig.read(moved)];
  const sum = (data: Float32Array): number => data.reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sum(end) - sum(start)) < 1e-2 * sum(start), 'material is moved, not made');
  assert.ok(end[32 * n + 23]! < 1 && end[32 * n + 20]! > 0 && Math.max(...end) <= 1, 'the cliff has collapsed outwards');
  assert.ok(sum(total) > 0 && total.every((v) => v >= 0));
});
