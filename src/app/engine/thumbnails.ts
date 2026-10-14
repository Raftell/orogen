// Thumbnail pixels (runtime.md 8.5): the last image of each node, with the content key it was made from. They
// are in no store: a node component subscribes here by node id and draws into a plain 2D canvas through a ref.

declare global {
  // The page's ImageData. Empty here so that this module also compiles where the DOM types are absent (the
  // window-free tests); with them, the two declarations merge.
  interface ImageData {}
}

/** A thumbnail is 128 × 128 (5.12 rule 2). */
export const THUMBNAIL_SIZE = 128;

export interface ThumbnailEntry {
  readonly contentKey: string;           // 5.4: stale when it differs from EngineState.keys[nodeId]
  readonly resolution: number;           // of the field it was made from
  readonly image: ImageData;
}

/** The members of a `thumbnail` event that the cache reads. */
export interface ThumbnailSource {
  readonly nodeId: string;
  readonly contentKey: string;
  readonly resolution: number;
  readonly rgba: Uint8ClampedArray;
}

export interface ThumbnailCache {
  /** Keeps the image, in place of the one the node had, and tells the node's subscribers. The pixels are kept, not copied. */
  put(thumbnail: ThumbnailSource): void;
  get(nodeId: string): ThumbnailEntry | null;
  /** Called after every `put` for this node. Returns the function that ends the subscription. */
  subscribe(nodeId: string, listener: () => void): () => void;
  /**
   * Forgets the image of one node and tells the node's subscribers, which then draw nothing: the image of a node
   * of the project before that bears this id is no picture of this project's node (8.5, "Another project").
   */
  drop(nodeId: string): void;
  clear(): void;
  readonly size: number;
}

export type ImageFactory = (rgba: Uint8ClampedArray, size: number) => ImageData;

/**
 * Entries kept: 64 MiB of pixels. An entry is not dropped when its node leaves the document: the engine delivers
 * a thumbnail once per node id and content key (5.12 rule 1), so a node that comes back by undo, or with a
 * document that is opened again, is sent none while its key is the one it had.
 */
export const THUMBNAIL_CAPACITY = 1024;

function pageImage(rgba: Uint8ClampedArray, size: number): ImageData {
  const Pixels = (globalThis as { ImageData?: unknown }).ImageData as (new (data: Uint8ClampedArray, width: number, height: number) => ImageData) | undefined;
  if (!Pixels) throw new Error('This environment has no ImageData: createThumbnailCache needs a createImage of its own');
  return new Pixels(rgba, size, size);
}

export function createThumbnailCache(options: { readonly createImage?: ImageFactory; readonly capacity?: number } = {}): ThumbnailCache {
  const createImage = options.createImage ?? pageImage;
  const capacity = options.capacity ?? THUMBNAIL_CAPACITY;
  // In the order of the last put: the first entry is the one to forget.
  const entries = new Map<string, ThumbnailEntry>();
  const listeners = new Map<string, Set<() => void>>();

  return {
    put(thumbnail) {
      if (thumbnail.rgba.length !== THUMBNAIL_SIZE * THUMBNAIL_SIZE * 4) {
        console.error(`[orogen] a thumbnail of node "${thumbnail.nodeId}" has ${thumbnail.rgba.length} bytes, not ${THUMBNAIL_SIZE} × ${THUMBNAIL_SIZE} × 4; it is left out`);
        return;
      }
      const image = createImage(thumbnail.rgba, THUMBNAIL_SIZE);
      entries.delete(thumbnail.nodeId);
      entries.set(thumbnail.nodeId, { contentKey: thumbnail.contentKey, resolution: thumbnail.resolution, image });
      if (entries.size > capacity) entries.delete(entries.keys().next().value!);
      for (const listener of [...(listeners.get(thumbnail.nodeId) ?? [])]) {
        try {
          listener();
        } catch (thrown) {
          console.error('[orogen] a thumbnail listener threw', thrown);
        }
      }
    },

    get: (nodeId) => entries.get(nodeId) ?? null,

    subscribe(nodeId, listener) {
      let set = listeners.get(nodeId);
      if (!set) listeners.set(nodeId, set = new Set());
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0 && listeners.get(nodeId) === set) listeners.delete(nodeId);
      };
    },

    drop(nodeId) {
      if (!entries.delete(nodeId)) return;
      for (const listener of [...(listeners.get(nodeId) ?? [])]) {
        try {
          listener();
        } catch (thrown) {
          console.error('[orogen] a thumbnail listener threw', thrown);
        }
      }
    },

    clear: () => entries.clear(),

    get size() { return entries.size; },
  };
}

/** The application's cache. EngineClient fills it. */
export const thumbnails: ThumbnailCache = createThumbnailCache();
