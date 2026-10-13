// src/core/nodes/surface/scatter.ts
import { defineKernel, defineNode, hashCell, hashUnit, ops, param, type Field } from '../../api.ts';

/** The hard maximum of `count`: the constant bound of the kernel's loop over the copies. */
const MAX_COPIES = 256;
/** The stamp and its reductions by 2: a copy is read from the two whose texels are nearest in size to those of the grid. */
const LEVELS = 6;

/** The constants of the node, which the tests read. */
export const SCATTER = {
  /** A copy is round: it is whole up to this far from its middle, in stamp widths, and fades out from there to the edge of the stamp, 0.5 from it. */
  whole: 0.35,
} as const;

/** One copy of the stamp: where its middle lies, how wide it is as a length, and its turn as a unit vector. */
export interface Copy { readonly x: number; readonly y: number; readonly size: number; readonly cos: number; readonly sin: number }

/**
 * The copies of a seed. Copy `i` depends on the seed and on `i` alone: more copies leave the first ones as they
 * are, and every grid has them in the same places. Sizes are spread evenly over the octaves between the two ends.
 */
export function scatterCopies(seed: number, count: number, sizeMin: number, sizeMax: number): Copy[] {
  const least = Math.min(sizeMin, sizeMax), most = Math.max(sizeMin, sizeMax);
  const copies: Copy[] = [];
  for (let i = 0; i < Math.min(count, MAX_COPIES); i++) {
    const u = (k: number): number => hashUnit(hashCell(i, k, seed));
    const turn = 2 * Math.PI * u(3);
    copies.push({ x: u(0), y: u(1), size: least * (most / least) ** u(2), cos: Math.cos(turn), sin: Math.sin(turn) });
  }
  return copies;
}

const levelInputs = { kind: 'field', size: 'any' } as const;

const scatter = defineKernel({
  name: 'surface/scatter',
  // s0: the stamp. s1 to s5: the stamp reduced by 2, 4, 8, 16 and 32.
  inputs: { src: 'field', s0: levelInputs, s1: levelInputs, s2: levelInputs, s3: levelInputs, s4: levelInputs, s5: levelInputs },
  outputs: { out: 'field' },
  // mode: the index of the option. levels: how many of s0 to s5 differ.
  params: { mode: 'u32', levels: 'f32' },
  luts: { copies: 'vec4f' },
  code: /* wgsl */ `
const MAX_COPIES = ${MAX_COPIES}u;
const WHOLE = ${SCATTER.whole};

fn reduced(level: i32, at: vec2f) -> f32 {
  switch (level) {
    case 0: { return s0_uv(at); }
    case 1: { return s1_uv(at); }
    case 2: { return s2_uv(at); }
    case 3: { return s3_uv(at); }
    case 4: { return s4_uv(at); }
    default: { return s5_uv(at); }
  }
}

fn compute(px: vec2i, uv: vec2f) -> f32 {
  let n = min(copies_len() / 2u, MAX_COPIES);
  var sum = 0.0;
  var most = 0.0;
  for (var i = 0u; i < MAX_COPIES; i++) {
    if (i >= n) { break; }
    let place = copies_item(2u * i);                 // the middle, the size
    let d = (uv - place.xy) / place.z;
    let far = length(d);
    if (far >= 0.5) { continue; }
    let turn = copies_item(2u * i + 1u).xy;
    // Where this texel lies on the stamp, turned back.
    let at = vec2f(d.x * turn.x + d.y * turn.y, d.y * turn.x - d.x * turn.y) + vec2f(0.5);
    // A copy smaller than the stamp is read from a reduction of it whose texels are as large as the grid's:
    // read from the stamp itself, it would be every so-manieth texel of it, and its fine detail would be noise.
    let level = clamp(-log2(place.z), 0.0, P.levels - 1.0);
    let lower = i32(floor(level));
    let value = mix(reduced(lower, at), reduced(lower + 1, at), level - floor(level));
    // As tall for its width as the stamp is, and round: whole in the middle, faded out towards the stamp's edge.
    let copy = value * place.z * (1.0 - smoothstep(WHOLE, 0.5, far));
    sum += copy;
    most = max(most, copy);
  }
  let ground = src_at(px);
  switch (P.mode) {                     // the index of the option, in the order the node lists them
    case 1u: { return ground + most; }
    case 2u: { return ground - sum; }
    default: { return ground + sum; }
  }
}`,
});

export default defineNode({
  type: 'surface/scatter',
  title: 'Scatter',
  category: 'surface',
  description: 'Stamps round copies of a second terrain over the first, each at a random place, size and turn, and as tall for its width as the stamp.',
  keywords: ['stamp', 'instances', 'copies', 'distribute', 'place', 'clone', 'populate', 'sprinkle'],
  inputs: [
    { name: 'in', type: 'field' },
    { name: 'stamp', type: 'field' },
  ],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    { kind: 'int', name: 'count', label: 'Count', default: 24, min: 1, max: MAX_COPIES, help: 'How many copies are stamped. More copies leave the first ones where they are.' },
    param.size({ name: 'sizeMin', label: 'Smallest size', default: 0.08, min: 0.005, max: 1, soft: false, help: 'How wide the smallest copies are. A copy is as much lower than the stamp as it is narrower.' }),
    param.size({ name: 'sizeMax', label: 'Largest size', default: 0.3, min: 0.005, max: 1, soft: false, help: 'How wide the largest copies are. At 1 a copy is as large as the stamp.' }),
    {
      kind: 'enum', name: 'mode', label: 'Mode', default: 'add',
      // Stored in documents: values are never renamed or reordered, and new ones are appended.
      options: [
        { value: 'add', label: 'Add' },
        { value: 'maximum', label: 'Maximum' },
        { value: 'subtract', label: 'Subtract' },
      ],
      help: 'Add piles the copies on the terrain and on each other, maximum lets the taller of two overlapping copies stand, subtract carves them out.',
    },
    param.seed(),
  ],
  kernels: [scatter],
  maskable: true,
  evaluate(ctx) {
    const { count, sizeMin, sizeMax } = ctx.params;
    const src = ctx.input('in');
    const stamp = ctx.input('stamp');
    // The stamp and its reductions: each from the one before with the triangle filter, down to a few texels.
    const levels: Field<'field'>[] = [stamp];
    while (levels.length < LEVELS && levels.at(-1)!.width >= 8) {
      levels.push(ops.resample(ctx, levels.at(-1)!, { size: Math.floor((levels.at(-1)!.width + 1) / 2), filter: 'tent' }));
    }
    const level = (k: number): Field<'field'> => levels[Math.min(k, levels.length - 1)]!;
    const copies = scatterCopies(ctx.seed, count, sizeMin, sizeMax);
    const table = new Float32Array(8 * count);
    let covered = 0;
    copies.forEach((copy, i) => {
      table.set([copy.x, copy.y, copy.size, 0, copy.cos, copy.sin, 0, 0], 8 * i);
      covered += Math.min((Math.PI / 4) * copy.size * copy.size, 1);
    });
    const out = ctx.alloc('field');
    ctx.run(scatter, {
      in: { src, s0: level(0), s1: level(1), s2: level(2), s3: level(3), s4: level(4), s5: level(5) },
      out: { out },
      params: { mode: ctx.enumIndex('mode'), levels: levels.length },
      luts: { copies: ctx.lut(table, 'vec4f') },
      // The terrain, two table reads a copy, and two readings between four texels for every copy that covers a texel.
      cost: 1 + 2 * count + 8 * covered,
    });
    for (const reduced of levels.slice(1)) ctx.release(reduced);
    ctx.output('out', out);
  },
});
