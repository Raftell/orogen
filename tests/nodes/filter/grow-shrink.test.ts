// tests/nodes/filter/grow-shrink.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  at, conformance, expectClose, expectIdentical, expectLadder, fieldOf, fixtures, renderLadder, renderNode, traceNode, type FieldData,
} from '../../helpers/index.ts';
import def from '../../../src/core/nodes/filter/grow-shrink.ts';
import { bilinearAt, clamped, mapField } from './_reference.ts';

conformance(def);

const N = 257;
const render = async (src: FieldData | 'mask' | 'cone' | 'terrain', mode: string, radius: number): Promise<FieldData> =>
  (await renderNode(def, { inputs: { in: src }, params: { mode, radius } })).out;

/**
 * One pass of the node on the CPU: the highest point of the terrain's bilinear surface within `radius` texels,
 * found among the texels inside the disc and 32 points on its rim. `radius` is at most 3.
 */
function dilate(src: FieldData, radius: number): FieldData {
  // The surface beyond the border continues with the border texel, as a clamped read does.
  const surface = (x: number, y: number): number => {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const top = clamped(src, ix, iy) * (1 - fx) + clamped(src, ix + 1, iy) * fx;
    const bottom = clamped(src, ix, iy + 1) * (1 - fx) + clamped(src, ix + 1, iy + 1) * fx;
    return top * (1 - fy) + bottom * fy;
  };
  return mapField(src, (x, y) => {
    let best = at(src, x, y);
    for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) if (i * i + j * j <= radius * radius) best = Math.max(best, clamped(src, x + i, y + j));
    for (let k = 0; k < 32; k++) best = Math.max(best, surface(x + radius * Math.cos((Math.PI * k) / 16), y + radius * Math.sin((Math.PI * k) / 16)));
    return best;
  });
}
const upsideDown = (f: FieldData): FieldData => mapField(f, (x, y) => 1 - at(f, x, y));

test('filter/grow-shrink: grow gives each point the highest point within the radius, and shrink the lowest', async () => {
  // Radii of 1.28 and 2.56 texels at 257: one pass.
  const src = await fixtures.fbm(N);
  for (const radius of [0.005, 0.01]) {
    expectClose(await render(src, 'grow', radius), dilate(src, radius * 256), { max: 1e-6 });
    expectClose(await render(src, 'shrink', radius), upsideDown(dilate(upsideDown(src), radius * 256)), { max: 1e-6 });
  }
});

test('filter/grow-shrink: a cone grown by a radius is the cone moved outwards by it, all around', async () => {
  // The cone falls by 4 per unit length from 1 at the centre: 0.0156 a texel. 0.01 is the pass that is exact to a
  // fraction of a texel alone; 0.02 adds a disc of texels to it and 0.05 a ring. Those lie on texels and not on
  // a circle: the radius is met within half a texel in every direction.
  const d = (u: number, v: number): number => Math.hypot(u - 0.5, v - 0.5);
  for (const [radius, tolerance] of [[0.01, 4e-3], [0.02, 8e-3], [0.05, 8e-3]] as const) {
    const grown = await render('cone', 'grow', radius);
    expectClose(grown, fieldOf(N, (u, v) => Math.min(1, Math.max(0, 1 - 4 * (d(u, v) - radius)))), { max: tolerance });
    const shrunk = await render('cone', 'shrink', radius);
    expectClose(shrunk, fieldOf(N, (u, v) => Math.max(0, 1 - 4 * (d(u, v) + radius))), { max: tolerance });
  }
  // All around: at 0.3 from the centre, along the axes, the diagonals and between them, the grown cone is as high.
  const grown = await render('cone', 'grow', 0.05);
  const around = Array.from({ length: 32 }, (_, k) => bilinearAt(grown, 128 + 0.3 * 256 * Math.cos((Math.PI * k) / 16), 128 + 0.3 * 256 * Math.sin((Math.PI * k) / 16)));
  assert.ok(Math.max(...around) - Math.min(...around) < 0.012, `around the cone the height varies from ${Math.min(...around)} to ${Math.max(...around)}`);
});

test('filter/grow-shrink: a mask grows and shrinks by the radius, and a sharp edge stays sharp', async () => {
  // The mask fixture falls from 1 at 0.2 from the centre to 0 at 0.35: 0.026 a texel.
  const disc = (shift: number): FieldData => fieldOf(N, (u, v) => Math.min(1, Math.max(0, (0.35 + shift - Math.hypot(u - 0.5, v - 0.5)) / 0.15)));
  expectClose(await render('mask', 'grow', 0.04), disc(0.04), { max: 0.013 });
  expectClose(await render('mask', 'shrink', 0.04), disc(-0.04), { max: 0.013 });

  // A disc of 1 on 0, 25.6 texels in radius, grown by 12.8: a disc of 38.4. Its edge crosses two texels at most.
  const hard = fieldOf(N, (u, v) => (Math.hypot(u - 0.5, v - 0.5) <= 0.1 ? 1 : 0));
  const grown = await render(hard, 'grow', 0.05);
  let area = 0, between = 0;
  for (const v of grown.data) {
    area += v;
    if (v > 0.02 && v < 0.98) between++;
  }
  const ideal = Math.PI * 38.4 ** 2;
  assert.ok(Math.abs(area / ideal - 1) < 0.03, `the grown disc covers ${area} texels; a disc of 38.4 texels covers ${ideal}`);
  assert.ok(between < 2 * 2 * Math.PI * 38.4, `${between} texels lie between 0 and 1: more than two along the edge`);
});

test('filter/grow-shrink: grow never lowers a point and shrink never raises one; open and close lie between', async () => {
  const src = await fixtures.fbm(N);
  let step = 0;
  for (let y = 0; y < N; y++) for (let x = 1; x < N; x++) step = Math.max(step, Math.abs(at(src, x, y) - at(src, x - 1, y)));
  for (const radius of [0.005, 0.02, 0.05]) {
    const [grown, shrunk, opened, closed] = [await render(src, 'grow', radius), await render(src, 'shrink', radius), await render(src, 'open', radius), await render(src, 'close', radius)];
    let exact = 0, over = 0;
    for (let i = 0; i < N * N; i++) {
      const v = src.data[i]!;
      if (grown.data[i]! < v || shrunk.data[i]! > v) exact++;
      if (opened.data[i]! < shrunk.data[i]! - 1e-6 || closed.data[i]! > grown.data[i]! + 1e-6) exact++;
      over = Math.max(over, opened.data[i]! - v, v - closed.data[i]!);
    }
    assert.equal(exact, 0, `radius ${radius}: texels out of order`);
    // The fraction of a texel in the radius is read between texels: by a part of the step between two of them
    // an opening can lie above the terrain. The largest step of this one is 0.05.
    assert.ok(over < 0.3 * step, `radius ${radius}: open rises ${over} above the terrain, whose largest step between two texels is ${step}`);
  }
  // Shrink is grow of the terrain turned upside down.
  expectClose(await render(src, 'shrink', 0.02), upsideDown(await render(upsideDown(src), 'grow', 0.02)), { max: 1e-6 });
});

test('filter/grow-shrink: open removes a peak narrower than the radius and close fills such a pit; what is broader keeps its shape', async () => {
  // A plateau 80 texels across with a pit 6 across in it, and beside it a peak 6 across. The radius is 7.68 texels.
  const shapes = fieldOf(N, (u, v) => {
    const plateau = Math.abs(u - 0.35) < 40 / 256 && Math.abs(v - 0.5) < 40 / 256 ? 0.6 : 0;
    const pit = Math.hypot(u - 0.35, v - 0.5) < 3 / 256 ? -0.4 : 0;
    const peak = Math.hypot(u - 0.8, v - 0.5) < 3 / 256 ? 0.9 : 0;
    return 0.2 + plateau + pit + peak;
  });
  const without = (what: 'pit' | 'peak'): FieldData => mapField(shapes, (x, y) => {
    const near = Math.hypot(x - (what === 'pit' ? 0.35 : 0.8) * 256, y - 128) < 3;
    return near ? (what === 'pit' ? 0.8 : 0.2) : at(shapes, x, y);
  });
  /** Whether a cliff of `f` passes within `reach` texels of (x, y). */
  const nearCliff = (f: FieldData, x: number, y: number, reach: number): boolean => {
    for (let j = -reach; j <= reach; j++) for (let i = -reach; i <= reach; i++) if (clamped(f, x + i, y + j) !== at(f, x, y)) return true;
    return false;
  };
  for (const [mode, gone, kept] of [['open', 'peak', 'pit'], ['close', 'pit', 'peak']] as const) {
    const out = await render(shapes, mode, 0.03);
    const expected = without(gone);
    // What is narrower than the radius is gone without a trace; what is broader is as high or as deep as it was.
    assert.ok(Math.abs(at(out, gone === 'peak' ? 205 : 90, 128) - at(expected, gone === 'peak' ? 205 : 90, 128)) < 1e-6, `${mode}: the ${gone} is still there`);
    assert.ok(Math.abs(at(out, kept === 'peak' ? 205 : 90, 128) - at(shapes, kept === 'peak' ? 205 : 90, 128)) < 1e-6, `${mode}: the ${kept} has changed`);
    // The radius has a fraction of a texel, so a cliff comes back a texel softer on either side; and the square
    // corners of the plateau, which a disc cannot reach into, come back round. Nothing else changes.
    let far = 0, changed = 0;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if (Math.abs(at(out, x, y) - at(expected, x, y)) <= 1e-6) continue;
        changed++;
        if (!nearCliff(expected, x, y, 4)) far++;
      }
    }
    assert.equal(far, 0, `${mode}: texels changed that lie more than 4 texels from every cliff`);
    assert.ok(changed > 0 && changed < 1200, `${mode}: ${changed} texels changed`);
  }
});

test('filter/grow-shrink: within a quarter of a texel the output is the input itself, and a flat terrain stays flat', async () => {
  // The smallest radius, 0.128 texels at 257.
  const src = await fixtures.fbm(N);
  const { outputs, report } = await traceNode(def, { inputs: { in: src }, params: { radius: 0.0005 } });
  expectIdentical(outputs.out, src);
  assert.equal(report.nodes.node.peakBytes, 0, 'an alias of the input: no texture, no pass');
  const flat = fieldOf(N, () => 0.3);
  for (const mode of ['grow', 'shrink', 'open', 'close']) expectIdentical(await render(flat, mode, 0.05), flat);
});

test('filter/grow-shrink: the result is the same at two levels of the ladder, in one pass and in several', async () => {
  for (const [mode, radius] of [['grow', 0.01], ['shrink', 0.03], ['open', 0.02], ['close', 0.05]] as const) {
    const levels = await renderLadder(def, { inputs: { in: 'terrain' }, params: { mode, radius } });
    expectLadder(levels[257].out, levels[513].out, { rel: 0.01 });
  }
});
