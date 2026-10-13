// src/core/nodes/generate/mountain.ts
import { defineNode, param } from '../../api.ts';
import { landRandom, SegmentList } from './_land.ts';
import { massif, runMassif } from './_land-massif.ts';

const TAU = 2 * Math.PI;

/**
 * The crests of a massif in its own frame: main ridges that leave the summit at the origin and descend to
 * their tips about 1 away, each with spurs to either side. Heights are 1 at the summit; a sharper massif has
 * crests that drop faster from it.
 */
function crests(seed: number, sharpness: number): { list: SegmentList; mains: number } {
  const random = landRandom(seed, 1);
  const list = new SegmentList();
  const mains = 5 + Math.floor(random() * 3);
  const turn = random() * TAU;
  const drop = 1.4 - 0.5 * sharpness;
  for (let i = 0; i < mains; i++) {
    let angle = turn + ((i + 0.7 * (random() - 0.5)) / mains) * TAU;
    const length = 0.6 + 0.5 * random();
    const parts = 4;
    let x = 0, y = 0, height = 1;
    let side = random() < 0.5 ? 1 : -1;
    for (let k = 1; k <= parts; k++) {
      const step = (length / parts) * (0.8 + 0.4 * random());
      const nx = x + Math.cos(angle) * step, ny = y + Math.sin(angle) * step;
      const along = k / parts;
      // A crest steps down from knot to knot towards its tip; a knot may stand a little proud of the line.
      const nextHeight = Math.max(0.1, 1 - 0.85 * along ** drop + (k < parts ? 0.08 * (random() - 0.4) : 0));
      list.add(x, y, nx, ny, height, nextHeight);
      if (k < parts) {
        spur(list, random, nx, ny, nextHeight, angle + side * (0.8 + 0.6 * random()), 0.2 + 0.25 * random());
        side = -side;
      }
      x = nx;
      y = ny;
      height = nextHeight;
      angle += 0.9 * (random() - 0.5);
    }
  }
  return { list, mains };
}

function spur(list: SegmentList, random: () => number, x: number, y: number, height: number, angle: number, length: number): void {
  const bend = angle + 0.8 * (random() - 0.5);
  const mx = x + Math.cos(angle) * length * 0.5, my = y + Math.sin(angle) * length * 0.5;
  const ex = mx + Math.cos(bend) * length * 0.5, ey = my + Math.sin(bend) * length * 0.5;
  const mid = height * (0.6 + 0.15 * random());
  list.add(x, y, mx, my, height, mid);
  list.add(mx, my, ex, ey, mid, height * 0.2);
}

export default defineNode({
  type: 'generate/mountain',
  title: 'Mountain',
  category: 'generate',
  description: 'Generates one massif: a summit with ridges and spurs that fall away into gullied valleys.',
  keywords: ['peak', 'massif', 'summit', 'alpine', 'ridge'],
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    {
      kind: 'vec2', name: 'center', label: 'Center', unit: 'length', default: [0.5, 0.5], min: 0, max: 1, soft: true,
      help: 'Where the summit stands on the terrain.',
    },
    param.size({ label: 'Base width', default: 0.9, min: 0.05, max: 2, help: 'Larger values spread the massif over more of the terrain.' }),
    param.height({ default: 0.9, help: 'Larger values raise the summit.' }),
    {
      kind: 'float', name: 'sharpness', label: 'Sharpness', unit: 'ratio', default: 0.5, min: 0, max: 1,
      help: 'Larger values give a pointed summit and knife-edged crests; smaller ones a rounded, worn massif.',
    },
    {
      kind: 'float', name: 'ridges', label: 'Ridges', unit: 'ratio', default: 0.5, min: 0, max: 1,
      help: 'Larger values make the ridges stand higher above the valleys between them.',
    },
    {
      kind: 'float', name: 'erosion', label: 'Erosion', unit: 'ratio', default: 0.6, min: 0, max: 1,
      help: 'Larger values cut deeper gullies into the flanks.',
    },
    param.seed(),
  ],
  kernels: [massif],
  evaluate(ctx) {
    const { center, size, height, sharpness, ridges, erosion } = ctx.params;
    const { list, mains } = crests(ctx.seed, sharpness);
    ctx.output('out', runMassif(ctx, {
      crests: list,
      meeting: mains,
      center,
      angle: 0,
      radius: Math.max(size, 0.001) / 2,
      height,
      pinned: true,
      sharpness,
      ridges,
      erosion,
    }));
  },
});
