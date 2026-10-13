// tests/nodes/simulate/_route-reference.ts
// The router of simulation.md 6.2 written as the document states it, step by step, for grids of test size: every
// texel passes through a heap ordered by (filled, texel index), receivers are chosen by the printed code, the
// flats are resolved by Dijkstra's algorithm over a sorted list, and the area is summed donors first. The task of
// the product computes the same surface and the same receivers with less work; the tests hold it to this one.
// Nothing here touches the GPU.
import { hashCell, hashUnit } from '../../../src/core/api.ts';
import { ROUTE_FLAT_COST, ROUTE_FLAT_DROPS, ROUTE_FLAT_JITTER, ROUTE_FLAT_SHORE } from '../../../src/core/nodes/simulate/_route.ts';

/** The N4 offsets in the order of simulation.md 1.3. */
export const N4: readonly (readonly [number, number])[] = [[1, 0], [0, 1], [-1, 0], [0, -1]];

export interface Routed {
  readonly filled: Float32Array;
  /** The N4 index of the receiver, or 4 for none. Only for routing 'single'; otherwise every code is 4. */
  readonly receiver: Uint8Array;
  /** 1 on the border ring and where the terrain is at or below the sea level. */
  readonly outlet: Uint8Array;
  /** 1 where the texel lies on a flat (6.2 step 3). Only for routing 'single'. */
  readonly flat: Uint8Array;
  readonly area: Float32Array | null;
}

export interface RouteInput {
  readonly height: Float32Array;
  readonly res: number;
  readonly eps: number;
  readonly seaLevel: number;
  readonly routing: 'none' | 'single' | 'multiple';
  readonly seed: number;
  readonly weight?: Float32Array;
}

/** The index of the N4 neighbour k of texel i, or -1 outside the grid. */
export function neighbour(i: number, k: number, res: number): number {
  const x = (i % res) + N4[k]![0], y = Math.floor(i / res) + N4[k]![1];
  return x < 0 || y < 0 || x >= res || y >= res ? -1 : y * res + x;
}

/** The outlets of simulation.md 1.3. */
export function outletsOf(height: Float32Array, res: number, seaLevel: number): Uint8Array {
  const sea = Math.fround(seaLevel);
  const outlet = new Uint8Array(res * res);
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      if (x === 0 || y === 0 || x === res - 1 || y === res - 1 || height[i]! <= sea) outlet[i] = 1;
    }
  }
  return outlet;
}

/** The falls of texel i to its four neighbours, as float32 numbers that are never below 0. */
export function dropsOf(filled: Float32Array, i: number, res: number): number[] {
  return [0, 1, 2, 3].map((k) => Math.max(Math.fround(filled[i]! - filled[neighbour(i, k, res)]!), 0));
}

/** The receiver of texel (x, y), which is not an outlet, by the code simulation.md 6.2 prints. */
export function receiverOf(filled: Float32Array, x: number, y: number, res: number, seed: number): number {
  const d = dropsOf(filled, y * res + x, res);
  const total = Math.fround(Math.fround(Math.fround(d[0]! + d[1]!) + d[2]!) + d[3]!);
  let pick = 4;
  if (total > 0) {
    const t = Math.fround(hashUnit(hashCell(x, y, seed)) * total);
    let run = 0;
    for (let k = 0; k < 4; k++) {
      run = Math.fround(run + d[k]!);
      if (d[k]! > 0) { pick = k; if (run > t) break; }
    }
  }
  return pick;
}

/** The texels of the flats: those that are no outlet and none of whose falls is above ROUTE_FLAT_DROPS eps. */
export function flatsOf(filled: Float32Array, outlet: Uint8Array, res: number, eps: number): Uint8Array {
  const limit = Math.fround(ROUTE_FLAT_DROPS * Math.fround(eps));
  const flat = new Uint8Array(res * res);
  for (let i = 0; i < flat.length; i++) if (!outlet[i] && dropsOf(filled, i, res).every((d) => d <= limit)) flat[i] = 1;
  return flat;
}

/** How many N4 steps over flat texels a flat texel lies from one that has a neighbour off the flat. */
export function shoreOf(flat: Uint8Array, res: number): Int32Array {
  const steps = new Int32Array(flat.length).fill(-1);
  let front: number[] = [];
  for (let i = 0; i < flat.length; i++) {
    if (flat[i] && [0, 1, 2, 3].some((k) => !flat[neighbour(i, k, res)])) { steps[i] = 0; front.push(i); }
  }
  for (let d = 1; front.length > 0; d++) {
    const next: number[] = [];
    for (const i of front) {
      for (let k = 0; k < 4; k++) {
        const q = neighbour(i, k, res);
        if (flat[q] && steps[q]! < 0) { steps[q] = d; next.push(q); }
      }
    }
    front = next;
  }
  return steps;
}

/** What a step onto the flat texel i costs, `steps` from the edge of its flat. */
export function flatCost(i: number, steps: number, res: number, seed: number): number {
  const base = Math.floor(ROUTE_FLAT_COST / (Math.min(steps, ROUTE_FLAT_SHORE) + 1));
  return base + Math.floor((base * ROUTE_FLAT_JITTER * (hashCell(i % res, Math.floor(i / res), seed) >>> 24)) / 256);
}

/**
 * The receivers of the flat texels into `receiver`, as simulation.md 6.2 step 3 states it: the exits by level
 * and then by texel, and for the exits of one level Dijkstra's algorithm, in which of two entries at one
 * distance the one entered first is taken first.
 */
export function resolveFlats(filled: Float32Array, flat: Uint8Array, receiver: Uint8Array, res: number, seed: number): void {
  const steps = shoreOf(flat, res);
  const exits: { level: number; texel: number; towards: number }[] = [];
  for (let i = 0; i < flat.length; i++) {
    if (!flat[i]) continue;
    let lowest = Infinity, towards = -1;
    for (let k = 0; k < 4; k++) {
      const d = neighbour(i, k, res);
      if (!flat[d] && filled[d]! <= filled[i]! && filled[d]! < lowest) { lowest = filled[d]!; towards = k; }
    }
    if (towards >= 0) exits.push({ level: lowest, texel: i, towards });
  }
  exits.sort((a, b) => a.level - b.level || a.texel - b.texel);
  const resolved = new Uint8Array(flat.length);
  for (let from = 0; from < exits.length;) {
    let to = from;
    while (to < exits.length && exits[to]!.level === exits[from]!.level) to++;
    // Entries of (distance, order of entry, texel, receiver), kept sorted: the first is the next to take.
    const open: [number, number, number, number][] = [];
    let entered = 0;
    const enter = (distance: number, texel: number, towards: number): void => {
      const entry: [number, number, number, number] = [distance, entered++, texel, towards];
      let at = open.length;
      while (at > 0 && open[at - 1]![0] > distance) at--;
      open.splice(at, 0, entry);
    };
    for (const exit of exits.slice(from, to)) if (!resolved[exit.texel]) enter(flatCost(exit.texel, steps[exit.texel]!, res, seed), exit.texel, exit.towards);
    while (open.length > 0) {
      const [distance, , i, towards] = open.shift()!;
      if (resolved[i]) continue;
      resolved[i] = 1;
      receiver[i] = towards;
      for (let k = 0; k < 4; k++) {
        const q = neighbour(i, k, res);
        if (flat[q] && !resolved[q]) enter(distance + flatCost(q, steps[q]!, res, seed), q, (k + 2) % 4);
      }
    }
    from = to;
  }
}

export function referenceRoute(input: RouteInput): Routed {
  const { height, res, routing, seed, weight } = input;
  const n = res * res;
  const eps = Math.fround(input.eps);
  const outlet = outletsOf(height, res, input.seaLevel);
  const filled = new Float32Array(n);
  const reached = new Uint8Array(n);

  // A binary heap of texel indices ordered by (filled, index).
  const heap: number[] = [];
  const before = (a: number, b: number): boolean => filled[a]! < filled[b]! || (filled[a]! === filled[b]! && a < b);
  const push = (i: number): void => {
    let at = heap.push(i) - 1;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (!before(heap[at]!, heap[parent]!)) break;
      [heap[at], heap[parent]] = [heap[parent]!, heap[at]!];
      at = parent;
    }
  };
  const pop = (): number => {
    const top = heap[0]!;
    const end = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = end;
      for (let at = 0; ;) {
        let least = at;
        for (const child of [2 * at + 1, 2 * at + 2]) if (child < heap.length && before(heap[child]!, heap[least]!)) least = child;
        if (least === at) break;
        [heap[at], heap[least]] = [heap[least]!, heap[at]!];
        at = least;
      }
    }
    return top;
  };

  for (let i = 0; i < n; i++) {
    if (!outlet[i]) continue;
    filled[i] = height[i]!;
    reached[i] = 1;
    push(i);
  }
  const order: number[] = [];
  while (heap.length > 0) {
    const c = pop();
    order.push(c);
    for (let k = 0; k < 4; k++) {
      const q = neighbour(c, k, res);
      if (q < 0 || reached[q]) continue;
      filled[q] = Math.max(height[q]!, Math.fround(filled[c]! + eps));
      reached[q] = 1;
      push(q);
    }
  }

  const receiver = new Uint8Array(n).fill(4);
  const flat = new Uint8Array(n);
  if (routing === 'none') return { filled, receiver, outlet, flat, area: null };
  const sums = new Float64Array(n);
  for (let i = 0; i < n; i++) sums[i] = (weight ? Math.max(weight[i]!, 0) : 1) / n;
  if (routing === 'single') {
    flat.set(flatsOf(filled, outlet, res, eps));
    for (let i = 0; i < n; i++) if (!outlet[i] && !flat[i]) receiver[i] = receiverOf(filled, i % res, Math.floor(i / res), res, seed);
    resolveFlats(filled, flat, receiver, res, seed);
    // Donors first: a texel passes its sum on when every texel that drains into it has.
    const donors = new Int32Array(n);
    for (let i = 0; i < n; i++) if (receiver[i]! < 4) donors[neighbour(i, receiver[i]!, res)]!++;
    const ready: number[] = [];
    for (let i = 0; i < n; i++) if (donors[i] === 0) ready.push(i);
    let passed = 0;
    for (let i = ready.pop(); i !== undefined; i = ready.pop()) {
      passed++;
      if (receiver[i]! === 4) continue;
      const to = neighbour(i, receiver[i]!, res);
      sums[to]! += sums[i]!;
      if (--donors[to]! === 0) ready.push(to);
    }
    if (passed !== n) throw new Error(`the receivers of ${n - passed} texels form a ring`);
    return { filled, receiver, outlet, flat, area: Float32Array.from(sums) };
  }
  for (let at = order.length - 1; at >= 0; at--) {
    const i = order[at]!;
    if (outlet[i]) continue;
    const d = dropsOf(filled, i, res);
    const total = Math.fround(Math.fround(Math.fround(d[0]! + d[1]!) + d[2]!) + d[3]!);
    if (!(total > 0)) continue;
    for (let k = 0; k < 4; k++) if (d[k]! > 0) sums[neighbour(i, k, res)]! += (sums[i]! * d[k]!) / total;
  }
  return { filled, receiver, outlet, flat, area: Float32Array.from(sums) };
}

/** How many values of two arrays of one length are not the same float32, and the first place where. */
export function unequal(a: Float32Array, b: Float32Array): { count: number; first: number } {
  let count = 0, first = -1;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i] || (Number.isNaN(a[i]!) && Number.isNaN(b[i]!))) continue;
    if (count++ === 0) first = i;
  }
  return { count, first };
}

/** Whether two float32 numbers are equal or next to each other. */
export function adjacent(a: number, b: number): boolean {
  if (a === b) return true;
  const bits = new Int32Array(new Float32Array([a, b]).buffer);
  return (bits[0]! ^ bits[1]!) >= 0 && Math.abs(bits[0]! - bits[1]!) <= 1;
}
