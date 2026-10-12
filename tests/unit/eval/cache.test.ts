// The result cache (runtime.md 5.4, 2.2, 2.7) against a pool that only counts references: what an entry
// holds, eviction order, evictability, transient entries. No device is involved.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCache, type ResultCache } from '../../../src/core/eval/cache.ts';
import type { PoolTexture } from '../../../src/core/runtime.ts';

/** Published textures by name, with their reference counts; a texture at zero is FREE. */
function fakePool() {
  const references = new Map<PoolTexture, number>();
  const names = new Map<PoolTexture, string>();
  const freed: string[] = [];
  const count = (t: PoolTexture): number => {
    const n = references.get(t);
    if (n === undefined) throw new Error(`pool: ${names.get(t)} is not published`);
    return n;
  };
  return {
    freed,
    /** A texture as publish() leaves it: one reference, the caller's. */
    texture(name: string): PoolTexture {
      const t = { kind: 'field', width: 4, height: 4, bytes: 64 } as unknown as PoolTexture;
      references.set(t, 1);
      names.set(t, name);
      return t;
    },
    retain: (t: PoolTexture): void => void references.set(t, count(t) + 1),
    drop(t: PoolTexture): void {
      const left = count(t) - 1;
      if (left === 0) {
        references.delete(t);
        freed.push(names.get(t)!);
      } else {
        references.set(t, left);
      }
    },
    references: count,
    refs: (t: PoolTexture): number => references.get(t) ?? 0,
  };
}

/** Stores one texture under `content` and gives the caller's reference up, as the evaluator does after publication. */
function store(pool: ReturnType<typeof fakePool>, cache: ResultCache, content: string, transient: number | null = null, resolution = 65): PoolTexture {
  const t = pool.texture(content);
  cache.set(content, resolution, new Map([['out', t]]), transient);
  pool.drop(t);
  return t;
}
const evictAll = (cache: ResultCache, pool: ReturnType<typeof fakePool>): string[] => {
  const from = pool.freed.length;
  for (let rounds = 0; rounds < 100 && cache.evictOne(); rounds++);
  return pool.freed.slice(from);
};

test('an entry holds one reference per output it names, and drops them when it is replaced or evicted', () => {
  const pool = fakePool();
  const cache = createCache(pool);
  const a = pool.texture('a'), b = pool.texture('b');
  cache.set('k', 65, new Map([['out', a], ['extra', a], ['flow', b]]), null);
  assert.deepEqual([pool.refs(a), pool.refs(b), cache.cacheReferences(a), cache.cacheReferences(b), cache.size], [3, 2, 2, 1, 1]);
  assert.deepEqual([...cache.peek('k', 65)!.keys()], ['out', 'extra', 'flow']);
  assert.equal(cache.peek('k', 33), undefined, 'the resolution is half of the address');
  assert.equal(cache.get('other', 65, null), undefined);
  pool.drop(a);
  pool.drop(b);

  // Replaced by an entry that names one of the same textures: it must not pass through zero.
  const c = pool.texture('c');
  cache.set('k', 65, new Map([['out', a], ['extra', c]]), null);
  pool.drop(c);
  assert.deepEqual([pool.refs(a), pool.refs(b), pool.refs(c), cache.cacheReferences(a), cache.size], [1, 0, 1, 1, 1]);
  assert.deepEqual(pool.freed, ['b']);
  assert.equal(cache.evictOne(), true);
  assert.deepEqual([pool.freed, cache.size, cache.cacheReferences(a)], [['b', 'a', 'c'], 0, 0]);
  assert.equal(cache.evictOne(), false);
});

test('eviction order: transient entries by generation, then the rest by last use; a get is a use', () => {
  const pool = fakePool();
  const cache = createCache(pool);
  store(pool, cache, 'old');
  store(pool, cache, 't9', 9);
  store(pool, cache, 'mid');
  store(pool, cache, 't4', 4);
  store(pool, cache, 'new');
  cache.get('old', 65, null);
  cache.peek('mid', 65);                                         // not a use
  assert.deepEqual(evictAll(cache, pool), ['t4', 't9', 'mid', 'new', 'old']);
});

test('an entry is evictable when it alone keeps a texture; pinned content is skipped, shared content goes together', () => {
  const pool = fakePool();
  const cache = createCache(pool);
  const pinned = store(pool, cache, 'pinned');
  pool.retain(pinned);                                           // a handle
  store(pool, cache, 'free');
  assert.deepEqual(evictAll(cache, pool), ['free']);
  assert.equal(cache.size, 1, 'the pinned entry stays');
  pool.drop(pinned);
  assert.deepEqual(evictAll(cache, pool), ['pinned']);

  // A pass-through: two entries name one texture, and neither is its only holder.
  const shared = pool.texture('shared');
  cache.set('source', 65, new Map([['out', shared]]), null);
  cache.set('alias', 65, new Map([['out', shared]]), null);
  pool.drop(shared);
  store(pool, cache, 'other');
  const from = pool.freed.length;
  assert.equal(cache.evictOne(), true);
  assert.deepEqual(pool.freed.slice(from), ['other'], 'an entry that frees something by itself goes first');
  assert.equal(cache.evictOne(), true);
  assert.deepEqual([pool.freed.slice(from), cache.size], [['other', 'shared'], 0], 'then the entries of the shared texture, until it is free');

  // Shared and pinned: nothing can be freed, and nothing is removed.
  const held = pool.texture('held');
  cache.set('s1', 65, new Map([['out', held]]), null);
  cache.set('s2', 65, new Map([['out', held]]), null);
  assert.equal(cache.evictOne(), false);
  assert.equal(cache.size, 2);
  cache.evictEvictable();
  assert.equal(cache.size, 2);
  pool.drop(held);
  cache.evictEvictable();
  assert.deepEqual([cache.size, pool.refs(held)], [0, 0]);
});

test('transient entries: a generation per evaluation, dropped below the next one unless hit; "keep" makes them ordinary', () => {
  const pool = fakePool();
  const cache = createCache(pool);
  const upstream = store(pool, cache, 'upstream', 1);
  const tick1 = store(pool, cache, 'tick1', 1);
  cache.dropTransientBelow(1);
  assert.equal(cache.size, 2, 'the entries of the evaluation that just settled stay');

  // The next tick hits upstream and makes a new result.
  cache.get('upstream', 65, 2);
  const tick2 = store(pool, cache, 'tick2', 2);
  cache.dropTransientBelow(2);
  assert.deepEqual([pool.refs(upstream), pool.refs(tick1), pool.refs(tick2), cache.size], [1, 0, 1, 2]);

  // A 'keep' evaluation hits tick2: it is ordinary from then on, and a later transient hit leaves it so.
  cache.get('tick2', 65, null);
  cache.get('tick2', 65, 7);
  cache.dropTransientBelow(99);
  assert.deepEqual([pool.refs(upstream), pool.refs(tick2), cache.size], [0, 1, 1]);

  // An entry that replaces an ordinary one stays ordinary.
  const again = pool.texture('again');
  cache.set('tick2', 65, new Map([['out', again], ['extra', again]]), 100);
  pool.drop(again);
  cache.dropTransientBelow(1000);
  assert.deepEqual([cache.size, pool.refs(again), pool.refs(tick2)], [1, 2, 0]);
  // Dropping is not eviction: a transient entry goes even while its content is pinned.
  const pinned = store(pool, cache, 'pinned', 5);
  pool.retain(pinned);
  cache.dropTransientBelow(6);
  assert.deepEqual([cache.size, pool.refs(pinned), cache.cacheReferences(pinned)], [1, 1, 0]);
});

test('evictExcept keeps one resolution; forget empties the cache without a call to the pool', () => {
  const pool = fakePool();
  const cache = createCache(pool);
  const a33 = store(pool, cache, 'a', null, 33);
  const a65 = store(pool, cache, 'a', null, 65);
  const b129 = store(pool, cache, 'b', 3, 129);
  cache.evictExcept(65);
  assert.deepEqual([pool.refs(a33), pool.refs(a65), pool.refs(b129), cache.size], [0, 1, 0, 1]);
  cache.evictExcept();
  assert.deepEqual([pool.refs(a65), cache.size], [0, 0]);

  const kept = store(pool, cache, 'kept');
  const before = pool.freed.length;
  cache.forget();
  assert.deepEqual([cache.size, cache.cacheReferences(kept), pool.refs(kept), pool.freed.length], [0, 0, 1, before]);
  assert.equal(cache.evictOne(), false);
});

test('the cache holds at most 8192 entries: beyond that the first in eviction order go, freeing or not', () => {
  const pool = fakePool();
  const cache = createCache(pool);
  const shared = pool.texture('shared');
  // 8192 entries that cost no bytes of their own: all name one texture, which a handle pins as well.
  for (let i = 0; i < 8192; i++) cache.set(`alias${i}`, 65, new Map([['out', shared]]), null);
  assert.deepEqual([cache.size, pool.refs(shared)], [8192, 8193]);
  cache.get('alias0', 65, null);
  for (let i = 0; i < 10; i++) cache.set(`more${i}`, 65, new Map([['out', shared]]), null);
  assert.equal(cache.size, 8192);
  assert.equal(pool.refs(shared), 8193);
  assert.ok(cache.peek('alias0', 65), 'the entry that was used last stays');
  assert.equal(cache.peek('alias1', 65), undefined, 'the least recently used went');
  assert.ok(cache.peek('alias11', 65) && cache.peek('more9', 65));
  assert.equal(cache.evictOne(), false, 'none of them can free the pinned texture');
});
