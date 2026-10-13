// tests/nodes/select/exposure.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, compareLadder, conformance, expectClose, expectLadder, expectStats, fieldOf, fixtures, renderLadder, renderNode, stats, type FieldData } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/select/exposure.ts';
import { rough } from './terrains.ts';

conformance(def);

// With the test settings the terrain is 4096 m wide and a height of 1 is 1024 m: a cell is 16 m at 257.
const CELL = 16, RANGE = 1024;
const degrees = (angle: number): number => (angle * Math.PI) / 180;
const ease = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};
/** Half the height of the sun's disc at a softness of 1, in degrees. */
const HALF_DISC = 15;
const uniform = (value: number, tolerance = 1e-5) => ({ min: [value - tolerance, value + tolerance], max: [value - tolerance, value + tolerance] }) as const;

/** A radius of 0 smooths nothing: the terrain is lit as it is, walls and corners included. */
const SHARP = { radius: 0 } as const;

/** A plateau 64 m high (0.0625 of the height range) over the texels up to column 100, level ground at 0 beyond: a step with its wall between 100 and 101. */
const STEP_HEIGHT = 0.0625;
const step = fieldOf(257, (u) => (Math.round(u * 256) <= 100 ? STEP_HEIGHT : 0));

test('select/exposure: level ground is lit by the sine of the elevation, whichever way the sun stands', async () => {
  for (const elevation of [10, 30, 60, 90]) {
    for (const angle of [0, 77, 180, 225]) {
      const { out } = await renderNode(def, { inputs: { in: 'zero' }, params: { angle, elevation } });
      expectStats(out, uniform(Math.sin(degrees(elevation))));
    }
  }
  // A sun on the horizon lights no level ground.
  expectStats((await renderNode(def, { inputs: { in: 'zero' }, params: { elevation: 0, softness: 0 } })).out, uniform(0));
});

test('select/exposure: a slope is lit by the cosine between its normal and the sun, and the direction is the one towards the sun', async () => {
  // rampX rises towards +X at atan(1/4): it faces -X, direction 180. Its normal is (-1, 0, 4) / sqrt(17).
  for (const [angle, elevation] of [[180, 30], [0, 30], [90, 30], [180, 80], [135, 45]] as const) {
    const sun = [Math.cos(degrees(elevation)) * Math.cos(degrees(angle)), Math.cos(degrees(elevation)) * Math.sin(degrees(angle)), Math.sin(degrees(elevation))];
    const facing = Math.max(0, (-sun[0] + 4 * sun[2]) / Math.sqrt(17));
    const { out } = await renderNode(def, { inputs: { in: 'rampX' }, params: { angle, elevation } });
    expectStats(out, uniform(facing, 1e-4));
  }
  // The sun in the direction the slope faces lights it more than level ground, and the opposite sun less.
  const towards = (await renderNode(def, { inputs: { in: 'rampX' }, params: { angle: 180, elevation: 30 } })).out;
  const away = (await renderNode(def, { inputs: { in: 'rampX' }, params: { angle: 0, elevation: 30 } })).out;
  assert.ok(at(towards, 128, 128) > 0.5 && at(away, 128, 128) < 0.5);
  // A slope steeper than the sun is high, facing away from it, is not lit at all.
  const steep = fieldOf(257, (u) => 4 * u);   // 45 degrees, facing -X
  expectStats((await renderNode(def, { inputs: { in: steep }, params: { angle: 0, elevation: 30 } })).out, uniform(0));
});

test('select/exposure: a step casts a shadow as long as its height over the tangent of the elevation', async () => {
  // The sun stands in the direction 180, towards -X, behind the plateau, 40 degrees high: the wall of 64 m shades
  // the ground up to 64 / tan(40) = 76.3 m from the last texel of the plateau, 4.77 cells.
  const { out } = await renderNode(def, { inputs: { in: step }, params: { ...SHARP, angle: 180, elevation: 40, softness: 0 } });
  const level = Math.fround(Math.sin(degrees(40)));
  for (const y of [0, 100, 256]) {
    for (let x = 0; x <= 98; x++) assert.ok(Math.abs(at(out, x, y) - level) <= 1e-5, `the plateau at ${x} is ${at(out, x, y)}`);
    for (let x = 101; x <= 104; x++) assert.equal(at(out, x, y), 0, `the ground ${x - 100} cells from the wall is in its shadow`);
    for (let x = 105; x < 257; x++) assert.ok(Math.abs(at(out, x, y) - level) <= 1e-5, `the ground ${x - 100} cells from the wall is ${at(out, x, y)}`);
  }
  // From the other side the sun lights the wall and all the ground.
  const front = (await renderNode(def, { inputs: { in: step }, params: { ...SHARP, angle: 0, elevation: 40, softness: 0 } })).out;
  for (let x = 102; x < 257; x++) assert.ok(Math.abs(at(front, x, 7) - level) <= 1e-5);
  // The two texels the wall lies between have its slope in their central difference: 64 m over 32 m, facing +X.
  const wall = (2 * Math.cos(degrees(40)) + Math.sin(degrees(40))) / Math.sqrt(5);
  assert.ok(Math.abs(at(front, 100, 7) - wall) <= 1e-5 && Math.abs(at(front, 101, 7) - wall) <= 1e-5, `the wall is ${at(front, 100, 7)}; expected ${wall}`);
});

test('select/exposure: shadows are physical: twice the height range, or a sun half as high in tangent, is twice the shadow', async () => {
  const shaded = (out: FieldData): number => {
    let count = 0;
    for (let x = 102; x < 257; x++) if (at(out, x, 50) === 0) count++;
    return count + 1;   // and texel 101, which the wall's own slope keeps dark
  };
  const base = (await renderNode(def, { inputs: { in: step }, params: { ...SHARP, angle: 180, elevation: 40, softness: 0 } })).out;
  assert.equal(shaded(base), 4);
  const tall = (await renderNode(def, { inputs: { in: step }, params: { ...SHARP, angle: 180, elevation: 40, softness: 0 }, settings: { heightRange: 2 * RANGE } })).out;
  assert.equal(shaded(tall), 9, 'a wall of 128 m shades 9.53 cells');
  const low = (await renderNode(def, { inputs: { in: step }, params: { ...SHARP, angle: 180, elevation: 15, softness: 0 } })).out;
  assert.equal(shaded(low), 14, 'at 15 degrees the wall of 64 m shades 14.93 cells');
  // Twice the height range on twice the width is the same picture.
  const terrain = (await renderNode(def, { inputs: { in: 'terrain' } })).out;
  const scaled = (await renderNode(def, { inputs: { in: 'terrain' }, settings: { terrainSize: 8192, heightRange: 2 * RANGE } })).out;
  expectClose(scaled, terrain, { max: 1e-4 });
});

test('select/exposure: the softness is the height of the sun\'s disc: the edge of the shadow is the share of the disc above the wall', async () => {
  // A softness of 0.4 is a disc from 34 to 46 degrees around the elevation of 40, and one of 1 a disc from 25 to
  // 55. From the ground d cells from the wall its top stands at atan(64 / (16 d)): above the disc the sun is
  // hidden, below it the sun is whole, and between them the mask is the smooth step of the share of the disc
  // that clears the wall, whichever of the disc's strips the top of the wall stands in.
  for (const softness of [0.4, 1]) {
    const elevation = 40;
    const lo = elevation - softness * HALF_DISC, hi = elevation + softness * HALF_DISC;
    const { out } = await renderNode(def, { inputs: { in: step }, params: { ...SHARP, angle: 180, elevation, softness } });
    let partly = 0;
    for (let x = 102; x < 140; x++) {
      const horizon = (Math.atan((STEP_HEIGHT * RANGE) / ((x - 100) * CELL)) * 180) / Math.PI;
      const seen = horizon >= hi ? 0 : horizon <= lo ? 1 : ease((hi - horizon) / (hi - lo));
      if (seen > 0 && seen < 1) partly++;
      assert.ok(Math.abs(at(out, x, 200) - Math.sin(degrees(elevation)) * seen) <= 1e-4, `softness ${softness}: ${x - 100} cells from the wall the mask is ${at(out, x, 200)}; expected ${Math.sin(degrees(elevation)) * seen}`);
    }
    assert.ok(partly >= (softness === 1 ? 5 : 2), `softness ${softness}: ${partly} texels lie in the half-shadow`);
  }
});

test('select/exposure: the part of the sun\'s disc below the horizontal is not seen', async () => {
  // rampX faces -X at atan(1/4), and towards -X the ground only falls: nothing hides a sun in the direction 180.
  // Its normal is (-1, 0, 4) / sqrt(17).
  for (const [elevation, softness] of [[0, 1], [5, 1], [0, 0.2], [10, 1]] as const) {
    const lo = elevation - softness * HALF_DISC, hi = elevation + softness * HALF_DISC;
    const seen = ease((hi - Math.max(lo, 0)) / (hi - lo));
    const facing = (Math.cos(degrees(elevation)) + 4 * Math.sin(degrees(elevation))) / Math.sqrt(17);
    const { out } = await renderNode(def, { inputs: { in: 'rampX' }, params: { angle: 180, elevation, softness } });
    expectStats(out, uniform(facing * seen, 1e-4));
  }
  // Half of a sun on the horizon is seen, whatever the size of the terrain towards it.
  const half = (await renderNode(def, { res: 129, inputs: { in: 'rampX' }, params: { angle: 180, elevation: 0, softness: 1 } })).out;
  expectStats(half, uniform(0.5 / Math.sqrt(17), 1e-4));
});

/**
 * The CPU reference for a sun in the direction 180, where a step is a whole texel along a row: for every texel
 * the horizon, the steepest line to any ground towards the sun, and with it the share of the disc that is seen.
 */
function horizonReference(src: FieldData, elevation: number, softness: number): FieldData {
  const n = src.width;
  const cell = 4096 / (n - 1);
  const z = (x: number, y: number): number => src.data[y * n + x] * RANGE;
  const lo = degrees(elevation - softness * HALF_DISC), hi = degrees(elevation + softness * HALF_DISC);
  const sun = [-Math.cos(degrees(elevation)), 0, Math.sin(degrees(elevation))];
  const derivative = (i: number, heightAt: (i: number) => number): number =>
    (i === 0 ? 0.5 * (4 * heightAt(1) - 3 * heightAt(0) - heightAt(2))
      : i === n - 1 ? -0.5 * (4 * heightAt(n - 2) - 3 * heightAt(n - 1) - heightAt(n - 3))
        : 0.5 * (heightAt(i + 1) - heightAt(i - 1))) / cell;
  const data = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const gx = derivative(x, (i) => z(i, y)), gy = derivative(y, (i) => z(x, i));
      const facing = (-gx * sun[0] - gy * sun[1] + sun[2]) / Math.hypot(gx, gy, 1);
      if (facing <= 0) continue;
      let steepest = -Infinity;
      for (let s = 1; x - s >= 0; s++) steepest = Math.max(steepest, (z(x - s, y) - z(x, y)) / (s * cell));
      const horizon = Math.max(Math.atan(steepest), lo, 0);
      data[y * n + x] = horizon >= hi ? 0 : facing * ease((hi - horizon) / (hi - lo));
    }
  }
  return { ...src, data };
}

test('select/exposure: on rough ground a half-shadow is that of the horizon found texel by texel', async () => {
  // Whether the horizon lies below, inside or above each of the disc's four strips is exact. Inside a strip it
  // is taken from the ground nearest the strip's lower edge, which is not always the ground that makes the
  // horizon: a texel in a hundred of the half-shadows is then lit by more than a tenth too much.
  const src = await fixtures.fbm(257);
  for (const [elevation, softness] of [[30, 1], [10, 1], [30, 0.2], [20, 0.5]] as const) {
    const { out } = await renderNode(def, { inputs: { in: src }, params: { ...SHARP, angle: 180, elevation, softness } });
    const expected = horizonReference(src, elevation, softness);
    let off = 0, partly = 0, sum = 0;
    for (let i = 0; i < expected.data.length; i++) {
      const error = Math.abs(out.data[i] - expected.data[i]);
      sum += error;
      if (error > 0.1) off++;
      if (expected.data[i] > 0 && Math.abs(out.data[i] - expected.data[i]) < 1e-3 && out.data[i] < 0.999) partly++;
    }
    assert.ok(partly > 5000, `elevation ${elevation}, softness ${softness}: ${partly} lit texels agree with the reference`);
    assert.ok(off <= 0.005 * expected.data.length, `elevation ${elevation}, softness ${softness}: ${off} texels are off by more than 0.1`);
    assert.ok(sum / expected.data.length <= 0.003, `elevation ${elevation}, softness ${softness}: the mean error is ${sum / expected.data.length}`);
  }
});

test('select/exposure: a pit is shaded from its wall on the side of the sun, along a diagonal too', async () => {
  // A square pit 48 m deep (0.046875) over the texels 96 to 160. The sun stands towards -X and -Y, direction 225,
  // at 35 degrees: a step towards it is one texel on each axis, 22.63 m, on which a ray rises 15.84 m. A texel of
  // the floor i texels inside the nearer of the two walls on the sun's side reaches the rim after i + 1 steps: it is shaded while
  // (i + 1) * 15.84 < 48, for i = 0 and 1.
  const depth = 0.046875;
  const insidePit = (x: number, y: number): boolean => x >= 96 && x <= 160 && y >= 96 && y <= 160;
  const pit = fieldOf(257, (u, v) => (insidePit(Math.round(u * 256), Math.round(v * 256)) ? 0.5 - depth : 0.5));
  const { out } = await renderNode(def, { inputs: { in: pit }, params: { ...SHARP, angle: 225, elevation: 35, softness: 0 } });
  const level = Math.sin(degrees(35));
  let wrong = 0;
  for (let y = 98; y <= 158; y++) {
    for (let x = 98; x <= 158; x++) {
      // Two texels from the walls the floor is level in its central difference.
      const stepsToRim = Math.min(x - 96, y - 96) + 1;
      const shaded = stepsToRim * Math.SQRT2 * CELL * Math.tan(degrees(35)) < depth * RANGE;
      if (Math.abs(at(out, x, y) - (shaded ? 0 : level)) > 1e-5) wrong++;
    }
  }
  assert.equal(wrong, 0, 'texels of the floor that are not as the shadow of the rim says');
  assert.equal(at(out, 98, 98), 0, 'the corner under the sun is dark');
  assert.ok(Math.abs(at(out, 150, 150) - level) <= 1e-5, 'the far corner is lit');
  // The ground around the pit is lit: nothing rises above it.
  assert.ok(Math.abs(at(out, 60, 60) - level) <= 1e-5 && Math.abs(at(out, 200, 128) - level) <= 1e-5);
});

/**
 * The CPU reference at a softness of 0. The light: the cosine between the sun and the normal, from central
 * differences of the heights in metres (of second order on the border). The shadow: for every texel a march
 * towards the sun, step by step to the border, a whole texel at a time along the axis the direction mostly runs
 * along and with the height interpolated between the two texels beside the ray on the other; a texel is dark
 * where some ground rises above the ray.
 */
function reference(src: FieldData, angle: number, elevation: number): FieldData {
  const n = src.width;
  const cell = 4096 / (n - 1);
  const z = (x: number, y: number): number => src.data[y * n + x] * RANGE;
  const dx = Math.cos(degrees(angle)), dy = Math.sin(degrees(angle));
  const sun = [Math.cos(degrees(elevation)) * dx, Math.cos(degrees(elevation)) * dy, Math.sin(degrees(elevation))];
  const major = Math.max(Math.abs(dx), Math.abs(dy));
  const sx = dx / major, sy = dy / major;
  const drop = (cell / major) * Math.tan(degrees(elevation));
  /** The derivative along one axis at index i of n, from the heights at(i). */
  const derivative = (i: number, heightAt: (i: number) => number): number =>
    (i === 0 ? 0.5 * (4 * heightAt(1) - 3 * heightAt(0) - heightAt(2))
      : i === n - 1 ? -0.5 * (4 * heightAt(n - 2) - 3 * heightAt(n - 1) - heightAt(n - 3))
        : 0.5 * (heightAt(i + 1) - heightAt(i - 1))) / cell;
  const data = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const gx = derivative(x, (i) => z(i, y)), gy = derivative(y, (i) => z(x, i));
      const facing = (-gx * sun[0] - gy * sun[1] + sun[2]) / Math.hypot(gx, gy, 1);
      if (facing <= 0) continue;
      let dark = false;
      for (let s = 1; s < n && !dark; s++) {
        const qx = x + s * sx, qy = y + s * sy;
        if (qx < 0 || qy < 0 || qx > n - 1 || qy > n - 1) break;
        const ax = Math.floor(qx), ay = Math.floor(qy);
        const bx = ax + (qx > ax ? 1 : 0), by = ay + (qy > ay ? 1 : 0);
        const t = Math.max(qx - ax, qy - ay);
        dark = z(ax, ay) * (1 - t) + z(bx, by) * t - s * drop > z(x, y);
      }
      data[y * n + x] = dark ? 0 : facing;
    }
  }
  return { ...src, data };
}

test('select/exposure: in any direction the mask is that of a march texel by texel, up to a few texels along the edges of the shadows', async () => {
  // The node reaches across the terrain in passes that double their stride. Along an axis or a diagonal every
  // stride lands on texels and the two are the same shadows. In any other direction a pass interpolates what the
  // pass before found between two texels, where the reference interpolates the height: along the edge of a shadow
  // a texel in 200 of the terrain comes out on the other side, at most.
  for (const src of [fixtures.terrain(129), await fixtures.fbm(129)]) {
    for (const [angle, elevation] of [[0, 25], [90, 25], [225, 30], [315, 15], [30, 20], [200, 35], [285, 15], [10, 30]] as const) {
      const { out } = await renderNode(def, { res: 129, inputs: { in: src }, params: { ...SHARP, angle, elevation, softness: 0 } });
      const expected = reference(src, angle, elevation);
      let differing = 0, dark = 0;
      for (let i = 0; i < expected.data.length; i++) {
        if (expected.data[i] === 0) dark++;
        if (Math.abs(out.data[i] - expected.data[i]) > 1e-4) differing++;
      }
      assert.ok(dark > 1500 && dark < 129 * 129 - 1500, `direction ${angle}: ${dark} texels of the reference are dark`);
      const onGrid = angle % 45 === 0;
      assert.ok(differing <= (onGrid ? 0 : 0.008 * 129 * 129), `direction ${angle}, elevation ${elevation}: ${differing} texels differ from the reference`);
    }
  }
});

test('select/exposure: a cone casts its shadow away from the sun', async () => {
  // The cone is 1024 m high with its tip at the centre and a foot 64 texels out. A sun 30 degrees high towards
  // +X puts the tip's shadow 1024 / tan(30) = 1774 m behind it, 110.9 cells towards -X: 46.9 beyond the foot.
  const { out } = await renderNode(def, { inputs: { in: 'cone' }, params: { ...SHARP, angle: 0, elevation: 30, softness: 0 } });
  const level = Math.sin(degrees(30));
  for (const x of [20, 30, 40, 60]) assert.equal(at(out, x, 128), 0, `the floor at ${x} lies in the shadow of the cone`);
  for (const x of [4, 10, 16]) assert.ok(Math.abs(at(out, x, 128) - level) <= 1e-5, `the floor at ${x} is beyond the shadow of the tip`);
  // Beside the cone and in front of it the floor is lit.
  for (const [x, y] of [[128, 20], [128, 236], [230, 128], [40, 40]] as const) assert.ok(Math.abs(at(out, x, y) - level) <= 1e-5, `the floor at (${x}, ${y}) is ${at(out, x, y)}`);
  // The flank towards the sun is lit more squarely than the floor; the flank away from it faces away.
  assert.ok(at(out, 160, 128) > 0.9, `the flank towards the sun is ${at(out, 160, 128)}`);
  assert.equal(at(out, 96, 128), 0, 'the flank away from the sun');
});

test('select/exposure: the radius smooths before the terrain is lit: ripples narrower than it cast no shadows', async () => {
  // Ripples 8 texels long and 30 m high on level ground, steeper than a sun of 20 degrees stands high: each casts
  // a shadow across the next. Smoothed over a radius of 16 texels nothing of them is left, and the ground is lit as
  // level ground is.
  const ripples = fieldOf(257, (u) => 0.5 + 0.03 * Math.sin((2 * Math.PI * u * 256) / 8));
  const params = { angle: 180, elevation: 20, softness: 0 };
  const sharp = (await renderNode(def, { inputs: { in: ripples }, params: { ...params, ...SHARP } })).out;
  assert.ok(stats(sharp).min === 0 && stats(sharp).max > 0.9, 'unsmoothed, the ripples are lit on one side and dark on the other');
  const smooth = (await renderNode(def, { inputs: { in: ripples }, params: { ...params, radius: 0.0625 } })).out;
  for (const [x, y] of [[64, 64], [128, 3], [129, 128], [131, 250], [190, 128]] as const) {
    assert.ok(Math.abs(at(smooth, x, y) - Math.sin(degrees(20))) <= 1e-3, `smoothed, the ground at (${x}, ${y}) is ${at(smooth, x, y)}`);
  }
  // Within a few radii of the border the smoothed surface is fitted to the ripples there are: a trace is left.
  expectStats(smooth, { min: [Math.sin(degrees(20)) - 0.03, 1], max: [0, Math.sin(degrees(20)) + 0.03] });
  // A plane smoothed is the plane it was, up to the border: a slope is lit the same at any radius.
  for (const radius of [0.005, 0.03, 0.2]) {
    const { out } = await renderNode(def, { inputs: { in: 'rampX' }, params: { angle: 180, elevation: 30, radius } });
    expectStats(out, uniform((Math.cos(degrees(30)) + 4 * Math.sin(degrees(30))) / Math.sqrt(17), 1e-4));
  }
});

test('select/exposure: inverted, the mask is its complement: the ground in shade', async () => {
  const plain = (await renderNode(def, { inputs: { in: 'terrain' } })).out;
  const inverted = (await renderNode(def, { inputs: { in: 'terrain' }, params: { invert: true } })).out;
  expectClose(inverted, fieldOf(257, (u, v) => 1 - at(plain, Math.round(u * 256), Math.round(v * 256))), { max: 1e-6 });
  assert.ok(stats(plain).min === 0 && stats(plain).max > 0.9, 'the fixture has ground in shadow and ground lit squarely');
});

test('select/exposure: two levels of the ladder agree, with a hard shadow and with a soft one', async () => {
  // The edge of a hard shadow falls between two texels of the coarser level, where a texel is lit at one level
  // and dark at the other; over a half-shadow the two levels grade alike.
  const hard = await renderLadder(def, { inputs: { in: 'terrain' }, params: { softness: 0 } });
  const atHard = expectLadder(hard[257].out, hard[513].out, { rel: 0.02 });
  const soft = await renderLadder(def, { inputs: { in: 'terrain' } });
  const atDefault = expectLadder(soft[257].out, soft[513].out, { rel: 0.01 });
  assert.ok(atHard.rel > atDefault.rel, `the levels differ by ${atHard.rel} of the standard deviation with a hard shadow and by ${atDefault.rel} at the defaults`);
  // Other suns. The lower the sun, the longer the shadows and the more texels lie along their edges.
  for (const [angle, elevation] of [[0, 20], [225, 45], [77, 60], [300, 10]] as const) {
    const levels = await renderLadder(def, { inputs: { in: 'terrain' }, params: { angle, elevation } });
    expectLadder(levels[257].out, levels[513].out, { rel: 0.02 });
  }
});

test('select/exposure: on rough ground the radius is what makes a preview show what the build lights', async () => {
  // A terrain with detail down to 8 cells at 257. Unsmoothed, every texel is lit by its own facet, the finer
  // level has facets the coarser one lacks, and the masks differ by 1.4 % of their standard deviation; at the
  // default radius by 1.1 %; smoothed over 0.02, by 0.2 %: both levels light the same shapes. On ground with
  // detail down to the texel, as ref/fbm has, the unsmoothed masks differ by a third of it.
  const share: number[] = [];
  for (const radius of [0, 0.005, 0.02]) {
    const levels: FieldData[] = [];
    for (const res of [257, 513]) levels.push((await renderNode(def, { res, inputs: { in: rough(res) }, params: { radius } })).out);
    share.push(expectLadder(levels[0], levels[1], { rel: 0.05 }).rel);
  }
  assert.ok(share[2] < 0.005, `smoothed over 0.02 the levels differ by ${share[2]} of the standard deviation`);
  assert.ok(share[0] > share[1] && share[1] > share[2], `the levels differ by ${share[0]} unsmoothed, by ${share[1]} at the default radius and by ${share[2]} smoothed over 0.02`);
});
