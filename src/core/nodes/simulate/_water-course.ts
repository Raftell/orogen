// src/core/nodes/simulate/_water-course.ts
// The courses of the rivers (simulation.md 8.5): the task that follows the rivers of a routed terrain as lines and
// gives each its width, its course, its valley and its water level, and the form in which it hands them on to
// the kernels of simulate/rivers.
import { defineCpuTask, type CpuEnv } from '../../api.ts';
import {
  COURSE_SLACK, COURSE_SLACK_MIN, COURSE_SMOOTHING, COURSE_SMOOTHING_MIN, PROFILE_DEPTH, PROFILE_SMOOTHING,
  RIVER_DEPTH_EXPONENT, RIVER_TAPER, RIVER_WIDTH_EXPONENT, VALLEY_GRADE,
} from './_water-constants.ts';

/** Steps in which a site's place inside its texel is stored along an axis: `x + PLACE_STEPS * y`, whole numbers in one float. */
export const PLACE_STEPS = 4096;
/** No link: the offset (0, 0) among the nine `(dy + 1) * 3 + (dx + 1)` to a neighbouring texel. */
export const NO_LINK = 4;
/** Steps in which the height of the terrain above a river is stored, as a part of the largest: `down + 9 * (up + 9 * rise)`. */
export const RISE_STEPS = 65536;
/** How far apart the sites of a river lie along it at the most, in texels: below 1, so that their texels touch. */
export const SITE_SPACING = 0.75;

/**
 * What the course task says of a site beside its level and its share, in the texel the site lies in: the plane
 * `place`, where in the texel it lies, and the plane `course`, the offsets to the texels of the next site down
 * the river and of the next one up it, and how high the terrain stood above the river there.
 */
export const COURSE_WGSL = /* wgsl */ `
const PLACE_STEPS = ${PLACE_STEPS}u;

// Where the site in the texel q lies.
fn placeAt(q: vec2i) -> vec2f {
  let packed = u32(place_at(q));
  return vec2f(q) + vec2f(f32(packed % PLACE_STEPS), f32(packed / PLACE_STEPS)) / f32(PLACE_STEPS - 1u) - 0.5;
}

// The texels of the sites beside the one in the texel q on its river, as offsets, (0, 0) for none; and how high
// the terrain stood above the river there, as a part of the largest such height.
struct Course { down: vec2i, up: vec2i, rise: f32 }

fn courseLink(code: u32) -> vec2i { return vec2i(i32(code % 3u) - 1, i32(code / 3u) - 1); }

fn courseAt(q: vec2i) -> Course {
  let packed = u32(course_at(q));
  return Course(courseLink(packed % 9u), courseLink((packed / 9u) % 9u), f32(packed / 81u) / ${RISE_STEPS - 1}.0);
}`;

export interface CourseArgs {
  readonly height: Float32Array;     // res × res: the terrain; consumed, and returned as `course`
  readonly filled: Float32Array;     // its routing surface; consumed, and returned as `level`
  readonly area: Float32Array;       // the share of the terrain that drains through each texel; consumed, and returned as `share`
  readonly receivers: Uint8Array;    // the N4 index of each texel's receiver, 4 for none
  readonly res: number;
  readonly seaLevel: number;
  readonly catchment: number;        // the share at which a river begins
  readonly cell: number;             // metres between two texels
  readonly range: number;            // metres of a height of 1
  readonly width: number;            // metres: the width of a river that drains the whole terrain
  readonly depth: number;            // metres: its depth
  readonly valley: number;           // metres: the depth of its valley
  readonly bank: number;             // the tangent of the bank's angle
}
export interface Course {
  readonly level: Float32Array;      // in the texel of a site, the river's water level there; elsewhere of no meaning
  readonly share: Float32Array;      // likewise the share a river of its width drains, below 0 where the site is none a texel may take; 0 elsewhere
  readonly course: Float32Array;     // likewise what COURSE_WGSL reads as `course`
  readonly place: Float32Array;      // likewise what it reads as `place`
  readonly deepest: number;          // metres: the most a river lies below the routing surface
}

// The rivers as what they are, lines: every river texel with the one it drains to and the one most of its water
// comes from. Along those lines, which no kernel can follow, a river is given its width, its course, its valley
// and its water level, and the lines are handed on as sites: points a texel apart, each in the texel it lies in.
// Pure: the result depends on the arguments only.
//
// - Width. A river is as wide as its share makes it, but grows no faster along its course than RIVER_TAPER: it
//   begins as a trickle and widens over a confluence, where its share jumps.
// - Course. Each river texel's place is moved onto a smoothed course: a stair becomes its diagonal, and a wide
//   river loses the turns that are shorter than it is wide.
// - Confluence. Routing takes a tributary on to the middle of the river it joins. Its places inside that
//   river's channel are no sites a texel may take: they would hand the channel's texels to the tributary. They
//   keep the level of the river they are in.
// - Valley. A river lies below the routing surface by the depth of its valley, and never below the sea. Up a
//   tributary a valley shallows no faster than VALLEY_GRADE allows, and by what the ground rises: it meets the
//   river it joins at that river's level and does not hang above it, but it does not carry that river's valley
//   up a cliff. A lake on the way is lowered as its outlet is cut.
// - Level. The routing surface along a river falls in steps: every hollow on the way is a pool filled to its
//   rim. The long profile is smoothed from below, by PROFILE_DEPTH widths at the most, so that the river cuts
//   through the rims and keeps its level on an even slope. The level never rises downstream.
export const course = defineCpuTask({
  name: 'simulate/water-course',
  run(args: CourseArgs, env: CpuEnv): Course {
    const { height, filled, area, receivers, res, catchment, cell, range, width, depth, valley, bank } = args;
    const n = res * res;
    if (height.length !== n || filled.length !== n || area.length !== n || receivers.length !== n) throw new Error(`simulate/water-course: the fields are not ${res} x ${res}`);
    const sea = Math.fround(args.seaLevel);   // the value a kernel compares with
    const offsets = [1, res, -1, -res], stepX = [1, 0, -1, 0], stepY = [0, 1, 0, -1];

    // The river texels, each after the one it drains to: breadth first from the outlets, upstream.
    let order = new Int32Array(1 << 12), down = new Int32Array(1 << 12), count = 0;
    const add = (texel: number, to: number): void => {
      if (count === order.length) {
        const texels = new Int32Array(count * 2), tos = new Int32Array(count * 2);
        texels.set(order); tos.set(down);
        order = texels; down = tos;
      }
      order[count] = texel;
      down[count++] = to;
    };
    for (let i = 0; i < n; i++) if (receivers[i] === 4 && area[i] >= catchment) add(i, -1);
    env.progress(0.2);
    for (let at = 0; at < count; at++) {
      const c = order[at], x = c % res, y = (c - x) / res;
      for (let k = 0; k < 4; k++) {
        const qx = x + stepX[k], qy = y + stepY[k];
        if (qx < 0 || qy < 0 || qx >= res || qy >= res) continue;
        const q = c + offsets[k];
        if (receivers[q] === ((k + 2) & 3) && area[q] >= catchment) add(q, at);
      }
    }
    // The donor that drains the most: where the river comes from. -1 where a river begins.
    const main = new Int32Array(count).fill(-1);
    for (let i = 0; i < count; i++) {
      const to = down[i];
      if (to >= 0 && (main[to] < 0 || area[order[i]] > area[order[main[to]]])) main[to] = i;
    }
    env.progress(0.4);

    // Width, from the springs down: donors come after their receiver in the order.
    const wide = new Float64Array(count), share = new Float64Array(count), blend = new Float64Array(count);
    {
      const fed = new Float64Array(count);
      for (let i = count - 1; i >= 0; i--) {
        const whole = width * Math.min(Math.max(area[order[i]], 0), 1) ** RIVER_WIDTH_EXPONENT;
        const w = Math.min(whole, fed[i] + RIVER_TAPER * cell);
        wide[i] = w;
        if (down[i] >= 0 && w > fed[down[i]]) fed[down[i]] = w;
      }
    }
    // Along a river, the mean of what lies downstream and of what lies upstream, each fading with the distance,
    // over COURSE_SMOOTHING widths and never less than COURSE_SMOOTHING_MIN texels; twice, which leaves of a
    // stair less than a thousandth of a texel. On an even course the mean is the value itself.
    const lower = new Float64Array(count), upper = new Float64Array(count);
    // Past the end of a river the values go on as they came: the mean beyond the last texel is the one its
    // neighbour's step gives, not the texel's own value, which would draw the end of every river back.
    // The step is taken over as many texels of the river as the mean reaches, 16 at the most: a single step of
    // a course is a step of the grid.
    const beyond = (values: Float64Array, i: number, inward: Int32Array): number => {
      const reach = (1 - blend[i]) / blend[i];
      let at = i, steps = 0;
      while (steps < Math.min(reach, 16) && inward[at] >= 0) { at = inward[at]; steps++; }
      return steps === 0 ? values[i] : values[i] + ((values[i] - values[at]) / steps) * reach;
    };
    const smooth = (values: Float64Array): void => {
      for (let round = 0; round < 2; round++) {
        for (let i = 0; i < count; i++) lower[i] = down[i] < 0 ? beyond(values, i, main) : blend[i] * values[i] + (1 - blend[i]) * lower[down[i]];
        for (let i = count - 1; i >= 0; i--) upper[i] = main[i] < 0 ? beyond(values, i, down) : blend[i] * values[i] + (1 - blend[i]) * upper[main[i]];
        for (let i = 0; i < count; i++) values[i] = 0.5 * (lower[i] + upper[i]);
      }
    };
    for (let i = 0; i < count; i++) blend[i] = 1 / (1 + Math.max((COURSE_SMOOTHING * wide[i]) / cell, COURSE_SMOOTHING_MIN));
    // The width: a river's share grows by what every texel of its banks adds, in lumps, and its edge is
    // measured to (simulate/rivers.carve): an edge that turned a little at every texel would be met at another
    // place from one texel to the next.
    smooth(wide);
    for (let i = 0; i < count; i++) {
      wide[i] = Math.max(wide[i], 0);
      share[i] = width > 0 ? Math.min((wide[i] / width) ** (1 / RIVER_WIDTH_EXPONENT), 1) : 0;
    }

    // The course, likewise: a stair becomes its diagonal, and a wide river loses the turns that are shorter
    // than it is wide. A place stays within reach of its river texel.
    const px = new Float64Array(count), py = new Float64Array(count);
    for (let i = 0; i < count; i++) { px[i] = order[i] % res; py[i] = (order[i] - px[i]) / res; }
    smooth(px);
    smooth(py);
    for (let i = 0; i < count; i++) {
      const c = order[i], x = c % res, y = (c - x) / res;
      const slack = Math.max((COURSE_SLACK * wide[i]) / cell, COURSE_SLACK_MIN);
      px[i] = Math.min(Math.max(x + Math.min(Math.max(px[i] - x, -slack), slack), 0), res - 1);
      py[i] = Math.min(Math.max(y + Math.min(Math.max(py[i] - y, -slack), slack), 0), res - 1);
    }
    // A tributary's places inside the channel of the river it joins, measured from where it joins it.
    const inside = new Uint8Array(count);
    {
      const joins = new Int32Array(count).fill(-1);
      for (let i = 0; i < count; i++) {
        const to = down[i];
        if (to < 0) continue;
        const river = inside[to] ? joins[to] : main[to] === i ? -1 : to;
        if (river < 0) continue;
        joins[i] = river;
        if (Math.hypot(px[i] - px[river], py[i] - py[river]) * cell < 0.5 * wide[river]) inside[i] = 1;
      }
    }
    env.progress(0.6);

    // The depth of the valley, in metres: what the share makes it, and no less than the valley the river drains
    // into less what the way from it allows. The level: that far below the routing surface, never below the
    // sea, the sea itself at a mouth, and inside another river that river's level.
    const cut = new Float64Array(count), level = new Float64Array(count);
    const kept = new Uint8Array(count);
    const grade = VALLEY_GRADE * bank * cell;
    for (let i = 0; i < count; i++) {
      const c = order[i], to = down[i];
      if (height[c] <= sea) { level[i] = sea; kept[i] = 1; continue; }
      if (inside[i]) {
        level[i] = level[to];
        cut[i] = Math.max((filled[c] - level[i]) * range, 0);
        kept[i] = 1;
        continue;
      }
      cut[i] = Math.max(valley * share[i] ** RIVER_DEPTH_EXPONENT, to < 0 ? 0 : cut[to] - grade - Math.max(filled[c] - filled[order[to]], 0) * range);
      level[i] = Math.max(filled[c] - cut[i] / range, sea);
    }
    // The mean of the levels downstream and of those upstream, each fading with the distance: on an even slope
    // their mean is the level itself; across a step it runs through the middle of the step.
    const below = new Float64Array(count), above = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      blend[i] = 1 / (1 + (PROFILE_SMOOTHING * Math.max(wide[i], cell)) / cell);
      // Beyond a mouth lies the sea, level; beyond the border the river falls on as it came.
      below[i] = down[i] < 0 ? (kept[i] ? level[i] : beyond(level, i, main)) : blend[i] * level[i] + (1 - blend[i]) * below[down[i]];
    }
    for (let i = count - 1; i >= 0; i--) above[i] = main[i] < 0 ? level[i] : blend[i] * level[i] + (1 - blend[i]) * above[main[i]];
    // How far that mean lies above the level, and the most it does so nearby, fading with the distance likewise:
    // taken off the mean, it leaves a profile that is nowhere above the level, has no step where the level has
    // one, and passes under a flight of pools along their floors.
    const excess = new Float64Array(count), near = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      below[i] = 0.5 * (below[i] + above[i]);
      excess[i] = Math.max(below[i] - level[i], 0);
    }
    for (let i = 0; i < count; i++) near[i] = down[i] < 0 ? excess[i] : Math.max(excess[i], (1 - blend[i]) * near[down[i]]);
    above.fill(0);
    for (let i = count - 1; i >= 0; i--) {
      const most = Math.max(excess[i], above[i]);
      // No lower than PROFILE_DEPTH widths below where the river lay: it saws through the rim of a pool, not through a cliff.
      if (!kept[i]) level[i] = Math.max(below[i] - Math.max(most, near[i]), level[i] - (PROFILE_DEPTH * wide[i]) / range, sea);
      if (down[i] >= 0) above[down[i]] = Math.max(above[down[i]], (1 - blend[down[i]]) * most);
    }
    // Once more from the mouths up, with the levels as the smoothing left them: inside another river that
    // river's level, nowhere below the level downstream, and no valley shallower than the one it leads to allows.
    for (let i = 0; i < count; i++) {
      const to = down[i];
      if (to < 0) continue;
      if (inside[i]) { level[i] = level[to]; continue; }
      if (!kept[i]) {
        const below = Math.max((filled[order[to]] - level[to]) * range - grade - Math.max(filled[order[i]] - filled[order[to]], 0) * range, 0);
        level[i] = Math.min(level[i], Math.max(filled[order[i]] - below / range, sea));
      }
      if (level[to] > level[i]) level[i] = level[to];
    }
    env.progress(0.8);

    // The sites: points along every course, SITE_SPACING apart at the most, one in every texel a course passes
    // through; each knows the site before it and the one after it on its river. A point in the texel of the
    // site before it, or in a texel another river's site has taken, is left out.
    let deepest = 0;
    for (let i = 0; i < count; i++) {
      // How far the river lies below the routing surface in the end: as high above the water its sides are cut.
      cut[i] = Math.max((filled[order[i]] - level[i]) * range, 0);
      deepest = Math.max(deepest, cut[i]);
    }
    let texels = new Int32Array(1 << 12), links = new Int32Array(1 << 12), rises = new Float64Array(1 << 12), made = 0;
    const last = new Int32Array(count).fill(-1);   // the site farthest up the river that stands for a place
    const place = new Float32Array(n);
    area.fill(0);
    const put = (v: number, x: number, y: number, a: number, l: number, rise: number, before: number): number => {
      if (made === texels.length) {
        const t = new Int32Array(made * 2), k = new Int32Array(made * 2), r = new Float64Array(made * 2);
        t.set(texels); k.set(links); r.set(rises);
        texels = t; links = k; rises = r;
      }
      area[v] = a;
      filled[v] = l;
      place[v] = Math.round((x - (v % res) + 0.5) * (PLACE_STEPS - 1)) + PLACE_STEPS * Math.round((y - Math.floor(v / res) + 0.5) * (PLACE_STEPS - 1));
      texels[made] = v;
      rises[made] = rise;
      // The link down the river now, the link up it when the next site of the main course is made.
      let down = NO_LINK;
      if (before >= 0) {
        const dx = (texels[before] % res) - (v % res), dy = Math.floor(texels[before] / res) - Math.floor(v / res);
        if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) down = (dy + 1) * 3 + (dx + 1);
      }
      links[made] = down + 9 * NO_LINK;
      return made++;
    };
    for (let i = 0; i < count; i++) {
      const to = down[i];
      let before = to < 0 ? -1 : last[to];
      const first = before;
      if (share[i] > 0) {
        // From the place downstream to this one, which is the last point; a river's first place stands alone.
        const fx = to < 0 ? px[i] : px[to], fy = to < 0 ? py[i] : py[to];
        const pieces = Math.max(Math.ceil(Math.hypot(px[i] - fx, py[i] - fy) / SITE_SPACING), 1);
        for (let k = 1; k <= pieces; k++) {
          const t = k / pieces;
          const x = fx + t * (px[i] - fx), y = fy + t * (py[i] - fy);
          const v = Math.round(x) + res * Math.round(y);
          if ((before >= 0 && texels[before] === v) || area[v] !== 0) continue;
          const from = to < 0 ? i : to;
          const made1 = put(
            v, x, y,
            (inside[i] ? -1 : 1) * (share[from] + t * (share[i] - share[from])),
            level[from] + t * (level[i] - level[from]),
            cut[from] + t * (cut[i] - cut[from]),
            before,
          );
          // Up the river from the site before: this one, where it continues the same river and no other site did.
          if (before >= 0 && (before !== first || main[to] === i) && links[before] >= 9 * NO_LINK && links[before] < 9 * (NO_LINK + 1)) {
            const dx = (v % res) - (texels[before] % res), dy = Math.floor(v / res) - Math.floor(texels[before] / res);
            if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) links[before] += 9 * ((dy + 1) * 3 + (dx + 1) - NO_LINK);
          }
          before = made1;
        }
      }
      last[i] = before;
    }
    for (let k = 0; k < made; k++) {
      height[texels[k]] = links[k] + 81 * (deepest > 0 ? Math.round((rises[k] / deepest) * (RISE_STEPS - 1)) : 0);
    }
    env.progress(1);
    return { level: filled, share: area, course: height, place, deepest };
  },
});
