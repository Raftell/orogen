import { defineKernel, type AnyKernel } from '../gpu/kernel.ts';
import type { PoolTexture } from '../gpu/pool.ts';
import type { FieldStats } from './context.ts';
import type { EngineParts } from './parts.ts';
import { runKernel } from './service.ts';

/** Side of the block one record reduces (runtime.md 5.7 rule 4). */
const BLOCK = 32;

// One record per block: (min, max, sum, count of non-finite texels) over the block's finite texels. A block
// that lies outside the source, or holds no finite texel, has min > max. Rows are summed one by one, which
// keeps the float32 sum of a block accurate; the blocks are combined in float64 on the CPU.
const reduce = defineKernel({
  name: 'core/stats',
  inputs: { src: { kind: 'field', size: 'any' } },
  outputs: { out: 'aux' },
  cost: BLOCK * BLOCK,
  code: /* wgsl */ `
const BLOCK = ${BLOCK};

fn compute(px: vec2i, uv: vec2f) -> vec4f {
  let size = vec2i(src_res());
  let p0 = px * BLOCK;
  let p1 = min(p0 + vec2i(BLOCK), size);
  var lo = 3.4028234e38;
  var hi = -3.4028234e38;
  var sum = 0.0;
  var bad = 0.0;
  for (var y = p0.y; y < p1.y; y++) {
    var row = 0.0;
    for (var x = p0.x; x < p1.x; x++) {
      let v = src_at(vec2i(x, y));
      // The integer test survives a compiler that folds v != v away.
      if ((bitcast<u32>(v) & 0x7f800000u) == 0x7f800000u) {
        bad += 1.0;
      } else {
        lo = min(lo, v);
        hi = max(hi, v);
        row += v;
      }
    }
    sum += row;
  }
  return vec4f(lo, hi, sum, bad);
}`,
});

/** The kernels of this module, for createEngine to compile. */
export function statsKernels(): readonly AnyKernel[] {
  return [reduce];
}

/** Combines the records of the reduction, in float64. `texels` is the size of the reduced field. */
export function combineStats(records: Float32Array, texels: number): FieldStats {
  let min = Infinity, max = -Infinity, sum = 0, nonFinite = 0;
  for (let i = 0; i + 3 < records.length; i += 4) {
    const lo = records[i]!, hi = records[i + 1]!;
    nonFinite += records[i + 3]!;
    if (lo > hi) continue;
    if (lo < min) min = lo;
    if (hi > max) max = hi;
    sum += records[i + 2]!;
  }
  const finite = texels - nonFinite;
  // A field without a finite texel has no minimum; 0 keeps the record plain numbers.
  if (finite <= 0 || min > max) return { min: 0, max: 0, mean: 0, nonFinite };
  return { min, max, mean: sum / finite, nonFinite };
}

/**
 * ctx.stats and Engine.stats (runtime.md 5.7 rule 4): reduced on the GPU to one record per 32 × 32 block and
 * combined on the CPU in float64. Encodes for the stream's current owner. `texture` has one channel.
 */
export async function fieldStats(parts: EngineParts, texture: PoolTexture, signal?: AbortSignal): Promise<FieldStats> {
  const owner = parts.stream.current;
  if (!owner) throw new Error('No stream owner is current: statistics are encoded for an owner');
  // Kernels write square grids: blocks beyond the source of a field that is not square reduce nothing.
  const side = Math.max(Math.ceil(texture.width / BLOCK), Math.ceil(texture.height / BLOCK));
  const records = parts.pool.acquire('aux', side, side);
  try {
    runKernel(parts, 'stats', reduce, { in: { src: texture }, out: { out: records } });
    const data = await parts.readback.read(records, undefined, signal);
    return combineStats(data, texture.width * texture.height);
  } finally {
    parts.pool.release(records);
  }
}
