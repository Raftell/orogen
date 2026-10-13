// Thumbnails (runtime.md 5.12): a by-product of an evaluation, 128 x 128, sampled and shaded on the GPU,
// delivered once per node when they are better than the last one.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { defineKernel, defineNode } from '../../../src/core/api.ts';
import { drawPreview } from '../../../src/cli/preview.ts';
import type { GraphDoc, Thumbnail } from '../../../src/core/runtime.ts';
import { constantNode, gainNode, MIB, rampNode, SETTINGS, startEngine, tintNode, until } from './rig.ts';

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
  await until(() => delivered.length - from >= count, `${count} thumbnails; ${delivered.length - from} were delivered`);
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

test('a height is shaded by its slope in metres, lit from the top left, with mid-tones on every slope', async () => {
  // heightRange / terrainSize is 1 / 4: a ramp with gain 4 rises at 45 degrees, one with 16 at 76 and one with 64 at 86.
  const doc = t.doc({
    level: { type: 'ref/constant', params: { value: 0.3 } },
    east: { type: 'ref/ramp', params: { gainX: 4, gainY: 0 } },
    west: { type: 'ref/ramp', params: { gainX: -4, gainY: 0 } },
    south: { type: 'ref/ramp', params: { gainX: 0, gainY: 4 } },
    cliff: { type: 'ref/ramp', params: { gainX: -16, gainY: 0 } },
    wall: { type: 'ref/ramp', params: { gainX: -64, gainY: -64 } },
  });
  const from = delivered.length;
  // At 128 every thumbnail texel reads a texel of its own; a coarser source repeats texels, which shades as steps.
  await evaluate(doc, ['level.out', 'east.out', 'west.out', 'south.out', 'cliff.out', 'wall.out'], 128);
  const { level, east, west, south, cliff, wall } = byNode(await thumbnails(from, 6));
  // 0.10 + 0.80 ((1 + n·L) / 2)^2 with L = normalize(-1, -1, sqrt 2), for a surface with the slope (sx, sy): 0.68 when level.
  const light = (sx: number, sy: number): number => {
    const wrapped = 0.5 + 0.5 * ((0.5 * sx + 0.5 * sy + Math.SQRT1_2) / Math.hypot(sx, sy, 1));
    return Math.round(255 * (0.10 + 0.80 * wrapped * wrapped));
  };
  assert.equal(light(0, 0), Math.round(255 * 0.6828), 'level ground');
  const shaded: readonly (readonly [string, Thumbnail, number, number])[] = [
    ['level', level!, 0, 0],
    // Rising towards +X: the normal leans towards -X, where the light is.
    ['east', east!, 1, 0], ['west', west!, -1, 0], ['south', south!, 0, 1], ['cliff', cliff!, -4, 0], ['wall', wall!, -16, -16],
  ];
  for (const [name, thumbnail, sx, sy] of shaded) {
    for (const [i, j] of [[0, 0], [64, 64], [127, 127], [127, 0]] as const) {
      near(pixel(thumbnail, i, j), [light(sx, sy), light(sx, sy), light(sx, sy), 255], `${name} at (${i}, ${j})`);
    }
  }
  const tone = (thumbnail: Thumbnail): number => pixel(thumbnail, 9, 9)[0]!;
  assert.ok(tone(east!) > tone(level!) && tone(level!) > tone(west!));
  // A slope above 45 degrees that faces away from the light is not black, and a steeper one is darker still:
  // max(n·L, 0) draws all three in one tone. Every tone lies within 0.10..0.90.
  assert.ok(tone(west!) > tone(cliff!) + 20 && tone(cliff!) > tone(wall!) + 10 && tone(wall!) >= 25, `${tone(west!)}, ${tone(cliff!)}, ${tone(wall!)}`);
  assert.ok(tone(east!) <= 230);

  // The shading of the test pictures (testing.md 2.7), from the same 128 x 128 samples.
  const heights = new Float32Array(128 * 128);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) heights[y * 128 + x] = (-4 * x) / 127;
  const picture = drawPreview({ kind: 'field', width: 128, height: 128, channels: 1, data: heights }, { style: 'hillshade', terrainSize: SETTINGS.terrainSize, heightRange: SETTINGS.heightRange });
  for (const [i, j] of [[0, 0], [64, 64], [127, 127]] as const) {
    const at = (j * 128 + i) * 3;
    near(pixel(west!, i, j), [picture.rgb[at]!, picture.rgb[at + 1]!, picture.rgb[at + 2]!, 255], `the thumbnail against the harness's hillshade at (${i}, ${j})`);
  }
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

test('a budget that shrinks below what the atlas fits in gives the atlas back, after what it stages is read back', async () => {
  const ATLAS = 16 * MIB;
  const own = await startEngine([constantNode, gainNode], { budgetBytes: 64 * MIB });
  try {
    const heard: string[] = [];
    own.engine.onThumbnail((x) => heard.push(x.nodeId));
    const graph = (value: number) => own.doc({ level: { type: 'ref/constant', params: { value } }, gain: { type: 'ref/gain', inputs: { in: 'level.out' } } });
    const delivered = (count: number): Promise<void> => until(() => heard.length >= count, `${count} thumbnails; ${heard.length} were delivered`);
    await own.run(graph(0.25), ['gain.out'], { thumbnails: true });
    await delivered(2);
    const withAtlas = own.engine.memory().reservedBytes;
    assert.ok(withAtlas >= ATLAS, 'the atlas is in the ledger');

    // A budget it still fits in changes nothing; neither does one that grows.
    own.engine.setBudget(withAtlas + 4 * MIB);
    own.engine.setBudget(96 * MIB);
    assert.equal(own.engine.memory().reservedBytes, withAtlas);

    // Thumbnails that are staged and not yet read back, and then a budget below what is reserved.
    const staged = own.evaluate(graph(0.5), ['gain.out'], { thumbnails: true });
    const result = await staged;
    for (const field of result.result.fields) field?.release();
    own.engine.setBudget(withAtlas - 1);
    assert.equal(own.engine.memory().reservedBytes <= withAtlas - ATLAS + ATLAS / 4, true, `the 16 MiB are given back at once: ${own.engine.memory().reservedBytes} of ${withAtlas} bytes are reserved`);
    await delivered(4);
    assert.deepEqual(heard, ['level', 'gain', 'level', 'gain'], 'what the atlas staged was read back before it went');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(own.engine.memory().reservedBytes <= withAtlas - ATLAS, 'the readback buffer is gone too');

    // Under that budget there are no thumbnails; with room again the atlas is made again.
    await own.run(graph(0.75), ['gain.out'], { thumbnails: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(heard.length, 4);
    own.engine.setBudget(64 * MIB);
    await own.run(graph(1), ['gain.out'], { thumbnails: true });
    await delivered(6);
    assert.equal(heard.length, 6);
    assert.ok(own.engine.memory().reservedBytes >= ATLAS);
    own.noLeaks();
  } finally {
    await own.dispose();
  }
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
