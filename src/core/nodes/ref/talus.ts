// src/core/nodes/ref/talus.ts
import { defineKernel, defineNode, param } from '../../api.ts';

const step = defineKernel({
  name: 'ref/talus.step',
  inputs: { h: 'field' },          // current heights: read with neighbours
  outputs: { next: 'field' },      // new heights: the other half of the ping-pong pair
  inPlace: { moved: 'field' },     // accumulator: read and written at the own texel only
  params: { talus: 'f32', rate: 'f32' },
  code: /* wgsl */ `
// Height this texel receives from neighbour q (negative: gives). The amount
// depends only on the two heights, so both texels compute the same magnitude
// with opposite sign and the total is conserved.
fn exchange(hp: f32, q: vec2i, dist: f32) -> f32 {
  if (!inGrid(q)) { return 0.0; }
  let d = h_at(q) - hp;
  return sign(d) * max(abs(d) - P.talus * dist, 0.0) * P.rate / dist;
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
        let e = exchange(hp, px + vec2i(i, j), length(vec2f(vec2i(i, j))));
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
