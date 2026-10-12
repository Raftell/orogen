import type { FieldHandle, PoolTexture } from '../gpu/pool.ts';
import type { EngineParts } from './parts.ts';

/**
 * A handle on a published texture (runtime.md 2.2). It takes one reference with pool.retain and drops it in
 * release(). `kind` is the kind the content is delivered as.
 */
export function createFieldHandle<K extends 'field' | 'color'>(parts: EngineParts, texture: PoolTexture, kind: K): FieldHandle<K> {
  throw new Error('not implemented: createFieldHandle');
}

/**
 * The pool texture behind a handle this engine made. Throws FieldAccessError for a released handle and
 * DeviceLostError for one of an earlier device epoch, as reading its `texture` does.
 */
export function poolTextureOf(handle: FieldHandle): PoolTexture {
  throw new Error('not implemented: poolTextureOf');
}
