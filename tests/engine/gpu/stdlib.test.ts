// The standard library and the core libraries on the device (engine.md 3.8, 3.9, 4.8): the written grid, texture
// reads and their clamping, vertex-centred bilinear interpolation, slopeAt and normalAt, seeds, the integer
// hashes against their TypeScript twins, and the lattice noise against a reference built on those twins.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hashCell, hashU32, hashUnit, mixSeed } from '../../../src/core/gpu/hash.ts';
import { defineKernel } from '../../../src/core/gpu/kernel.ts';
import { hash } from '../../../src/core/wgsl/hash.ts';
import { noise } from '../../../src/core/wgsl/noise.ts';
import { createRig, HEIGHT_RANGE, SEED, TERRAIN_SIZE, texel, texels } from './rig.ts';

// ---- the kernels of this file ----------------------------------------------------------------------------------

const grid = defineKernel({
  name: 'test/grid',
  outputs: { cell: 'aux', coords: 'aux', metres: 'aux' },
  params: { offset: 'vec2i' },
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> Out {
  let q = px + P.offset;
  let c = clampToGrid(q);
  return Out(
    vec4f(f32(inGrid(q)), f32(c.x), f32(c.y), f32(all(pixel() == px) && all(uv == uvOf(px)))),
    vec4f(uvOf(px), uvOf(q)),
    vec4f(metresOf(px), metresOf(q)),
  );
}`,
});

const ANY = { size: 'any' } as const;

const loads = defineKernel({
  name: 'test/loads',
  inputs: { s: { kind: 'field', ...ANY }, v: { kind: 'vec2', ...ANY }, c: { kind: 'aux', ...ANY } },
  outputs: { a: 'aux', b: 'aux' },
  params: { offset: 'vec2i' },
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> Out {
  let q = px + P.offset;
  return Out(vec4f(ld(s, q), ldMask(s, q), ld2(v, q)), ld4(c, q));
}`,
});

const interpolate = defineKernel({
  name: 'test/interpolate',
  inputs: { s: { kind: 'field', ...ANY }, v: { kind: 'vec2', ...ANY }, c: { kind: 'aux', ...ANY } },
  outputs: { texel1: 'aux', texel4: 'aux', terrain1: 'aux', terrain4: 'aux' },
  params: { origin: 'vec2f', step: 'f32', uvScale: 'f32', uvBias: 'f32' },
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> Out {
  let t = P.origin + vec2f(px) * P.step;
  let w = uv * P.uvScale + P.uvBias;
  return Out(
    vec4f(bilinearPx(s, t), bilinearPx2(v, t), 0.0),
    bilinearPx4(c, t),
    vec4f(bilinear(s, w), bilinear2(v, w), 0.0),
    bilinear4(c, w),
  );
}`,
});

const shape = defineKernel({
  name: 'test/shape',
  inputs: { h: { kind: 'field', ...ANY } },
  outputs: { slope: 'vec2', normal: 'aux' },
  params: { offset: 'vec2i' },
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> Out {
  let q = px + P.offset;
  return Out(slopeAt(h, q), vec4f(normalAt(h, q), 1.0));
}`,
});

/** A u32 as two floats that hold it exactly. */
const SPLIT = 'fn split(x: u32) -> vec2f { return vec2f(f32(x & 0xffffu), f32(x >> 16u)); }';
const join = (lo: number, hi: number): number => (hi * 65536 + lo) >>> 0;

const seeds = defineKernel({
  name: 'test/seeds',
  outputs: { out: 'aux' },
  params: { mul: 'u32', add: 'u32', other: 'u32' },
  code: /* wgsl */ `
${SPLIT}
fn compute(px: vec2i, uv: vec2f) -> vec4f {
  let i = u32(px.y) * frame.res.x + u32(px.x);
  return vec4f(split(mixSeed(i * P.mul + P.add, P.other + i)), split(seedFor(i * P.mul)));
}`,
});

const hashes = defineKernel({
  name: 'test/hashes',
  outputs: { bits: 'aux', units: 'aux' },
  params: { mul: 'u32', add: 'u32', cellScale: 'vec2i', cellOffset: 'vec2i', seed: 'u32' },
  includes: [hash],
  code: /* wgsl */ `
${SPLIT}
fn compute(px: vec2i, uv: vec2f) -> Out {
  let i = u32(px.y) * frame.res.x + u32(px.x);
  let x = i * P.mul + P.add;
  let h = hash_u32(x);
  return Out(
    vec4f(split(h), split(hash_cell(px * P.cellScale + P.cellOffset, P.seed + i))),
    vec4f(hash_unit(x), hash_unit2(x), hash_unit(h)),
  );
}`,
});

const lattice = defineKernel({
  name: 'test/lattice',
  outputs: { basic: 'aux', derivative: 'aux', fractal: 'aux' },
  params: { origin: 'vec2f', step: 'f32', seed: 'u32', octaves: 'i32', lacunarity: 'f32', gain: 'f32' },
  includes: [noise],
  code: /* wgsl */ `
const E = 0.00390625;   // 1 / 256
fn compute(px: vec2i, uv: vec2f) -> Out {
  let p = P.origin + vec2f(px) * P.step;
  let d = noise_gradientD(p, P.seed);
  let fdx = (noise_gradient(p + vec2f(E, 0.0), P.seed) - noise_gradient(p - vec2f(E, 0.0), P.seed)) / (2.0 * E);
  let fdy = (noise_gradient(p + vec2f(0.0, E), P.seed) - noise_gradient(p - vec2f(0.0, E), P.seed)) / (2.0 * E);
  return Out(
    vec4f(noise_value(p, P.seed), noise_gradient(p, P.seed), noise_worley(p, P.seed)),
    vec4f(d, 0.0),
    vec4f(noise_fbm(p, P.seed, P.octaves, P.lacunarity, P.gain), fdx, fdy, 0.0),
  );
}`,
});

const rig = await createRig();
await rig.compile(grid, loads, interpolate, shape, seeds, hashes, lattice);

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
const mix = (a: number, b: number, t: number): number => a * (1 - t) + b * t;
/** Values with no structure a wrong texel or weight could hide behind. */
const rough = (x: number, y: number, k = 0): number => hashUnit(hashCell(x, y, 77 + k)) * 4 - 2;

// ---- the written grid ------------------------------------------------------------------------------------------

test('inGrid, clampToGrid, uvOf, metresOf and pixel() describe the written grid', async () => {
  for (const n of [1, 2, 9, 33]) {
    for (const [dx, dy] of [[0, 0], [-1, 0], [0, 1], [3, -4], [100, 100]] as const) {
      const out = { cell: rig.field('aux', n), coords: rig.field('aux', n), metres: rig.field('aux', n) };
      rig.run(grid, { out, params: { offset: [dx, dy] } });
      const [cell, coords, metres] = [await rig.read(out.cell), await rig.read(out.coords), await rig.read(out.metres)];
      const d = Math.max(n - 1, 1);                               // for n = 1 the divisor n - 1 is replaced by 1
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const qx = x + dx, qy = y + dy;
          const where = `n ${n}, texel (${x}, ${y}), offset (${dx}, ${dy})`;
          assert.deepEqual(
            texel(cell, n, x, y, 4),
            [qx >= 0 && qy >= 0 && qx < n && qy < n ? 1 : 0, clamp(qx, 0, n - 1), clamp(qy, 0, n - 1), 1],
            `inGrid, clampToGrid, pixel() == px and uv == uvOf(px): ${where}`,
          );
          const [u, v, uq, vq] = texel(coords, n, x, y, 4);
          const expected = [x / d, y / d, qx / d, qy / d];
          [u, v, uq, vq].forEach((got, k) => assert.ok(Math.abs(got! - expected[k]!) <= 1e-6 * Math.max(1, Math.abs(expected[k]!)), `uvOf: ${where}`));
          const [mx, my, mqx] = texel(metres, n, x, y, 4);
          assert.ok(Math.abs(mx! - (x / d) * TERRAIN_SIZE) < 1e-2 && Math.abs(my! - (y / d) * TERRAIN_SIZE) < 1e-2, `metresOf: ${where}`);
          assert.ok(Math.abs(mqx! - (qx / d) * TERRAIN_SIZE) < 1e-6 * TERRAIN_SIZE * Math.max(1, Math.abs(qx / d)), `metresOf outside the grid: ${where}`);
        }
      }
      for (const field of Object.values(out)) rig.release(field);
    }
  }
});

test('uv is exactly 0 and 1 at the corners: samples sit on vertices', async () => {
  for (const n of [2, 129, 257]) {
    const out = { cell: rig.field('aux', n), coords: rig.field('aux', n), metres: rig.field('aux', n) };
    rig.run(grid, { out, params: { offset: [0, 0] } });
    const coords = await rig.read(out.coords);
    assert.deepEqual(texel(coords, n, 0, 0, 4).slice(0, 2), [0, 0]);
    assert.deepEqual(texel(coords, n, n - 1, n - 1, 4).slice(0, 2), [1, 1], 'never (px + 0.5) / n');
    const metres = await rig.read(out.metres);
    assert.deepEqual(texel(metres, n, n - 1, 0, 4).slice(0, 2), [TERRAIN_SIZE, 0]);
    for (const field of Object.values(out)) rig.release(field);
  }
});

// ---- texture reads ---------------------------------------------------------------------------------------------

test('ld, ld2, ld4 and ldMask read a texel and clamp to the texture\'s own size', async () => {
  const w = 7, h = 4, n = 12;                                      // the textures are smaller than the written grid and not square
  const sData = texels(w, h, (x, y) => rough(x, y));
  const vData = texels(w, h, (x, y) => [rough(x, y, 1), rough(x, y, 2)]);
  const cData = texels(w, h, (x, y) => [rough(x, y, 3), rough(x, y, 4), rough(x, y, 5), rough(x, y, 6)]);
  const s = rig.field('field', [w, h], sData), v = rig.field('vec2', [w, h], vData), c = rig.field('aux', [w, h], cData);
  for (const [dx, dy] of [[0, 0], [-2, -1], [-5, 2], [1, -9]] as const) {
    const a = rig.field('aux', n), b = rig.field('aux', n);
    rig.run(loads, { in: { s, v, c }, out: { a, b }, params: { offset: [dx, dy] } });
    const [gotA, gotB] = [await rig.read(a), await rig.read(b)];
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const tx = clamp(x + dx, 0, w - 1), ty = clamp(y + dy, 0, h - 1);
        const value = texel(sData, w, tx, ty)[0]!;
        assert.deepEqual(
          texel(gotA, n, x, y, 4), [value, Math.fround(clamp(value, 0, 1)), ...texel(vData, w, tx, ty, 2)],
          `ld, ldMask and ld2 at (${x + dx}, ${y + dy}) read the border texel outside`,
        );
        assert.deepEqual(texel(gotB, n, x, y, 4), texel(cData, w, tx, ty, 4), `ld4 at (${x + dx}, ${y + dy})`);
      }
    }
    rig.release(a);
    rig.release(b);
  }
});

test('a 1 x 1 texture is a constant for every read', async () => {
  const n = 6;
  const s = rig.field('field', 1, new Float32Array([0.375])), v = rig.field('vec2', 1, new Float32Array([-1, 2]));
  const c = rig.field('aux', 1, new Float32Array([5, 6, 7, 8]));
  const a = rig.field('aux', n), b = rig.field('aux', n);
  rig.run(loads, { in: { s, v, c }, out: { a, b }, params: { offset: [-3, 9] } });
  const out = { texel1: rig.field('aux', n), texel4: rig.field('aux', n), terrain1: rig.field('aux', n), terrain4: rig.field('aux', n) };
  rig.run(interpolate, { in: { s, v, c }, out, params: { origin: [-2.5, 0.25], step: 1.5, uvScale: 3, uvBias: -1 } });
  const [gotA, gotB] = [await rig.read(a), await rig.read(b)];
  const got = { texel1: await rig.read(out.texel1), texel4: await rig.read(out.texel4), terrain1: await rig.read(out.terrain1), terrain4: await rig.read(out.terrain4) };
  for (const [x, y] of [[0, 0], [5, 5], [2, 4]] as const) {
    assert.deepEqual(texel(gotA, n, x, y, 4), [0.375, 0.375, -1, 2]);
    assert.deepEqual(texel(gotB, n, x, y, 4), [5, 6, 7, 8]);
    assert.deepEqual(texel(got.texel1, n, x, y, 4), [0.375, -1, 2, 0]);
    assert.deepEqual(texel(got.terrain1, n, x, y, 4), [0.375, -1, 2, 0]);
    assert.deepEqual(texel(got.texel4, n, x, y, 4), [5, 6, 7, 8]);
    assert.deepEqual(texel(got.terrain4, n, x, y, 4), [5, 6, 7, 8]);
  }
});

// ---- bilinear --------------------------------------------------------------------------------------------------

/** engine.md 3.8: bilinear at the fractional texel position (x, y), clamped to [0, size - 1]. */
function bilinearRef(data: Float32Array, w: number, h: number, count: number, x: number, y: number): number[] {
  const cx = clamp(x, 0, w - 1), cy = clamp(y, 0, h - 1);
  const ix = Math.floor(cx), iy = Math.floor(cy), fx = cx - ix, fy = cy - iy;
  const at = (i: number, j: number): number[] => texel(data, w, clamp(i, 0, w - 1), clamp(j, 0, h - 1), count);
  const [p00, p10, p01, p11] = [at(ix, iy), at(ix + 1, iy), at(ix, iy + 1), at(ix + 1, iy + 1)];
  return p00.map((_, k) => mix(mix(p00[k]!, p10[k]!, fx), mix(p01[k]!, p11[k]!, fx), fy));
}
const near = (got: readonly number[], expected: readonly number[], tolerance: number): boolean =>
  got.length === expected.length && got.every((v, k) => Math.abs(v - expected[k]!) <= tolerance);

test('bilinearPx, bilinearPx2 and bilinearPx4 interpolate the four texels around a texel position', async () => {
  const w = 6, h = 5, n = 16;
  const sData = texels(w, h, (x, y) => rough(x, y));
  const vData = texels(w, h, (x, y) => [rough(x, y, 1), rough(x, y, 2)]);
  const cData = texels(w, h, (x, y) => [rough(x, y, 3), rough(x, y, 4), rough(x, y, 5), rough(x, y, 6)]);
  const s = rig.field('field', [w, h], sData), v = rig.field('vec2', [w, h], vData), c = rig.field('aux', [w, h], cData);
  const out = { texel1: rig.field('aux', n), texel4: rig.field('aux', n), terrain1: rig.field('aux', n), terrain4: rig.field('aux', n) };
  // Positions from (-1.25, -1.25) in steps of 0.5: inside, on texels, and outside on every side.
  const origin = [-1.25, -1.25] as const, step = 0.5;
  rig.run(interpolate, { in: { s, v, c }, out, params: { origin, step, uvScale: 1, uvBias: 0 } });
  const [one, four] = [await rig.read(out.texel1), await rig.read(out.texel4)];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const tx = origin[0] + x * step, ty = origin[1] + y * step;
      const got = texel(one, n, x, y, 4);
      assert.ok(near(got.slice(0, 1), bilinearRef(sData, w, h, 1, tx, ty), 1e-5), `bilinearPx at (${tx}, ${ty})`);
      assert.ok(near(got.slice(1, 3), bilinearRef(vData, w, h, 2, tx, ty), 1e-5), `bilinearPx2 at (${tx}, ${ty})`);
      assert.ok(near(texel(four, n, x, y, 4), bilinearRef(cData, w, h, 4, tx, ty), 1e-5), `bilinearPx4 at (${tx}, ${ty})`);
    }
  }
  // At an integer position the texel comes back exactly.
  rig.run(interpolate, { in: { s, v, c }, out, params: { origin: [0, 0], step: 1, uvScale: 1, uvBias: 0 } });
  const exact = await rig.read(out.texel4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) assert.deepEqual(texel(exact, n, x, y, 4), texel(cData, w, x, y, 4), `texel (${x}, ${y})`);
  }
});

test('bilinear is vertex-centred: uv 0..1 spans the first to the last texel', async () => {
  // A 5 x 3 texture read into a 9 x 5 corner of a 9 x 9 grid would hide nothing; the grid is 9 x 9 and the texture 5 x 3:
  // output texel (x, y) has uv = (x, y) / 8, which is texture position (x / 2, y / 4).
  const w = 5, h = 3, n = 9;
  const sData = texels(w, h, (x, y) => rough(x, y));
  const vData = texels(w, h, (x, y) => [rough(x, y, 1), rough(x, y, 2)]);
  const cData = texels(w, h, (x, y) => [rough(x, y, 3), rough(x, y, 4), rough(x, y, 5), rough(x, y, 6)]);
  const s = rig.field('field', [w, h], sData), v = rig.field('vec2', [w, h], vData), c = rig.field('aux', [w, h], cData);
  const out = { texel1: rig.field('aux', n), texel4: rig.field('aux', n), terrain1: rig.field('aux', n), terrain4: rig.field('aux', n) };
  rig.run(interpolate, { in: { s, v, c }, out, params: { origin: [0, 0], step: 1, uvScale: 1, uvBias: 0 } });
  const [one, four] = [await rig.read(out.terrain1), await rig.read(out.terrain4)];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const tx = (x / 8) * (w - 1), ty = (y / 8) * (h - 1);
      const got = texel(one, n, x, y, 4);
      assert.ok(near(got.slice(0, 1), bilinearRef(sData, w, h, 1, tx, ty), 1e-5), `bilinear at uv (${x / 8}, ${y / 8})`);
      assert.ok(near(got.slice(1, 3), bilinearRef(vData, w, h, 2, tx, ty), 1e-5), `bilinear2 at uv (${x / 8}, ${y / 8})`);
      assert.ok(near(texel(four, n, x, y, 4), bilinearRef(cData, w, h, 4, tx, ty), 1e-5), `bilinear4 at uv (${x / 8}, ${y / 8})`);
      // Where the uv falls on a texture vertex the texel comes back exactly: a texel-centred mapping would blend there.
      if (x % 2 === 0 && y % 4 === 0) assert.deepEqual(texel(four, n, x, y, 4), texel(cData, w, x / 2, y / 4, 4), `vertex (${x / 2}, ${y / 4})`);
    }
  }
  // uv outside 0..1 reads the border.
  rig.run(interpolate, { in: { s, v, c }, out, params: { origin: [0, 0], step: 1, uvScale: 3, uvBias: -1 } });
  const wide = await rig.read(out.terrain4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const tx = ((x / 8) * 3 - 1) * (w - 1), ty = ((y / 8) * 3 - 1) * (h - 1);
      assert.ok(near(texel(wide, n, x, y, 4), bilinearRef(cData, w, h, 4, tx, ty), 2e-5), `bilinear4 at uv (${(x / 8) * 3 - 1}, ${(y / 8) * 3 - 1})`);
    }
  }
});

// ---- terrain shape ---------------------------------------------------------------------------------------------

/** engine.md 3.8: central difference, one-sided on the border, in metres per metre, with the texture's own cell size. */
function slopeRef(data: Float32Array, w: number, h: number, x: number, y: number): [number, number] {
  const qx = clamp(x, 0, w - 1), qy = clamp(y, 0, h - 1);
  const lox = Math.max(qx - 1, 0), hix = Math.min(qx + 1, w - 1), loy = Math.max(qy - 1, 0), hiy = Math.min(qy + 1, h - 1);
  const at = (i: number, j: number): number => data[j * w + i]!;
  const runX = Math.max(hix - lox, 1) * (TERRAIN_SIZE / Math.max(w - 1, 1));
  const runY = Math.max(hiy - loy, 1) * (TERRAIN_SIZE / Math.max(h - 1, 1));
  return [(at(hix, qy) - at(lox, qy)) * HEIGHT_RANGE / runX, (at(qx, hiy) - at(qx, loy)) * HEIGHT_RANGE / runY];
}

test('slopeAt of a plane is its gradient in metres per metre, on the border too', async () => {
  const n = 33;                                                    // cell 128 m; heights times 1024 m
  const a = 0.01, b = -0.004;                                      // height units per texel
  const h = rig.field('field', n, texels(n, n, (x, y) => 0.2 + a * x + b * y));
  const slope = rig.field('vec2', n), normal = rig.field('aux', n);
  rig.run(shape, { in: { h }, out: { slope, normal }, params: { offset: [0, 0] } });
  const [gotSlope, gotNormal] = [await rig.read(slope), await rig.read(normal)];
  const cell = TERRAIN_SIZE / (n - 1);
  const sx = (a * HEIGHT_RANGE) / cell, sy = (b * HEIGHT_RANGE) / cell;
  const length = Math.hypot(sx, sy, 1);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      assert.ok(near(texel(gotSlope, n, x, y, 2), [sx, sy], 2e-4), `slopeAt (${x}, ${y}): ${texel(gotSlope, n, x, y, 2)} against ${[sx, sy]}`);
      assert.ok(near(texel(gotNormal, n, x, y, 4), [-sx / length, -sy / length, 1 / length, 1], 2e-4), `normalAt (${x}, ${y})`);
    }
  }
});

test('slopeAt is a central difference inside, one-sided on the border, and clamps its texel', async () => {
  const w = 9, hgt = 6, n = 12;                                    // a texture of its own size, not square: its cells are 512 m by 819.2 m
  const data = texels(w, hgt, (x, y) => 0.001 * x * x + 0.002 * y * y * y + 0.0005 * x * y);
  const h = rig.field('field', [w, hgt], data);
  for (const [dx, dy] of [[0, 0], [-2, -3]] as const) {
    const slope = rig.field('vec2', n), normal = rig.field('aux', n);
    rig.run(shape, { in: { h }, out: { slope, normal }, params: { offset: [dx, dy] } });
    const [gotSlope, gotNormal] = [await rig.read(slope), await rig.read(normal)];
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const [sx, sy] = slopeRef(data, w, hgt, x + dx, y + dy);
        assert.ok(near(texel(gotSlope, n, x, y, 2), [sx, sy], 1e-5), `slopeAt (${x + dx}, ${y + dy}): ${texel(gotSlope, n, x, y, 2)} against ${[sx, sy]}`);
        const length = Math.hypot(sx, sy, 1);
        assert.ok(near(texel(gotNormal, n, x, y, 4), [-sx / length, -sy / length, 1 / length, 1], 1e-5), `normalAt (${x + dx}, ${y + dy})`);
      }
    }
    rig.release(slope);
    rig.release(normal);
  }
  // The values that tell the three cases apart, for x * x along a row: 2x inside, 1 at the left edge, 2 * last - 1 at the right.
  const row = rig.field('field', [w, 1], texels(w, 1, (x) => x * x));
  const slope = rig.field('vec2', n), normal = rig.field('aux', n);
  rig.run(shape, { in: { h: row }, out: { slope, normal }, params: { offset: [0, 0] } });
  const got = await rig.read(slope);
  const scale = HEIGHT_RANGE / (TERRAIN_SIZE / (w - 1));
  assert.ok(near([0, 1, 4, 8].map((x) => texel(got, n, x, 0, 2)[0]! / scale), [1, 2, 8, 15], 1e-4));
  assert.ok(texel(got, n, 4, 0, 2)[1] === 0, 'a texture one texel high has no slope along y');
});

test('slopeAt of a constant is zero and its normal points up', async () => {
  const n = 8;
  for (const size of [1, 5]) {
    const h = rig.field('field', size, 0.7);
    const slope = rig.field('vec2', n), normal = rig.field('aux', n);
    rig.run(shape, { in: { h }, out: { slope, normal }, params: { offset: [0, 0] } });
    assert.ok((await rig.read(slope)).every((v) => v === 0), `size ${size}`);
    // -0 is a correct x and y of normalize(vec3f(-0, -0, 1)).
    assert.deepEqual(texel(await rig.read(normal), n, 3, 3, 4).map((v) => v + 0), [0, 0, 1, 1]);
  }
});

// ---- seeds and hashes ------------------------------------------------------------------------------------------

const SIDE = 32;                                                   // 1024 inputs per run

test('mixSeed and seedFor return what the TypeScript mixSeed returns, on 2048 inputs', async () => {
  for (const [mul, add, other] of [[1, 0, 0], [2654435761, 0xdeadbeef, 0xfffffff0]] as const) {
    const out = rig.field('aux', SIDE);
    rig.run(seeds, { out: { out }, params: { mul, add, other } });
    const got = await rig.read(out);
    for (let i = 0; i < SIDE * SIDE; i++) {
      const [lo, hi, seedLo, seedHi] = got.subarray(i * 4, i * 4 + 4);
      const a = (Math.imul(i, mul) + add) >>> 0, b = (other + i) >>> 0;
      assert.equal(join(lo!, hi!), mixSeed(a, b), `mixSeed(${a}, ${b})`);
      assert.equal(join(seedLo!, seedHi!), mixSeed(SEED, Math.imul(i, mul) >>> 0), `seedFor(${Math.imul(i, mul) >>> 0}) with frame.seed ${SEED}`);
    }
    rig.release(out);
  }
});

test('hash_u32, hash_cell, hash_unit and hash_unit2 agree with hashU32, hashCell and hashUnit on 3072 inputs', async () => {
  const runs = [
    { mul: 1, add: 0, cellScale: [1, 1], cellOffset: [0, 0], seed: 0 },
    { mul: 2654435761, add: 0x9e3779b9, cellScale: [-3, 7], cellOffset: [-40, -100], seed: 0x7fffffff },
    { mul: 0x01000193, add: 0xffffff00, cellScale: [65536, -65536], cellOffset: [-2147483648, 2147483647], seed: 0xfffffc00 },
  ] as const;
  for (const params of runs) {
    const bits = rig.field('aux', SIDE), units = rig.field('aux', SIDE);
    rig.run(hashes, { out: { bits, units }, params });
    const [gotBits, gotUnits] = [await rig.read(bits), await rig.read(units)];
    for (let i = 0; i < SIDE * SIDE; i++) {
      const px = i % SIDE, py = Math.floor(i / SIDE);
      const x = (Math.imul(i, params.mul) + params.add) >>> 0;
      const [lo, hi, cellLo, cellHi] = gotBits.subarray(i * 4, i * 4 + 4);
      assert.equal(join(lo!, hi!), hashU32(x), `hash_u32(${x})`);
      // The cell is computed in wrapping i32 arithmetic, as WGSL computes it.
      const cx = (Math.imul(px, params.cellScale[0]) + params.cellOffset[0]) | 0, cy = (Math.imul(py, params.cellScale[1]) + params.cellOffset[1]) | 0;
      const seed = (params.seed + i) >>> 0;
      assert.equal(join(cellLo!, cellHi!), hashCell(cx, cy, seed), `hash_cell((${cx}, ${cy}), ${seed})`);
      const [unit, unit2x, unit2y, unitOfHash] = gotUnits.subarray(i * 4, i * 4 + 4);
      assert.equal(unit, hashUnit(x), `hash_unit(${x}) is exact`);
      assert.deepEqual([unit2x, unit2y], [hashUnit(x), hashUnit(hashU32(x))], `hash_unit2(${x})`);
      assert.equal(unitOfHash, hashUnit(hashU32(x)));
      assert.ok(unit! >= 0 && unit! < 1);
    }
    rig.release(bits);
    rig.release(units);
  }
});

// ---- noise -----------------------------------------------------------------------------------------------------

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
const GRADIENTS = Array.from({ length: 16 }, (_, k) => [Math.cos(((k + 0.5) * Math.PI) / 8), Math.sin(((k + 0.5) * Math.PI) / 8)] as const);

function valueRef(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), ux = fade(x - ix), uy = fade(y - iy);
  const corner = (i: number, j: number): number => hashUnit(hashCell(ix + i, iy + j, seed));
  return mix(mix(corner(0, 0), corner(1, 0), ux), mix(corner(0, 1), corner(1, 1), ux), uy);
}
function gradientRef(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, ux = fade(fx), uy = fade(fy);
  const corner = (i: number, j: number): number => {
    const g = GRADIENTS[hashCell(ix + i, iy + j, seed) >>> 28]!;
    return g[0] * (fx - i) + g[1] * (fy - j);
  };
  return mix(mix(corner(0, 0), corner(1, 0), ux), mix(corner(0, 1), corner(1, 1), ux), uy) * Math.SQRT2;
}
/** Brute force over 7 x 7 cells, wider than the library searches. */
function worleyRef(x: number, y: number, seed: number): [number, number] {
  const cx = Math.floor(x), cy = Math.floor(y);
  const distances: number[] = [];
  for (let j = -3; j <= 3; j++) {
    for (let i = -3; i <= 3; i++) {
      const h = hashCell(cx + i, cy + j, seed);
      distances.push(Math.hypot(cx + i + hashUnit(h) - x, cy + j + hashUnit(hashU32(h)) - y));
    }
  }
  distances.sort((p, q) => p - q);
  return [distances[0]!, distances[1]!];
}
function fbmRef(x: number, y: number, seed: number, octaves: number, lacunarity: number, gain: number): number {
  let sum = 0, norm = 0, amp = 1;
  for (let i = 0; i < clamp(octaves, 1, 16); i++) {
    sum += amp * gradientRef(x, y, mixSeed(seed, i));
    norm += Math.abs(amp);
    amp *= gain;
    x = Math.fround(x * lacunarity);
    y = Math.fround(y * lacunarity);
  }
  return sum / norm;
}

const N = 65;
const noiseAt = async (params: { origin: readonly [number, number]; step: number; seed: number; octaves: number; lacunarity: number; gain: number }) => {
  const out = { basic: rig.field('aux', N), derivative: rig.field('aux', N), fractal: rig.field('aux', N) };
  rig.run(lattice, { out, params });
  const result = { basic: await rig.read(out.basic), derivative: await rig.read(out.derivative), fractal: await rig.read(out.fractal) };
  for (const field of Object.values(out)) rig.release(field);
  return result;
};

test('noise_value, noise_gradient and noise_worley are the functions of the lattice hashes the contract describes', async () => {
  // Eight cells across, starting at a negative lattice coordinate: the lattice is unbounded.
  for (const [ox, oy, seed] of [[0, 0, 1], [-3, -5, 0x9e3779b9], [1000, -77, 4294967295]] as const) {
    const step = 0.125;
    const { basic } = await noiseAt({ origin: [ox, oy], step, seed, octaves: 1, lacunarity: 2, gain: 0.5 });
    let low = Infinity, high = -Infinity;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const px = ox + x * step, py = oy + y * step;
        const [value, gradient, f1, f2] = texel(basic, N, x, y, 4);
        const where = `p (${px}, ${py}), seed ${seed}`;
        assert.ok(Math.abs(value! - valueRef(px, py, seed)) < 1e-5 && value! >= 0 && value! <= 1, `noise_value: ${where}`);
        assert.ok(Math.abs(gradient! - gradientRef(px, py, seed)) < 1e-5 && Math.abs(gradient!) <= 1, `noise_gradient: ${where}`);
        const [r1, r2] = worleyRef(px, py, seed);
        assert.ok(Math.abs(f1! - r1) < 1e-5 && Math.abs(f2! - r2) < 1e-5, `noise_worley: ${where}: ${[f1, f2]} against ${[r1, r2]}`);
        assert.ok(f1! >= 0 && f1! <= f2! && f1! <= Math.SQRT2 + 1e-6, `0 <= F1 <= F2, F1 <= sqrt 2: ${where}`);
        if (x % 8 === 0 && y % 8 === 0) {
          assert.equal(value, hashUnit(hashCell(px, py, seed)), `noise_value at a lattice point is the hash of the cell: ${where}`);
          assert.ok(gradient === 0, `noise_gradient is 0 at a lattice point: ${where}`);
        }
        low = Math.min(low, gradient!);
        high = Math.max(high, gradient!);
      }
    }
    assert.ok(high - low > 0.5, 'the gradient noise is not flat');
  }
});

test('noise_gradientD carries the value and its analytic derivative', async () => {
  const { basic, derivative, fractal } = await noiseAt({ origin: [-2.03125, 5.0625], step: 0.0625, seed: 12345, octaves: 1, lacunarity: 2, gain: 0.5 });
  let steepest = 0;
  for (let i = 0; i < N * N; i++) {
    const [value, dx, dy] = derivative.subarray(i * 4, i * 4 + 3);
    assert.equal(value, basic[i * 4 + 1], '.x is noise_gradient');
    const [, fdx, fdy] = fractal.subarray(i * 4, i * 4 + 3);
    assert.ok(Math.abs(dx! - fdx!) < 5e-3 && Math.abs(dy! - fdy!) < 5e-3, `.yz against a central difference: ${[dx, dy]} against ${[fdx, fdy]}`);
    steepest = Math.max(steepest, Math.abs(dx!), Math.abs(dy!));
  }
  assert.ok(steepest > 0.5, 'the derivative is not flat');
});

test('noise_fbm is the normalised sum of octaves with seeds mixSeed(seed, i), and clamps the octave count', async () => {
  const base = { origin: [-1.5, 2.25] as const, step: 0.046875, seed: 99, lacunarity: 2, gain: 0.5 };
  for (const [octaves, lacunarity, gain] of [[1, 2, 0.5], [5, 2, 0.5], [16, 1.75, 0.6], [3, 3, 1]] as const) {
    const { fractal } = await noiseAt({ ...base, octaves, lacunarity, gain });
    for (let y = 0; y < N; y += 3) {
      for (let x = 0; x < N; x += 3) {
        const px = base.origin[0] + x * base.step, py = base.origin[1] + y * base.step;
        const got = texel(fractal, N, x, y, 4)[0]!;
        // The position of octave i is p * lacunarity^i in float32; its error grows with the octave's frequency.
        assert.ok(Math.abs(got - fbmRef(px, py, base.seed, octaves, lacunarity, gain)) < 2e-3, `${octaves} octaves at (${px}, ${py}): ${got} against ${fbmRef(px, py, base.seed, octaves, lacunarity, gain)}`);
        assert.ok(Math.abs(got) <= 1);
      }
    }
  }
  const at = async (octaves: number): Promise<Float32Array> => (await noiseAt({ ...base, octaves })).fractal.filter((_, i) => i % 4 === 0);
  const [one, sixteen] = [await at(1), await at(16)];
  // The index of the first float that differs, or -1. A field of 4225 floats is never handed to deepEqual:
  // the diff node:assert builds when it fails grows with the square of the length.
  const firstDifference = (a: Float32Array, b: Float32Array): number => (a.length === b.length ? a.findIndex((v, i) => !Object.is(v, b[i])) : 0);
  assert.equal(firstDifference(await at(0), one), -1, '0 octaves are 1');
  assert.equal(firstDifference(await at(-7), one), -1, 'a negative count is 1');
  assert.equal(firstDifference(await at(40), sixteen), -1, '40 octaves are 16');
  assert.notEqual(firstDifference(one, sixteen), -1, '16 octaves are not 1');
});

test('the noise is finite for any finite position', async () => {
  for (const origin of [[1e12, -1e12], [3.0e38, 3.0e38], [-2147483648, 2147483647], [16777216, -16777217]] as const) {
    const { basic, derivative, fractal } = await noiseAt({ origin, step: 1e6, seed: 7, octaves: 16, lacunarity: 2, gain: 0.5 });
    for (const data of [basic, derivative, fractal.filter((_, i) => i % 4 === 0)]) {
      assert.ok(data.every(Number.isFinite), `origin ${origin}`);
    }
  }
});
