// src/core/nodes/ref/talus.ts
import { defineKernel, defineNode, param } from '../../api.ts';

const step = defineKernel({
  name: 'ref/talus.step',
  inputs: { h: 'field' },          // current heights: read with neighbours
  outputs: { next: 'field' },      // new heights: the other half of the ping-pong pair
  inPlace: { moved: 'field' },     // accumulator: read and written at the own texel only
  params: { talus: 'f32', rate: 'f32' },
  cost: 33,                        // per texel: its own height, and for each of its eight pairs the neighbour and the two or four heights beside the pair
  code: /* wgsl */ `
// Height this texel receives from its neighbour at offset o (negative: gives).
// A pair exchanges the share of its height difference by which the slope at its
// middle is above the talus slope. That slope has two parts: along the pair the
// difference of the two heights, and across it the other diagonal of the cell
// the two share, or for a pair in a row or column the mean of the two central
// differences beside it. Measured between the two texels alone, a slope that
// faces between a row and a diagonal is gentler than it is, and a heap comes to
// rest as an octagon. Seen from the other texel the sums are the same and the
// differences only change sign, so both compute the same magnitude with
// opposite sign and the total is conserved.
fn exchange(px: vec2i, hp: f32, o: vec2i) -> f32 {
  let q = px + o;
  if (!inGrid(q)) { return 0.0; }
  let along = h_at(q) - hp;
  var across: f32;
  var run = 1.0;                   // texels between the two
  if (o.x != 0 && o.y != 0) {
    across = h_at(px + vec2i(o.x, 0)) - h_at(px + vec2i(0, o.y));
    run = sqrt(2.0);
  } else {
    let e = vec2i(abs(o.y), abs(o.x));
    across = 0.25 * ((h_at(px + e) + h_at(q + e)) - (h_at(px - e) + h_at(q - e)));
  }
  let steep = sqrt(along * along + across * across) / run;
  if (steep <= P.talus) { return 0.0; }
  return along * (steep - P.talus) / steep * P.rate / run;
}

// moved accumulates the height that crossed the texel: half of what it gave and
// received, so that material passing through counts once. The net change is no
// measure of it: along a uniform slope what a texel receives and gives cancel,
// and what is left halves with the cell.
fn compute(px: vec2i, uv: vec2f, cur: Cur) -> Out {
  let hp = h_at(px);
  var net = 0.0;
  var gross = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      if (i != 0 || j != 0) {
        let e = exchange(px, hp, vec2i(i, j));
        net += e;
        gross += abs(e);
      }
    }
  }
  return Out(hp + net, cur.moved + 0.5 * gross);
}`,
});

export default defineNode({
  type: 'ref/talus',
  title: 'Talus (Reference)',
  category: 'ref',
  description: 'Relaxes slopes steeper than the talus angle and maps the height that crossed each texel; the reference node for iterative simulations.',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [
    { name: 'out', type: 'field' },
    { name: 'moved', type: 'field', role: 'data' },
  ],
  params: [
    param.slope('talus', { label: 'Talus angle', default: 35, help: 'Slopes steeper than this collapse.' }),
    {
      kind: 'float', name: 'reach', label: 'Reach', unit: 'length', default: 0.02, min: 0.001, max: 0.25, scale: 'log',
      help: 'How far material can travel downslope.',
    },
  ],
  kernels: [step],
  maskable: true,
  async evaluate(ctx) {
    const { talus, reach } = ctx.params;

    // All state is allocated before the loop.
    let a = ctx.clone(ctx.input('in'));      // writable copy: the input itself is read-only
    let b = ctx.alloc('field');              // contents undefined: every texel is written before it is read
    const moved = ctx.wants('moved') ? ctx.alloc('field', { clear: 0 }) : null;

    const params = {
      talus: Math.tan((talus * Math.PI) / 180) * ctx.cellSize / ctx.heightRange,   // height units per texel
      rate: 0.1,
    };
    const iterations = Math.ceil(ctx.lengthToPx(reach));   // material moves at most one texel per iteration

    await ctx.loop(iterations, () => {
      ctx.run(step, { in: { h: a }, out: { next: b }, rw: { moved }, params });
      [a, b] = [b, a];                       // a always holds the latest complete state
    }, { preview: () => ({ out: a }) });

    ctx.release(b);
    ctx.output('out', a);
    if (moved) ctx.output('moved', moved);
  },
});
