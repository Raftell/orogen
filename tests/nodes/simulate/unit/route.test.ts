// tests/nodes/simulate/unit/route.test.ts
// The router task of simulation.md 6.2, run in this thread on grids of up to 129 x 129 texels: its surface
// against the algorithm as the document states it, and the invariants of 6.5 that need no GPU.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashCell, hashUnit } from '../../../../src/core/api.ts';
import { ROUTE_EPS_FLOOR, ROUTE_FLAT_DROPS, route, routeEps, type RouteArgs } from '../../../../src/core/nodes/simulate/_route.ts';
import { adjacent, neighbour, receiverOf, referenceRoute, unequal, type RouteInput } from '../_route-reference.ts';

const TAU = 2 * Math.PI;
const SEA = 0.25;
/** ROUTE_EPS with the height range of the test settings. */
const EPS = routeEps(1024);

function grid(res: number, fn: (u: number, v: number) => number): Float32Array {
  const data = new Float32Array(res * res);
  for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) data[y * res + x] = fn(x / (res - 1), y / (res - 1));
  return data;
}

// The fixtures of testing.md 2.2 that simulation.md section 14 names, by their formulas, and three grids no
// formula smooths: noise with a pit on every few texels, level ground, and steps of exactly eps.
const terrains: Readonly<Record<string, (res: number) => Float32Array>> = {
  terrain: (res) => grid(res, (u, v) => 0.5 + 0.22 * Math.sin(TAU * (u + 0.5 * v) + 0.3) + 0.10 * Math.sin(TAU * (-2 * u + 3 * v) + 1.7)
    + 0.05 * Math.sin(TAU * (5 * u + 4 * v) + 4.1) + 0.025 * Math.sin(TAU * (9 * u - 7 * v) + 2.9)),
  basin: (res) => grid(res, (u, v) => 0.3 + 0.4 * u - 0.35 * Math.exp(-((u - 0.5) ** 2 + (v - 0.5) ** 2) / 0.0288)),
  bowl: (res) => grid(res, (u, v) => 0.3 + 0.6 * (2 * Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5))) ** 2),
  notch: (res) => grid(res, (u, v) => 0.75 - 0.5 * u - 0.05 * Math.max(0, 1 - Math.abs(v - 0.5) / 0.1)),
  cone: (res) => grid(res, (u, v) => Math.max(0, 1 - 4 * Math.hypot(u - 0.5, v - 0.5))),
  noise: (res) => grid(res, (u, v) => 0.3 + 0.5 * hashUnit(hashCell(Math.round(u * (res - 1)), Math.round(v * (res - 1)), 3))),
  level: (res) => grid(res, () => 0.5),
  steps: (res) => grid(res, (u, v) => 0.4 + Math.fround(EPS) * Math.round((u + v) * (res - 1))),
};

const run = (args: Omit<RouteArgs, 'height'> & { height: Float32Array }) => route.run({ ...args, height: args.height.slice() }, { progress() {} });

test('simulate/route: the surface is that of Priority-Flood with epsilon, bit for bit, on every kind of ground', () => {
  for (const [name, make] of Object.entries(terrains)) {
    for (const res of [33, 65]) {
      for (const eps of [0, EPS, 1e-4, 3e-3]) {
        const input: RouteInput = { height: make(res), res, eps, seaLevel: SEA, routing: 'none', seed: 0 };
        const expected = referenceRoute(input).filled;
        const { filled, area } = run(input);
        const off = unequal(filled, expected);
        assert.equal(off.count, 0, `${name} at ${res}, eps ${eps}: ${off.count} texels differ, the first at ${off.first}: ${filled[off.first]} against ${expected[off.first]}`);
        assert.equal(area, undefined, 'routing none gives no area');
      }
    }
  }
});

test('simulate/route: the surface is nowhere below the terrain and is the terrain at every outlet (6.5 item 1)', () => {
  for (const [name, make] of Object.entries(terrains)) {
    const height = make(129);
    for (const eps of [0, EPS]) {
      const { filled } = run({ height, res: 129, eps, seaLevel: SEA, routing: 'none', seed: 0 });
      const { outlet } = referenceRoute({ height, res: 129, eps, seaLevel: SEA, routing: 'none', seed: 0 });
      let below = 0, moved = 0;
      for (let i = 0; i < height.length; i++) {
        if (filled[i]! < height[i]!) below++;
        if (outlet[i] && filled[i] !== height[i]) moved++;
      }
      assert.equal(below, 0, `${name}, eps ${eps}: texels of the surface below the terrain`);
      assert.equal(moved, 0, `${name}, eps ${eps}: outlets whose height changed`);
    }
  }
});

test('simulate/route: with eps above 0 every texel that is no outlet has a neighbour lower by eps, and is the fixed point of the sweep (6.5 items 2 and 3)', () => {
  for (const [name, make] of Object.entries(terrains)) {
    const res = 129, height = make(res), eps = Math.fround(EPS);
    const { filled } = run({ height, res, eps: EPS, seaLevel: SEA, routing: 'none', seed: 0 });
    const { outlet } = referenceRoute({ height, res, eps: EPS, seaLevel: SEA, routing: 'none', seed: 0 });
    let stuck = 0, unsettled = 0;
    for (let i = 0; i < height.length; i++) {
      if (outlet[i]) continue;
      let lowest = Infinity;
      for (let k = 0; k < 4; k++) lowest = Math.min(lowest, filled[neighbour(i, k, res)]!);
      // The float32 operations of simulate/route.sweep with lift 0: (lowest + 0) + eps.
      const swept = Math.max(height[i]!, Math.fround(lowest + eps));
      if (filled[i] !== swept) unsettled++;
      if (!(filled[i]! >= Math.fround(lowest + eps))) stuck++;
    }
    assert.equal(stuck, 0, `${name}: texels without a neighbour lower by eps`);
    assert.equal(unsettled, 0, `${name}: texels a sweep would change`);
  }
});

test('simulate/route: with eps 0 a lake is level (6.5 item 6)', () => {
  for (const name of ['terrain', 'basin', 'bowl', 'noise']) {
    const res = 129, height = terrains[name]!(res);
    // Without a sea: the floor of the basin fixture lies below the test sea level and would be an outlet.
    const { filled } = run({ height, res, eps: 0, seaLevel: 0, routing: 'none', seed: 0 });
    let lake = 0, tilted = 0;
    for (let i = 0; i < height.length; i++) {
      if (!(filled[i]! > height[i]!)) continue;
      lake++;
      for (let k = 0; k < 2; k++) {
        const q = neighbour(i, k, res);
        if (q >= 0 && filled[q]! > height[q]! && filled[q] !== filled[i]) tilted++;
      }
    }
    assert.ok(lake > 0, `${name} has a depression`);
    assert.equal(tilted, 0, `${name}: neighbouring lake texels at different levels`);
  }
  // The bowl's border ring is its highest part: the whole of it fills to the lowest texel of the ring.
  const bowl = run({ height: terrains.bowl!(65), res: 65, eps: 0, seaLevel: 0, routing: 'none', seed: 0 }).filled;
  let lowestOnRing = Infinity;
  for (let x = 0; x < 65; x++) lowestOnRing = Math.min(lowestOnRing, terrains.bowl!(65)[x]!);
  assert.equal(bowl[32 * 65 + 32], lowestOnRing);
});

test('simulate/route: the area is that of the document\'s accumulation, is above 0, never falls along a receiver and reaches the outlets whole (6.5 item 5)', () => {
  for (const [name, make] of Object.entries(terrains)) {
    for (const res of [33, 129]) {
      const input: RouteInput = { height: make(res), res, eps: EPS, seaLevel: SEA, routing: 'single', seed: 77 };
      const expected = referenceRoute(input);
      const { filled, area } = run(input);
      assert.ok(area, 'routing single gives an area');
      assert.equal(unequal(filled, expected.filled).count, 0, `${name} at ${res}: the surface`);
      let apart = 0, none = 0, falling = 0, sum = 0, without = 0;
      for (let i = 0; i < area.length; i++) {
        if (!adjacent(area[i]!, expected.area![i]!)) apart++;
        if (!(area[i]! > 0)) none++;
        if (expected.outlet[i]) { sum += area[i]!; continue; }
        const k = expected.receiver[i]!;
        if (k === 4) without++;
        else if (area[neighbour(i, k, res)]! < area[i]!) falling++;
      }
      assert.equal(apart, 0, `${name} at ${res}: areas more than a float32 step from the reference`);
      assert.equal(none, 0, `${name} at ${res}: texels without area`);
      assert.equal(without, 0, `${name} at ${res}: texels that are no outlet and have no receiver`);
      assert.equal(falling, 0, `${name} at ${res}: receivers with less area than their donor`);
      assert.ok(Math.abs(sum - 1) < 1e-4, `${name} at ${res}: the outlets hold ${sum} of the terrain`);
    }
  }
});

test('simulate/route: the receiver is drawn by the texel\'s hash, in proportion to the fall', () => {
  // A plane that falls three times as fast towards -x as towards -y: about three quarters of its texels drain
  // towards -x, and another seed draws other texels.
  const res = 129, height = grid(res, (u, v) => 0.3 + 0.3 * u + 0.1 * v);
  const { filled } = run({ height, res, eps: EPS, seaLevel: 0, routing: 'none', seed: 0 });
  let west = 0, north = 0, changed = 0;
  for (let y = 1; y < res - 1; y++) {
    for (let x = 1; x < res - 1; x++) {
      const k = receiverOf(filled, x, y, res, 5);
      if (k === 2) west++;
      if (k === 3) north++;
      if (receiverOf(filled, x, y, res, 6) !== k) changed++;
    }
  }
  const inner = (res - 2) ** 2;
  assert.equal(west + north, inner, 'every texel drains towards -x or -y');
  assert.ok(Math.abs(west / inner - 0.75) < 0.02, `${west / inner} of the texels drain towards -x`);
  assert.ok(changed > 0.2 * inner, `${changed} receivers change with the seed`);
  // The task draws the same receivers, so its areas are the reference's.
  const a = run({ height, res, eps: EPS, seaLevel: 0, routing: 'single', seed: 5 }).area!;
  const b = referenceRoute({ height, res, eps: EPS, seaLevel: 0, routing: 'single', seed: 5 }).area!;
  const c = run({ height, res, eps: EPS, seaLevel: 0, routing: 'single', seed: 6 }).area!;
  let apart = 0;
  for (let i = 0; i < a.length; i++) if (!adjacent(a[i]!, b[i]!)) apart++;
  assert.equal(apart, 0);
  assert.ok(unequal(a, c).count > 0.2 * inner, 'another seed gives another network');
});

test('simulate/route: the receivers it returns are the document\'s, on slopes and on flats, and only when asked for', () => {
  for (const [name, make] of Object.entries(terrains)) {
    const res = 65;
    const input: RouteInput = { height: make(res), res, eps: EPS, seaLevel: SEA, routing: 'single', seed: 21 };
    const expected = referenceRoute(input);
    const { receivers } = run({ ...input, receivers: true });
    assert.ok(receivers, 'receivers are returned when asked for');
    let other = 0, flats = 0;
    for (let i = 0; i < res * res; i++) {
      if (receivers[i] !== expected.receiver[i]) other++;
      if (expected.flat[i]) flats++;
    }
    assert.equal(other, 0, `${name}: receivers that are not the reference's (${flats} texels lie on flats)`);
  }
  const height = terrains.terrain!(33);
  assert.equal(run({ height, res: 33, eps: EPS, seaLevel: SEA, routing: 'single', seed: 0 }).receivers, undefined);
  assert.equal(run({ height, res: 33, eps: EPS, seaLevel: SEA, routing: 'multiple', seed: 0, receivers: true }).receivers, undefined);
  assert.equal(run({ height, res: 33, eps: EPS, seaLevel: SEA, routing: 'none', seed: 0, receivers: true }).receivers, undefined);
});

test('simulate/route: every texel that is no outlet drains to a neighbour, downhill off the flats and within their tilt on them, and reaches an outlet', () => {
  const limit = Math.fround(ROUTE_FLAT_DROPS * Math.fround(EPS));
  for (const [name, make] of Object.entries(terrains)) {
    for (const sea of [SEA, -1]) {
      const res = 65, height = make(res);
      const input: RouteInput = { height, res, eps: EPS, seaLevel: sea, routing: 'single', seed: 3 };
      const expected = referenceRoute(input);
      const { filled, receivers } = run({ ...input, receivers: true });
      let without = 0, uphill = 0, steep = 0, lost = 0, onOutlets = 0;
      for (let i = 0; i < res * res; i++) {
        const k = receivers![i]!;
        if (expected.outlet[i]) { if (k !== 4) onOutlets++; continue; }
        if (k > 3) { without++; continue; }
        const to = neighbour(i, k, res);
        // Off a flat water never flows uphill; on one the receiver lies within the tilt the flood gave the flat.
        if (!expected.flat[i] && !(filled[to]! < filled[i]!)) uphill++;
        if (expected.flat[i] && filled[to]! - filled[i]! > limit) steep++;
        // Down the receivers every texel comes to an outlet: there is no ring.
        let at = i, steps = 0;
        while (receivers![at] !== 4 && steps <= res * res) { at = neighbour(at, receivers![at]!, res); steps++; }
        if (!expected.outlet[at]) lost++;
      }
      assert.equal(onOutlets, 0, `${name}, sea ${sea}: outlets with a receiver`);
      assert.equal(without, 0, `${name}, sea ${sea}: texels that are no outlet and have no receiver`);
      assert.equal(uphill, 0, `${name}, sea ${sea}: texels off the flats whose receiver is not lower`);
      assert.equal(steep, 0, `${name}, sea ${sea}: flat texels whose receiver lies higher than the tilt of a flat`);
      assert.equal(lost, 0, `${name}, sea ${sea}: texels whose water reaches no outlet`);
    }
  }
});

test('simulate/route: level ground drains through its lowest exit, and its water gathers along the middle', () => {
  // A level valley floor between two walls, askew to the grid, that ends at the border in the corner (1, 1) and
  // is closed by a wall towards (0, 0). Its falls are those of the eps the flood tilts it by: drawn from them, a
  // river would run along a row and a column and hug a wall.
  const res = 129, last = res - 1;
  const half = 0.09;
  const height = grid(res, (u, v) => {
    const off = Math.abs(v - u), wall = Math.max(off - half, 0), closed = Math.max(0.25 - 0.5 * (u + v), 0);
    return 0.3 + 2 * wall + 2 * closed;
  });
  const input: RouteInput = { height, res, eps: EPS, seaLevel: 0, routing: 'single', seed: 5 };
  const expected = referenceRoute(input);
  const { area, receivers } = run({ ...input, receivers: true });
  let flats = 0, without = 0;
  for (let i = 0; i < res * res; i++) {
    if (!expected.flat[i]) continue;
    flats++;
    if (receivers![i] === 4) without++;
  }
  assert.ok(flats > 1500, `${flats} texels of the floor lie on the flat`);
  assert.equal(without, 0, 'flat texels without a receiver');
  // Across the floor, along the lines u + v = const: where the most water passes, as a part of the floor's half width.
  let offCentre = 0, sections = 0, alongAxis = 0, steps = 0;
  for (let sum = Math.round(0.9 * last); sum <= Math.round(1.6 * last); sum += 4) {
    let most = 0, where = 0;
    for (let x = Math.max(sum - last, 0); x <= Math.min(sum, last); x++) {
      const y = sum - x;
      if (Math.abs(y - x) / last >= half) continue;
      if (area![y * res + x]! > most) { most = area![y * res + x]!; where = (y - x) / last / half; }
    }
    sections++;
    if (Math.abs(where) > 0.5) offCentre++;
  }
  assert.ok(offCentre <= 0.1 * sections, `in ${offCentre} of ${sections} sections of the floor the river lies in its outer half`);
  // The river's own steps on the floor: neither all along one axis nor in long runs along a row or a column.
  let at = Math.round(0.45 * last) * res + Math.round(0.45 * last), run4 = 0, longest = 0, before = -1;
  for (; receivers![at] !== 4 && steps < 4 * res; steps++) {
    const k = receivers![at]!;
    if (k === 0 || k === 2) alongAxis++;
    run4 = k === before ? run4 + 1 : 1;
    longest = Math.max(longest, run4);
    before = k;
    at = neighbour(at, k, res);
  }
  assert.ok(steps > 100 && steps < 4 * res, `the way from the middle of the floor to the border has ${steps} steps`);
  assert.ok(alongAxis > 0.3 * steps && alongAxis < 0.7 * steps, `${alongAxis} of ${steps} steps go along x`);
  assert.ok(longest <= 12, `the longest run along one row or column has ${longest} steps`);
});

test('simulate/route: with routing multiple every lower neighbour receives its share, and the outlets hold the whole terrain', () => {
  for (const name of ['terrain', 'cone', 'noise', 'bowl']) {
    const res = 65;
    const input: RouteInput = { height: terrains[name]!(res), res, eps: EPS, seaLevel: SEA, routing: 'multiple', seed: 1 };
    const expected = referenceRoute(input);
    const { area } = run(input);
    assert.ok(area);
    let sum = 0, off = 0, small = 0;
    for (let i = 0; i < area.length; i++) {
      // Shares are summed in another order than the reference sums them: a few float32 steps.
      if (Math.abs(area[i]! - expected.area![i]!) > 1e-6 * Math.max(area[i]!, 1e-9)) off++;
      if (area[i]! < Math.fround(1 / (res * res)) * (1 - 1e-6)) small++;
      if (expected.outlet[i]) sum += area[i]!;
    }
    assert.equal(off, 0, `${name}: areas that differ from the reference`);
    assert.equal(small, 0, `${name}: texels with less than their own area`);
    assert.ok(Math.abs(sum - 1) < 1e-4, `${name}: the outlets hold ${sum}`);
  }
  // On a cone the flow spreads: no texel below the summit gathers what a single receiver would.
  const cone = terrains.cone!(65);
  const single = run({ height: cone, res: 65, eps: EPS, seaLevel: -1, routing: 'single', seed: 1 }).area!;
  const multiple = run({ height: cone, res: 65, eps: EPS, seaLevel: -1, routing: 'multiple', seed: 1 }).area!;
  let most = [0, 0];
  for (let y = 20; y < 45; y++) for (let x = 20; x < 45; x++) most = [Math.max(most[0]!, single[y * 65 + x]!), Math.max(most[1]!, multiple[y * 65 + x]!)];
  assert.ok(most[1]! < 0.5 * most[0]!, `the largest area on the flank is ${most[1]} with multiple receivers and ${most[0]} with one`);
});

test('simulate/route: a weight is what a texel contributes; one below 0 contributes nothing', () => {
  const res = 65, height = terrains.terrain!(res);
  const base: RouteInput = { height, res, eps: EPS, seaLevel: SEA, routing: 'single', seed: 4 };
  const plain = run(base).area!;
  const ones = run({ ...base, weight: new Float32Array(res * res).fill(1) }).area!;
  assert.equal(unequal(plain, ones).count, 0, 'a weight of 1 everywhere is no weight');
  const halves = run({ ...base, weight: new Float32Array(res * res).fill(0.5) }).area!;
  let off = 0;
  for (let i = 0; i < plain.length; i++) if (Math.abs(halves[i]! - 0.5 * plain[i]!) > 1e-6 * plain[i]!) off++;
  assert.equal(off, 0, 'half the weight is half the area');
  // Rain on the left half only.
  const weight = grid(res, (u) => (u < 0.5 ? 1 : -3));
  const routed = referenceRoute({ ...base, weight });
  const left = run({ ...base, weight }).area!;
  let sum = 0, negative = 0, falling = 0;
  for (let i = 0; i < left.length; i++) {
    if (left[i]! < 0) negative++;
    if (routed.outlet[i]) sum += left[i]!;
    else if (left[neighbour(i, routed.receiver[i]!, res)]! < left[i]!) falling++;
  }
  let expected = 0;
  for (let i = 0; i < weight.length; i++) expected += Math.max(weight[i]!, 0) / (res * res);
  assert.equal(negative, 0);
  assert.equal(falling, 0, 'the weighted area never falls along a receiver');
  assert.ok(Math.abs(sum - expected) < 1e-4, `the outlets hold ${sum}; the weights sum to ${expected}`);
});

test('simulate/route: texels at or below the sea level are outlets, and the sea level is compared as the float32 a kernel receives', () => {
  const res = 33;
  // A pit in a plain: dry it is filled to its rim; with the sea above its floor the floor is an outlet and stays.
  const height = grid(res, (u, v) => 0.5 - 0.3 * Math.exp(-((u - 0.5) ** 2 + (v - 0.5) ** 2) / 0.01));
  const centre = 16 * res + 16;
  const dry = run({ height, res, eps: 0, seaLevel: 0, routing: 'none', seed: 0 }).filled;
  assert.ok(dry[centre]! > 0.49, `without a sea the pit is filled to ${dry[centre]}`);
  const wet = run({ height, res, eps: 0, seaLevel: 0.3, routing: 'none', seed: 0 }).filled;
  assert.equal(wet[centre], height[centre]);
  // 0.3 is no float32: a texel at Math.fround(0.3), which is above 0.3, is at the sea level of a kernel.
  const edge = height.slice();
  edge[centre] = Math.fround(0.3);
  edge[centre + 1] = 0.31;
  const atSea = run({ height: edge, res, eps: 0, seaLevel: 0.3, routing: 'none', seed: 0 }).filled;
  assert.equal(atSea[centre], Math.fround(0.3));
  assert.equal(atSea[centre + 1], Math.fround(0.31), 'its neighbour drains into it and is not raised');
});

test('simulate/route: with the connected sea, ground below the sea level that the border does not reach fills and drains like any hollow', () => {
  // The basin fixture: a slope from 0.3 to 0.7 with a hollow down to -0.05 at its middle, far from the border.
  // A sea level of 0.31 covers the hollow and a strip along the low border; the two do not touch.
  const res = 65, sea = 0.31, height = terrains.basin!(res);
  const all = run({ height, res, eps: EPS, seaLevel: sea, routing: 'single', seed: 1, receivers: true });
  const connected = run({ height, res, eps: EPS, seaLevel: sea, routing: 'single', seed: 1, receivers: true, sea: 'connected' });
  const centre = 32 * res + 32;
  assert.ok(height[centre]! <= sea, `the middle of the hollow lies at ${height[centre]}`);
  assert.equal(all.receivers![centre], 4, 'with every texel below the sea level an outlet, the hollow is one');
  assert.equal(all.filled[centre], height[centre]);
  assert.notEqual(connected.receivers![centre], 4, 'with the connected sea the hollow drains');
  assert.ok(connected.filled[centre]! > Math.fround(sea), `it fills to ${connected.filled[centre]}, above the sea level`);
  let inland = 0, lower = 0, strip = 0, sum = 0;
  for (let y = 1; y < res - 1; y++) {
    for (let x = 1; x < res - 1; x++) {
      const i = y * res + x;
      if (connected.receivers![i] === 4) {
        // An outlet off the border ring: sea the border reaches, which lies on the low side of the slope.
        strip++;
        if (!(height[i]! <= Math.fround(sea)) || x > 8) inland++;
        continue;
      }
      // Every other texel has a lower neighbour on the surface, by eps within a float32 step, or lies on a flat.
      const lowest = Math.min(connected.filled[i + 1]!, connected.filled[i + res]!, connected.filled[i - 1]!, connected.filled[i - res]!);
      if (!(lowest < connected.filled[i]!)) lower++;
    }
  }
  for (let i = 0; i < res * res; i++) if (connected.receivers![i] === 4) sum += connected.area![i]!;
  assert.ok(strip > 0, 'the sea reaches in from the low border');
  assert.equal(inland, 0, 'outlets off the border that the sea does not reach');
  assert.equal(lower, 0, 'texels that are no outlets and have no lower neighbour');
  assert.ok(Math.abs(sum - 1) < 1e-4, `the outlets drain ${sum} of the terrain`);
});

test('simulate/route: equal arguments give bit-identical results (1.7 item 5)', () => {
  const res = 129, height = terrains.noise!(res);
  for (const routing of ['single', 'multiple'] as const) {
    const a = run({ height, res, eps: EPS, seaLevel: SEA, routing, seed: 9 });
    const b = run({ height, res, eps: EPS, seaLevel: SEA, routing, seed: 9 });
    assert.equal(unequal(a.filled, b.filled).count, 0);
    assert.equal(unequal(a.area!, b.area!).count, 0);
  }
});

test('simulate/route: the height array is consumed and becomes the surface; progress never goes back', () => {
  const res = 65, height = terrains.terrain!(res);
  const reports: number[] = [];
  const result = route.run({ height, res, eps: EPS, seaLevel: SEA, routing: 'single', seed: 0 }, { progress: (f) => reports.push(f) });
  assert.equal(result.filled, height);
  assert.equal(result.area!.length, res * res);
  assert.equal(result.area!.buffer.byteLength, 4 * res * res, 'the area travels back as its own buffer of float32');
  assert.equal(reports.at(-1), 1);
  assert.ok(reports.every((f, i) => i === 0 || f >= reports[i - 1]!), 'progress is non-decreasing');
});

test('simulate/route: sizes that do not match and an eps below 0 are refused', () => {
  const height = new Float32Array(9);
  assert.throws(() => route.run({ height, res: 4, eps: 0, seaLevel: 0, routing: 'none', seed: 0 }, { progress() {} }), /height holds 9 values, not 4 x 4/);
  assert.throws(() => route.run({ height, res: 3, eps: -1, seaLevel: 0, routing: 'none', seed: 0 }, { progress() {} }), /eps is -1/);
  assert.throws(() => route.run({ height, res: 3, eps: 0, seaLevel: 0, routing: 'single', seed: 0, weight: new Float32Array(4) }, { progress() {} }), /weight holds 4 values/);
  // Grids too small to hold a texel off the border ring are all outlets.
  for (const res of [1, 2, 3]) {
    const flat = new Float32Array(res * res).fill(0.5);
    flat[res * res >> 1] = 0.1;
    const { filled, area } = route.run({ height: flat.slice(), res, eps: EPS, seaLevel: 0, routing: 'single', seed: 0 }, { progress() {} });
    assert.equal(filled[res * res >> 1], res === 3 ? Math.fround(Math.fround(0.5) + Math.fround(EPS)) : Math.fround(0.1));
    // At 3 x 3 the middle texel is the one that is no outlet: its area reaches the ring, where the whole is found.
    let onRing = 0;
    for (let i = 0; i < res * res; i++) if (res < 3 || i !== 4) onRing += area![i]!;
    assert.ok(Math.abs(onRing - 1) < 1e-6, `${res} x ${res}: the outlets hold ${onRing}`);
  }
});

test('simulate/route: ROUTE_EPS is a millimetre per texel and never below its floor', () => {
  assert.equal(routeEps(1024), 0.001 / 1024);
  assert.equal(routeEps(100), 1e-5);
  assert.equal(routeEps(8000), ROUTE_EPS_FLOOR);
  assert.equal(ROUTE_EPS_FLOOR, 5e-7);
});
