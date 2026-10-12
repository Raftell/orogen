// src/core/nodes/ref/distance.ts
import { defineCpuTask, defineNode } from '../../api.ts';

// The exact Euclidean distance transform of a square grid, in place: `data` arrives as a mask and leaves as
// distances. A texel is selected when its value is at least 0.5; `span` is the number of texels in a length of 1.
// Pure: the result depends on the arguments only, and the function runs in another thread.
const transform = defineCpuTask({
  name: 'ref/distance',
  run({ data, size, span }: { data: Float32Array; size: number; span: number }, env): Float32Array {
    const n = size;
    const far = 2 * n;   // longer than any distance on the grid: a column without a selected texel

    // Down the columns, then up: the distance along the column to its nearest selected texel.
    let any = false;
    for (let i = 0; i < n * n; i++) {
      const selected = data[i] >= 0.5;
      any ||= selected;
      data[i] = selected ? 0 : i < n ? far : Math.min(data[i - n] + 1, far);
    }
    if (!any) return data.fill(Math.SQRT2);   // nothing is selected: the diagonal of the terrain, which no distance exceeds
    for (let i = n * n - n - 1; i >= 0; i--) data[i] = Math.min(data[i], data[i + n] + 1);

    // Along each row the squared distance is the lower envelope of the parabolas (x - p)^2 + column(p)^2
    // (Felzenszwalb and Huttenlocher). Squares of whole numbers of texels are exact in float64.
    const square = new Float64Array(n);
    const at = new Int32Array(n);            // the columns whose parabolas form the envelope, left to right
    const from = new Float64Array(n + 1);    // where each takes over from the one before it
    for (let y = 0; y < n; y++) {
      const row = y * n;
      for (let x = 0; x < n; x++) square[x] = data[row + x] ** 2;
      const meet = (p: number, q: number): number => (square[q] + q * q - square[p] - p * p) / (2 * (q - p));
      let k = 0;
      at[0] = 0;
      from[0] = -Infinity;
      from[1] = Infinity;
      for (let q = 1; q < n; q++) {
        let s = meet(at[k], q);
        while (s <= from[k]) s = meet(at[--k], q);   // from[0] is -Infinity: k stays at 0 or above
        at[++k] = q;
        from[k] = s;
        from[k + 1] = Infinity;
      }
      k = 0;
      for (let x = 0; x < n; x++) {
        while (from[k + 1] < x) k++;
        const p = at[k];
        data[row + x] = Math.sqrt((x - p) ** 2 + square[p]) / span;
      }
      if ((y & 63) === 63) env.progress((y + 1) / n);
    }
    return data;
  },
});

export default defineNode({
  type: 'ref/distance',
  title: 'Distance (Reference)',
  category: 'ref',
  description: 'Measures the distance to the nearest selected point, as a fraction of the terrain width; the reference node for CPU tasks.',
  keywords: ['distance field', 'edt', 'proximity', 'falloff'],
  inputs: [{ name: 'in', type: 'field', role: 'mask' }],
  outputs: [{ name: 'out', type: 'field', role: 'data' }],
  params: [],
  kernels: [],
  cpuTasks: [transform],
  async evaluate(ctx) {
    const out = ctx.alloc('field');                  // first: a node that does not fit the budget fails before the CPU works
    const mask = await ctx.read(ctx.input('in'));    // waits for the work that produces the input
    // The buffer is moved to the task, not copied: `mask` is unusable from here on.
    const distances = await ctx.cpu(transform, { data: mask, size: ctx.res, span: ctx.lengthToPx(1) }, [mask.buffer]);
    ctx.write(out, distances);
    ctx.output('out', out);
  },
});
