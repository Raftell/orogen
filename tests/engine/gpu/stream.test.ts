// The command stream on the device (runtime.md section 3, engine.md 3.11, 3.14, 3.15): per-run uniforms inside
// one slice, call order, tiles, slices and their owners, the arena, learned throughput, the hard ceiling,
// waiting, cancellation and error scopes.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DeviceLostError } from '../../../src/core/gpu/device.ts';
import { defineKernel } from '../../../src/core/gpu/kernel.ts';
import { GpuValidationError, WatchdogError, type SliceReport } from '../../../src/core/gpu/stream.ts';
import { RATE_CAP_FACTOR, RATE_FLOOR_FACTOR, RATE_INITIAL } from '../../../src/core/gpu/tuning.ts';
import { createRig, firstDifference, HEIGHT_RANGE, TERRAIN_SIZE, texel, texels, type Rig } from './rig.ts';
import { fbm, relax, step } from './worked.ts';

// ---- the kernels of this file ----------------------------------------------------------------------------------

const stamp = defineKernel({
  name: 'test/stamp',
  outputs: { out: 'aux' },
  params: { value: 'f32', tag: 'u32' },
  code: 'fn compute(px: vec2i, uv: vec2f) -> vec4f { return vec4f(P.value, f32(P.tag), f32(frame.iteration), f32(frame.seed & 0xffffu)); }',
});

const chain = defineKernel({
  name: 'test/chain',
  inPlace: { acc: 'field' },
  params: { mul: 'f32', add: 'f32' },
  code: 'fn compute(px: vec2i, uv: vec2f, cur: Cur) -> Out { return Out(cur.acc * P.mul + P.add); }',
});

const count = defineKernel({
  name: 'test/count',
  inPlace: { acc: 'field' },
  code: 'fn compute(px: vec2i, uv: vec2f, cur: Cur) -> Out { return Out(cur.acc + f32(frame.iteration)); }',
});

const WHERE = 'fn compute(px: vec2i, uv: vec2f) -> f32 { return f32(px.x) + 1000.0 * f32(px.y); }';
const where = defineKernel({ name: 'test/where', outputs: { out: 'field' }, code: WHERE });
const whereWide = defineKernel({ name: 'test/where#wide', outputs: { out: 'field' }, workgroup: [16, 4], code: WHERE });
const whereTall = defineKernel({ name: 'test/where#tall', outputs: { out: 'field' }, workgroup: [2, 64], code: WHERE });
const untiled = defineKernel({ name: 'test/untiled', outputs: { out: 'field' }, tiled: false, code: WHERE });

const checker = defineKernel({
  name: 'test/checker',
  mode: 'raw',
  inputs: { src: 'field' },
  outputs: { out: 'field' },
  inPlace: { total: 'field' },
  workgroup: [4, 4],
  code: /* wgsl */ `
@compute @workgroup_size(4, 4)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (!beginPixel(gid)) { return; }
  let px = pixel();
  if (((px.x + px.y) & 1) != 0) { return; }
  out_set(src_at(px + vec2i(1, 1)) - src_at(px - vec2i(1, 1)));
  total_set(total_get() + src_at(px));
}`,
});

const KERNELS = [stamp, chain, count, where, whereWide, whereTall, untiled, checker, fbm, step, relax] as const;

/** One rig per slicing of testing.md 2.1, made on first use. `tiled` cuts every run into tiles of 8 rows inside one slice. */
const SLICING = {
  auto: { poisonRecycled: true },
  small: { poisonRecycled: true, sliceTargetMs: 1e-6 },
  one: { poisonRecycled: true, sliceTargetMs: 1e9 },
  tiled: { poisonRecycled: true, sliceTargetMs: 1e9, maxTileRows: 8 },
} as const;
const rigs = new Map<string, Promise<Rig>>();
function rigFor(slicing: keyof typeof SLICING): Promise<Rig> {
  let rig = rigs.get(slicing);
  if (!rig) {
    rig = createRig({ hooks: SLICING[slicing] }).then(async (made) => {
      await made.compile(...KERNELS);
      return made;
    });
    rigs.set(slicing, rig);
  }
  return rig;
}

/** The slices that complete while `work` runs; `work` ends with a wait for everything it submitted. */
async function slicesOf(rig: Rig, work: () => void | Promise<void>): Promise<SliceReport[]> {
  await rig.stream.flush();
  const before = rig.slices.length;
  await work();
  await rig.stream.flush();
  return rig.slices.slice(before);
}

// ---- per-run uniforms (engine.md 3.11) -------------------------------------------------------------------------

test('every run owns its params, its iteration and its seed, however many runs share one slice', async () => {
  const rig = await rigFor('one');
  const n = 8, runs = 40;
  const fields = Array.from({ length: runs }, () => rig.field('aux', n));
  const slices = await slicesOf(rig, () => {
    fields.forEach((out, i) => {
      rig.run(stamp, { out: { out }, params: { value: i * 0.5 - 3, tag: 1000 + i }, ...(i % 2 === 0 ? { iteration: 7 * i } : {}) }, { iteration: i, seed: 100 + i });
    });
  });
  assert.equal(slices.length, 1, 'forty runs, one submission');
  assert.deepEqual(slices[0]!.kernels, ['test/stamp']);
  assert.equal(slices[0]!.work, runs * n * n * 8, 'texels written x cost, with the default cost of 8');
  for (let i = 0; i < runs; i++) {
    const got = await rig.read(fields[i]!);
    const expected = [i * 0.5 - 3, 1000 + i, i % 2 === 0 ? 7 * i : i, 100 + i];
    assert.deepEqual(texel(got, n, 0, 0, 4), expected, `run ${i}`);
    assert.deepEqual(texel(got, n, n - 1, n - 1, 4), expected, `run ${i}`);
    rig.release(fields[i]!);
  }
});

test('runs of one slice take effect in the order of the calls', async () => {
  const rig = await rigFor('one');
  const n = 16;
  const acc = rig.field('field', n, 1);
  let expected = 1;
  const slices = await slicesOf(rig, () => {
    for (let i = 0; i < 20; i++) {
      const mul = 1 + (i % 2), add = i;                          // not commutative: 2 * (v + a) differs from 2 * v + a
      rig.run(chain, { rw: { acc }, params: { mul, add } });
      expected = expected * mul + add;
    }
  });
  assert.equal(slices.length, 1);
  assert.ok(expected < 2 ** 24, 'every intermediate value is an exact float');
  assert.ok((await rig.read(acc)).every((v) => v === expected), `${texel(await rig.read(acc), n, 0, 0)[0]} against ${expected}`);
});

// ---- call order (engine.md 3.11) -------------------------------------------------------------------------------

for (const slicing of ['auto', 'small', 'one'] as const) {
  test(`run, clear, copy, write and read take effect in the order of the calls (slices: ${slicing})`, async () => {
    const rig = await rigFor(slicing);
    const n = 24;
    const f = rig.field('field', n, 1);                                              // 1
    rig.run(chain, { rw: { acc: f }, params: { mul: 2, add: 1 } });                  // 3
    rig.write(f, new Float32Array(2 * n).fill(10), [2, 4]);                          // rows 2 and 3: 10
    rig.run(chain, { rw: { acc: f }, params: { mul: 3, add: 0 } });                  // 9; rows 2 and 3: 30
    const g = rig.field('field', n);
    rig.stream.copy(rig.texture(f), rig.texture(g));                                 // g is f as it is now
    rig.stream.clear(rig.texture(f), [5, 5, 5, 5]);                                  // f: 5
    rig.run(chain, { rw: { acc: g }, params: { mul: 1, add: 100 } });                // g: 109; rows 2 and 3: 130
    const early = rig.read(g);                                                       // not awaited: later work must not show in it
    rig.write(f, new Float32Array(n).fill(7), [0, 1]);                               // f row 0: 7
    rig.run(chain, { rw: { acc: g }, params: { mul: 0, add: -1 } });                 // g: -1
    rig.run(chain, { rw: { acc: f }, params: { mul: 2, add: 0 } });                  // f: 10; row 0: 14

    assert.equal(firstDifference(await early, texels(n, n, (_, y) => (y === 2 || y === 3 ? 130 : 109))), -1, 'a read sees the work before it and none after');
    assert.equal(firstDifference(await rig.read(f), texels(n, n, (_, y) => (y === 0 ? 14 : 10))), -1);
    assert.ok((await rig.read(g)).every((v) => v === -1));
    rig.release(f);
    rig.release(g);
  });
}

// ---- tiles (runtime.md 3.4, engine.md 3.14, 3.15) --------------------------------------------------------------

/** Everything a tiling could change, computed on one rig. */
async function tiledWork(rig: Rig): Promise<Record<string, Float32Array>> {
  const out: Record<string, Float32Array> = {};
  const n = 129;

  for (const kernel of [where, whereWide, whereTall]) {
    const field = rig.field('field', n);
    rig.run(kernel, { out: { out: field } });
    out[kernel.name] = await rig.read(field);
    rig.release(field);
  }

  const noise = rig.field('field', n);
  rig.run(fbm, { out: { out: noise }, params: { cells: 6, octaves: 6, gain: 0.5 }, cost: 48 });
  out.fbm = await rig.read(noise);

  // A stencil that reads the rows of other tiles, with an in-place accumulator, over a ping-pong pair.
  let a = rig.field('field', n, out.fbm);
  let b = rig.field('field', n);
  const moved = rig.field('field', n, 0);
  const params = { talus: Math.tan((20 * Math.PI) / 180) * (TERRAIN_SIZE / (n - 1)) / HEIGHT_RANGE, rate: 0.1 };
  for (let i = 0; i < 25; i++) {
    rig.run(step, { in: { h: a }, out: { next: b }, rw: { moved }, params }, { iteration: i });
    [a, b] = [b, a];
  }
  out.talus = await rig.read(a);
  out.moved = await rig.read(moved);

  // Raw mode: conditional stores, which leave the other texels as they were.
  const kept = rig.field('field', n, 0.5), total = rig.field('field', n, 0);
  for (let i = 0; i < 3; i++) rig.run(checker, { in: { src: noise }, out: { out: kept }, rw: { total } });
  out.checker = await rig.read(kept);
  out.total = await rig.read(total);

  // unsafeReadWrite: every half-step reads the neighbours the other half-step wrote, across tile borders.
  const g = rig.field('field', n, out.fbm);
  for (let i = 0; i < 6; i++) rig.run(relax, { rw: { g }, params: { parity: i % 2 } });
  out.relax = await rig.read(g);

  for (const field of [noise, a, b, moved, kept, total, g]) rig.release(field);
  return out;
}

test('tiles give bit-identical results to an untiled run', async () => {
  const reference = await tiledWork(await rigFor('one'));
  assert.equal(firstDifference(reference['test/where']!, texels(129, 129, (x, y) => x + 1000 * y)), -1, 'px is the texel being written');
  assert.ok(reference.moved!.some((v) => v > 0) && reference.checker!.some((v) => v !== 0.5) && reference.relax!.some((v, i) => v !== reference.fbm![i]));
  for (const slicing of ['tiled', 'small', 'auto'] as const) {
    const got = await tiledWork(await rigFor(slicing));
    for (const [name, data] of Object.entries(reference)) {
      const at = firstDifference(got[name]!, data);
      assert.equal(at, -1, `${name} with slices "${slicing}" differs at index ${at} (texel ${at % 129}, ${Math.floor(at / 129)})`);
    }
  }
});

test('a tile is a band of whole workgroup rows, each its own dispatch', async () => {
  const n = 129;
  const expected = texels(n, n, (x, y) => x + 1000 * y);
  for (const [kernel, workgroupY] of [[where, 8], [whereWide, 4], [whereTall, 64]] as const) {
    // With the smallest target every tile is one workgroup high and every dispatch is its own slice.
    const small = await rigFor('small');
    const field = small.field('field', n);
    const slices = await slicesOf(small, () => { small.run(kernel, { out: { out: field } }); });
    assert.equal(slices.length, Math.ceil(n / workgroupY), `${kernel.name}: one slice per tile`);
    slices.forEach((slice, t) => {
      const rows = Math.min(workgroupY, n - t * workgroupY);
      assert.equal(slice.work, n * rows * 8, `${kernel.name}: tile ${t} covers ${rows} rows`);
      assert.deepEqual(slice.kernels, [kernel.name]);
    });
    assert.equal(firstDifference(await small.read(field), expected), -1);
    small.release(field);

    // With the largest target a run is one dispatch.
    const one = await rigFor('one');
    const whole = one.field('field', n);
    const single = await slicesOf(one, () => { one.run(kernel, { out: { out: whole } }); });
    assert.deepEqual(single.map((s) => s.work), [n * n * 8]);
    one.release(whole);
  }
  // maxTileRows cuts a run into tiles without cutting the slice.
  const tiled = await rigFor('tiled');
  const field = tiled.field('field', n);
  const slices = await slicesOf(tiled, () => { tiled.run(where, { out: { out: field } }); });
  assert.deepEqual(slices.map((s) => s.work), [n * n * 8]);
  assert.equal(firstDifference(await tiled.read(field), expected), -1);
  tiled.release(field);
});

test('a kernel run twice on the same inputs is bit-identical', async () => {
  const rig = await rigFor('auto');
  const first = await tiledWork(rig);
  // The second run gets recycled textures, which hold -1e30 where the first run's were new.
  const second = await tiledWork(rig);
  for (const [name, data] of Object.entries(first)) assert.equal(firstDifference(second[name]!, data), -1, name);
});

// ---- slices and owners (runtime.md 3.1, 5.14) ------------------------------------------------------------------

test('a slice holds the work of one owner; a change of owner closes it', async () => {
  const rig = await rigFor('one');
  const n = 8;
  const a = rig.field('field', n), b = rig.field('field', n), c = rig.field('field', n);
  await rig.stream.flush();
  const before = rig.slices.length;

  const node = rig.use({ nodeId: 'node-a' });
  assert.equal(rig.stream.current, node);
  rig.run(where, { out: { out: a } });
  const submitted = rig.stream.submitted;
  const service = rig.use({ nodeId: null, service: 'convert' });
  assert.equal(rig.stream.submitted, submitted + 1, 'the open slice of the first owner was submitted');
  assert.equal(rig.stream.current, service);
  rig.run(where, { out: { out: b } });
  rig.run(whereWide, { out: { out: c } });
  rig.stream.use(service);
  assert.equal(rig.stream.submitted, submitted + 1, 'making the current owner current again changes nothing');
  await rig.stream.flush();

  const reports = rig.slices.slice(before);
  assert.deepEqual(reports.map((s) => [s.nodeId, s.service, s.kernels]), [
    ['node-a', null, ['test/where']],
    [null, 'convert', ['test/where', 'test/where#wide']],
  ], 'exactly one of nodeId and service is not null');
  assert.deepEqual(reports.map((s) => s.work), [n * n * 8, 2 * n * n * 8]);
  assert.equal((await node.settle()).slices, 1);
  assert.equal((await service.settle()).slices, 1);
  node.close();
  service.close();
  rig.stream.use(rig.owner);
  for (const field of [a, b, c]) rig.release(field);
});

test('an owner is a node or a service, and is used until it is closed', async () => {
  const rig = await rigFor('one');
  assert.throws(() => rig.stream.open({ nodeId: null, service: null, mode: 'preview' }), TypeError);
  assert.throws(() => rig.stream.open({ nodeId: 'n', service: 'mask', mode: 'preview' }), TypeError);
  const owner = rig.use({ nodeId: 'short-lived' });
  const field = rig.field('field', 8, 2);
  await rig.stream.flush();
  rig.run(chain, { rw: { acc: field }, params: { mul: 1, add: 1 } });
  const submitted = rig.stream.submitted;
  owner.close();
  owner.close();
  assert.equal(rig.stream.current, null);
  assert.equal(rig.stream.submitted, submitted, 'the unsubmitted work of a closed owner is discarded');
  assert.throws(() => rig.stream.use(owner), /closed/);
  assert.throws(() => rig.run(where, { out: { out: field } }), /No stream owner is current/);
  rig.stream.use(rig.owner);
  assert.ok((await rig.read(field)).every((v) => v === 2));
  rig.release(field);
});

test('a slice is closed as soon as its estimate reaches the target', async () => {
  const n = 128;
  const run = n * n * 8 * RATE_INITIAL;                            // the estimate of one run of a kernel that has not run
  const target = 2.4 * run;
  const rig = await createRig({ hooks: { sliceTargetMs: target } });
  await rig.compile(where, whereWide);
  const fields = Array.from({ length: 10 }, () => rig.field('field', n));
  // Encoded in one synchronous section, so no measurement changes a rate on the way.
  const slices = await slicesOf(rig, () => { for (const out of fields) rig.run(where, { out: { out } }); });
  assert.deepEqual(slices.map((s) => s.work / (n * n * 8)), [3, 3, 3, 1], 'three runs reach 2.4 runs; the last slice is closed by the wait');
  for (const slice of slices.slice(0, -1)) assert.ok(slice.estimateMs >= target && slice.estimateMs < 2 * target);

  // A run estimated above the target is cut into tiles, and its slices are still below twice the target.
  const out = rig.field('field', n);
  const tiled = await slicesOf(rig, () => { rig.run(whereWide, { out: { out }, cost: 80 }); });
  assert.equal(tiled.reduce((sum, s) => sum + s.work, 0), n * n * 80, 'the tiles cover the grid once');
  assert.ok(tiled.length >= 3, `${tiled.length} slices`);
  tiled.forEach((slice, i) => {
    assert.ok(slice.estimateMs < 2 * target && (slice.estimateMs >= target || i === tiled.length - 1), `estimate ${slice.estimateMs} for a target of ${target}`);
  });
  assert.equal(firstDifference(await rig.read(out), texels(n, n, (x, y) => x + 1000 * y)), -1);
  rig.dispose();
});

// ---- the uniform arena (runtime.md 3.2) ------------------------------------------------------------------------

test('a full arena submits the open slice; every run still has its own uniforms', async () => {
  const rig = await rigFor('one');
  const n = 4;
  // 5000 runs without params take 5000 Frame slots; the arena has 4096.
  const acc = rig.field('field', n, 0);
  const frames = await slicesOf(rig, () => { for (let i = 0; i < 5000; i++) rig.run(count, { rw: { acc } }, { iteration: i }); });
  assert.deepEqual(frames.map((s) => s.work / (n * n * 8)), [4096, 904]);
  assert.ok((await rig.read(acc)).every((v) => v === (4999 * 5000) / 2), 'the sum of the iterations, which is exact below 2^24');

  // With params a run takes two slots.
  const sum = rig.field('field', n, 0);
  let expected = 0;
  const pairs = await slicesOf(rig, () => {
    for (let i = 0; i < 3000; i++) {
      rig.run(chain, { rw: { acc: sum }, params: { mul: 1, add: i % 7 } });
      expected += i % 7;
    }
  });
  assert.deepEqual(pairs.map((s) => s.work / (n * n * 8)), [2048, 952]);
  assert.ok((await rig.read(sum)).every((v) => v === expected));
  rig.release(acc);
  rig.release(sum);
});

// ---- learned throughput (runtime.md 3.3) -----------------------------------------------------------------------

test('a kernel starts at RATE_INITIAL and its rate follows the measurements, by at most a factor of two per slice', async () => {
  const rig = await createRig({ hooks: { sliceTargetMs: 1e9 } });
  await rig.compile(where, whereWide);
  const n = 257, work = n * n * 8;
  const out = rig.field('field', n);
  const reports: SliceReport[] = [];
  for (let i = 0; i < 24; i++) {
    const [slice] = await slicesOf(rig, () => { rig.run(where, { out: { out } }); });
    reports.push(slice!);
  }
  assert.equal(reports[0]!.estimateMs, work * RATE_INITIAL);
  for (let i = 0; i + 1 < reports.length; i++) {
    const { estimateMs, measuredMs } = reports[i]!;
    const ratio = reports[i + 1]!.estimateMs / estimateMs;
    assert.ok(measuredMs >= 0 && Number.isFinite(measuredMs));
    assert.ok(ratio >= 0.5 - 1e-9 && ratio <= 2 + 1e-9, `slice ${i}: the estimate changed by ${ratio}`);
    const floor = work * RATE_INITIAL * RATE_FLOOR_FACTOR, cap = work * RATE_INITIAL * RATE_CAP_FACTOR;
    assert.ok(reports[i + 1]!.estimateMs >= floor * (1 - 1e-9) && reports[i + 1]!.estimateMs <= cap * (1 + 1e-9));
    const wanted = Math.min(Math.max(measuredMs / estimateMs, 0.5), 2);
    const next = Math.min(Math.max(estimateMs * wanted, floor), cap);
    if (wanted <= 1 || rig.gpu.caps.timestampQuery) {
      assert.ok(Math.abs(reports[i + 1]!.estimateMs - next) <= 1e-9 * next, `slice ${i}: measured ${measuredMs} for an estimate of ${estimateMs}, next estimate ${reports[i + 1]!.estimateMs}`);
    } else {
      // By wall clock a slice too close to the completion latency does not raise a rate (3.5 rule 2).
      assert.ok(ratio >= 1 - 1e-9 && reports[i + 1]!.estimateMs <= next * (1 + 1e-9));
    }
  }
  // A rate belongs to a kernel name: another kernel still starts at RATE_INITIAL.
  const [other] = await slicesOf(rig, () => { rig.run(whereWide, { out: { out } }); });
  assert.equal(other!.estimateMs, work * RATE_INITIAL);
  rig.dispose();
});

test('a kernel keeps its rate when it shares slices with a kernel the device has not measured', async () => {
  const rig = await createRig({ hooks: { sliceTargetMs: 1e9 } });
  await rig.compile(fbm, where);
  const n = 513;
  const out = rig.field('field', n), other = rig.field('field', n);
  const params = { cells: 8, octaves: 16, gain: 0.5 };
  const known = (): void => { rig.run(fbm, { out: { out }, params, cost: 128 }); };
  const rateOf = (slice: SliceReport): number => slice.estimateMs / slice.work;

  // The generator alone, in slices long enough to be measured on any device, until its estimate is the measurement.
  let alone: SliceReport[] = [];
  for (let i = 0; i < 12; i++) {
    alone = await slicesOf(rig, () => { for (let k = 0; k < 20; k++) known(); });
    assert.equal(alone.length, 1);
    if (i >= 3 && alone[0]!.resolved && alone[0]!.measuredMs > 0.6 * alone[0]!.estimateMs && alone[0]!.measuredMs < 1.6 * alone[0]!.estimateMs) break;
  }
  const settled = rateOf((await slicesOf(rig, known))[0]!);

  // One run of it beside a long run of a kernel new to the device, whose declared cost makes the slice's estimate
  // many times its duration: the slice as a whole measures far below its estimate, four times over.
  for (let i = 0; i < 4; i++) {
    const [mixed, ...rest] = await slicesOf(rig, () => {
      known();
      for (let k = 0; k < 20; k++) rig.run(where, { out: { out: other }, cost: 4000 });
    });
    assert.equal(rest.length, 0);
    assert.deepEqual(mixed!.kernels, ['ref/fbm', 'test/where']);
    assert.ok(mixed!.measuredMs < 0.5 * mixed!.estimateMs, `the mixed slice measured ${mixed!.measuredMs} ms for an estimate of ${mixed!.estimateMs} ms`);
  }

  // Under one factor for the whole slice the generator's rate would now be a sixteenth of what was measured.
  const after = rateOf((await slicesOf(rig, known))[0]!);
  assert.ok(after >= 0.45 * settled && after <= 2.2 * settled, `the rate went from ${settled} to ${after}`);
  rig.dispose();
});

test('a rate is learned per ladder level: what a small grid measures does not change the estimate of a large one', async () => {
  const rig = await createRig({ hooks: { sliceTargetMs: 1e9 } });
  await rig.compile(fbm);
  const params = { cells: 8, octaves: 16, gain: 0.5 };
  const large = rig.field('field', 513), small = rig.field('field', 33);
  const rateOf = (slice: SliceReport): number => slice.estimateMs / slice.work;
  const at = (out: typeof large, runs: number) => (): void => { for (let k = 0; k < runs; k++) rig.run(fbm, { out: { out }, params, cost: 128 }); };

  // The first run at a level starts at RATE_INITIAL.
  const same = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * b;
  const first = (await slicesOf(rig, at(large, 20)))[0]!;
  assert.ok(same(rateOf(first), RATE_INITIAL));
  for (let i = 0; i < 12; i++) {
    const [slice] = await slicesOf(rig, at(large, 20));
    if (i >= 3 && slice!.resolved && slice!.measuredMs > 0.6 * slice!.estimateMs && slice!.measuredMs < 1.6 * slice!.estimateMs) break;
  }
  const learned = rateOf((await slicesOf(rig, at(large, 1)))[0]!);

  // A level it has not run at takes the rate of the nearest level where that is above RATE_INITIAL, and RATE_INITIAL otherwise.
  const smallFirst = (await slicesOf(rig, at(small, 1)))[0]!;
  // (The slice that showed `learned` may have moved the rate once more, by at most a factor of two.)
  const inherited = rateOf(smallFirst);
  assert.ok(
    inherited >= Math.max(0.5 * learned, RATE_INITIAL) * (1 - 1e-9) && inherited <= Math.max(2 * learned, RATE_INITIAL) * (1 + 1e-9),
    `${inherited} at 33 after ${learned} at 513`,
  );
  // Slices far too short to be measured: each halves the rate of the small level, down to the floor (3.3 rule 7).
  for (let i = 0; i < 12; i++) await slicesOf(rig, at(small, 1));
  const smallRate = rateOf((await slicesOf(rig, at(small, 1)))[0]!);

  const after = rateOf((await slicesOf(rig, at(large, 1)))[0]!);
  // The single run in between may move the large level by its own factor of at most two; twelve halvings would not.
  assert.ok(after >= 0.45 * learned && after <= 2.2 * learned, `the rate at 513 went from ${learned} to ${after} while the rate at 33 went to ${smallRate}`);
  rig.dispose();
});

test('a kernel the device has not measured fills a slice by texels, whatever its estimate; a measured one by its estimate', async () => {
  const rig = await createRig();
  await rig.compile(where, fbm);
  const n = 513;                                                   // 263 169 texels: four runs pass 2^20
  const out = rig.field('field', n);
  const runsPerSlice = (slices: readonly SliceReport[]): number[] => slices.map((s) => Math.round(s.work / (n * n * 8)));

  // Estimated at RATE_INITIAL the five runs are 1 ms, far below the slice target of 8 ms.
  const cold = await slicesOf(rig, () => { for (let i = 0; i < 5; i++) rig.run(where, { out: { out } }); });
  assert.deepEqual(runsPerSlice(cold), [4, 1]);

  // Once a slice has measured at most twice its estimate, the estimate alone decides. A software adapter needs
  // some slices to get there: each raises the rate by at most a factor of two.
  let warm: number[] = [];
  for (let i = 0; i < 16 && warm.length !== 1; i++) warm = runsPerSlice(await slicesOf(rig, () => { for (let k = 0; k < 5; k++) rig.run(where, { out: { out } }); }));
  assert.deepEqual(warm, [5]);

  // A kernel that declares an eighth of a load where it performs 128 stays bound: every slice measures far above its estimate.
  const params = { cells: 8, octaves: 16, gain: 0.5 };
  for (let i = 0; i < 3; i++) {
    const heavy = await slicesOf(rig, () => { for (let k = 0; k < 5; k++) rig.run(fbm, { out: { out }, params, cost: 0.125 }); });
    assert.deepEqual(heavy.map((s) => Math.round(s.work / (n * n * 0.125))), [4, 1], `round ${i}`);
  }
  rig.dispose();
});

test('a slice is closed when it holds 256 runs, however small its estimate', async () => {
  const rig = await createRig();
  await rig.compile(count);
  const n = 4;
  const acc = rig.field('field', n, 0);
  const slices = await slicesOf(rig, () => { for (let i = 0; i < 600; i++) rig.run(count, { rw: { acc } }, { iteration: 1 }); });
  assert.deepEqual(slices.map((s) => s.work / (n * n * 8)), [256, 256, 88]);
  assert.ok((await rig.read(acc)).every((v) => v === 600));
  rig.dispose();
});

// ---- the hard ceiling (runtime.md 3.4 rule 3, 3.5) -------------------------------------------------------------

test('a kernel declared tiled: false is one dispatch, and is refused when one dispatch is estimated above the ceiling', async () => {
  const small = await rigFor('small');
  const n = 129;
  const field = small.field('field', n);
  const slices = await slicesOf(small, () => { small.run(untiled, { out: { out: field } }); });
  assert.deepEqual(slices.map((s) => s.work), [n * n * 8], 'never tiled, whatever the target');
  assert.equal(firstDifference(await small.read(field), texels(n, n, (x, y) => x + 1000 * y)), -1);
  small.release(field);

  const rig = await createRig();
  await rig.compile(untiled);
  const big = rig.field('field', 513, 4);
  await rig.stream.flush();
  const submitted = rig.stream.submitted, reported = rig.slices.length;
  // 513 x 513 texels x 1e6 loads x 1e-7 ms = 26 317 ms.
  assert.throws(() => rig.run(untiled, { out: { out: big }, cost: 1e6 }), (thrown: unknown) => {
    assert.ok(thrown instanceof WatchdogError);
    assert.equal(thrown.message, 'kernel "test/untiled" cannot be tiled and one dispatch is estimated at 26317 ms; the limit is 500 ms');
    return true;
  });
  await rig.stream.flush();
  assert.deepEqual([rig.stream.submitted, rig.slices.length], [submitted, reported], 'nothing was encoded');
  assert.ok((await rig.read(big)).every((v) => v === 4));

  // After a device loss the node's ceiling is halved (5.9 rule 6): 513 x 513 x 15000 x 1e-7 = 395 ms.
  rig.run(untiled, { out: { out: big }, cost: 15000 });
  rig.use({ nodeId: 'retried', limitScale: 0.5 });
  assert.throws(() => rig.run(untiled, { out: { out: big }, cost: 15000 }), /estimated at 395 ms; the limit is 250 ms$/);
  rig.dispose();
});

test('a slice measured above the ceiling is reported and corrects its rates at once', async () => {
  const overruns: SliceReport[] = [];
  const ceilings: number[] = [];
  const rig = await createRig({ hooks: { sliceTargetMs: 1e9 }, onOverrun: (slice, ceilingMs) => { overruns.push(slice); ceilings.push(ceilingMs); } });
  await rig.compile(fbm);
  const n = 513;
  const out = rig.field('field', n);
  const params = { cells: 8, octaves: 16, gain: 0.5 };
  // The first use of the pipeline, and a completion latency measured on an idle queue.
  rig.run(fbm, { out: { out }, params });
  await rig.stream.flush();
  await rig.stream.barrier();
  assert.equal(overruns.length, 0);

  // An owner whose ceiling is half a microsecond: whatever its slice takes is above it. The run declares one
  // load per texel where it performs 128, so the slice is estimated far too short.
  const owner = rig.use({ nodeId: 'slow', limitScale: 1e-6 });
  const before = rig.slices.length;
  for (let i = 0; i < 40; i++) rig.run(fbm, { out: { out }, params, cost: 1 });
  await owner.settle();
  owner.close();
  const [slice, ...others] = rig.slices.slice(before);
  assert.equal(others.length, 0);
  assert.deepEqual(overruns, [slice]);
  assert.deepEqual(ceilings, [500e-6], 'with the ceiling of the owner it was held against');
  assert.equal(slice!.resolved, true, 'only a measured duration is held against the ceiling');
  assert.ok(slice!.measuredMs > 2 * slice!.estimateMs, `measured ${slice!.measuredMs} ms for an estimate of ${slice!.estimateMs} ms`);

  // 3.3 rule 3: the factor is not held at two. The kernel's rate is now what was measured.
  rig.stream.use(rig.owner);
  rig.run(fbm, { out: { out }, params, cost: 1 });
  await rig.stream.flush();
  const next = rig.slices[rig.slices.length - 1]!;
  const learned = next.estimateMs / next.work, measured = slice!.measuredMs / slice!.work;
  assert.ok(Math.abs(learned - measured) <= 1e-9 * measured, `rate ${learned} against a measured ${measured}`);
  assert.equal(overruns.length, 1, 'under the usual ceiling of 500 ms nothing more is reported');
  rig.dispose();
});

test('a completion nobody waited for is not a measured duration, and is not held against the ceiling', async () => {
  const overruns: SliceReport[] = [];
  const rig = await createRig({ hooks: { sliceTargetMs: 1e9 }, onOverrun: (slice) => overruns.push(slice) });
  await rig.compile(where);
  const out = rig.field('field', 257);
  rig.run(where, { out: { out } });
  await rig.stream.flush();
  await rig.stream.barrier();

  // A ceiling of half a microsecond: whatever is measured is above it.
  const owner = rig.use({ nodeId: 'unwatched', limitScale: 1e-6 });
  const before = rig.slices.length;
  rig.run(where, { out: { out } });
  rig.stream.submit();
  // The thread does something else for 30 ms and only then looks: the slice completed long before.
  const until = performance.now() + 30;
  while (performance.now() < until);
  await rig.gpu.device.queue.onSubmittedWorkDone();
  for (let i = 0; i < 50 && rig.slices.length === before; i++) await new Promise<void>((done) => { setTimeout(done, 1); });
  const [slice] = rig.slices.slice(before);
  assert.ok(slice, 'the slice was reported');
  if (rig.gpu.caps.timestampQuery) {
    assert.ok(slice.resolved && slice.measuredMs < 20, `timestamps are the GPU's own: ${slice.measuredMs} ms`);
  } else {
    assert.equal(slice.resolved, false);
    assert.ok(slice.measuredMs >= 25, `what is known is an upper bound: ${slice.measuredMs} ms`);
    assert.deepEqual(overruns, []);
    // And no rate was raised by it.
    rig.stream.use(rig.owner);
    const [next] = await slicesOf(rig, () => { rig.run(where, { out: { out } }); });
    assert.ok(next!.estimateMs <= slice.estimateMs, `the estimate went from ${slice.estimateMs} to ${next!.estimateMs}`);
  }
  owner.close();
  rig.dispose();
});

// ---- waiting (runtime.md 3.6) ----------------------------------------------------------------------------------

test('flush and the last batch boundary resolve when every slice has completed', async () => {
  for (const slicing of ['small', 'auto'] as const) {
    const rig = await rigFor(slicing);
    assert.equal(rig.stream.inFlightLimit, rig.gpu.caps.timestampQuery ? 2 : 1);
    const n = 33;
    const acc = rig.field('field', n, 0);
    await rig.stream.flush();
    // A loop as ctx.loop runs it: a boundary whenever a slice was submitted, and after the last iteration.
    const iterations = 30;
    let boundaries = 0;
    for (let i = 0; i < iterations; i++) {
      const before = rig.stream.submitted;
      rig.run(count, { rw: { acc } }, { iteration: i });
      const last = i === iterations - 1;
      if (rig.stream.submitted !== before || last) {
        await rig.stream.boundary(last);
        boundaries++;
      }
    }
    assert.equal(rig.slices.length, rig.stream.submitted, 'every submitted slice has completed and was reported');
    assert.ok(slicing === 'small' ? boundaries === iterations : boundaries >= 1, `${boundaries} boundaries`);
    assert.ok((await rig.read(acc)).every((v) => v === (iterations * (iterations - 1)) / 2));
    rig.release(acc);
  }
});

test('settle resolves with the owner\'s slices, and with its GPU time when the device measures it', async () => {
  const rig = await rigFor('small');
  const owner = rig.use({ nodeId: 'settled' });
  const field = rig.field('field', 65);
  rig.run(where, { out: { out: field } });
  const result = await owner.settle();
  assert.equal(result.slices, 9, 'nine tiles of eight rows, each its own slice');
  if (rig.gpu.caps.timestampQuery) assert.ok(typeof result.gpuMs === 'number' && result.gpuMs >= 0 && Number.isFinite(result.gpuMs));
  else assert.equal(result.gpuMs, null);
  owner.close();
  rig.stream.use(rig.owner);
  rig.release(field);
});

test('a node that submits hundreds of slices without waiting settles, with bounded timing resources', async () => {
  const rig = await createRig({ hooks: { sliceTargetMs: 1e-6 } });
  await rig.compile(where);
  const n = 257, runs = 6;
  const fields = Array.from({ length: runs }, () => rig.field('field', n));
  await rig.stream.flush();
  const owner = rig.use({ nodeId: 'eager' });
  const started = performance.now();
  for (const out of fields) rig.run(where, { out: { out } });
  assert.equal(rig.stream.submitted >= runs * 33, true, 'every tile was submitted as it was encoded');
  const before = rig.slices.length;
  const result = await owner.settle();
  assert.equal(result.slices, runs * 33);
  const mine = rig.slices.slice(before);
  assert.equal(mine.length, runs * 33);
  if (rig.gpu.caps.timestampQuery) {
    // Every slice is timed, however many are in flight: the node's GPU time is the sum over all of them.
    assert.ok(mine.every((slice) => slice.resolved), `${mine.filter((slice) => !slice.resolved).length} slices were not timed`);
    const sum = mine.reduce((total, slice) => total + slice.measuredMs, 0);
    assert.ok(result.gpuMs !== null && Math.abs(result.gpuMs - sum) <= 1e-6 * Math.max(sum, 1), `gpuMs ${result.gpuMs} against a sum of ${sum}`);
  } else {
    // By wall clock every tile here is over long before anybody looks: what is reported is an upper bound, never a duration.
    assert.equal(result.gpuMs, null);
    const total = mine.filter((slice) => slice.resolved).reduce((sum, slice) => sum + slice.measuredMs, 0);
    assert.ok(mine.every((slice) => slice.measuredMs >= 0) && total <= performance.now() - started, `resolved slices add up to ${total} ms`);
  }
  // The arena of 1 MiB, one query set with its buffer of 32 KiB each, and a buffer of 256 bytes per slice in flight.
  assert.ok(rig.pool.report().reservedBytes <= 1_048_576 + 2 * 32_768 + runs * 33 * 256 + 65_536, `${rig.pool.report().reservedBytes} bytes reserved`);
  for (const out of fields) assert.equal(firstDifference(await rig.read(out), texels(n, n, (x, y) => x + 1000 * y)), -1);
  owner.close();
  rig.dispose();
});

test('two slices in flight need timestamp-query', async (t) => {
  const { gpu } = await rigFor('auto');
  if (gpu.caps.timestampQuery) {
    const rig = await createRig({ hooks: { inFlightLimit: 1 } });
    assert.equal(rig.stream.inFlightLimit, 1, 'the hook lowers the limit');
    rig.dispose();
    t.diagnostic('the device has timestamp-query: the refusal of inFlightLimit 2 is checked under profile "core"');
    return;
  }
  await assert.rejects(createRig({ hooks: { inFlightLimit: 2 } }), RangeError);
});

test('what an onSlice hook throws fails the next wait', async () => {
  const failure = new Error('asserted inside onSlice');
  let armed = true;
  const rig = await createRig({ hooks: { onSlice: () => { if (armed) { armed = false; throw failure; } } } });
  await rig.compile(where);
  const field = rig.field('field', 8);
  rig.run(where, { out: { out: field } });
  await assert.rejects(rig.stream.flush(), (thrown: unknown) => thrown === failure);
  rig.run(where, { out: { out: field } });
  await rig.stream.flush();
  rig.dispose();
});

// ---- cancellation (runtime.md 3.7) -----------------------------------------------------------------------------

test('an aborted owner\'s open slice is discarded; its waits reject with the reason', async () => {
  const rig = await rigFor('one');
  const n = 16;
  const field = rig.field('field', n, 3);
  await rig.stream.flush();

  const controller = new AbortController();
  const owner = rig.use({ nodeId: 'cancelled', signal: controller.signal });
  rig.run(chain, { rw: { acc: field }, params: { mul: 1, add: 1 } });
  const submitted = rig.stream.submitted;
  const reason = new DOMException('The evaluation was cancelled', 'AbortError');
  controller.abort(reason);
  await assert.rejects(rig.stream.flush(), (thrown: unknown) => thrown === reason);
  assert.equal(rig.stream.submitted, submitted, 'nothing was submitted after the abort');
  rig.run(chain, { rw: { acc: field }, params: { mul: 1, add: 1 } });
  await assert.rejects(rig.stream.boundary(false), (thrown: unknown) => thrown === reason);
  await assert.rejects(rig.stream.boundary(true), (thrown: unknown) => thrown === reason);
  await assert.rejects(owner.settle(), (thrown: unknown) => thrown === reason);
  assert.equal(rig.stream.submitted, submitted);
  owner.close();

  rig.stream.use(rig.owner);
  assert.ok((await rig.read(field)).every((v) => v === 3), 'the cancelled runs never reached the GPU');
  rig.release(field);
});

test('a submitted slice cannot be recalled', async () => {
  const rig = await rigFor('one');
  const field = rig.field('field', 16, 3);
  await rig.stream.flush();
  const controller = new AbortController();
  const owner = rig.use({ nodeId: 'late', signal: controller.signal });
  rig.run(chain, { rw: { acc: field }, params: { mul: 1, add: 1 } });
  rig.stream.submit();
  controller.abort(new DOMException('cancelled', 'AbortError'));
  await assert.rejects(rig.stream.flush(), { name: 'AbortError' });
  owner.close();
  rig.stream.use(rig.owner);
  assert.ok((await rig.read(field)).every((v) => v === 4));
  rig.release(field);
});

// ---- error scopes (runtime.md 3.1, 5.8) ------------------------------------------------------------------------

test('a validation error of a slice belongs to its owner and fails its settle', async () => {
  const rig = await createRig();
  await rig.compile(where);
  const field = rig.field('field', 16);
  await rig.owner.settle();

  const owner = rig.use({ nodeId: 'invalid' });
  const scratch = rig.gpu.device.createBuffer({ size: 4096, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  // bytesPerRow must be a multiple of 256: the encoder is invalid and the submission fails inside its scopes.
  rig.stream.encode((encoder) => encoder.copyTextureToBuffer({ texture: rig.texture(field).texture }, { buffer: scratch, bytesPerRow: 100 }, [16, 16, 1]));
  await assert.rejects(rig.stream.boundary(true), GpuValidationError);
  await assert.rejects(owner.settle(), (thrown: unknown) => {
    assert.ok(thrown instanceof GpuValidationError);
    assert.ok(thrown.message.length > 0 && !thrown.message.includes('\n'), 'the first line of the GPU message');
    assert.ok(thrown.detail.startsWith(thrown.message) && /bytesPerRow/i.test(thrown.detail), thrown.detail);
    return true;
  });
  owner.close();

  // The next owner is not touched by it.
  const next = rig.use({ nodeId: 'valid' });
  rig.run(where, { out: { out: field } });
  assert.equal((await next.settle()).slices, 1);
  assert.equal(firstDifference(await rig.read(field), texels(16, 16, (x, y) => x + 1000 * y)), -1);
  scratch.destroy();
  rig.dispose();
});

// ---- write, copy, encode ---------------------------------------------------------------------------------------

test('write replaces whole rows and checks its data', async () => {
  const rig = await rigFor('auto');
  const w = 5, h = 4;
  const field = rig.field('vec2', [w, h], 1);
  rig.write(field, texels(w, 2, (x, y) => [x, 10 * y + 0.5]), [1, 3]);
  const got = await rig.read(field);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) assert.deepEqual(texel(got, w, x, y, 2), y === 1 || y === 2 ? [x, 10 * (y - 1) + 0.5] : [1, 1]);
  }
  assert.throws(() => rig.write(field, new Float32Array(w * h * 2 - 1)), RangeError, 'width x rows x channels floats');
  assert.throws(() => rig.write(field, new Float32Array(w * 2), [3, 5]), RangeError);
  assert.throws(() => rig.write(field, new Float32Array(0), [2, 2]), RangeError);
  assert.throws(() => rig.write(field, new Float32Array(w * 2), [-1, 0]), RangeError);
  assert.throws(() => rig.write(field, new Float32Array(w * 2), [0.5, 1.5]), RangeError);
  rig.release(field);
});

test('copy needs two textures of one shape; encode adds its estimate to the slice', async () => {
  const rig = await rigFor('one');
  const a = rig.field('field', 8, 1), b = rig.field('field', 16), c = rig.field('vec2', 8);
  assert.throws(() => rig.stream.copy(rig.texture(a), rig.texture(b)), /one shape/);
  assert.throws(() => rig.stream.copy(rig.texture(a), rig.texture(c)), /one shape/);
  const [slice] = await slicesOf(rig, () => {
    rig.stream.encode(() => undefined, 2.5);
    rig.stream.encode(() => undefined);
  });
  assert.deepEqual([slice!.estimateMs, slice!.work, slice!.kernels], [2.5, 0, []]);
  for (const field of [a, b, c]) rig.release(field);
});

// ---- device loss (runtime.md 3.7, 5.9): last, because the device does not come back ----------------------------

test('on a lost device the open slice is discarded and every wait rejects with DeviceLostError', async () => {
  const rig = await rigFor('one');
  const field = rig.field('field', 16, 1);
  await rig.stream.flush();
  const lost = new Promise<void>((resolve) => { rig.gpu.onLost(() => resolve()); });
  rig.gpu.device.destroy();
  await lost;
  assert.equal(rig.gpu.lost, true);
  const submitted = rig.stream.submitted;
  rig.run(chain, { rw: { acc: field }, params: { mul: 1, add: 1 } });
  await assert.rejects(rig.stream.flush(), DeviceLostError);
  await assert.rejects(rig.stream.boundary(false), DeviceLostError);
  await assert.rejects(rig.owner.settle(), DeviceLostError);
  await assert.rejects(rig.read(field), DeviceLostError);
  assert.equal(rig.stream.submitted, submitted);
  await rig.stream.barrier();
});
