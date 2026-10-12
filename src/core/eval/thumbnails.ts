import type { AnyKernel } from '../gpu/kernel.ts';
import type { PoolTexture } from '../gpu/pool.ts';
import type { ProjectSettings } from '../graph/doc.ts';
import type { PortRole } from '../graph/ports.ts';
import type { EngineParts } from './parts.ts';

export interface Thumbnail {
  readonly nodeId: string;
  readonly contentKey: string;           // 5.4
  readonly resolution: number;           // of the field it was made from
  readonly rgba: Uint8ClampedArray;      // 128 × 128 × 4, row-major, first row = row 0 of the field
}

/** The kernels of this module, for createEngine to compile. */
export function thumbnailKernels(): readonly AnyKernel[] {
  throw new Error('not implemented: thumbnailKernels');
}

/** The thumbnail service of runtime.md 5.12: the atlas, its readback and the record of what was last delivered per node id. */
export interface Thumbnails {
  /** Rule 1: true when a thumbnail of this content at this resolution would be better than the last one delivered for the node. */
  wanted(nodeId: string, contentKey: string, resolution: number): boolean;
  /** Shades outputs[0] into a cell of the atlas (rules 2 and 3). `role` is null for a color. */
  add(source: PoolTexture, info: {
    readonly nodeId: string; readonly contentKey: string; readonly resolution: number;
    readonly role: PortRole | null; readonly settings: ProjectSettings;
  }): void;
  /** Rule 4: reads the atlas back when `force` is set (the evaluation has ended), when 250 ms have passed, or when all cells are in use; delivers each thumbnail once. Never delays the caller. */
  poll(force: boolean): void;
  onThumbnail(listener: (t: Thumbnail) => void): () => void;
  /** Destroys the atlas. Not called for a lost device. */
  dispose(): void;
}

export function createThumbnails(parts: EngineParts): Thumbnails {
  throw new Error('not implemented: createThumbnails');
}
