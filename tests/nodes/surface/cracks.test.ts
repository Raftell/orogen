// tests/nodes/surface/cracks.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  at, conformance, expectClose, expectIdentical, expectLadder, fieldOf, fixtures, renderLadder, renderNode, stats, traceNode, type FieldData,
} from '../../helpers/index.ts';
import def, { CRACKS } from '../../../src/core/nodes/surface/cracks.ts';
import { mapField, share } from './_probe.ts';

conformance(def, {
  resolutionTol: {
    value: 0.02,
    reason: 'A crack under 2 texels wide is drawn that wide and as much shallower, and those around plates under 6 texels across are shallower too: at the defaults the smallest plates are 4.8 texels across at 257 and their cracks 1.1 wide. 1.1 % from 257 to 513, none from 513 to 1025.',
  },
});

const N = 257;
/** How far the node lowers a terrain. */
const lowered = (out: FieldData, src: FieldData): FieldData => mapField(out, (v, x, y) => at(src, x, y) - v);

/** The sizes of the connected patches of the texels for which `inside` holds, largest first: a flood over 4 or 8 neighbours. */
function patches(f: FieldData, inside: (value: number) => boolean, neighbours: 4 | 8): number[] {
  const seen = new Uint8Array(f.data.length);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let start = 0; start < f.data.length; start++) {
    if (seen[start] || !inside(f.data[start]!)) continue;
    let size = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const index = stack.pop()!;
      size++;
      const x = index % f.width, y = (index - x) / f.width;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((dx === 0 && dy === 0) || (neighbours === 4 && dx !== 0 && dy !== 0)) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= f.width || ny >= f.height) continue;
          const next = ny * f.width + nx;
          if (!seen[next] && inside(f.data[next]!)) {
            seen[next] = 1;
            stack.push(next);
          }
        }
      }
    }
    sizes.push(size);
  }
  return sizes.sort((a, b) => b - a);
}

test('surface/cracks: the cracks are one connected net around plates of very different sizes', async () => {
  // Plates of 0.2 at 513: the main cracks are 10 texels wide, those of the smallest plates 3.7.
  const flat = fieldOf(513, () => 0.5);
  const { out } = await renderNode(def, { res: 513, inputs: { in: flat }, params: { size: 0.2, width: 0.02, depth: 0.05 } });
  const cut = lowered(out, flat);
  const net = patches(cut, (v) => v > 1e-6, 8);
  const cracked = net.reduce((sum, size) => sum + size, 0);
  // A plate that reaches beyond the border has cracks that join the net beyond it: they are left out of the count.
  assert.ok(net[0]! > 0.93 * cracked, `the largest connected piece holds ${net[0]} of ${cracked} cracked texels, in ${net.length} pieces`);
  assert.ok(cracked > 0.1 * 513 * 513 && cracked < 0.6 * 513 * 513, `${cracked} texels are cracked`);

  const plates = patches(cut, (v) => v <= 1e-6, 4).filter((size) => size >= 4);
  assert.ok(plates.length >= 40, `${plates.length} plates`);
  // A plate that does not break is 0.2 across, 100 texels; the smallest are 5.3 times smaller, 28 times in area.
  const large = plates[Math.floor(0.1 * plates.length)]!, small = plates[Math.floor(0.9 * plates.length)]!;
  assert.ok(large > 10 * small, `a large plate has ${large} texels and a small one ${small}`);
});

test('surface/cracks: a crack is as deep as the depth, never raises the ground, and is as wide as the width', async () => {
  const src = await fixtures.fbm(N);
  const { out } = await renderNode(def, { inputs: { in: src }, params: { size: 0.2, width: 0.03, depth: 0.05 } });
  const cut = stats(lowered(out, src));
  assert.ok(cut.min >= -1e-7, `the ground is raised by ${-cut.min}`);
  assert.ok(Math.abs(cut.max - 0.05) < 5e-4, `the deepest crack is ${cut.max} deep`);
  // Twice as wide: twice the ground is cracked, less where two cracks run into each other.
  const flat = fieldOf(N, () => 0.5);
  const area = async (width: number): Promise<number> => share(lowered((await renderNode(def, { inputs: { in: flat }, params: { size: 0.25, width } })).out, flat), (v) => v > 1e-6);
  const narrow = await area(0.02), wide = await area(0.04);
  assert.ok(wide / narrow > 1.6 && wide / narrow < 2.05, `${narrow} of the ground is cracked at a width of 0.02 and ${wide} at 0.04`);
  // Twice as deep is the same net, twice as deep.
  const shallow = lowered((await renderNode(def, { inputs: { in: flat }, params: { size: 0.25, width: 0.03, depth: 0.02 } })).out, flat);
  const deep = lowered((await renderNode(def, { inputs: { in: flat }, params: { size: 0.25, width: 0.03, depth: 0.04 } })).out, flat);
  expectClose(deep, mapField(shallow, (v) => 2 * v), { max: 2e-6 });
});

test('surface/cracks: the net is laid out on the terrain, not by it, and another seed is another net', async () => {
  const flat = fieldOf(N, () => 0.25);
  const params = { size: 0.15, width: 0.02 };
  const onFlat = lowered((await renderNode(def, { inputs: { in: flat }, params })).out, flat);
  const ramp = fixtures.rampX(N);
  const onRamp = lowered((await renderNode(def, { inputs: { in: ramp }, params })).out, ramp);
  expectClose(onRamp, onFlat, { max: 2e-6 });
  const other = lowered((await renderNode(def, { inputs: { in: flat }, params: { ...params, seed: 1 } })).out, flat);
  assert.ok(share(other, (v, x, y) => v > 1e-6 !== at(onFlat, x, y) > 1e-6) > 0.1, 'the cracks of another seed lie elsewhere');
});

test('surface/cracks: a crack narrower than the grid draws is as much shallower, and plates it cannot tell apart have none', async () => {
  const flat = fieldOf(N, () => 0.5);
  // A width of 0.001 is half of 0.128 texels to either side; it is drawn one texel to either side.
  const thin = lowered((await renderNode(def, { inputs: { in: flat }, params: { size: 0.2, width: 0.001, depth: 0.05 } })).out, flat);
  const most = stats(thin).max, expected = (0.05 * 0.0005 * (N - 1)) / CRACKS.texels;
  assert.ok(most <= expected * 1.001 && most > 0.5 * expected, `the deepest crack is ${most} deep; ${expected} is the depth it is drawn with`);
  // Plates of 0.008 are 2 texels across.
  const src = await fixtures.fbm(N);
  const none = await renderNode(def, { inputs: { in: src }, params: { size: 0.008 } });
  expectIdentical(none.out, src);
});

test('surface/cracks: no depth and no width give the input itself', async () => {
  const src = await fixtures.fbm(N);
  for (const params of [{ depth: 0 }, { width: 0 }, { depth: -0.1 }] as Record<string, number>[]) {
    const { outputs, report } = await traceNode(def, { inputs: { in: src }, params });
    expectIdentical(outputs.out!, src);
    assert.equal(report.nodes.node!.peakBytes, 0, 'an alias of the input: no texture, no pass');
  }
});

test('surface/cracks: the net is the same at two levels of the ladder wherever both can draw it', async () => {
  // Plates of 0.2 and cracks of 0.03: the narrowest crack is 1.4 texels to either side at 257.
  const levels = await renderLadder(def, { inputs: { in: 'terrain' }, params: { size: 0.2, width: 0.03 } });
  expectLadder(levels[257]!.out, levels[513]!.out, { max: 1e-6 });
});
