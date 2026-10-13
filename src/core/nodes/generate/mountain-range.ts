// src/core/nodes/generate/mountain-range.ts
import { defineNode, param } from '../../api.ts';
import { landRandom, SegmentList } from './_land.ts';
import { massif, MAX_SEGMENTS, runMassif } from './_land-massif.ts';

/** With this many peaks the skeleton stays within the kernel's bound on crest segments. */
const MAX_PEAKS = 12;

/** A spur: two segments that leave (x, y) at `angle` and descend from `height` to the ground, with a side branch. */
function spur(list: SegmentList, random: () => number, x: number, y: number, height: number, angle: number, length: number): void {
  const bend = angle + 0.7 * (random() - 0.5);
  const mx = x + Math.cos(angle) * length * 0.5, my = y + Math.sin(angle) * length * 0.5;
  const ex = mx + Math.cos(bend) * length * 0.5, ey = my + Math.sin(bend) * length * 0.5;
  const mid = height * (0.4 + 0.15 * random());
  list.add(x, y, mx, my, height, mid);
  list.add(mx, my, ex, ey, mid, height * 0.1);
  // The branch leaves the knee of the spur, away from the bend.
  const fork = angle + (bend > angle ? -1 : 1) * (0.7 + 0.4 * random());
  const reach = length * (0.3 + 0.2 * random());
  list.add(mx, my, mx + Math.cos(fork) * reach, my + Math.sin(fork) * reach, mid, mid * 0.2);
}

interface Knot { readonly x: number; readonly y: number; readonly h: number }

/**
 * The crest from one knot to the next. Where peaks stand far apart it does not run straight and even between
 * them: it is laid in up to `pieces` shorter ones that wander a little to either side and up and down.
 */
function crest(list: SegmentList, random: () => number, from: Knot, to: Knot, pieces: number): void {
  const count = Math.min(Math.max(Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 0.7), 1), pieces);
  let at = from;
  for (let k = 1; k <= count; k++) {
    const t = k / count;
    const knot = k === count ? to : {
      x: from.x + (to.x - from.x) * t + 0.16 * (random() - 0.5),
      y: from.y + (to.y - from.y) * t + 0.16 * (random() - 0.5),
      // Never above the higher of the two ends: the peaks stay the summits of the crest.
      h: Math.min((from.h + (to.h - from.h) * t) * (0.82 + 0.26 * random()), Math.max(from.h, to.h)),
    };
    list.add(at.x, at.y, knot.x, knot.y, at.h, knot.h);
    at = knot;
  }
}

/**
 * The crests of a range in its own frame: the main crest winds along the x axis from -halfLength to halfLength
 * through `count` peaks with saddles between them, and spurs leave it to both sides, about 1 long. The highest
 * peak is at height 1.
 */
function crests(seed: number, count: number, halfLength: number): SegmentList {
  const random = landRandom(seed, 1);
  const list = new SegmentList();
  const spacing = (2 * halfLength) / count;

  // What the kernel's bound on crest segments leaves for the crest between the peaks, once every spur is laid.
  const pieces = count > 1 ? Math.max(1, Math.floor((MAX_SEGMENTS - 2 - 6 * count - 3 * (count - 1)) / (2 * (count - 1)))) : 1;

  const peaks: { x: number; y: number; h: number }[] = [];
  let highest = 0;
  for (let i = 0; i < count; i++) {
    const along = (i + 0.5) / count;
    // Peaks stand lower towards the two ends of the range.
    const taper = 0.55 + 0.45 * Math.sin(Math.PI * along) ** 0.7;
    const peak = {
      x: -halfLength + (i + 0.5 + 0.5 * (random() - 0.5)) * spacing,
      y: 0.4 * (random() - 0.5),
      h: taper * (0.7 + 0.3 * random()),
    };
    highest = Math.max(highest, peak.h);
    peaks.push(peak);
  }
  for (const peak of peaks) peak.h /= highest;

  // The two ends: the crest runs out to the ground beyond the first and the last peak.
  const first = peaks[0]!, last = peaks[count - 1]!;
  const run = Math.min(0.5 * spacing + 0.4, 1.2);
  list.add(first.x, first.y, first.x - run, first.y + 0.4 * (random() - 0.5), first.h, 0.08);
  list.add(last.x, last.y, last.x + run, last.y + 0.4 * (random() - 0.5), last.h, 0.08);

  for (let i = 0; i < count; i++) {
    const peak = peaks[i]!;
    for (const side of [1, -1]) {
      const angle = side * (Math.PI / 2 + 0.9 * (random() - 0.5));
      spur(list, random, peak.x, peak.y, peak.h, angle, (0.6 + 0.35 * random()) * (0.5 + 0.5 * peak.h));
    }
    if (i + 1 === count) break;
    // A saddle between this peak and the next, off the straight line between them.
    const next = peaks[i + 1]!;
    const t = 0.35 + 0.3 * random();
    const saddle = {
      x: peak.x + (next.x - peak.x) * t,
      y: peak.y + (next.y - peak.y) * t + 0.3 * (random() - 0.5),
      h: Math.min(peak.h, next.h) * (0.68 + 0.2 * random()),
    };
    crest(list, random, peak, saddle, pieces);
    crest(list, random, saddle, next, pieces);
    if (random() < 0.6) {
      const side = random() < 0.5 ? 1 : -1;
      spur(list, random, saddle.x, saddle.y, saddle.h, side * (Math.PI / 2 + 0.6 * (random() - 0.5)), 0.4 + 0.25 * random());
    }
  }
  return list;
}

export default defineNode({
  type: 'generate/mountain-range',
  title: 'Mountain Range',
  category: 'generate',
  description: 'Generates an elongated chain of peaks along one crest, with spurs that fall away to both sides.',
  keywords: ['chain', 'cordillera', 'sierra', 'ridge', 'alpine', 'peaks'],
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    param.angle({ help: 'The direction the crest of the range runs in.' }),
    param.size({ label: 'Width', default: 0.55, min: 0.05, max: 2, help: 'Larger values make the range wider, from foot to foot.' }),
    {
      kind: 'float', name: 'length', label: 'Length', unit: 'length', default: 1.3, min: 0.1, max: 4, scale: 'log', soft: true,
      help: 'Larger values make the chain longer; a range longer than the terrain runs off both borders.',
    },
    param.height({ default: 0.75, help: 'Larger values raise the highest peak.' }),
    {
      kind: 'int', name: 'count', label: 'Peaks', default: 6, min: 1, max: MAX_PEAKS,
      help: 'How many peaks stand along the crest.',
    },
    {
      kind: 'float', name: 'sharpness', label: 'Sharpness', unit: 'ratio', default: 0.5, min: 0, max: 1,
      help: 'Larger values give pointed peaks and knife-edged crests; smaller ones a rounded, worn range.',
    },
    {
      kind: 'float', name: 'erosion', label: 'Erosion', unit: 'ratio', default: 0.6, min: 0, max: 1,
      help: 'Larger values cut deeper gullies into the flanks.',
    },
    param.seed(),
  ],
  kernels: [massif],
  evaluate(ctx) {
    const { angle, size, length, height, count, sharpness, erosion } = ctx.params;
    const radius = Math.max(size, 0.001) / 2;
    // The crest is shorter than the range by the run-out beyond its last peaks; a range is never shorter than wide.
    const halfLength = Math.max(Math.min(Math.max(length, 0), 16) / (2 * radius) - 1, 0.25);
    ctx.output('out', runMassif(ctx, {
      crests: crests(ctx.seed, count, halfLength),
      // At a peak: the crest to either side and a spur to either side.
      meeting: 4,
      center: [0.5, 0.5],
      angle,
      radius,
      height,
      pinned: false,
      sharpness,
      ridges: 0.5,
      erosion,
    }));
  },
});
