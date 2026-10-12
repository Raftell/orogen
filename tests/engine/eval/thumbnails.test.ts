// Thumbnails (runtime.md 5.12): a by-product of an evaluation, 128 x 128, sampled and shaded on the GPU,
// delivered once per node when they are better than the last one.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { defineKernel, defineNode } from '../../../src/core/api.ts';
import type { GraphDoc, Thumbnail } from '../../../src/core/runtime.ts';
import { constantNode, gainNode, MIB, rampNode, startEngine, tintNode } from './rig.ts';

const planeKernel = defineKernel({
  name: 'test/plane',
  outputs: { out: 'field' },
  params: { gain: 'vec2f', base: 'f32' },
  cost: 1,
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return dot(uv, P.gain) + P.base; }',
});
/** A plane whose outputs[0] has the given role. */
const plane = (role: 'mask' | 'data') => defineNode({
  type: `ref/plane-${role}`,
  title: `Plane ${role} (Test)`,
  category: 'ref',
  description: 'A plane over the terrain.',
  inputs: [],
  outputs: [{ name: 'out', type: 'field', role }],
  params: [
    { kind: 'float', name: 'gainX', unit: 'none', default: 0, min: -100, max: 100, help: 'Slope along X.' },
    { kind: 'float', name: 'gainY', unit: 'none', default: 0, min: -100, max: 100, help: 'Slope along Y.' },
    { kind: 'float', name: 'base', unit: 'none', default: 0, min: -100, max: 100, help: 'Value at the origin.' },
  ],
  kernels: [planeKernel],
  evaluate(ctx) {
    const out = ctx.alloc('field');
    ctx.run(planeKernel, { out: { out }, params: { gain: [ctx.params.gainX, ctx.params.gainY], base: ctx.params.base } });
    ctx.output('out', out);
  },
});

const t = await startEngine([constantNode, rampNode, tintNode, gainNode, plane('mask'), plane('data')]);
after(() => t.dispose());

const delivered: Thumbnail[] = [];
t.engine.onThumbnail((thumbnail) => delivered.push(thumbnail));

/** Waits until `count` thumbnails have been delivered since `from`; the readback runs behind the evaluation. */
async function thumbnails(from: number, count: number): Promise<Thumbnail[]> {
  for (let tries = 0; tries < 400 && delivered.length - from < count; tries++) await new Promise((resolve) => setTimeout(resolve, 5));
  // A little longer, so that one too many would be seen.
  await new Promise((resolve) => setTimeout(resolve, 30));
  return delivered.slice(from);
}
const evaluate = (doc: GraphDoc, targets: string[], resolution = 65) => t.run(doc, targets, { thumbnails: true, resolution });
/** The pixel (i, j) of a thumbnail: row j, column i. */
const pixel = (thumbnail: Thumbnail, i: number, j: number): number[] => [...thumbnail.rgba.subarray((j * 128 + i) * 4, (j * 128 + i) * 4 + 4)];
const near = (found: readonly number[], expected: readonly number[], message: string, tolerance = 1): void => {
  assert.ok(found.length === expected.length && found.every((v, k) => Math.abs(v - expected[k]!) <= tolerance), `${message}: [${found}] against [${expected}]`);
};
const byNode = (list: readonly Thumbnail[]): Record<string, Thumbnail> => Object.fromEntries(list.map((thumbnail) => [thumbnail.nodeId, thumbnail]));

test('every node of the plan whose outputs[0] is available gets a thumbnail: 128 x 128 RGBA, row 0 first', async () => {
  const doc = t.doc({
    mask: { type: 'ref/plane-mask', params: { gainY: 1 } },
    wide: { type: 'ref/plane-mask', params: { gainX: 3, base: -1 } },
    tint: { type: 'ref/tint' },
    data: { type: 'ref/plane-data', params: { gainX: 2, base: 3 } },
    flat: { type: 'ref/plane-data', params: { base: 5 } },
  });
  const from = delivered.length;
  const out = await evaluate(doc, ['mask.out', 'wide.out', 'tint.out', 'data.out', 'flat.out']);
  assert.equal(out.result.status, 'ok', JSON.stringify(out.result.errors));
  const made = await thumbnails(from, 5);
  assert.equal(made.length, 5);
  const keys = await t.engine.keys(doc);
  for (const thumbnail of made) {
    assert.ok(thumbnail.rgba instanceof Uint8ClampedArray && thumbnail.rgba.length === 128 * 128 * 4);
    assert.deepEqual([thumbnail.contentKey, thumbnail.resolution], [keys.get(thumbnail.nodeId), 65]);
  }
  const { mask, wide, tint, data, flat } = byNode(made);

  // A mask: grey saturate(v). v is the row here: row 0 of the field is the first row of the picture.
  near(pixel(mask!, 5, 0), [0, 0, 0, 255], 'mask, first row');
  near(pixel(mask!, 5, 127), [255, 255, 255, 255], 'mask, last row');
  // Texel (i, j) takes the source texel nearest to uv = (i, j) / 127: row 64 reads row round(64 / 127 * 64) = 32 of 65, which is 0.5.
  near(pixel(mask!, 100, 64), [128, 128, 128, 255], 'mask, middle row');
  near(pixel(mask!, 0, 32), pixel(mask!, 127, 32), 'a mask that does not depend on x', 0);
  near(pixel(wide!, 0, 9), [0, 0, 0, 255], 'values below 0 are black');
  near(pixel(wide!, 127, 9), [255, 255, 255, 255], 'values above 1 are white');

  // A colour: rgb encoded to sRGB, alpha ignored.
  near(pixel(tint!, 3, 99), [137, 188, 225, 255], 'linear (0.25, 0.5, 0.75) as sRGB');

  // Data: (v - min) / (max - min) over the samples; 0.5 when they are all equal.
  near(pixel(data!, 0, 50), [0, 0, 0, 255], 'data, the minimum');
  near(pixel(data!, 127, 50), [255, 255, 255, 255], 'data, the maximum');
  near(pixel(data!, 64, 50), [128, 128, 128, 255], 'data, the middle');
  near(pixel(flat!, 77, 77), [128, 128, 128, 255], 'data without a range');
  t.noLeaks();
  assert.ok(t.engine.memory().reservedBytes >= 16 * MIB, 'the atlas is in the ledger');
});

test('a height is shaded by its slope in metres, lit from the top left', async () => {
  // heightRange / terrainSize is 1 / 4: a ramp with gain 4 rises at 45 degrees.
  const doc = t.doc({
    level: { type: 'ref/constant', params: { value: 0.3 } },
    east: { type: 'ref/ramp', params: { gainX: 4, gainY: 0 } },
    west: { type: 'ref/ramp', params: { gainX: -4, gainY: 0 } },
    south: { type: 'ref/ramp', params: { gainX: 0, gainY: 4 } },
  });
  const from = delivered.length;
  // At 128 every thumbnail texel reads a texel of its own; a coarser source repeats texels, which shades as steps.
  await evaluate(doc, ['level.out', 'east.out', 'west.out', 'south.out'], 128);
  const { level, east, west, south } = byNode(await thumbnails(from, 4));
  // dot(n, L) with L = normalize(-0.5, -0.5, 0.7): 0.7035 for a level surface.
  const light = (nx: number, ny: number): number => {
    const length = Math.hypot(nx, ny, 1) * Math.hypot(0.5, 0.5, 0.7);
    return Math.round(255 * Math.min(1, Math.max(0, (-0.5 * nx - 0.5 * ny + 0.7) / length)));
  };
  for (const [i, j] of [[0, 0], [64, 64], [127, 127], [127, 0]] as const) {
    near(pixel(level!, i, j), [light(0, 0), light(0, 0), light(0, 0), 255], `level at (${i}, ${j})`);
    // Rising towards +X: the normal leans towards -X, where the light is.
    near(pixel(east!, i, j), [light(-1, 0), light(-1, 0), light(-1, 0), 255], `east at (${i}, ${j})`);
    near(pixel(west!, i, j), [light(1, 0), light(1, 0), light(1, 0), 255], `west at (${i}, ${j})`);
    near(pixel(south!, i, j), [light(0, -1), light(0, -1), light(0, -1), 255], `south at (${i}, ${j})`);
  }
  assert.ok(pixel(east!, 9, 9)[0]! > pixel(level!, 9, 9)[0]! && pixel(level!, 9, 9)[0]! > pixel(west!, 9, 9)[0]!);
  t.noLeaks();
});

test('a thumbnail is made when it is better than the last one: another content key, or the same at a higher resolution', async () => {
  const graph = (value: number) => t.doc({
    level: { type: 'ref/constant', params: { value } },
    gain: { type: 'ref/gain', inputs: { in: 'level.out' } },
  });
  let from = delivered.length;
  await evaluate(graph(0.1), ['gain.out']);
  assert.deepEqual((await thumbnails(from, 2)).map((x) => [x.nodeId, x.resolution]), [['level', 65], ['gain', 65]]);

  from = delivered.length;
  await evaluate(graph(0.1), ['gain.out']);
  assert.equal((await thumbnails(from, 0)).length, 0, 'the same content at the same resolution: nothing new');
  await evaluate(graph(0.1), ['gain.out'], 33);
  assert.equal((await thumbnails(from, 0)).length, 0, 'a lower resolution is not better');

  await evaluate(graph(0.1), ['gain.out'], 129);
  assert.deepEqual((await thumbnails(from, 2)).map((x) => [x.nodeId, x.resolution]), [['level', 129], ['gain', 129]]);

  // An edit: both nodes have new content keys; a cached node gets its thumbnail too.
  from = delivered.length;
  await evaluate(graph(0.2), ['gain.out'], 33);
  const edited = await thumbnails(from, 2);
  assert.deepEqual(edited.map((x) => [x.nodeId, x.resolution]), [['level', 33], ['gain', 33]]);
  assert.notEqual(edited[0]!.contentKey, (await t.engine.keys(graph(0.1))).get('level'));
  from = delivered.length;
  await evaluate(graph(0.1), ['gain.out'], 33);
  assert.deepEqual((await thumbnails(from, 2)).map((x) => x.nodeId), ['level', 'gain'], 'back to the old content: its nodes are cached, their thumbnails are made again');
  t.noLeaks();
});

test('no thumbnail without the option, for a failed node, or for a node whose outputs[0] nobody wants', async () => {
  const doc = t.doc({
    level: { type: 'ref/constant', params: { value: 0.7 } },
    broken: { type: 'ref/gain' },
    after: { type: 'ref/gain', params: { gain: 3 }, inputs: { in: 'level.out' } },
  });
  let from = delivered.length;
  await t.run(doc, ['after.out'], { thumbnails: false });
  await t.run(doc, ['after.out'], { mode: 'build' });
  assert.equal((await thumbnails(from, 0)).length, 0, 'thumbnails are off unless asked for, and off by default in a build');

  from = delivered.length;
  const out = await t.run(doc, ['after.out', 'broken.out'], { thumbnails: true });
  assert.equal(out.result.status, 'errors');
  assert.deepEqual((await thumbnails(from, 2)).map((x) => x.nodeId), ['level', 'after']);

  // A listener that was removed hears nothing.
  const heard: string[] = [];
  const stop = t.engine.onThumbnail((x) => heard.push(x.nodeId));
  stop();
  from = delivered.length;
  await evaluate(t.doc({ level: { type: 'ref/constant', params: { value: 0.9 } } }), ['level.out']);
  assert.equal((await thumbnails(from, 1)).length, 1);
  assert.deepEqual(heard, []);
  t.noLeaks();
});

test('more thumbnails than the atlas has cells are read back in several batches', async () => {
  // 300 nodes with 300 contents: the atlas holds 256.
  const nodes: Record<string, { type: string; params: Record<string, unknown> }> = {};
  for (let i = 0; i < 300; i++) nodes[`n${i}`] = { type: 'ref/plane-mask', params: { base: i / 299 } };
  const doc = t.doc(nodes);
  const from = delivered.length;
  const out = await t.evaluate(doc, Object.keys(nodes).map((id) => `${id}.out`), { thumbnails: true, resolution: 33, outputs: 'needed' });
  for (const field of out.result.fields) field!.release();
  const made = await thumbnails(from, 300);
  assert.equal(made.length, 300);
  assert.equal(new Set(made.map((x) => x.nodeId)).size, 300, 'each once');
  let wrong = 0;
  for (const thumbnail of made) {
    const expected = Math.round(255 * Number(thumbnail.nodeId.slice(1)) / 299);
    if (Math.abs(thumbnail.rgba[4 * (128 * 60 + 60)]! - expected) > 1) wrong++;
  }
  assert.equal(wrong, 0, 'every thumbnail shows its own node');
  t.noLeaks();
});

test('under a budget the atlas does not fit, an evaluation makes no thumbnails and is not disturbed', async () => {
  const small = await startEngine([constantNode, gainNode], { budgetBytes: 8 * MIB });
  try {
    const heard: string[] = [];
    small.engine.onThumbnail((x) => heard.push(x.nodeId));
    const doc = small.doc({ level: { type: 'ref/constant', params: { value: 2 } }, gain: { type: 'ref/gain', inputs: { in: 'level.out' } } });
    const out = await small.run(doc, ['gain.out'], { thumbnails: true });
    assert.equal(out.result.status, 'ok', JSON.stringify(out.result.errors));
    assert.equal(out.data[0]![0], 4);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(heard, []);
    assert.ok(small.engine.memory().reservedBytes < 8 * MIB, 'the atlas of 16 MiB was not made');
    small.noLeaks();
  } finally {
    await small.dispose();
  }
});
