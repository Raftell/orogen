// src/core/nodes/simulate/_route.ts
// The routing module of simulation.md section 6: the routing surface of a terrain, on which every texel that is
// not an outlet has a lower N4 neighbour, and what flows over it.
//
//   route         the CPU task `simulate/route`: the exact surface, receivers and drainage area (6.2)
//   fillSweep     the kernel `simulate/route.sweep`: one Jacobi sweep that keeps a surface current (6.3)
//   receivers     the kernel `simulate/route.receivers`: the receiver code of every texel (6.3)
//   routeEps      ROUTE_EPS of the calibration register, for a height range
//   routeWeight   reads a mask input as the task's `weight`
//
// The task and the two kernels perform the same float32 operations in the same order, so that a sweep leaves
// the task's surface as it is (6.5 item 3). On level ground the task alone knows the way: there it draws no
// receiver from the falls, which say nothing, and takes the cheapest way to where the flat drains (6.2 step 3).

import { defineCpuTask, defineKernel, hash, hashU32, hashUnit, type CpuEnv, type CpuTask, type Field, type OpContext } from '../../api.ts';

/** ROUTE_EPS of simulation.md 13 is `max(ROUTE_EPS_METRES / R, ROUTE_EPS_FLOOR)`: a fall of one millimetre per texel. To calibrate. */
export const ROUTE_EPS_METRES = 0.001;
/** Never less than a few float32 steps of a height near 1, below which a flat would not drain. */
export const ROUTE_EPS_FLOOR = 5e-7;

/** ROUTE_EPS for a height range in metres, as a normalised height. */
export function routeEps(heightRange: number): number {
  return Math.max(ROUTE_EPS_METRES / Math.max(heightRange, 1e-6), ROUTE_EPS_FLOOR);
}

/** A texel whose largest fall to a neighbour is at most this many `eps` lies on a flat (6.2 step 3). To calibrate. */
export const ROUTE_FLAT_DROPS = 2;
/** What a step onto a flat texel beside the flat's edge costs; `ROUTE_FLAT_COST / (d + 1)` at `d` steps from it. To calibrate. */
export const ROUTE_FLAT_COST = 256;
/** Beyond this many steps from the edge of a flat a step costs no less. To calibrate. */
export const ROUTE_FLAT_SHORE = 63;
/** A texel's random number adds up to this many times its cost: what lets a course across open level ground wind. To calibrate. */
export const ROUTE_FLAT_JITTER = 3;

export interface RouteArgs {
  readonly height: Float32Array;                       // res × res, the layout of ctx.read; consumed
  readonly res: number;
  readonly eps: number;                                // normalised; 0 gives level lakes
  readonly seaLevel: number;
  readonly routing: 'none' | 'single' | 'multiple';
  readonly seed: number;                               // u32: mixSeed(ctx.seed, 0); used by 'single'
  readonly weight?: Float32Array;                      // contribution of each texel; default 1 everywhere
  readonly receivers?: boolean;                        // also return the receiver codes; with 'single' only
  readonly sea?: 'all' | 'connected';                  // which ground at or below the sea level is an outlet: all of it (default), or what the border reaches through such ground
}
export interface RouteResult {
  readonly filled: Float32Array;                       // the routing surface w
  readonly area?: Float32Array;                        // drainage fraction; absent for routing 'none'
  readonly receivers?: Uint8Array;                     // the N4 index of each texel's receiver, 4 for none; when asked for
}

/** Texels between two progress reports. */
const REPORT_EVERY = 1 << 20;

/** What a texel's byte holds during the flood. TOUCHED and QUEUED are open texels a settled neighbour has reached. */
const OPEN = 0, SETTLED = 1, OUTLET = 2, TOUCHED = 3, QUEUED = 4;
/**
 * After the flood: the receiver code in bits 0..2, the count of donors still to come in bits 3..5, bit 6 once
 * passed on. Bit 7 marks a texel of a flat, whose receiver code is NO_RECEIVER until the flat is resolved.
 */
const DONOR = 8, WAITING = 0x78, PASSED = 0x40, FLAT = 0x80, NO_RECEIVER = 7, UNRESOLVED = FLAT | NO_RECEIVER;

/**
 * The waiting texels of the flood: a monotone priority queue (a radix heap) of (level, texel), for levels that
 * are never below the last one taken. A level is held as the bits of its float32, which order as the numbers
 * do; bucket b holds the entries whose level differs from the last one taken first in bit b - 1, so an entry
 * moves to a lower bucket a few times at the most and is never sifted through a heap. Entries of one level
 * leave in the order they came.
 */
class Waiting {
  private readonly keys: Uint32Array[] = [];
  private readonly ids: Int32Array[] = [];
  private readonly count = new Int32Array(33);
  private head = 0;                       // of bucket 0, which is a queue
  private last = 0;
  private readonly f32 = new Float32Array(1);
  private readonly u32 = new Uint32Array(this.f32.buffer);
  /** The level of the entry `take` returned. */
  level = 0;

  constructor() {
    for (let b = 0; b < 33; b++) { this.keys.push(new Uint32Array(64)); this.ids.push(new Int32Array(64)); }
  }

  private put(b: number, key: number, id: number): void {
    let n = this.count[b];
    if (n === this.keys[b].length) {
      if (b === 0 && this.head > n >> 1) {
        // The queue has room at its front.
        this.keys[0].copyWithin(0, this.head, n); this.ids[0].copyWithin(0, this.head, n);
        n -= this.head; this.head = 0;
      } else {
        const k = new Uint32Array(n * 2), d = new Int32Array(n * 2);
        k.set(this.keys[b]); d.set(this.ids[b]);
        this.keys[b] = k; this.ids[b] = d;
      }
    }
    this.keys[b][n] = key; this.ids[b][n] = id;
    this.count[b] = n + 1;
  }

  add(level: number, id: number): void {
    this.f32[0] = level;
    const bits = this.u32[0];
    // Positive floats order as their bits, negative ones in reverse and below them.
    const key = (bits & 0x80000000) !== 0 ? ~bits >>> 0 : (bits | 0x80000000) >>> 0;
    this.put(key <= this.last ? 0 : 32 - Math.clz32(key ^ this.last), key <= this.last ? this.last : key, id);
  }

  /** The id of the entry with the lowest level, or -1 when none is left. With `mark`, an entry whose id it shows as settled has lapsed. */
  take(mark?: Uint8Array): number {
    while (this.head === this.count[0]) {
      this.head = 0; this.count[0] = 0;
      let b = 1;
      while (b < 33 && this.count[b] === 0) b++;
      if (b === 33) return -1;
      // The lowest level of the bucket becomes the last one taken, and its entries move down. An entry whose
      // texel was settled meanwhile is dropped here, at the first look at it.
      const keys = this.keys[b], ids = this.ids[b];
      let n = 0, lowest = 0xffffffff;
      for (let i = 0, end = this.count[b]; i < end; i++) {
        const id = ids[i];
        if (mark !== undefined && mark[id] === SETTLED) continue;
        const key = keys[i];
        if (key < lowest) lowest = key;
        keys[n] = key; ids[n++] = id;
      }
      this.count[b] = 0;
      if (n === 0) continue;
      this.last = lowest;
      for (let i = 0; i < n; i++) {
        const key = keys[i];
        this.put(key === lowest ? 0 : 32 - Math.clz32(key ^ lowest), key, ids[i]);
      }
    }
    const key = this.keys[0][this.head];
    this.u32[0] = (key & 0x80000000) !== 0 ? key & 0x7fffffff : ~key >>> 0;
    this.level = this.f32[0];
    return this.ids[0][this.head++];
  }
}

/**
 * The routing surface, in place: `h` arrives as the terrain and leaves as `filled`. `mark` leaves with OUTLET on
 * the outlets and SETTLED elsewhere.
 *
 * The surface is the one Priority-Flood with epsilon computes (Barnes14), in which every texel passes through a
 * heap ordered by (filled, texel index). It is found with less work. A texel that has a settled neighbour lower
 * by eps or more keeps its own height whatever the order, since `max(height, lowest neighbour + eps)` is then
 * its height: it is settled at once, from a stack. A texel that a settled neighbour would raise only waits: it
 * is noted, and when the stack is empty and it is still open, it joins the waiting texels with the lowest level
 * its settled neighbours give it. The lowest level among them is then final as in Dijkstra's algorithm, because
 * every other way to an open texel passes a waiting one and nothing on the way lowers a level. On a slope
 * nearly every noted texel is settled from below before the stack is empty, so only pits and their rims wait.
 */
function flood(h: Float32Array, mark: Uint8Array, res: number, eps: number, sea: number, connected: boolean, report: (settled: number) => void): void {
  const last = res - 1;
  let stack = new Int32Array(1 << 14), sp = 0;
  let noted = new Int32Array(1 << 14), np = 0;
  const waiting = new Waiting();
  let settled = 0, due = REPORT_EVERY;

  // A settled texel reaches its neighbour q with the level it would raise q to; q keeps its height when that is no lower.
  const reach = (q: number, level: number): void => {
    const m = mark[q];
    if (m === SETTLED || m === OUTLET) return;
    if (h[q] >= level) {
      mark[q] = SETTLED;
      if (sp === stack.length) { const s = new Int32Array(sp * 2); s.set(stack); stack = s; }
      stack[sp++] = q;
    } else if (m === OPEN) {
      mark[q] = TOUCHED;
      if (np === noted.length) { const s = new Int32Array(np * 2); s.set(noted); noted = s; }
      noted[np++] = q;
    } else if (m === QUEUED) waiting.add(level, q);   // it waits with the level of an earlier neighbour
  };

  // Everything the stack holds is settled and not on the border ring: it has four neighbours.
  const drain = (): void => {
    while (sp > 0) {
      const c = stack[--sp];
      const level = Math.fround(h[c] + eps);
      reach(c + 1, level); reach(c + res, level); reach(c - 1, level); reach(c - res, level);
      if (++settled === due) { due += REPORT_EVERY; report(settled); }
    }
  };

  // The level of a settled neighbour, or infinity.
  const from = (c: number): number => (mark[c] === SETTLED || mark[c] === OUTLET ? Math.fround(h[c] + eps) : Infinity);
  // With the stack empty: the noted texels that are still open begin to wait.
  const queue = (): void => {
    for (let i = 0; i < np; i++) {
      const q = noted[i];
      if (mark[q] !== TOUCHED) continue;
      mark[q] = QUEUED;
      waiting.add(Math.min(from(q + 1), from(q + res), from(q - 1), from(q - res)), q);
    }
    np = 0;
  };

  for (let y = 0, i = 0; y < res; y++) {
    const ring = y === 0 || y === last;
    for (let x = 0; x < res; x++, i++) if (ring || x === 0 || x === last || (!connected && h[i] <= sea)) mark[i] = OUTLET;
  }
  if (connected) {
    // The sea the border reaches: from the texels of the border ring at or below the sea level, through N4
    // neighbours at or below it. A basin below the sea level that the sea does not reach fills like any other.
    let front = new Int32Array(1 << 14), count = 0;
    const wet = (q: number): void => {
      if (mark[q] === OUTLET || !(h[q] <= sea)) return;
      mark[q] = OUTLET;
      if (count === front.length) { const grown = new Int32Array(count * 2); grown.set(front); front = grown; }
      front[count++] = q;
    };
    const enter = (q: number): void => {
      if (!(h[q] <= sea)) return;
      if (count === front.length) { const grown = new Int32Array(count * 2); grown.set(front); front = grown; }
      front[count++] = q;
    };
    for (let x = 0; x < res; x++) { enter(x); enter(last * res + x); }
    for (let y = 1; y < last; y++) { enter(y * res); enter(y * res + last); }
    // Depth first: every texel is entered once, and a texel of the ring has its neighbours tested for the grid.
    while (count > 0) {
      const c = front[--count], x = c % res, y = (c - x) / res;
      if (x < last) wet(c + 1);
      if (y < last) wet(c + res);
      if (x > 0) wet(c - 1);
      if (y > 0) wet(c - res);
    }
  }
  for (let y = 0, i = 0; y < res; y++) {
    for (let x = 0; x < res; x++, i++) {
      if (mark[i] !== OUTLET) continue;
      const level = Math.fround(h[i] + eps);
      if (x < last) reach(i + 1, level);
      if (y < last) reach(i + res, level);
      if (x > 0) reach(i - 1, level);
      if (y > 0) reach(i - res, level);
      if (++settled === due) { due += REPORT_EVERY; report(settled); }
      drain();
    }
  }

  for (;;) {
    queue();
    const c = waiting.take(mark);
    if (c < 0) break;
    if (mark[c] === SETTLED) continue;   // settled since it began to wait, at this level or a lower one
    mark[c] = SETTLED;
    h[c] = waiting.level;
    const next = Math.fround(waiting.level + eps);
    reach(c + 1, next); reach(c + res, next); reach(c - 1, next); reach(c - res, next);
    if (++settled === due) { due += REPORT_EVERY; report(settled); }
    drain();
  }
}

/**
 * The receiver code of every texel into the low bits of `code`, and the count of its donors above them: one
 * lower neighbour, drawn with the probability of its share of the fall (6.2 step 2). `code` arrives as the
 * marks of the flood. A texel none of whose falls is above `flat` lies on a flat: it is left without a receiver
 * and listed in `flats`, which has room for every texel, in the order of the texels, for `resolveFlats`. Returns
 * how many there are.
 */
function singleReceivers(w: Float32Array, code: Uint8Array, res: number, seed: number, flat: number, flats: Int32Array): number {
  const offsets = [1, res, -1, -res];
  for (let i = 0; i < code.length; i++) code[i] = code[i] === OUTLET ? 4 : 0;
  let count = 0;
  const seeded = hashU32(seed);
  for (let y = 1; y < res - 1; y++) {
    const row = hashU32((y + seeded) >>> 0);
    for (let x = 1, i = y * res + 1; x < res - 1; x++, i++) {
      if ((code[i] & 7) === 4) continue;
      // The falls to the four neighbours in the order of N4, each a float32 and never below 0.
      const wi = w[i];
      const d0 = w[i + 1] < wi ? Math.fround(wi - w[i + 1]) : 0;
      const d1 = w[i + res] < wi ? Math.fround(wi - w[i + res]) : 0;
      const d2 = w[i - 1] < wi ? Math.fround(wi - w[i - 1]) : 0;
      const d3 = w[i - res] < wi ? Math.fround(wi - w[i - res]) : 0;
      if (d0 <= flat && d1 <= flat && d2 <= flat && d3 <= flat) {
        code[i] |= UNRESOLVED;
        flats[count++] = i;
        continue;
      }
      const total = Math.fround(Math.fround(Math.fround(d0 + d1) + d2) + d3);
      // The neighbour at which the running sum of the falls passes the texel's random share of the total; the
      // last one with a fall when rounding keeps the sum from passing it.
      const t = Math.fround(hashUnit(hashU32((x + row) >>> 0)) * total);
      let pick = 4, run = d0;
      if (d0 > 0) pick = 0;
      if (!(d0 > 0 && run > t)) {
        run = Math.fround(run + d1);
        if (d1 > 0) pick = 1;
        if (!(d1 > 0 && run > t)) {
          run = Math.fround(run + d2);
          if (d2 > 0) pick = 2;
          if (!(d2 > 0 && run > t) && d3 > 0) pick = 3;
        }
      }
      code[i] |= pick;
      code[i + offsets[pick]] += DONOR;
    }
  }
  return count;
}

/** Slots of the flood over the flats: a power of two above the most a step costs. */
const FLAT_SLOTS = 1024;

/**
 * The receivers of the flat texels (6.2 step 3). The falls of a flat are those of the eps the flood tilted it
 * by, in steps of N4: a receiver drawn from them takes a river across a lake along a row and a column. Here a
 * flat drains as a lake does: through the lowest texel beside it, by the cheapest way there over its own
 * texels, where a step costs less the farther it is from the flat's edge. Water gathers along the middle of a
 * valley floor and of a lake, and a texel's random number lets the way across open ground wind.
 *
 * The exits are taken lowest first, so the first to reach a flat takes all of it, and those of one level
 * share it by cost. Every flat has an exit no higher than its lowest texel: the way out the flood gave it.
 *
 * `cost` has a value for every texel, all 0, and `reached` room for `count` texels: the caller's scratch.
 */
function resolveFlats(w: Float32Array, code: Uint8Array, res: number, seed: number, flats: Int32Array, count: number, cost: Uint16Array, reached: Int32Array): void {
  if (count === 0) return;
  const offsets = [1, res, -1, -res];

  // Steps to the edge of the flat plus one, breadth first from the texels on the edge; 0 until a texel is
  // reached. Then, in the same place, what a step onto the texel costs: a whole number from 4 to 1021.
  let tail = 0;
  for (let at = 0; at < count; at++) {
    const i = flats[at];
    if ((code[i + 1] & FLAT) === 0 || (code[i + res] & FLAT) === 0 || (code[i - 1] & FLAT) === 0 || (code[i - res] & FLAT) === 0) {
      cost[i] = 1;
      reached[tail++] = i;
    }
  }
  for (let head = 0; head < tail; head++) {
    const i = reached[head], next = Math.min(cost[i] + 1, ROUTE_FLAT_SHORE + 1);
    for (let k = 0; k < 4; k++) {
      const q = i + offsets[k];
      if ((code[q] & FLAT) !== 0 && cost[q] === 0) { cost[q] = next; reached[tail++] = q; }
    }
  }
  const seeded = hashU32(seed);
  for (let at = 0; at < count; at++) {
    const i = flats[at], x = i % res, y = (i - x) / res;
    const base = (ROUTE_FLAT_COST / cost[i]) | 0;
    cost[i] = base + ((base * ROUTE_FLAT_JITTER * (hashU32((x + hashU32((y + seeded) >>> 0)) >>> 0) >>> 24)) >>> 8);
  }

  // Dijkstra's algorithm over whole-number costs: slot s holds what is s away, modulo the slots, and a bit per
  // slot says which hold anything. An entry is a texel and the receiver it would get; of two for one texel the
  // first taken stands.
  const slots: (Int32Array | undefined)[] = new Array<Int32Array | undefined>(FLAT_SLOTS);
  const held = new Int32Array(FLAT_SLOTS);
  const some = new Int32Array(FLAT_SLOTS >> 5);
  let pending = 0, resolved = 0;
  const push = (slot: number, entry: number): void => {
    const n = held[slot];
    let list = slots[slot];
    if (list === undefined) list = slots[slot] = new Int32Array(16);
    else if (n === list.length) { const grown = new Int32Array(n * 2); grown.set(list); list = slots[slot] = grown; }
    list[n] = entry;
    held[slot] = n + 1;
    some[slot >> 5] |= 1 << (slot & 31);
    pending++;
  };
  const drain = (): void => {
    for (let now = 0; pending > 0; now++) {
      // On to the next slot that holds something: the lowest set bit at or after this one, around the ring.
      let slot = now & (FLAT_SLOTS - 1), word = slot >> 5;
      let bits = some[word] & (-1 << (slot & 31));
      while (bits === 0) {
        word = (word + 1) & ((FLAT_SLOTS >> 5) - 1);
        now = (now | 31) + 1;
        bits = some[word];
      }
      const bit = 31 - Math.clz32(bits & -bits);
      now += bit - (now & 31);
      slot = now & (FLAT_SLOTS - 1);
      // Nothing joins the slot while it is read: a step costs at least 1 and less than the slots there are.
      const list = slots[slot]!, n = held[slot];
      for (let at = 0; at < n; at++) {
        const entry = list[at], i = entry >> 2;
        if ((code[i] & UNRESOLVED) !== UNRESOLVED) continue;
        const k = entry & 3;
        code[i] -= NO_RECEIVER - k;
        code[i + offsets[k]] += DONOR;
        resolved++;
        for (let j = 0; j < 4; j++) {
          const q = i + offsets[j];
          if ((code[q] & UNRESOLVED) === UNRESOLVED) push((now + cost[q]) & (FLAT_SLOTS - 1), q * 4 + ((j + 2) & 3));
        }
      }
      held[slot] = 0;
      some[word] &= ~(1 << (slot & 31));
      pending -= n;
    }
  };

  // The exits: for a flat texel beside ground that is no flat and no higher, the lowest such neighbour.
  const exits = new Waiting();
  for (let at = 0; at < count; at++) {
    const i = flats[at], wi = w[i];
    let lowest = Infinity, towards = -1;
    for (let k = 0; k < 4; k++) {
      const d = i + offsets[k];
      if ((code[d] & FLAT) === 0 && w[d] <= wi && w[d] < lowest) { lowest = w[d]; towards = k; }
    }
    if (towards >= 0) exits.add(lowest, i * 4 + towards);
  }
  let level = NaN;
  for (;;) {
    const entry = exits.take();
    if (entry < 0 || exits.level !== level) {
      drain();
      if (entry < 0) break;
      level = exits.level;
    }
    if ((code[entry >> 2] & UNRESOLVED) === UNRESOLVED) push(cost[entry >> 2], entry);
  }
  if (resolved !== count) throw new Error(`simulate/route: ${count - resolved} texels of level ground have no way out`);
}

/** Adds the area of every texel to its receiver, donors first: a texel is passed on when its last donor has been. */
function accumulateSingle(area: Float64Array, code: Uint8Array, res: number): void {
  const offsets = [1, res, -1, -res, 0];
  for (let i = 0; i < code.length; i++) {
    if ((code[i] & WAITING) !== 0) continue;
    // Downstream for as long as the texel reached was waiting for this donor alone. Every round passes one
    // texel on, and each is passed on once.
    for (let j = i; ;) {
      const c = code[j];
      code[j] = c | PASSED;
      const k = c & 7;
      if (k === 4) break;
      const r = j + offsets[k];
      area[r] += area[j];
      const left = code[r] - DONOR;
      code[r] = left;
      if ((left & WAITING) !== 0) break;
      j = r;
    }
  }
}

/**
 * Every lower neighbour receives the share of its part of the fall (6.2 step 3, 'multiple'). `code` arrives as
 * the marks of the flood and is used for the count of the higher neighbours still to come.
 */
function accumulateMultiple(area: Float64Array, w: Float32Array, code: Uint8Array, res: number): void {
  const offsets = [1, res, -1, -res];
  const drop = new Float32Array(4);
  const OUT = 0x80;
  for (let i = 0; i < code.length; i++) code[i] = code[i] === OUTLET ? OUT : 0;
  // A fall of two different float32 heights is never 0, so a neighbour is a receiver exactly when it is lower.
  for (let i = 0; i < code.length; i++) {
    if ((code[i] & OUT) !== 0) continue;
    const wi = w[i];
    for (let k = 0; k < 4; k++) if (w[i + offsets[k]] < wi) code[i + offsets[k]]++;
  }
  let stack = new Int32Array(1 << 14), sp = 0;
  for (let i = 0; i < code.length; i++) {
    if ((code[i] & 0x7f) !== 0) continue;   // waits for a higher neighbour, or was passed on
    stack[sp++] = i;
    while (sp > 0) {
      const j = stack[--sp];
      const c = code[j];
      code[j] = c | PASSED;
      if ((c & OUT) !== 0) continue;
      const wj = w[j];
      for (let k = 0; k < 4; k++) drop[k] = Math.max(wj - w[j + offsets[k]], 0);
      const total = Math.fround(Math.fround(Math.fround(drop[0] + drop[1]) + drop[2]) + drop[3]);
      if (!(total > 0)) continue;
      const a = area[j];
      for (let k = 0; k < 4; k++) {
        if (!(drop[k] > 0)) continue;
        const r = j + offsets[k];
        area[r] += (a * drop[k]) / total;
        if ((--code[r] & 0x7f) === 0) {
          if (sp === stack.length) { const s = new Int32Array(sp * 2); s.set(stack); stack = s; }
          stack[sp++] = r;
        }
      }
    }
  }
}

function runRoute(args: RouteArgs, env: CpuEnv): RouteResult {
  const { height, res, routing, weight } = args;
  if (!Number.isInteger(res) || res < 1 || height.length !== res * res) throw new Error(`simulate/route: height holds ${height.length} values, not ${res} x ${res}`);
  if (weight && weight.length !== height.length) throw new Error(`simulate/route: weight holds ${weight.length} values, not ${res} x ${res}`);
  if (!(args.eps >= 0) || !Number.isFinite(args.eps)) throw new Error(`simulate/route: eps is ${String(args.eps)}; it is a height of 0 or more`);
  // The values a kernel receives as f32 params: the task compares and adds the same numbers.
  // `+ 0`: an eps of -0 would make levels of -0, whose bits do not order with those of 0.
  const eps = Math.fround(args.eps) + 0, sea = Math.fround(args.seaLevel);
  const n = res * res;
  const routed = routing !== 'none';
  const share = routed ? 0.6 : 1;

  const marks = new Uint8Array(n);
  flood(height, marks, res, eps, sea, args.sea === 'connected', (settled) => env.progress((share * settled) / n));
  if (!routed) {
    env.progress(1);
    return { filled: height };
  }

  const single = routing === 'single';
  const sums = new Float64Array(n);
  if (single) {
    // Until the sums are taken their 8 bytes per texel hold what the flats need: the cost of a step in the
    // first two, the list of the flat texels in the next four, and the texels reached in what is left, which is
    // room enough unless more than half the terrain is level.
    const aligned = (bytes: number): number => Math.ceil(bytes / 4) * 4;
    const flats = new Int32Array(sums.buffer, aligned(2 * n), n);
    const count = singleReceivers(height, marks, res, args.seed >>> 0, Math.fround(ROUTE_FLAT_DROPS * eps), flats);
    env.progress(0.7);
    const room = Math.floor((8 * n - aligned(2 * n) - 4 * n) / 4);
    const reached = count <= room ? new Int32Array(sums.buffer, aligned(2 * n) + 4 * n, count) : new Int32Array(count);
    resolveFlats(height, marks, res, args.seed >>> 0, flats, count, new Uint16Array(sums.buffer, 0, n), reached);
  }
  env.progress(0.75);
  const unit = 1 / n;
  // A weight below 0, or one that is no number, contributes nothing: the area never falls along a receiver.
  if (weight) for (let i = 0; i < n; i++) sums[i] = weight[i] > 0 ? weight[i] * unit : 0;
  else sums.fill(unit);
  if (single) accumulateSingle(sums, marks, res);
  else accumulateMultiple(sums, height, marks, res);
  env.progress(0.95);

  // Rounded to float32 in place: value i lands in the first half of the bytes value i / 2 was read from.
  const area = new Float32Array(sums.buffer, 0, n);
  for (let i = 0; i < n; i++) area[i] = sums[i];
  env.progress(1);
  const result = { filled: height, area: new Float32Array(sums.buffer.transfer(4 * n)) };
  if (!single || !args.receivers) return result;
  for (let i = 0; i < n; i++) marks[i] &= 7;
  return { ...result, receivers: marks };
}

/** The router task of simulation.md 6.2. Pure and deterministic: equal arguments give bit-identical results. */
export const route: CpuTask<RouteArgs, RouteResult> = defineCpuTask({ name: 'simulate/route', run: runRoute });

/** `simulate/route.sweep`: one sweep of the routing surface towards the terrain `z`, from a surface `w` that is nowhere below it (6.3). */
export const fillSweep = defineKernel({
  name: 'simulate/route.sweep',
  inputs: { z: 'field', w: 'field' },
  outputs: { next: 'field' },
  params: { eps: 'f32', lift: 'f32', sea: 'f32' },
  cost: 5,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  let zp = z_at(px);
  let last = vec2i(frame.res) - vec2i(1);
  if (any(px == vec2i(0)) || any(px == last) || zp <= P.sea) { return zp; }
  let lowest = min(min(w_at(px + vec2i(1, 0)), w_at(px + vec2i(0, 1))), min(w_at(px - vec2i(1, 0)), w_at(px - vec2i(0, 1))));
  return max(zp, (lowest + P.lift) + P.eps);
}`,
});

/** `simulate/route.receivers`: the N4 index of the texel each texel drains to on the surface `w`, or 4 for none (6.3). */
export const receivers = defineKernel({
  name: 'simulate/route.receivers',
  inputs: { z: 'field', w: 'field' },
  outputs: { rcv: 'field' },
  params: { sea: 'f32' },
  includes: [hash],
  cost: 6,
  code: /* wgsl */ `
fn n4(k: i32) -> vec2i {
  var o = array<vec2i, 4>(vec2i(1, 0), vec2i(0, 1), vec2i(-1, 0), vec2i(0, -1));
  return o[k];
}

fn compute(px: vec2i, uv: vec2f) -> f32 {
  let last = vec2i(frame.res) - vec2i(1);
  if (any(px == vec2i(0)) || any(px == last) || z_at(px) <= P.sea) { return 4.0; }
  let wp = w_at(px);
  var drop: array<f32, 4>;
  var total = 0.0;
  for (var k = 0; k < 4; k++) {
    drop[k] = max(wp - w_at(px + n4(k)), 0.0);
    total += drop[k];
  }
  if (total == 0.0) { return 4.0; }
  let t = hash_unit(hash_cell(px, seedFor(0u))) * total;
  var run = 0.0;
  var pick = 4.0;
  for (var k = 0; k < 4; k++) {
    run += drop[k];
    if (drop[k] > 0.0) {
      pick = f32(k);
      if (run > t) { break; }
    }
  }
  return pick;
}`,
});

const weightKernel = defineKernel({
  name: 'simulate/route.weight',
  inputs: { mask: { kind: 'field', saturate: true } },
  outputs: { out: 'field' },
  cost: 1,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 { return mask_at(px); }`,
});

/** The kernels of this module a node lists when it calls `routeWeight`. */
export const routeWeightKernels = [weightKernel] as const;

/**
 * A mask input as the `weight` of the router: its values saturated, as every reader of a mask takes them
 * (engine.md 1.7). The array is the caller's, to hand to the task in its transfer list.
 */
export async function routeWeight(ctx: OpContext, mask: Field<'field'>): Promise<Float32Array<ArrayBuffer>> {
  const saturated = ctx.alloc('field', { like: mask });
  ctx.run(weightKernel, { in: { mask }, out: { out: saturated } });
  const data = await ctx.read(saturated);
  ctx.release(saturated);
  return data;
}
