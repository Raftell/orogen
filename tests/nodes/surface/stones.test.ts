// tests/nodes/surface/stones.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  at, conformance, expectClose, expectIdentical, expectLadder, expectMask, fieldOf, fixtures, renderLadder, renderNode, stats, traceNode, type FieldData,
} from '../../helpers/index.ts';
import { hashCell, hashU32, hashUnit } from '../../../src/core/api.ts';
import { CELL_JITTER } from '../../../src/core/nodes/surface/_cells.ts';
import def, { STONES } from '../../../src/core/nodes/surface/stones.ts';
import { mapField, seedFor, share } from './_probe.ts';

conformance(def, {
  resolutionTol: {
    value: 0.08,
    reason: 'A stone with a radius under 0.75 texels is left out: the stones of the default size that are still growing or that dwindle on a slope are that small at 257, and are in the coverage of one level only. 5.1 % from 257 to 513, 1.9 % from 513 to 1025, 0.3 % with stones of 0.1; out 0.06 %.',
  },
});

const N = 257;
const L = N - 1;
const f = Math.fround;
const smoothstep = (lo: number, hi: number, x: number): number => {
  const t = Math.min(Math.max((x - lo) / (hi - lo), 0), 1);
  return t * t * (3 - 2 * t);
};

interface Stones { readonly size: number; readonly density: number; readonly height: number; readonly seed: number }
const BASE: Stones = { size: 0.05, density: 0.5, height: 0.035, seed: 0 };

/** The library's noise_value at a lattice cell over the patch size: value noise in 0..1, quintic between the hashes of four corners. */
function crowding(cx: number, cy: number, seed: number): number {
  const x = cx / STONES.patch, y = cy / STONES.patch;
  const ix = Math.floor(x), iy = Math.floor(y);
  const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
  const u = fade(x - ix), v = fade(y - iy);
  const corner = (i: number, j: number): number => hashUnit(hashCell(ix + i, iy + j, seed));
  const top = corner(0, 0) + (corner(1, 0) - corner(0, 0)) * u, bottom = corner(0, 1) + (corner(1, 1) - corner(0, 1)) * u;
  return top + (bottom - top) * v;
}

/** The kernel's body: the top of a stone above the place q, in radii: a ball with flat faces cut off it. */
function body(qx: number, qy: number, kind: number): number {
  let top = Math.sqrt(Math.max(1 - (qx * qx + qy * qy), 0));
  let h = kind;
  for (let i = 0; i < STONES.faces; i++) {
    h = hashU32(h);
    const turn = 2 * Math.PI * hashUnit(h), part = hashUnit(hashU32(h));
    h = hashU32(hashU32(h));
    const lean = i > 0 ? STONES.lean[1] + (STONES.lean[2] - STONES.lean[1]) * part : STONES.lean[0] * part;
    const [least, most] = i > 0 ? STONES.cut : STONES.top;
    const cut = least + (most - least) * hashUnit(h);
    top = Math.min(top, cut * Math.sqrt(1 + lean * lean) - lean * (Math.cos(turn) * qx + Math.sin(turn) * qy));
  }
  return top;
}

/**
 * The stones on the CPU, on ground that is level or evenly sloping and nowhere too steep for them: how far the
 * highest stone stands above the ground at every texel, and the coverage. A stone on such ground is laid on it
 * as it is: what it stands above it does not depend on the ground.
 */
function reference(res: number, stones: Stones, dwindled = 1): { lift: FieldData; coverage: FieldData } {
  const last = res - 1;
  const cells = f(1 / (stones.size * STONES.spacing)), largest = f(0.5 / STONES.spacing);
  const places = seedFor(0, stones.seed), kinds = seedFor(1, stones.seed), crowds = seedFor(2, stones.seed);
  const coverage = new Float32Array(res * res);
  const lift = fieldOf(res, (u, v) => {
    const px = f(u * cells), py = f(v * cells);
    let top = 0, cover = 0;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const cx = Math.floor(px) + i, cy = Math.floor(py) + j;
        const h = hashCell(cx, cy, kinds);
        const given = f(stones.density);
        const density = Math.min(Math.max(given + STONES.cluster * (2 * crowding(cx, cy, crowds) - 1) * 4 * given * (1 - given), 0), 1);
        const grown = smoothstep(0, STONES.grow, density - (1 - STONES.grow) * hashUnit(h));
        if (grown <= 0) continue;
        const h2 = hashU32(h), part = hashUnit(h2);
        const radius = largest * (STONES.smallest + (1 - STONES.smallest) * part * part);
        const hp = hashCell(cx, cy, places);
        const dx = px - (cx + 0.5 * (1 - CELL_JITTER) + CELL_JITTER * hashUnit(hp));
        const dy = py - (cy + 0.5 * (1 - CELL_JITTER) + CELL_JITTER * hashUnit(hashU32(hp)));
        if (dx * dx + dy * dy >= radius * radius * STONES.stretch) continue;
        const r = radius * grown * dwindled;
        const held = Math.min(Math.max(((r / cells) * last) / STONES.texels - 1, 0), 1);
        if (held <= 0) continue;
        const h3 = hashU32(h2), turn = 2 * Math.PI * hashUnit(h3), h4 = hashU32(h3);
        const drawn = Math.sqrt(1 + (STONES.stretch - 1) * hashUnit(h4));
        const qx = (dx * Math.cos(turn) + dy * Math.sin(turn)) / drawn / r, qy = ((dy * Math.cos(turn) - dx * Math.sin(turn)) * drawn) / r;
        const shape = body(qx, qy, h4);
        if (shape <= STONES.sunk) continue;
        const tall = (f(stones.height) * held * r) / largest;
        const stands = (tall * (shape - STONES.sunk)) / (1 - STONES.sunk);
        top = Math.max(top, stands);
        cover = Math.max(cover, Math.min(stands / (STONES.edge * tall), 1));
      }
    }
    coverage[Math.round(v * last) * res + Math.round(u * last)] = cover;
    return top;
  });
  return { lift, coverage: { ...lift, data: coverage } };
}

/** What the node adds to a terrain. */
const raised = (out: FieldData, src: FieldData): FieldData => mapField(out, (v, x, y) => v - at(src, x, y));

/** The separate patches of a mask, as the widths and heights of their boxes in texels. A flood over the 4 neighbours. */
function patches(mask: FieldData): { width: number; height: number }[] {
  const seen = new Uint8Array(mask.data.length);
  const found: { width: number; height: number }[] = [];
  const stack: number[] = [];
  for (let start = 0; start < mask.data.length; start++) {
    if (seen[start] || mask.data[start]! <= 0) continue;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const index = stack.pop()!;
      const x = index % mask.width, y = (index - x) / mask.width;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const) {
        if (nx < 0 || ny < 0 || nx >= mask.width || ny >= mask.height) continue;
        const next = ny * mask.width + nx;
        if (!seen[next] && mask.data[next]! > 0) {
          seen[next] = 1;
          stack.push(next);
        }
      }
    }
    found.push({ width: x1 - x0 + 1, height: y1 - y0 + 1 });
  }
  return found;
}

test('surface/stones: on level ground every stone is a flattened ball with flat faces cut off it, placed, sized and turned by the hashes of its cell', async () => {
  const ground = fieldOf(N, () => 0.3);
  for (const change of [{}, { density: 1, seed: 4 }, { size: 0.11, density: 0.8, height: 0.2, seed: 9 }, { size: 0.02, density: 0.3 }]) {
    const stones = { ...BASE, ...change };
    const { out, coverage } = await renderNode(def, { inputs: { in: ground }, params: { ...stones } });
    const expected = reference(N, stones);
    expectClose(raised(out, ground), expected.lift, { max: 2e-5 });
    // The coverage climbs to 1 over a tenth of a stone's height: ten times as steep as the stone.
    expectClose(coverage, expected.coverage, { max: 2e-3 });
    expectMask(coverage);
  }
});

test('surface/stones: a stone on a slope is the same stone, laid on the slope', async () => {
  // rampX climbs at 14 degrees with the test settings: gentle enough for every stone to stay whole.
  const ramp = fixtures.rampX(N);
  const { out, coverage } = await renderNode(def, { inputs: { in: ramp }, params: { ...BASE } });
  const expected = reference(N, BASE);
  expectClose(raised(out, ramp), expected.lift, { max: 3e-5 });
  expectClose(coverage, expected.coverage, { max: 3e-3 });
});

test('surface/stones: the stones are separate bodies with straight edges, of varied size up to the size across and no taller than the height', async () => {
  const ground = fieldOf(N, () => 0.5);
  const stones = { ...BASE, size: 0.06, density: 0.3 };
  const { out, coverage } = await renderNode(def, { inputs: { in: ground }, params: { ...stones } });
  const bodies = patches(coverage);
  // A cell of the lattice is 1.15 sizes: 14.5 by 14.5 of them cover the terrain, and about three in ten hold a
  // stone: more in one patch and fewer in the next.
  const cells = (1 / (stones.size * STONES.spacing)) ** 2;
  assert.ok(bodies.length > 0.2 * cells && bodies.length < 0.45 * cells, `${bodies.length} bodies on ${cells} cells`);
  // What shows of a whole ball is 0.95 of its width, and the longest is drawn out by sqrt(1.5). The smallest is
  // a third of the size and as much narrower, and a steep side face may take up to half of what shows. Two
  // stones that touch are one patch, and a stone that is still growing is smaller.
  const shown = Math.sqrt(1 - STONES.sunk ** 2);
  const widest = shown * Math.sqrt(STONES.stretch) * stones.size * L + 2, narrowest = (0.5 * shown * STONES.smallest * stones.size * L) / Math.sqrt(STONES.stretch) - 2;
  const single = bodies.filter((body) => Math.max(body.width, body.height) <= widest && Math.max(body.width, body.height) >= narrowest);
  assert.ok(single.length > 0.75 * bodies.length, `${single.length} of ${bodies.length} bodies are between ${narrowest} and ${widest} texels across`);
  const spans = single.map((body) => Math.max(body.width, body.height));
  assert.ok(Math.max(...spans) > 2.5 * Math.min(...spans), `the bodies are ${Math.min(...spans)} to ${Math.max(...spans)} texels across`);
  const lift = stats(raised(out, ground));
  assert.ok(lift.min >= 0 && lift.max <= stones.height + 1e-6 && lift.max > 0.6 * stones.height, `the stones stand up to ${lift.max} above the ground; the height is ${stones.height}`);

  // A ball has no flat on it. A stone has faces that are planes: where three texels in a row lie on one, the
  // middle one is the mean of the other two, along both axes. Large stones, so that a face is many texels wide.
  const large = await renderNode(def, { inputs: { in: ground }, params: { ...BASE, size: 0.25, density: 1, height: 0.2 } });
  let flat = 0, covered = 0;
  for (let y = 1; y < L; y++) {
    for (let x = 1; x < L; x++) {
      if (at(large.coverage, x, y) < 1) continue;
      covered++;
      const v = at(large.out, x, y);
      if (Math.abs(at(large.out, x - 1, y) + at(large.out, x + 1, y) - 2 * v) < 2e-6 && Math.abs(at(large.out, x, y - 1) + at(large.out, x, y + 1) - 2 * v) < 2e-6) flat++;
    }
  }
  assert.ok(covered > 5000 && flat > 0.5 * covered, `${flat} of ${covered} texels of stone lie on a flat face`);
});

test('surface/stones: the stones lie in patches: close together in one place and few in the next', async () => {
  const ground = fieldOf(513, () => 0.5);
  const stones = { ...BASE, size: 0.03, density: 0.5 };
  const { coverage } = await renderNode(def, { res: 513, inputs: { in: ground }, params: { ...stones } });
  // The terrain in 8 by 8 squares of 64 texels, each about 3.6 lattice cells across and so about one patch.
  const shares: number[] = [];
  for (let by = 0; by < 8; by++) {
    for (let bx = 0; bx < 8; bx++) {
      let count = 0;
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (at(coverage, bx * 64 + x, by * 64 + y) > 0) count++;
      shares.push(count / 4096);
    }
  }
  shares.sort((a, b) => a - b);
  const sparse = shares.slice(0, 16).reduce((a, b) => a + b) / 16, dense = shares.slice(48).reduce((a, b) => a + b) / 16;
  assert.ok(dense > 2.5 * sparse && sparse > 0, `the quarter of the squares with the fewest stones is covered to ${sparse} and that with the most to ${dense}`);
  // At a density of 1 every cell holds its stone, and there are no patches left.
  const full = await renderNode(def, { res: 513, inputs: { in: ground }, params: { ...stones, density: 1 } });
  const cells = (1 / (stones.size * STONES.spacing)) ** 2;
  const bodies = patches(full.coverage).length;
  assert.ok(bodies > 0.7 * cells && bodies <= 1.1 * cells, `${bodies} bodies on ${cells} cells at a density of 1`);
});

test('surface/stones: the density is the part of the ground that holds a stone, and none leaves the input', async () => {
  const src = fixtures.rampY(N);
  const covered: number[] = [];
  for (const density of [0.1, 0.3, 0.6, 1]) {
    const { coverage } = await renderNode(def, { inputs: { in: src }, params: { ...BASE, density } });
    covered.push(share(coverage, (v) => v > 0));
  }
  for (let k = 1; k < covered.length; k++) assert.ok(covered[k]! > 1.3 * covered[k - 1]!, `the stones cover ${covered.join(', ')} of the ground at densities 0.1, 0.3, 0.6 and 1`);
  for (const params of [{ density: 0 }, { height: 0 }] as Record<string, number>[]) {
    const { outputs, report } = await traceNode(def, { inputs: { in: src }, params });
    expectIdentical(outputs.out!, src);
    assert.equal(stats(outputs.coverage!).max, 0);
    assert.equal(report.nodes.node!.state, 'done');
  }
});

test('surface/stones: stones lie on ground no steeper than the upper slope, and dwindle towards it', async () => {
  // The cone: a flank of 45 degrees on a level floor.
  const cone = fixtures.cone(N);
  const { out, coverage } = await renderNode(def, { inputs: { in: cone }, params: { ...BASE, size: 0.03, slopeMax: 40 } });
  let flank = 0, floor = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const r = Math.hypot(x - 128, y - 128);
      if (r > 20 && r < 52) flank = Math.max(flank, at(coverage, x, y), Math.abs(at(out, x, y) - at(cone, x, y)));
      else if (r > 76) floor += at(coverage, x, y);
    }
  }
  assert.equal(flank, 0, 'no stone on the flank');
  assert.ok(floor > 300, `${floor} texels of the floor are stone`);

  // A ramp half way through the ten degrees below the upper slope: every stone is half as wide and half as tall.
  const ramp = fixtures.rampX(N);
  const steep = { heightRange: 4096 * Math.tan((35 * Math.PI) / 180) };
  const half = await renderNode(def, { inputs: { in: ramp }, params: { ...BASE, slopeMax: 40 }, settings: steep });
  const expected = reference(N, BASE, 0.5);
  expectClose(raised(half.out, ramp), expected.lift, { max: 2e-4 });
  assert.ok(stats(expected.lift).max < 0.51 * BASE.height);
  // And on one steeper than the upper slope there is none.
  const none = await renderNode(def, { inputs: { in: ramp }, params: { ...BASE, slopeMax: 30 }, settings: steep });
  expectIdentical(none.out, ramp);
});

test('surface/stones: stones too small for the grid are left out', async () => {
  const src = await fixtures.fbm(N);
  // The largest stone of 0.005 has a radius of 0.64 texels at 257.
  const { outputs, report } = await traceNode(def, { inputs: { in: src }, params: { size: 0.005 } });
  expectIdentical(outputs.out!, src);
  assert.equal(stats(outputs.coverage!).max, 0);
  assert.equal(report.nodes.node!.state, 'done');
});

test('surface/stones: the stones are the same at two levels of the ladder', async () => {
  // Stones of 0.1: the smallest has a radius of 3.8 texels at 257, and every one is whole at both levels.
  const levels = await renderLadder(def, { inputs: { in: 'terrain' }, params: { ...BASE, size: 0.1 } });
  expectLadder(levels[257]!.out, levels[513]!.out, { rel: 0.001 });
  expectLadder(levels[257]!.coverage, levels[513]!.coverage, { rel: 0.01 });
});
