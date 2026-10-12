import { deviceLostError } from '../gpu/device.ts';
import { FieldAccessError } from '../gpu/errors.ts';
import type { FieldHandle, PoolTexture } from '../gpu/pool.ts';
import { deviceAlive, type EngineParts } from './parts.ts';

const textures = new WeakMap<FieldHandle, () => PoolTexture>();

/**
 * A handle on a published texture (runtime.md 2.2). It takes one reference with pool.retain and drops it in
 * release(). `kind` is the kind the content is delivered as.
 */
export function createFieldHandle<K extends 'field' | 'color'>(parts: EngineParts, texture: PoolTexture, kind: K): FieldHandle<K> {
  parts.pool.retain(texture);
  let released = false;
  const live = (): PoolTexture => {
    if (released) throw new FieldAccessError('This field handle was released');
    if (!deviceAlive(parts)) throw deviceLostError(parts.gpu);
    return texture;
  };
  const handle: FieldHandle<K> = {
    kind,
    width: texture.width,
    height: texture.height,
    epoch: parts.epoch,
    get texture() { return live().texture; },
    get view() { return live().view; },
    retain() {
      live();
      return createFieldHandle(parts, texture, kind);
    },
    release() {
      if (released) throw new FieldAccessError('This field handle was released twice');
      released = true;
      // The pool of a lost device is forgotten, not called (5.9 rule 3).
      if (deviceAlive(parts)) parts.pool.drop(texture);
    },
  };
  textures.set(handle, live);
  return handle;
}

/**
 * The pool texture behind a handle this engine made. Throws FieldAccessError for a released handle and
 * DeviceLostError for one of an earlier device epoch, as reading its `texture` does.
 */
export function poolTextureOf(handle: FieldHandle): PoolTexture {
  const live = textures.get(handle);
  if (!live) throw new FieldAccessError('This object is not a field handle of the engine');
  return live();
}
