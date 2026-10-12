// The texture pool on the device (runtime.md section 2): states and references, reuse by exact shape, the
// ledger, the budget with reclaim and eviction, deferred destruction, trim, and the test hooks of 5.14.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FieldKind } from '../../../src/core/gpu/field.ts';
import { defineKernel } from '../../../src/core/gpu/kernel.ts';
import { BudgetExceededError, BYTES_PER_TEXEL, type ManagedPool, type MemoryReport, type PoolCacheHooks, type PoolTexture } from '../../../src/core/gpu/pool.ts';
import { GpuOutOfMemoryError } from '../../../src/core/gpu/stream.ts';
import { createRig, type Rig } from './rig.ts';

const fill = defineKernel({
  name: 'test/fill',
  outputs: { out: 'field' },
  params: { value: 'f32' },
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return P.value + f32(px.x); }',
});

const KB = 1024;
const FIELD_256 = 256 * 256 * 4;                                   // 256 KiB
const FIELD_128 = 128 * 128 * 4;                                   // 64 KiB

/** A result cache as the pool sees one: entries in eviction order, each holding one reference per texture. */
function fakeCache() {
  const entries: PoolTexture[][] = [];
  const references = new Map<PoolTexture, number>();
  const state: { pool: ManagedPool | null; evictions: number } = { pool: null, evictions: 0 };
  const hooks: PoolCacheHooks = {
    evictOne() {
      const entry = entries.shift();
      if (!entry) return false;
      state.evictions++;
      for (const texture of entry) {
        references.set(texture, references.get(texture)! - 1);
        state.pool!.drop(texture);
      }
      return true;
    },
    cacheReferences: (texture) => references.get(texture) ?? 0,
  };
  return {
    hooks,
    state,
    /** An entry takes over the reference each texture was published with. */
    store(...textures: PoolTexture[]): void {
      for (const texture of textures) references.set(texture, (references.get(texture) ?? 0) + 1);
      entries.push(textures);
    },
  };
}

async function poolRig(opts: { hooks?: { failAllocAfter?: number; poisonRecycled?: boolean }; budgetKiB?: number } = {}): Promise<Rig & { cache: ReturnType<typeof fakeCache> }> {
  const cache = fakeCache();
  const rig = await createRig({ cache: cache.hooks, hooks: opts.hooks, budgetBytes: (opts.budgetKiB ?? 1024 * 1024) * KB });
  cache.state.pool = rig.pool;
  return Object.assign(rig, { cache });
}

const committed = (r: MemoryReport): number => r.workingBytes + r.cacheBytes + r.pinnedBytes + r.freeBytes + r.reservedBytes;
const ledger = (r: MemoryReport): number[] => [r.workingBytes, r.cacheBytes, r.pinnedBytes, r.freeBytes, r.drainingBytes];

// ---- states (2.1, 2.3) -----------------------------------------------------------------------------------------

test('acquire gives a WORKING texture of the kind\'s format with the usage of every field', async () => {
  const rig = await poolRig();
  const { pool, gpu } = rig;
  const t = pool.acquire('color', 48, 32);
  assert.deepEqual([t.kind, t.format, t.width, t.height, t.bytes], ['color', gpu.caps.formats.color, 48, 32, 48 * 32 * 8]);
  assert.deepEqual([t.texture.width, t.texture.height, t.texture.format, t.texture.dimension, t.texture.mipLevelCount, t.texture.sampleCount], [48, 32, gpu.caps.formats.color, '2d', 1, 1]);
  assert.equal(
    t.texture.usage,
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  );
  assert.ok(t.view);
  assert.deepEqual(ledger(pool.report()), [t.bytes, 0, 0, 0, 0]);
  rig.dispose();
});

test('WORKING, PUBLISHED and FREE: every transition, and the bytes that move with it', async () => {
  const rig = await poolRig();
  const { pool, cache } = rig;
  const t = pool.acquire('field', 256, 256);
  assert.deepEqual(ledger(pool.report()), [FIELD_256, 0, 0, 0, 0], 'WORKING');

  pool.publish(t);
  assert.deepEqual(ledger(pool.report()), [0, 0, FIELD_256, 0, 0], 'PUBLISHED with the caller\'s reference: pinned');
  cache.store(t);
  assert.deepEqual(ledger(pool.report()), [0, FIELD_256, 0, 0, 0], 'the reference is a cache entry\'s: evictable');
  pool.retain(t);
  assert.deepEqual(ledger(pool.report()), [0, 0, FIELD_256, 0, 0], 'a second holder pins it; the bytes are counted once');
  pool.retain(t);
  pool.drop(t);
  pool.drop(t);
  assert.deepEqual(ledger(pool.report()), [0, FIELD_256, 0, 0, 0]);
  assert.equal(cache.hooks.evictOne(), true);
  assert.deepEqual(ledger(pool.report()), [0, 0, 0, FIELD_256, 0], 'the last reference dropped: FREE');

  const again = pool.acquire('field', 256, 256);
  assert.equal(again.texture, t.texture, 'FREE to WORKING: the same texture');
  assert.notEqual(again, t, 'under a new tenancy');
  pool.release(again);
  assert.deepEqual(ledger(pool.report()), [0, 0, 0, FIELD_256, 0], 'WORKING to FREE');
  rig.dispose();
});

test('a call in the wrong state throws', async () => {
  const rig = await poolRig();
  const { pool } = rig;
  const working = pool.acquire('field', 16, 16);
  assert.throws(() => pool.retain(working), /WORKING, not PUBLISHED/);
  assert.throws(() => pool.drop(working), /WORKING, not PUBLISHED/);
  pool.publish(working);
  assert.throws(() => pool.publish(working), /PUBLISHED, not WORKING/);
  assert.throws(() => pool.release(working), /PUBLISHED, not WORKING/);
  pool.drop(working);
  for (const call of [() => pool.drop(working), () => pool.retain(working), () => pool.release(working), () => pool.publish(working)]) {
    assert.throws(call, /not held/, 'a texture that reached FREE is no longer the caller\'s');
  }
  const released = pool.acquire('field', 16, 16);
  pool.release(released);
  assert.throws(() => pool.release(released), /not held/);
  assert.throws(() => pool.release({ ...released }), /not held/, 'a copy of a pool texture is not one');
  assert.deepEqual(ledger(pool.report()), [0, 0, 0, 16 * 16 * 4, 0], 'nothing moved');
  rig.dispose();
});

test('a side outside 1..8192 is a RangeError before anything else happens', async () => {
  const rig = await poolRig({ budgetKiB: 0 });
  const before = rig.pool.report();
  for (const [w, h] of [[0, 16], [16, 0], [8193, 16], [16, 8193], [-1, 16], [1.5, 16], [16, NaN], [Infinity, 16]] as const) {
    assert.throws(() => rig.pool.acquire('field', w, h), RangeError, `${w} x ${h}`);
  }
  assert.equal(rig.cache.state.evictions, 0);
  assert.deepEqual(rig.pool.report(), before);
  // The budget is what refuses a legal size.
  assert.throws(() => rig.pool.acquire('field', 8192, 1), BudgetExceededError);
  rig.dispose();
});

// ---- reuse (2.1, 2.5 step 1) -----------------------------------------------------------------------------------

test('a texture is reused for its exact shape only, most recently freed first', async () => {
  const rig = await poolRig();
  const { pool, gpu } = rig;
  const a = pool.acquire('field', 64, 64), b = pool.acquire('field', 64, 64), c = pool.acquire('field', 64, 32);
  assert.ok(a.texture !== b.texture && a.texture !== c.texture);
  pool.release(a);
  pool.release(c);
  pool.release(b);

  const other = [pool.acquire('field', 32, 64), pool.acquire('field', 65, 64), pool.acquire('vec2', 64, 64)];
  for (const t of other) assert.ok(![a.texture, b.texture, c.texture].includes(t.texture), 'another shape is another texture: there are no size classes');

  const first = pool.acquire('field', 64, 64), second = pool.acquire('field', 64, 64), third = pool.acquire('field', 64, 64);
  assert.equal(first.texture, b.texture, 'the most recently freed');
  assert.equal(second.texture, a.texture);
  assert.ok(![a.texture, b.texture].includes(third.texture), 'the free list is empty: a new texture');
  assert.equal(pool.acquire('field', 64, 32).texture, c.texture);

  // Two kinds with one format share free lists; the tenant has the kind that was asked for.
  pool.release(first);
  const half = pool.acquire('half', 64, 64);
  assert.equal(half.kind, 'half');
  assert.equal(half.format, gpu.caps.formats.half);
  assert.equal(half.texture === b.texture, gpu.caps.formats.half === gpu.caps.formats.field, `half is ${gpu.caps.formats.half}`);
  rig.dispose();
});

test('a recycled texture is handed out with its previous contents', async () => {
  const rig = await poolRig();
  await rig.compile(fill);
  const first = rig.field('field', 16);
  rig.run(fill, { out: { out: first }, params: { value: 100 } });
  const texture = rig.texture(first).texture;
  // 2.1 rule 4: it returns to FREE and is acquired again while the work that writes it has not even been submitted.
  rig.release(first);
  const second = rig.field('field', 16);
  assert.equal(rig.texture(second).texture, texture);
  assert.deepEqual([...(await rig.read(second)).subarray(0, 3)], [100, 101, 102], 'undefined to the new owner, and not cleared');
  rig.run(fill, { out: { out: second }, params: { value: -5 } });
  assert.deepEqual([...(await rig.read(second)).subarray(0, 3)], [-5, -4, -3]);
  rig.dispose();
});

test('poisonRecycled: a recycled texture holds -1e30, a new one zeros', async () => {
  const rig = await poolRig({ hooks: { poisonRecycled: true } });
  const fresh = rig.field('field', 8);
  assert.ok((await rig.read(fresh)).every((v) => v === 0));
  rig.write(fresh, new Float32Array(64).fill(3));
  rig.release(fresh);
  const recycled = rig.field('field', 8);
  assert.ok((await rig.read(recycled)).every((v) => v === Math.fround(-1e30)));

  // Every kind is poisoned with a value a new texture's zeros differ from.
  for (const kind of ['vec2', 'color', 'aux', 'half', 'half2', 'mask8'] as const) {
    rig.release(rig.field(kind, 8));
    const again = rig.field(kind, 8);
    const data = await rig.read(again);
    assert.ok(data.every((v) => v !== 0 && Number.isFinite(v)), `${kind} (${rig.gpu.caps.formats[kind]}): ${data[0]}`);
  }
  rig.dispose();
});

// ---- the ledger (2.4) ------------------------------------------------------------------------------------------

test('bytes(texture) = width x height x bytes per texel of the format', async () => {
  const rig = await poolRig();
  const { pool, gpu } = rig;
  assert.deepEqual(BYTES_PER_TEXEL, { r8unorm: 1, r16float: 2, r32float: 4, rg16float: 4, rg32float: 8, rgba16float: 8, rgba32float: 16 });
  let working = 0;
  for (const kind of ['field', 'vec2', 'color', 'aux', 'half', 'half2', 'mask8'] as const satisfies readonly FieldKind[]) {
    const t = pool.acquire(kind, 40, 30);
    assert.equal(t.bytes, 40 * 30 * BYTES_PER_TEXEL[gpu.caps.formats[kind] as keyof typeof BYTES_PER_TEXEL], kind);
    working += t.bytes;
    assert.equal(pool.report().workingBytes, working);
  }
  assert.equal(working, 40 * 30 * (gpu.caps.compactFormats ? 4 + 8 + 8 + 16 + 2 + 4 + 1 : 4 + 8 + 8 + 16 + 4 + 8 + 4));
  rig.dispose();
});

test('reserve registers memory that is not a pool texture', async () => {
  const rig = await poolRig();
  const { pool } = rig;
  const before = pool.report().reservedBytes;
  const a = pool.reserve(1000, 'a'), b = pool.reserve(24, 'b');
  assert.equal(pool.report().reservedBytes, before + 1024);
  a.release();
  a.release();
  assert.equal(pool.report().reservedBytes, before + 24, 'release is idempotent');
  b.release();
  assert.equal(pool.report().reservedBytes, before);
  for (const bytes of [-1, NaN, Infinity]) assert.throws(() => pool.reserve(bytes, 'bad'), RangeError);

  // Reserved bytes are committed: they leave less of the budget for textures.
  pool.setBudget(before + FIELD_256 + 100);
  const held = pool.reserve(101, 'held');
  assert.throws(() => pool.acquire('field', 256, 256), BudgetExceededError);
  held.release();
  assert.doesNotThrow(() => pool.acquire('field', 256, 256));
  rig.dispose();
});

// ---- the budget: acquire (2.5), destroying (2.6) ---------------------------------------------------------------

test('acquire creates while the request fits, then destroys FREE textures, the largest first', async () => {
  const rig = await poolRig();
  const { pool } = rig;
  pool.setBudget(pool.report().reservedBytes + 1024 * KB);
  const a = pool.acquire('field', 256, 256), b = pool.acquire('field', 256, 256), c = pool.acquire('field', 128, 128), d = pool.acquire('field', 128, 128);
  for (const t of [c, a, d, b]) pool.release(t);                   // freed in this order
  assert.deepEqual(ledger(pool.report()), [0, 0, 0, 640 * KB, 0]);

  // 640 + 352 KiB fit 1024: a new texture, and nothing is destroyed for it.
  const e = pool.acquire('field', 352, 256);
  assert.deepEqual(ledger(pool.report()), [352 * KB, 0, 0, 640 * KB, 0]);

  // 992 + 160 KiB do not. The largest FREE texture goes; of the two of 256 KiB, the one freed first.
  const f = pool.acquire('field', 160, 256);
  assert.deepEqual(ledger(pool.report()), [512 * KB, 0, 0, 384 * KB, 256 * KB], 'one texture of 256 KiB is draining');
  assert.ok(committed(pool.report()) <= pool.report().budgetBytes);
  await pool.drained();
  assert.equal(pool.report().drainingBytes, 0, 'the barrier has completed');
  assert.deepEqual([e.bytes, f.bytes], [352 * KB, 160 * KB]);
  // What is left in the free lists: both textures of 128 and the 256 that was freed last.
  pool.setBudget(pool.report().reservedBytes + 4096 * KB);
  assert.equal(pool.acquire('field', 256, 256).texture, b.texture, 'the one freed last survived');
  assert.ok(![a.texture, b.texture].includes(pool.acquire('field', 256, 256).texture), 'the one freed first was destroyed');
  assert.equal(pool.acquire('field', 128, 128).texture, d.texture);
  assert.equal(pool.acquire('field', 128, 128).texture, c.texture);
  rig.dispose();
});

test('the largest FREE texture is destroyed even when a smaller one would do', async () => {
  const rig = await poolRig();
  const { pool } = rig;
  const small = pool.acquire('field', 128, 128), large = pool.acquire('field', 256, 256);
  pool.release(small);
  pool.release(large);
  pool.setBudget(pool.report().reservedBytes + FIELD_128 + FIELD_256 + 32 * KB);
  const t = pool.acquire('field', 128, 64);                        // 32 KiB fit; 64 KiB more do not
  const u = pool.acquire('field', 96, 128);                        // 48 KiB
  assert.deepEqual(ledger(pool.report()), [t.bytes + u.bytes, 0, 0, FIELD_128, FIELD_256]);
  assert.equal(pool.acquire('field', 128, 128).texture, small.texture);
  await pool.drained();
  rig.dispose();
});

test('with nothing FREE, acquire evicts cache entries in the cache\'s order until the request fits', async () => {
  const rig = await poolRig();
  const { pool, cache } = rig;
  pool.setBudget(pool.report().reservedBytes + 4 * FIELD_256);
  const [t1, t2, t3, t4] = [0, 1, 2, 3].map(() => {
    const t = pool.acquire('field', 256, 256);
    pool.publish(t);
    return t;
  }) as [PoolTexture, PoolTexture, PoolTexture, PoolTexture];
  cache.store(t1);
  cache.store(t2);
  cache.store(t3);                                                 // t4 stays with its publisher: pinned
  assert.deepEqual(ledger(pool.report()), [0, 3 * FIELD_256, FIELD_256, 0, 0]);

  // The first entry is evicted, and its texture has the exact shape: reused, not destroyed.
  const same = pool.acquire('field', 256, 256);
  assert.equal(cache.state.evictions, 1);
  assert.equal(same.texture, t1.texture);
  assert.deepEqual(ledger(pool.report()), [FIELD_256, 2 * FIELD_256, FIELD_256, 0, 0]);

  // A texture of twice the size needs two evictions; each freed texture is destroyed in turn.
  const wide = pool.acquire('field', 512, 256);
  assert.equal(cache.state.evictions, 3);
  assert.deepEqual(ledger(pool.report()), [3 * FIELD_256, 0, FIELD_256, 0, 2 * FIELD_256]);
  assert.ok(committed(pool.report()) <= pool.report().budgetBytes, 'the invariant holds after every successful acquire');
  assert.equal(wide.bytes, 2 * FIELD_256);
  assert.throws(() => pool.drop(t2), /not held/, 'an evicted texture is gone');

  // Nothing is FREE and nothing is evictable: the pinned texture is never taken.
  assert.throws(() => pool.acquire('field', 256, 256), (thrown: unknown) => {
    assert.ok(thrown instanceof BudgetExceededError);
    assert.equal(thrown.name, 'BudgetExceededError');
    assert.deepEqual([thrown.requestedBytes, thrown.kind, thrown.width, thrown.height], [FIELD_256, 'field', 256, 256]);
    assert.deepEqual(ledger(thrown.report), [3 * FIELD_256, 0, FIELD_256, 0, 2 * FIELD_256]);
    assert.equal(thrown.report.budgetBytes, pool.report().budgetBytes);
    assert.match(thrown.message, /256 x 256 "field"/);
    return true;
  });
  assert.doesNotThrow(() => pool.retain(t4));
  await pool.drained();
  assert.equal(pool.report().drainingBytes, 0);
  rig.dispose();
});

test('a cache that evicts without freeing anything stops acquire instead of looping', async () => {
  const rig = await createRig({ cache: { evictOne: () => true, cacheReferences: () => 0 }, budgetBytes: 0 });
  assert.throws(() => rig.pool.acquire('field', 16, 16), /no texture became FREE/);
  rig.dispose();
});

test('setBudget takes effect at the next acquire', async () => {
  const rig = await poolRig();
  const { pool } = rig;
  const reserved = pool.report().reservedBytes;
  const held = pool.acquire('field', 256, 256);
  pool.setBudget(reserved + FIELD_256);
  assert.equal(pool.report().budgetBytes, reserved + FIELD_256);
  assert.throws(() => pool.acquire('field', 16, 16), BudgetExceededError);
  pool.setBudget(reserved + FIELD_256 + 16 * 16 * 4);
  assert.doesNotThrow(() => pool.acquire('field', 16, 16));
  for (const bytes of [-1, NaN, Infinity]) assert.throws(() => pool.setBudget(bytes), RangeError);
  pool.release(held);
  rig.dispose();
});

test('the pool submits the open slice before it destroys a texture', async () => {
  const rig = await poolRig();
  await rig.compile(fill);
  const { pool, stream } = rig;
  const victim = rig.field('field', 256);
  const kept = rig.field('field', 128);
  await stream.flush();
  // An unsubmitted run writes the texture that is about to be destroyed.
  rig.run(fill, { out: { out: victim }, params: { value: 1 } });
  rig.run(fill, { out: { out: kept }, params: { value: 7 } });
  rig.release(victim);
  pool.setBudget(pool.report().reservedBytes + FIELD_256 + FIELD_128);
  const submitted = stream.submitted;
  pool.acquire('field', 64, 64);
  assert.equal(stream.submitted, submitted + 1, 'the slice went out first');
  assert.equal(pool.report().drainingBytes, FIELD_256);
  // No validation error: no submitted command refers to a destroyed texture.
  await rig.owner.settle();
  assert.deepEqual([...(await rig.read(kept)).subarray(0, 2)], [7, 8]);
  await pool.drained();
  rig.dispose();
});

// ---- trim (2.8) ------------------------------------------------------------------------------------------------

test('trim destroys the FREE textures of other resolutions and resolves when their memory is back', async () => {
  const rig = await poolRig();
  const { pool } = rig;
  const textures = [pool.acquire('field', 64, 64), pool.acquire('color', 128, 128), pool.acquire('field', 128, 128), pool.acquire('aux', 256, 256)];
  const working = pool.acquire('field', 64, 64);
  for (const t of textures) pool.release(t);
  const [f64, c128, f128, a256] = textures.map((t) => t.bytes) as [number, number, number, number];

  await pool.trim({ keepResolution: 128 });
  assert.deepEqual(ledger(pool.report()), [working.bytes, 0, 0, c128 + f128, 0], 'the textures 128 wide stay; WORKING ones are never destroyed');
  assert.equal(pool.acquire('field', 128, 128).texture, textures[2]!.texture);
  assert.notEqual(pool.acquire('field', 64, 64).texture, textures[0]!.texture);

  await pool.trim();
  assert.equal(pool.report().freeBytes, 0, 'without keepResolution every FREE texture goes');
  assert.equal(pool.report().drainingBytes, 0);
  assert.notEqual(pool.acquire('color', 128, 128).texture, textures[1]!.texture);
  assert.ok(f64 > 0 && a256 > 0);
  await pool.trim();
  rig.dispose();
});

test('drained resolves when no destroyed texture is still held by the driver', async () => {
  const rig = await poolRig();
  const { pool } = rig;
  await pool.drained();
  pool.release(pool.acquire('field', 256, 256));
  pool.release(pool.acquire('field', 128, 128));
  pool.setBudget(pool.report().reservedBytes + FIELD_256 + FIELD_128);
  pool.acquire('field', 200, 200);                                 // destroys the 256
  pool.acquire('field', 100, 100);                                 // fits
  pool.acquire('field', 100, 160);                                 // destroys the 128: a second barrier
  assert.equal(pool.report().drainingBytes, FIELD_256 + FIELD_128);
  await pool.drained();
  assert.equal(pool.report().drainingBytes, 0);
  rig.dispose();
});

// ---- test hooks and disposal -----------------------------------------------------------------------------------

test('failAllocAfter: the nth creation reports out of memory to its owner, once', async () => {
  const rig = await poolRig({ hooks: { failAllocAfter: 2 } });
  const { pool } = rig;
  const first = rig.use({ nodeId: 'first' });
  pool.acquire('field', 32, 32);
  await first.settle();
  first.close();

  const second = rig.use({ nodeId: 'second' });
  pool.release(pool.acquire('field', 32, 32));                     // the second creation
  pool.acquire('field', 32, 32);                                   // a reuse is not a creation
  await assert.rejects(second.settle(), (thrown: unknown) => thrown instanceof GpuOutOfMemoryError && thrown.name === 'GpuOutOfMemoryError');
  await assert.rejects(rig.stream.boundary(true), GpuOutOfMemoryError, 'a batch boundary reports it too');
  second.close();

  const third = rig.use({ nodeId: 'third' });
  pool.acquire('field', 48, 48);
  pool.acquire('field', 48, 48);
  await third.settle();
  third.close();
  rig.dispose();
});

test('an acquire without a current stream owner fails and leaves the ledger as it was', async () => {
  for (const poisonRecycled of [false, true]) {
    const rig = await poolRig({ hooks: { poisonRecycled } });
    const { pool } = rig;
    pool.release(pool.acquire('field', 32, 32));
    const before = pool.report();
    rig.owner.close();
    assert.throws(() => pool.acquire('field', 64, 64), /No stream owner is current/, 'a creation records its scopes for an owner');
    if (poisonRecycled) assert.throws(() => pool.acquire('field', 32, 32), /No stream owner is current/, 'a poisoned reuse is encoded for an owner');
    assert.deepEqual(pool.report(), before);
    rig.use();
    assert.doesNotThrow(() => pool.acquire('field', 32, 32));
    rig.dispose();
  }
});

test('dispose destroys every texture whatever its state', async () => {
  const rig = await poolRig();
  const { pool } = rig;
  const reserved = pool.report().reservedBytes;
  pool.acquire('field', 64, 64);
  pool.publish(pool.acquire('field', 64, 64));
  pool.release(pool.acquire('field', 64, 64));
  pool.dispose();
  assert.deepEqual(ledger(pool.report()), [0, 0, 0, 0, 0]);
  assert.equal(pool.report().reservedBytes, reserved);
  rig.dispose();
});
