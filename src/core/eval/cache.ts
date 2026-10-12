import type { ManagedPool, PoolCacheHooks, PoolTexture } from '../gpu/pool.ts';

/** What one cache entry holds: per output port for a node entry; under the name 'out' for a conversion, a mask blend and a constant. */
export type EntryTextures = ReadonlyMap<string, PoolTexture>;

/**
 * The result cache: (content, resolution) to published textures (runtime.md 5.4). An entry holds one reference
 * per texture it names, taken when it is stored and dropped when it is evicted or replaced.
 */
export interface ResultCache extends PoolCacheHooks {
  /** The entry, which this call marks as used. `transient` is the generation of a transient evaluation, null for 'keep' (5.4, Transient entries rules 1 and 3). */
  get(content: string, resolution: number, transient: number | null): EntryTextures | undefined;
  /** The entry, without using it: for the test whether it holds every wanted output (5.4 rule 2). */
  peek(content: string, resolution: number): EntryTextures | undefined;
  /**
   * Stores an entry, replacing one at the same address. The textures are PUBLISHED. An entry that replaces an
   * ordinary one is ordinary whatever `transient` says: the content was asked for outside a gesture.
   */
  set(content: string, resolution: number, textures: EntryTextures, transient: number | null): void;
  /** Rule 2 of transient entries: drops every transient entry whose generation is lower than `requestId`. */
  dropTransientBelow(requestId: number): void;
  /** Engine.trim (2.8): evicts every entry of another resolution; all entries when omitted. */
  evictExcept(keepResolution?: number): void;
  /** 5.8 Memory rule 2: evicts every evictable entry. */
  evictEvictable(): void;
  /** The device is lost: forgets every entry without calling the pool. */
  forget(): void;
  /** Entries held, for tests and reports. */
  readonly size: number;
}

/**
 * The most entries held. The budget bounds the bytes of the cache, not its entries: an entry that only names
 * textures other entries name too (a pass-through, 5.6) costs no bytes and would never be evicted for memory.
 */
const MAX_ENTRIES = 8192;

interface Entry {
  readonly content: string;
  readonly resolution: number;
  readonly textures: EntryTextures;
  /** The generation of a transient entry; null for an ordinary one. */
  transient: number | null;
  /** Order of last use. */
  used: number;
}

export function createCache(pool: Pick<ManagedPool, 'retain' | 'drop' | 'references'>): ResultCache {
  const byResolution = new Map<number, Map<string, Entry>>();
  /** References the entries hold, per texture. */
  const held = new Map<PoolTexture, number>();
  let clock = 0;
  let count = 0;

  const find = (content: string, resolution: number): Entry | undefined => byResolution.get(resolution)?.get(content);

  /** Removes the entry and drops its references. Returns whether a texture lost its last reference. */
  function remove(entry: Entry): boolean {
    const entries = byResolution.get(entry.resolution);
    if (entries?.get(entry.content) !== entry) return false;
    entries.delete(entry.content);
    if (entries.size === 0) byResolution.delete(entry.resolution);
    count--;
    let freed = false;
    for (const texture of entry.textures.values()) {
      const left = held.get(texture)! - 1;
      if (left === 0) held.delete(texture);
      else held.set(texture, left);
      if (pool.references(texture) === 1) freed = true;
      pool.drop(texture);
    }
    return freed;
  }

  /** How often the entry names each of its textures. */
  function own(entry: Entry): Map<PoolTexture, number> {
    const counts = new Map<PoolTexture, number>();
    for (const texture of entry.textures.values()) counts.set(texture, (counts.get(texture) ?? 0) + 1);
    return counts;
  }

  /** Every entry in eviction order (2.7): transient ones by generation, then the rest by last use. */
  function evictionOrder(): Entry[] {
    const all: Entry[] = [];
    for (const entries of byResolution.values()) for (const entry of entries.values()) all.push(entry);
    return all.sort((a, b) => {
      if ((a.transient === null) !== (b.transient === null)) return a.transient === null ? 1 : -1;
      if (a.transient !== null && b.transient !== null && a.transient !== b.transient) return a.transient - b.transient;
      return a.used - b.used;
    });
  }

  function evictOne(): boolean {
    const order = evictionOrder();
    // 2.7: the first entry one of whose textures has no reference but the entry's.
    for (const entry of order) {
      for (const [texture, mine] of own(entry)) {
        if (pool.references(texture) === mine) {
          remove(entry);
          return true;
        }
      }
    }
    // Entries that share a texture (a pass-through, 5.6) keep each other from being evictable alone. Such a
    // texture is not pinned, so its entries go together, in eviction order, until it is free.
    for (const entry of order) {
      let shared = false;
      for (const texture of entry.textures.values()) {
        if (pool.references(texture) === held.get(texture)) shared = true;
      }
      if (shared && remove(entry)) return true;
    }
    return false;
  }

  return {
    get size() { return count; },
    evictOne,
    cacheReferences: (texture) => held.get(texture) ?? 0,

    get(content, resolution, transient) {
      const entry = find(content, resolution);
      if (!entry) return undefined;
      entry.used = ++clock;
      // A 'keep' evaluation makes the entry ordinary; a transient one moves a transient entry to its generation.
      if (transient === null) entry.transient = null;
      else if (entry.transient !== null) entry.transient = Math.max(entry.transient, transient);
      return entry.textures;
    },

    peek(content, resolution) {
      return find(content, resolution)?.textures;
    },

    set(content, resolution, textures, transient) {
      const old = find(content, resolution);
      const entry: Entry = {
        content, resolution, textures: new Map(textures), used: ++clock,
        transient: old && old.transient === null ? null : transient,
      };
      // The new references first: a texture both entries name must not reach zero in between.
      for (const texture of entry.textures.values()) {
        pool.retain(texture);
        held.set(texture, (held.get(texture) ?? 0) + 1);
      }
      if (old) remove(old);
      let entries = byResolution.get(resolution);
      if (!entries) byResolution.set(resolution, entries = new Map());
      entries.set(content, entry);
      count++;
      if (count > MAX_ENTRIES) {
        // Whoever still reads the content of a removed entry holds a reference of its own (2.2).
        for (const oldest of evictionOrder()) {
          if (count <= MAX_ENTRIES) break;
          if (oldest !== entry) remove(oldest);
        }
      }
    },

    dropTransientBelow(requestId) {
      for (const entries of [...byResolution.values()]) {
        for (const entry of [...entries.values()]) {
          if (entry.transient !== null && entry.transient < requestId) remove(entry);
        }
      }
    },

    evictExcept(keepResolution) {
      for (const [resolution, entries] of [...byResolution]) {
        if (resolution === keepResolution) continue;
        for (const entry of [...entries.values()]) remove(entry);
      }
    },

    evictEvictable() {
      // Each round removes an entry, so the entries held now bound the loop.
      for (let rounds = count; rounds > 0 && evictOne(); rounds--);
    },

    forget() {
      byResolution.clear();
      held.clear();
      count = 0;
    },
  };
}
