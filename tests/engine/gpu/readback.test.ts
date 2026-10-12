// Readback on the device (runtime.md 5.7, engine.md 4.7 "Data"): padded rows, strips, row ranges, conversion to
// float32 from every format, serialised reads, cancellation, and the staging buffer in the ledger.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FieldKind } from '../../../src/core/gpu/field.ts';
import { defineKernel } from '../../../src/core/gpu/kernel.ts';
import { BYTES_PER_TEXEL } from '../../../src/core/gpu/pool.ts';
import { createReadback } from '../../../src/core/gpu/readback.ts';
import { floatToHalf, halfToFloat } from '../../../src/core/gpu/texels.ts';
import { channels, createRig, firstDifference, texels } from './rig.ts';

const add = defineKernel({
  name: 'test/add',
  inPlace: { acc: 'field' },
  params: { value: 'f32' },
  code: 'fn compute(px: vec2i, uv: vec2f, cur: Cur) -> Out { return Out(cur.acc + P.value); }',
});

const rig = await createRig();
await rig.compile(add);

/** Values that tell every texel and channel apart and that float32 holds exactly. */
const pattern = (count: number) => (x: number, y: number): number[] => Array.from({ length: count }, (_, k) => x + 64 * y + 0.25 * k - 100);

test('rows are read tightly packed whatever padding the copy needs', async () => {
  // Row sizes that are not multiples of 256 bytes, and one that is.
  const cases: [FieldKind, number, number][] = [['field', 13, 7], ['field', 64, 3], ['vec2', 50, 5], ['aux', 100, 9], ['aux', 1, 1], ['color', 33, 4], ['field', 257, 2]];
  for (const [kind, w, h] of cases) {
    const count = kind === 'field' ? 1 : kind === 'vec2' ? 2 : 4;
    const data = texels(w, h, pattern(count));
    const field = rig.field(kind, [w, h], data);
    const got = await rig.read(field);
    assert.equal(got.length, w * h * count, `${kind} ${w} x ${h}: width x height x channels floats`);
    assert.equal(firstDifference(got, data), -1, `${kind} ${w} x ${h}`);
    rig.release(field);
  }
});

test('rows = [y0, y1) reads those rows only', async () => {
  const w = 21, h = 10;
  const data = texels(w, h, pattern(2));
  const field = rig.field('vec2', [w, h], data);
  for (const [y0, y1] of [[0, 1], [3, 7], [9, 10], [0, 10]] as const) {
    const got = await rig.read(field, [y0, y1]);
    assert.equal(firstDifference(got, data.subarray(y0 * w * 2, y1 * w * 2)), -1, `rows ${y0} to ${y1}`);
  }
  for (const rows of [[-1, 2], [0, 11], [4, 4], [5, 3], [0.5, 2], [0, NaN]] as const) {
    await assert.rejects(rig.read(field, rows), RangeError, `rows ${rows}`);
  }
  rig.release(field);
});

test('a read wider than one strip is copied strip by strip', async () => {
  // Strips of at most 1024 bytes: a field 40 wide has rows of 160 bytes, padded to 256, so four rows a strip.
  const small = await createRig({ stripBytes: 1024 });
  const w = 40, h = 18;
  const data = texels(w, h, pattern(1));
  const field = small.field('field', [w, h], data);
  await small.stream.flush();
  const before = small.stream.submitted;
  assert.equal(firstDifference(await small.read(field), data), -1);
  assert.equal(small.stream.submitted - before, 5, 'five strips: four of four rows and one of two');
  assert.equal(firstDifference(await small.read(field, [3, 13]), data.subarray(3 * w, 13 * w)), -1, 'strips of a row range');
  // A strip is never less than one row: 100 texels of 16 bytes are 1600 bytes a row, above the strip size.
  const wide = small.field('aux', [100, 3], texels(100, 3, pattern(4)));
  assert.equal(firstDifference(await small.read(wide), texels(100, 3, pattern(4))), -1);
  small.dispose();
});

test('a strip is converted in pieces, with a completed submission between two of them: the thread is not held for a whole strip', async () => {
  // Pieces of at most 600 bytes: rows of a color 20 wide are 160 bytes, padded to 256, so two rows a piece.
  let barriers = 0;
  const pieces = createReadback({
    gpu: rig.gpu, reserve: (bytes, label) => rig.pool.reserve(bytes, label), pieceBytes: 600,
    stream: {
      encode: (work, estimate) => rig.stream.encode(work, estimate),
      flush: () => rig.stream.flush(),
      track: (scopes) => rig.stream.track(scopes),
      use: (owner) => rig.stream.use(owner),
      get current() { return rig.stream.current; },
      barrier: () => { barriers++; return rig.stream.barrier(); },
    },
  });
  try {
    const w = 20, h = 9;
    // Multiples of 1/256: a 16-bit float holds them exactly.
    const data = texels(w, h, (x, y) => [x / 256, y / 256, (x + y) / 256, 1]);
    const field = rig.field('color', [w, h], data);
    const whole = await rig.read(field);
    const got = await pieces.read(rig.texture(field));
    assert.equal(firstDifference(got, whole), -1, 'the pieces are the strip');
    assert.equal(firstDifference(got, data), -1);
    assert.equal(barriers, 4, 'nine rows in five pieces: four waits');
    barriers = 0;
    assert.equal(firstDifference(await pieces.read(rig.texture(field), [3, 5]), data.subarray(3 * w * 4, 5 * w * 4)), -1);
    assert.equal(barriers, 0, 'one piece needs no wait');
    rig.release(field);
  } finally {
    pieces.dispose();
  }
});

test('every kind is returned as float32, converted from the format the device gave it', async () => {
  const n = 9;
  const values = texels(n, n, (x, y) => (x + n * y) / (n * n - 1));          // 0 .. 1, mostly not exact in 8 or 16 bits
  for (const kind of ['field', 'vec2', 'color', 'aux', 'half', 'half2', 'mask8'] as const) {
    const count = channels({ kind, width: n, height: n, readOnly: false, id: 0 });
    const data = texels(n, n, (x, y) => Array.from({ length: count }, (_, k) => values[y * n + x]! * (k % 2 === 0 ? 1 : 0.5)));
    const field = rig.field(kind, n, data);
    const got = await rig.read(field);
    const format = rig.gpu.caps.formats[kind];
    assert.ok(got instanceof Float32Array && got.length === n * n * count, kind);
    const stored = (v: number): number =>
      (BYTES_PER_TEXEL[format as keyof typeof BYTES_PER_TEXEL] / count === 4 ? v
        : format === 'r8unorm' ? Math.fround(Math.round(v * 255) / 255)
        : halfToFloat(floatToHalf(v)));
    assert.equal(firstDifference(got, data.map(stored)), -1, `${kind} as ${format}`);
    rig.release(field);
  }
});

test('a read waits for all earlier work; pending reads are served one after another', async () => {
  const n = 32;
  const a = rig.field('field', n, 0), b = rig.field('field', n, 0), c = rig.field('field', n, 0);
  for (let i = 0; i < 10; i++) rig.run(add, { rw: { acc: a }, params: { value: 1 } });
  // No read is in progress: the copy is encoded now, so work encoded after the call is not in the result.
  const first = rig.read(a);
  rig.run(add, { rw: { acc: a }, params: { value: 1000 } });
  for (let i = 0; i < 5; i++) rig.run(add, { rw: { acc: b }, params: { value: 100 } });
  const second = rig.read(b, [0, 1]);
  rig.run(add, { rw: { acc: c }, params: { value: -3 } });
  const third = rig.read(c);
  // Three reads are pending at once on the one staging buffer.
  assert.ok((await third).every((v) => v === -3));
  assert.ok((await first).every((v) => v === 10));
  assert.ok((await second).every((v) => v === 500) && (await second).length === n);
  assert.ok((await rig.read(a)).every((v) => v === 1010));
  for (const field of [a, b, c]) rig.release(field);
});

test('an aborted read rejects with the reason', async () => {
  const field = rig.field('field', 16, 2);
  const reason = new DOMException('cancelled', 'AbortError');
  const aborted = AbortSignal.abort(reason);
  await assert.rejects(rig.readback.read(rig.texture(field), undefined, aborted), (thrown: unknown) => thrown === reason);
  const controller = new AbortController();
  const pending = rig.readback.read(rig.texture(field), undefined, controller.signal);
  controller.abort(reason);
  await assert.rejects(pending, (thrown: unknown) => thrown === reason);
  // The staging buffer is free again.
  assert.ok((await rig.read(field)).every((v) => v === 2));
  rig.release(field);
});

test('a read needs a current owner', async () => {
  const idle = await createRig();
  const field = idle.field('field', 4, 1);
  await idle.stream.flush();
  idle.owner.close();
  await assert.rejects(idle.readback.read(idle.texture(field)), /No stream owner is current/);
  idle.dispose();
});

test('the staging buffer is registered with the ledger and grows only when a read needs more', async () => {
  const fresh = await createRig();
  const reserved = (): number => fresh.pool.report().reservedBytes;
  const small = fresh.field('field', 16, 1), large = fresh.field('aux', 256, 1);
  await fresh.stream.flush();
  const before = reserved();

  await fresh.read(small);
  const afterSmall = reserved() - before;
  assert.ok(afterSmall >= 16 * 256 && afterSmall % 65536 === 0, `${afterSmall} bytes for a read of 16 padded rows`);
  await fresh.read(small);
  assert.equal(reserved() - before, afterSmall, 'the buffer is kept between reads');

  await fresh.read(large);                                          // 256 rows of 4096 bytes: 1 MiB
  const afterLarge = reserved() - before;
  assert.ok(afterLarge >= 256 * 4096 && afterLarge <= 67_108_864, `${afterLarge} bytes`);
  assert.ok(afterLarge > afterSmall, 'one buffer: the small one was replaced, not kept beside it');
  await fresh.read(small);
  assert.equal(reserved() - before, afterLarge);

  fresh.readback.dispose();
  assert.equal(reserved(), before, 'dispose returns the bytes');
  fresh.dispose();
});
