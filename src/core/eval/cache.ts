import type { PoolCacheHooks, PoolTexture, TexturePool } from '../gpu/pool.ts';

/** What one cache entry holds: per output port for a node entry; under the name 'out' for a conversion, a mask blend and a constant. */
export type EntryTextures = ReadonlyMap<string, PoolTexture>;

/**
 * The result cache: (content, resolution) to published textures (runtime.md 5.4). An entry holds one reference
 * per texture it names, taken when it is stored and dropped when it is evicted or replaced.
 */
export interface ResultCache extends PoolCacheHooks {
  /** The entry, which this call marks as used. `transient` is the generation of a transient evaluation, null for 'keep' (5.4, Transient entries rules 1 and 3). */
  get(content: string, resolution: number, transient: number | null): EntryTextures | undefined;
  /** Stores an entry, replacing one at the same address. The textures are PUBLISHED. */
  set(content: string, resolution: number, textures: EntryTextures, transient: number | null): void;
  /** Rule 2 of transient entries: drops every transient entry whose generation is lower than `requestId`. */
  dropTransientBelow(requestId: number): void;
  /** Engine.trim (2.8): evicts every entry of another resolution; all entries when omitted. */
  evictExcept(keepResolution?: number): void;
  /** 5.8 Memory rule 2: evicts every evictable entry. */
  evictEvictable(): void;
  /** The device is lost: forgets every entry without calling the pool. */
  forget(): void;
}

export function createCache(pool: Pick<TexturePool, 'retain' | 'drop'>): ResultCache {
  throw new Error('not implemented: createCache');
}
