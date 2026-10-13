// tests/nodes/simulate/unit/water-course.test.ts
// The course task of simulation.md 8.5, run in this thread on grids of up to 257 x 257 texels: the rivers it
// hands to the kernels of simulate/rivers as sites, and what the document states of their width, course, valley
// and level.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RIVER_DEPTH_EXPONENT, RIVER_TAPER, RIVER_WIDTH_EXPONENT, VALLEY_GRADE } from '../../../../src/core/nodes/simulate/_water-constants.ts';
import { SITE_SPACING } from '../../../../src/core/nodes/simulate/_water-course.ts';
import { R, T, riversOf, type Rivers, type Site } from '../_water-sites.ts';

const TAU = 2 * Math.PI;

function grid(res: number, fn: (u: number, v: number) => number): Float32Array {
  const data = new Float32Array(res * res);
  for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) data[y * res + x] = fn(x / (res - 1), y / (res - 1));
  return data;
}

// The fixtures of testing.md 2.2 by their formulas, and two valleys no fixture has: one that runs askew to the
// grid, so that its river is a stair of texels, and one with a tributary valley.
const terrain = (res: number): Float32Array => grid(res, (u, v) => 0.5 + 0.22 * Math.sin(TAU * (u + 0.5 * v) + 0.3) + 0.10 * Math.sin(TAU * (-2 * u + 3 * v) + 1.7)
  + 0.05 * Math.sin(TAU * (5 * u + 4 * v) + 4.1) + 0.025 * Math.sin(TAU * (9 * u - 7 * v) + 2.9));
const notch = (res: number): Float32Array => grid(res, (u, v) => 0.75 - 0.5 * u - 0.05 * Math.max(0, 1 - Math.abs(v - 0.5) / 0.1));
const basin = (res: number): Float32Array => grid(res, (u, v) => 0.3 + 0.4 * u - 0.35 * Math.exp(-((u - 0.5) ** 2 + (v - 0.5) ** 2) / 0.0288));
/** A valley along the line v = 0.6 u + 0.2 that falls towards +u, with sides at 30 %. */
const askew = (res: number): Float32Array => grid(res, (u, v) => 0.95 - 0.8 * u + 1.2 * Math.abs(v - 0.6 * u - 0.2));

/** The sites of a river from `site` down to its end. */
function downstream(rivers: Rivers, site: Site): Site[] {
  const way = [site];
  for (let at = site; at.down >= 0 && way.length <= rivers.sites.size;) {
    at = rivers.sites.get(at.down)!;
    way.push(at);
  }
  return way;
}

test('simulate/water-course: every site a texel may take lies in its own texel, a texel or less from the next one down its river', () => {
  for (const [name, height, sea] of [['terrain', terrain(129), 0.25], ['askew', askew(129), -1], ['basin', basin(129), 0]] as const) {
    const rivers = riversOf(height, 129, sea);
    assert.ok(rivers.sites.size > 50, `${name}: ${rivers.sites.size} sites`);
    let outside = 0, far = 0, ends = 0, astray = 0;
    for (const site of rivers.sites.values()) {
      const x = site.texel % 129, y = Math.floor(site.texel / 129);
      if (Math.abs(site.x - x) > 0.5 || Math.abs(site.y - y) > 0.5) outside++;
      if (site.down < 0) { ends++; continue; }
      const next = rivers.sites.get(site.down);
      if (!next) { astray++; continue; }
      // Two points of a course are SITE_SPACING apart at the most, and one in the texel of the site before it is
      // left out. Where a tributary runs into the sites of its river a point more is: the link then spans it.
      if (Math.hypot(next.x - site.x, next.y - site.y) > 2 * SITE_SPACING + 1e-6) far++;
    }
    assert.equal(outside, 0, `${name}: sites outside the texel that holds them`);
    assert.equal(astray, 0, `${name}: links that lead to no site`);
    assert.ok(far <= 0.02 * rivers.sites.size, `${name}: ${far} of ${rivers.sites.size} sites lie farther from the next one than two spacings`);
    assert.ok(ends < 0.2 * rivers.sites.size, `${name}: ${ends} of ${rivers.sites.size} sites have no site below them`);
  }
});

test('simulate/water-course: the level never rises down a river, never lies above the routing surface, and never below the sea', () => {
  for (const [name, height, sea] of [['terrain', terrain(129), 0.25], ['notch', notch(129), -1], ['basin', basin(129), 0]] as const) {
    const rivers = riversOf(height, 129, sea);
    const seaLevel = Math.fround(sea);
    let rising = 0, drowned = 0, floating = 0;
    for (const site of rivers.sites.values()) {
      if (site.level < seaLevel) drowned++;
      // The routing surface a texel away is higher by what the terrain rises over a texel at the most.
      let highest = -Infinity;
      for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) highest = Math.max(highest, rivers.filled[site.texel + i + 129 * j] ?? -Infinity);
      if (site.level > highest) floating++;
      if (site.down >= 0 && rivers.sites.get(site.down)!.level > site.level) rising++;
    }
    assert.equal(rising, 0, `${name}: sites whose river lies higher at the next site down`);
    assert.equal(drowned, 0, `${name}: sites below the sea level`);
    assert.equal(floating, 0, `${name}: sites above the routing surface around them`);
  }
});

test('simulate/water-course: a river is as wide as its share makes it, begins as a trickle and grows no faster than the taper', () => {
  const res = 257, height = notch(res);
  const params = { catchment: 0.02, riverWidth: 0.05, valleyDepth: 0 };
  const rivers = riversOf(height, res, -1, params);
  // The one river of the notch, along its middle row: from its first site down.
  const row = [...rivers.sites.values()].filter((site) => Math.floor(site.texel / res) === 128).sort((a, b) => a.x - b.x);
  assert.ok(row.length > 100, `${row.length} sites along the notch`);
  assert.ok(row[0]!.width < 2 * RIVER_TAPER * rivers.cell * 4, `the river begins ${row[0]!.width} m wide`);
  let steep = 0, narrowing = 0;
  for (let k = 1; k < row.length; k++) {
    const grown = row[k]!.width - row[k - 1]!.width, run = (row[k]!.x - row[k - 1]!.x) * rivers.cell;
    if (grown > RIVER_TAPER * run * 1.05 + 1e-6) steep++;
    if (grown < -1e-6) narrowing++;
  }
  assert.equal(steep, 0, 'steps along the river over which it widens faster than the taper');
  assert.equal(narrowing, 0, 'steps along the river over which it narrows');
  // Far from its beginning it has the width of its share: the area of the router at its river texel.
  for (const x of [200, 230]) {
    const site = rivers.sites.get(128 * res + x)!;
    const whole = params.riverWidth * T * rivers.area[128 * res + x]! ** RIVER_WIDTH_EXPONENT;
    assert.ok(Math.abs(site.width - whole) < 0.05 * whole, `at column ${x} the river is ${site.width} m wide; its share makes it ${whole} m`);
  }
});

test('simulate/water-course: a stair of river texels becomes a line', () => {
  const res = 257, height = askew(res);
  const rivers = riversOf(height, res, -1, { catchment: 0.05 });
  // The valley line v = 0.6 u + 0.2, in texels; the sites of the grown river lie on it, and no stair is left.
  const along = [...rivers.sites.values()].filter((site) => site.share > 0 && site.x > 120 && site.x < 230);
  assert.ok(along.length > 80, `${along.length} sites on the stretch`);
  let off = 0, turning = 0;
  for (const site of along) {
    const line = 0.6 * site.x + 0.2 * (res - 1);
    if (Math.abs(site.y - line) > 0.75) off++;
    const next = site.down >= 0 ? rivers.sites.get(site.down)! : null, after = next && next.down >= 0 ? rivers.sites.get(next.down)! : null;
    if (!next || !after) continue;
    // The turn between two stretches, as the sine of its angle: a stair turns by a right angle at every texel.
    const ax = next.x - site.x, ay = next.y - site.y, bx = after.x - next.x, by = after.y - next.y;
    if (Math.abs(ax * by - ay * bx) / (Math.hypot(ax, ay) * Math.hypot(bx, by)) > 0.02) turning++;
  }
  assert.equal(off, 0, 'sites more than three quarters of a texel from the valley line');
  assert.equal(turning, 0, 'sites at which the course turns by more than a degree');
});

test('simulate/water-course: a river lies a valley\'s depth below the routing surface, and the valley shallows up a tributary no faster than its grade and the rise of the ground', () => {
  const res = 257, height = notch(res);
  const params = { catchment: 0.02, riverWidth: 0.05, valleyDepth: 0.1 };
  const rivers = riversOf(height, res, -1, params);
  let worst = 0;
  for (const x of [150, 180, 210, 235]) {
    const site = rivers.sites.get(128 * res + x)!;
    const deep = params.valleyDepth * R * Math.abs(site.share) ** RIVER_DEPTH_EXPONENT;
    const below = (rivers.filled[128 * res + x]! - site.level) * R;
    worst = Math.max(worst, Math.abs(below - deep) / deep);
    assert.ok(Math.abs(site.rise - below) < 0.02 * below + 0.01, `column ${x}: the sides are cut ${site.rise} m high, the river lies ${below} m deep`);
  }
  assert.ok(worst < 0.05, `the river lies off its valley's depth by ${worst} of it at the most`);
  assert.ok(Math.abs(rivers.deepest - Math.max(...[...rivers.sites.values()].map((site) => site.rise))) < 1e-3 * rivers.deepest, 'deepest is the largest of them');

  // On the terrain fixture rivers join: up every river the valley shallows by the grade at the most, from site to site.
  const joined = riversOf(terrain(res), res, -1, { catchment: 0.002 });
  const grade = VALLEY_GRADE * Math.tan(Math.PI / 6) * joined.cell;
  let hanging = 0, inside = 0;
  for (const site of joined.sites.values()) {
    if (site.down < 0) continue;
    const next = joined.sites.get(site.down)!;
    // A site in the river it joins keeps that river's level: where its way down reaches a site of the river, it
    // lies no higher than the river does there or at the next site up it.
    if (site.share < 0) {
      inside++;
      const above = next.up >= 0 ? joined.sites.get(next.up)!.level : next.level;
      if (next.share > 0 && site.level > Math.max(next.level, above)) hanging++;
      continue;
    }
    // By the grade over the way between the two, and by what the ground rises on it; a site lies up to a texel
    // from the river texel its level was found at, which the margins allow for.
    const steps = Math.hypot(next.x - site.x, next.y - site.y);
    const rising = Math.max(joined.filled[site.texel]! - joined.filled[next.texel]!, 0) * R;
    if (site.rise < next.rise - grade * (steps + 1) - 2 * rising - 0.05 * next.rise - 0.5) hanging++;
  }
  assert.ok(inside > 0, 'the terrain has tributaries');
  assert.equal(hanging, 0, 'sites whose valley is shallower than the valley below them allows');
});

test('simulate/water-course: a tributary\'s sites inside the river it joins are none a texel may take', () => {
  const res = 257;
  const rivers = riversOf(terrain(res), res, -1, { catchment: 0.001, riverWidth: 0.2 });
  // The lowest site of a tributary that a texel may take: the one whose way down leads through sites that none
  // may. It lies at the edge of the river's channel or beyond it, measured from where the tributary joins.
  let mouths = 0, stealing = 0;
  for (const site of rivers.sites.values()) {
    if (!(site.share > 0) || site.down < 0 || !(rivers.sites.get(site.down)!.share < 0)) continue;
    const river = downstream(rivers, rivers.sites.get(site.down)!).find((other) => other.share > 0);
    if (!river) continue;
    mouths++;
    // Two texels are allowed: the place of joining may have no site of its own, and a site lies up to a texel from its place.
    if (Math.hypot(river.x - site.x, river.y - site.y) * rivers.cell < 0.5 * river.width - 2 * rivers.cell) stealing++;
  }
  assert.ok(mouths > 10, `${mouths} tributaries reach a river through sites inside it`);
  assert.equal(stealing, 0, 'tributaries with a site a texel may take inside the channel of their river');
});

test('simulate/water-course: at a mouth the level is the sea level; no width and no rivers leave no sites', () => {
  const res = 129, height = terrain(res);
  const rivers = riversOf(height, res, 0.25);
  const sea = Math.fround(0.25);
  let mouths = 0, wrong = 0;
  for (const site of rivers.sites.values()) {
    if (!(height[site.texel]! <= sea) || site.down >= 0) continue;
    mouths++;
    if (site.level !== sea) wrong++;
  }
  assert.ok(mouths > 0, 'the terrain has rivers that reach the sea');
  assert.equal(wrong, 0, 'mouths whose level is not the sea level');
  assert.equal(riversOf(height, res, 0.25, { riverWidth: 0 }).sites.size, 0);
  const none = riversOf(height, res, 0.25, { catchment: 0.5 });
  assert.equal(none.sites.size, 0);
  assert.equal(none.deepest, 0);
});

test('simulate/water-course: equal arguments give bit-identical results (1.7 item 5)', () => {
  const res = 129, height = terrain(res);
  const a = riversOf(height, res, 0.25, { seed: 3 }), b = riversOf(height, res, 0.25, { seed: 3 });
  assert.equal(a.sites.size, b.sites.size);
  let differing = 0;
  for (const [texel, site] of a.sites) {
    const other = b.sites.get(texel);
    if (!other || other.x !== site.x || other.y !== site.y || other.level !== site.level || other.share !== site.share || other.rise !== site.rise || other.down !== site.down || other.up !== site.up) differing++;
  }
  assert.equal(differing, 0);
  assert.equal(a.deepest, b.deepest);
});
