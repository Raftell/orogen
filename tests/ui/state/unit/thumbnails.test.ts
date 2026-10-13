// The thumbnail cache (runtime.md 8.5): the last image of each node with the content key it was made from,
// outside every store, with a subscription per node.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createThumbnailCache, THUMBNAIL_CAPACITY, THUMBNAIL_SIZE, type ThumbnailSource } from '../../../../src/app/engine/thumbnails.ts';
import { same } from './_page.ts';

// An image holds 65 536 bytes: none is ever handed to an assertion, which would print it when it fails (testing.md 8.2).

/** What stands for the page's ImageData here. */
interface Pixels { readonly data: Uint8ClampedArray; readonly width: number; readonly height: number }
const plain = (rgba: Uint8ClampedArray, size: number): Pixels => ({ data: rgba, width: size, height: size });

const BYTES = THUMBNAIL_SIZE * THUMBNAIL_SIZE * 4;
function thumbnail(nodeId: string, contentKey: string, fill = 0, resolution = 129): ThumbnailSource {
  return { nodeId, contentKey, resolution, rgba: new Uint8ClampedArray(BYTES).fill(fill) };
}

/** Runs `work` with console.error collected instead of printed. */
function quietly(work: () => void): string[] {
  const original = console.error;
  const said: string[] = [];
  console.error = (...args: unknown[]) => { said.push(args.map(String).join(' ')); };
  try {
    work();
  } finally {
    console.error = original;
  }
  return said;
}

test('a thumbnail is kept as an image of 128 by 128 with its content key and resolution; the pixels are not copied', () => {
  assert.deepEqual([THUMBNAIL_SIZE, BYTES], [128, 65536]);
  const cache = createThumbnailCache({ createImage: plain });
  assert.deepEqual([cache.get('a') === null, cache.size], [true, 0]);

  const first = thumbnail('a', 'key-1', 200, 257);
  cache.put(first);
  const entry = cache.get('a')!;
  const image = entry.image as unknown as Pixels;
  assert.deepEqual([entry.contentKey, entry.resolution, image.width, image.height], ['key-1', 257, 128, 128]);
  same(image.data, first.rgba, 'the buffer the engine sent is the image\'s');
  assert.equal(cache.size, 1);

  // The next one of the node takes its place: another key, or the same key from a finer field.
  cache.put(thumbnail('a', 'key-1', 50, 513));
  assert.deepEqual([cache.get('a')!.contentKey, cache.get('a')!.resolution, (cache.get('a')!.image as unknown as Pixels).data[0], cache.size], ['key-1', 513, 50, 1]);
  cache.put(thumbnail('a', 'key-2'));
  cache.put(thumbnail('b', 'key-1'));
  assert.deepEqual([cache.get('a')!.contentKey, cache.get('b')!.contentKey, cache.size], ['key-2', 'key-1', 2]);

  cache.clear();
  assert.deepEqual([cache.get('a') === null, cache.size], [true, 0]);
});

test('a thumbnail of another size is left out and said so', () => {
  const cache = createThumbnailCache({ createImage: plain });
  cache.put(thumbnail('a', 'key-1'));
  const said = quietly(() => cache.put({ nodeId: 'a', contentKey: 'key-2', resolution: 129, rgba: new Uint8ClampedArray(16) }));
  assert.equal(cache.get('a')!.contentKey, 'key-1', 'the image there was stays');
  assert.equal(said.length, 1);
  assert.match(said[0]!, /thumbnail of node "a" has 16 bytes/);
});

test('a subscriber hears of every thumbnail of its node, and of no other node\'s', () => {
  const cache = createThumbnailCache({ createImage: plain });
  const heard: string[] = [];
  const offA = cache.subscribe('a', () => heard.push(`a:${cache.get('a')!.contentKey}`));
  const offA2 = cache.subscribe('a', () => heard.push('a again'));
  cache.subscribe('b', () => heard.push(`b:${cache.get('b')!.contentKey}`));

  cache.put(thumbnail('a', 'k1'));
  cache.put(thumbnail('c', 'k1'));
  cache.put(thumbnail('b', 'k2'));
  // The same key from a finer field: no key in a store changes, and the node still has to draw.
  cache.put(thumbnail('a', 'k1', 0, 513));
  assert.deepEqual(heard, ['a:k1', 'a again', 'b:k2', 'a:k1', 'a again'], 'the image is there when the subscriber is called');

  offA();
  offA();
  cache.put(thumbnail('a', 'k3'));
  assert.deepEqual(heard.slice(5), ['a again']);
  offA2();
  cache.put(thumbnail('a', 'k4'));
  assert.equal(heard.length, 6);
});

test('a subscriber that throws keeps neither the others nor the cache from their work', () => {
  const cache = createThumbnailCache({ createImage: plain });
  let heard = 0;
  cache.subscribe('a', () => { throw new Error('a canvas that is gone'); });
  cache.subscribe('a', () => { heard++; });
  const said = quietly(() => cache.put(thumbnail('a', 'k1')));
  assert.deepEqual([heard, cache.get('a')!.contentKey, said.length], [1, 'k1', 1]);
});

test('the cache holds a bounded number of nodes and forgets the one whose image is oldest', () => {
  assert.equal(THUMBNAIL_CAPACITY * BYTES, 64 * 1024 * 1024, '64 MiB of pixels');
  const cache = createThumbnailCache({ createImage: plain, capacity: 3 });
  for (const id of ['a', 'b', 'c']) cache.put(thumbnail(id, 'k'));
  cache.put(thumbnail('a', 'k2'));
  cache.put(thumbnail('d', 'k'));
  assert.deepEqual(['a', 'b', 'c', 'd'].map((id) => cache.get(id) !== null), [true, false, true, true], 'b had the oldest image: a was sent a new one');
  assert.equal(cache.size, 3);

  // A node that left the document keeps its image: when it comes back with the key it had, the engine sends none (5.12 rule 1).
  const whole = createThumbnailCache({ createImage: plain });
  whole.put(thumbnail('removed', 'k'));
  for (let i = 0; i < 40; i++) whole.put(thumbnail(`n${i}`, 'k'));
  assert.equal(whole.get('removed')!.contentKey, 'k');
});

test('without a factory the image is the page\'s ImageData, and its absence is said in so many words', () => {
  const root = globalThis as { ImageData?: unknown };
  assert.equal(root.ImageData, undefined, 'Node has no ImageData');
  const cache = createThumbnailCache();
  assert.throws(() => cache.put(thumbnail('a', 'k')), /no ImageData/);
  assert.ok(cache.get('a') === null);

  class PageImageData {
    readonly data: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
    constructor(data: Uint8ClampedArray, width: number, height: number) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  }
  root.ImageData = PageImageData;
  try {
    cache.put(thumbnail('a', 'k', 9));
    const image = cache.get('a')!.image;
    assert.ok(image instanceof PageImageData);
    assert.deepEqual([image.width, image.height, image.data.length, image.data[0]], [128, 128, BYTES, 9]);
  } finally {
    delete root.ImageData;
  }
});
