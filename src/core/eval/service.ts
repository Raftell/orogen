import type { AnyRunBindings } from '../gpu/bindings.ts';
import type { Field, FieldKind } from '../gpu/field.ts';
import type { AnyKernel } from '../gpu/kernel.ts';
import type { PoolTexture } from '../gpu/pool.ts';
import { encodeRun } from '../gpu/run.ts';
import type { SliceService } from '../gpu/stream.ts';
import type { EngineParts } from './parts.ts';

// What the evaluator's own services share: field ids, kernel runs on pool textures without a node, and the
// life of a service owner (runtime.md 3.1, 5.8).

let lastFieldId = 0;

/** The id of a new Field: unique within the process, and so within the engine session (engine.md 1.4). */
export function nextFieldId(): number {
  return ++lastFieldId;
}

export interface ServiceRun {
  readonly in?: Readonly<Record<string, PoolTexture | null>>;
  readonly out: Readonly<Record<string, PoolTexture>>;
  readonly params?: Readonly<Record<string, number | boolean | readonly number[]>>;
  readonly cost?: number;
  /** The Frame's project values; a kernel that reads neither gets 1. */
  readonly terrainSize?: number;
  readonly heightRange?: number;
}

/** Encodes one run of an engine kernel on pool textures, for the stream's current owner. */
export function runKernel(parts: EngineParts, service: string, kernel: AnyKernel, run: ServiceRun): void {
  const textures = new Map<Field, PoolTexture>();
  const fieldOf = (texture: PoolTexture): Field => {
    const field: Field = { kind: texture.kind, width: texture.width, height: texture.height, readOnly: false, id: nextFieldId() };
    textures.set(field, texture);
    return field;
  };
  const bind = <T extends PoolTexture | null>(slot: Readonly<Record<string, T>> | undefined): Record<string, Field | null> | undefined => {
    if (!slot) return undefined;
    const bound: Record<string, Field | null> = {};
    for (const [name, texture] of Object.entries(slot)) bound[name] = texture ? fieldOf(texture) : null;
    return bound;
  };
  const bindings: AnyRunBindings = {
    ...(run.in ? { in: bind(run.in) } : {}),
    out: bind(run.out) as Record<string, Field | null>,
    ...(run.params ? { params: run.params } : {}),
    ...(run.cost !== undefined ? { cost: run.cost } : {}),
  };
  encodeRun(parts, kernel, bindings, {
    nodeId: 'engine',
    nodeType: service,
    listed: () => true,
    released: (field) => !textures.has(field),
    ownsLut: () => false,
    terrainSize: run.terrainSize ?? 1,
    heightRange: run.heightRange ?? 1,
    seed: 0,
    iteration: 0,
    texture: (field) => textures.get(field)!,
    lutBuffer: () => { throw new Error('An engine service binds no LUT'); },
  });
}

/**
 * One service call that produces a texture: opens the owner, acquires the texture, lets `encode` fill it, and
 * resolves with it, WORKING, when every slice and scope of the owner has reported. On any failure the texture
 * is FREE again. The caller makes its own owner current afterwards.
 */
export async function produce(
  parts: EngineParts, service: SliceService, mode: 'preview' | 'build', signal: AbortSignal | undefined,
  kind: FieldKind, width: number, height: number, encode: (target: PoolTexture) => void,
): Promise<PoolTexture> {
  const owner = parts.stream.open({ nodeId: null, service, mode, ...(signal ? { signal } : {}) });
  let texture: PoolTexture | null = null;
  try {
    parts.stream.use(owner);
    texture = parts.pool.acquire(kind, width, height);
    encode(texture);
    await owner.settle();
    return texture;
  } catch (thrown) {
    if (texture) parts.pool.release(texture);
    throw thrown;
  } finally {
    owner.close();
  }
}
