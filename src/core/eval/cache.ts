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
  /** Where the entry stands in the eviction order: under a generation, among the ordinary entries (null), or nowhere yet. */
  filed: number | null | undefined;
}

export function createCache(pool: Pick<ManagedPool, 'retain' | 'drop' | 'references'>): ResultCache {
  const byResolution = new Map<number, Map<string, Entry>>();
  /**
   * The entries in eviction order (2.7), kept as they are used: a set lists its members in the order they were
   * added, so an entry that is used is taken out and added again. Transient entries have one set per generation;
   * few generations exist at a time, because a settled transient evaluation drops those below its own. Sorting
   * every entry for every eviction took 0.15 ms an eviction with 8000 entries.
   */
  const transients = new Map<number, Set<Entry>>();
  /** The generations that have entries, ascending. */
  const generations: number[] = [];
  const ordinary = new Set<Entry>();
  /** References the entries hold, per texture. */
  const held = new Map<PoolTexture, number>();
  let count = 0;

  function unfile(entry: Entry): void {
    if (entry.filed === null) ordinary.delete(entry);
    else if (entry.filed !== undefined) {
      const peers = transients.get(entry.filed);
      peers?.delete(entry);
      if (peers?.size === 0) {
        transients.delete(entry.filed);
        generations.splice(generations.indexOf(entry.filed), 1);
      }
    }
    entry.filed = undefined;
  }

  /** The entry was created or used: among the ordinary entries, or those of its generation, it is the last to be evicted. */
  function touch(entry: Entry): void {
    unfile(entry);
    entry.filed = entry.transient;
    if (entry.transient === null) {
      ordinary.add(entry);
      return;
    }
    let peers = transients.get(entry.transient);
    if (!peers) {
      transients.set(entry.transient, peers = new Set());
      // A generation is a requestId, and those grow: the place is the end, or near it.
      let at = generations.length;
      while (at > 0 && generations[at - 1]! > entry.transient) at--;
      generations.splice(at, 0, entry.transient);
    }
    peers.add(entry);
  }

  const find = (content: string, resolution: number): Entry | undefined => byResolution.get(resolution)?.get(content);

  /** Removes the entry and drops its references. Returns whether a texture lost its last reference. */
  function remove(entry: Entry): boolean {
    const entries = byResolution.get(entry.resolution);
    if (entries?.get(entry.content) !== entry) return false;
    entries.delete(entry.content);
    if (entries.size === 0) byResolution.delete(entry.resolution);
    unfile(entry);
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
  function* evictionOrder(): Generator<Entry> {
    // Copies of the lists of generations, not of the entries: the caller removes entries while it walks.
    for (const generation of [...generations]) yield* transients.get(generation) ?? [];
    yield* ordinary;
  }

  function evictOne(): boolean {
    // 2.7: the first entry one of whose textures has no reference but the entry's.
    for (const entry of evictionOrder()) {
      for (const [texture, mine] of own(entry)) {
        if (pool.references(texture) === mine) {
          remove(entry);
          return true;
        }
      }
    }
    // Entries that share a texture (a pass-through, 5.6) keep each other from being evictable alone. Such a
    // texture is not pinned, so its entries go together, in eviction order, until it is free.
    for (const entry of evictionOrder()) {
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
      // A 'keep' evaluation makes the entry ordinary; a transient one moves a transient entry to its generation.
      if (transient === null) entry.transient = null;
      else if (entry.transient !== null) entry.transient = Math.max(entry.transient, transient);
      touch(entry);
      return entry.textures;
    },

    peek(content, resolution) {
      return find(content, resolution)?.textures;
    },

    set(content, resolution, textures, transient) {
      const old = find(content, resolution);
      const entry: Entry = {
        content, resolution, textures: new Map(textures), transient: old && old.transient === null ? null : transient, filed: undefined,
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
      touch(entry);
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
      transients.clear();
      generations.length = 0;
      ordinary.clear();
      held.clear();
      count = 0;
    },
  };
}
