export interface CurvePoint { readonly x: number; readonly y: number }
export interface GradientStop { readonly t: number; readonly color: readonly [number, number, number] }

interface Spline { readonly xs: readonly number[]; readonly ys: readonly number[]; readonly ms: readonly number[] }

/**
 * The tangents of Fritsch and Carlson (1980): the mean of the two neighbouring secants, the one secant at an
 * end; zero where the secants differ in sign or one is zero; then, per interval with secant d and a = m0 / d,
 * b = m1 / d, both tangents scaled by 3 / sqrt(a² + b²) when a² + b² > 9. Intervals are limited in order.
 */
function spline(points: readonly CurvePoint[]): Spline {
  const n = points.length;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const ds: number[] = [];
  for (let k = 0; k + 1 < n; k++) ds.push((ys[k + 1]! - ys[k]!) / (xs[k + 1]! - xs[k]!));
  const ms: number[] = [];
  for (let k = 0; k < n; k++) {
    if (n < 2) ms.push(0);
    else if (k === 0) ms.push(ds[0]!);
    else if (k === n - 1) ms.push(ds[n - 2]!);
    else ms.push(ds[k - 1]! * ds[k]! > 0 ? (ds[k - 1]! + ds[k]!) / 2 : 0);
  }
  for (let k = 0; k + 1 < n; k++) {
    const d = ds[k]!;
    if (d === 0) {
      ms[k] = 0;
      ms[k + 1] = 0;
      continue;
    }
    const a = ms[k]! / d;
    const b = ms[k + 1]! / d;
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      ms[k] = tau * a * d;
      ms[k + 1] = tau * b * d;
    }
  }
  return { xs, ys, ms };
}

function evalSpline({ xs, ys, ms }: Spline, x: number): number {
  const n = xs.length;
  if (n === 0) return 0;
  // Written so that NaN takes the first branch.
  if (!(x > xs[0]!)) return ys[0]!;
  if (x >= xs[n - 1]!) return ys[n - 1]!;
  let k = 0;
  while (x >= xs[k + 1]!) k++;
  const h = xs[k + 1]! - xs[k]!;
  const t = (x - xs[k]!) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  return ys[k]! * (2 * t3 - 3 * t2 + 1) + h * ms[k]! * (t3 - 2 * t2 + t)
    + ys[k + 1]! * (3 * t2 - 2 * t3) + h * ms[k + 1]! * (t3 - t2);
}

function sampleCount(n: number): number {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`a table needs a whole number of samples, at least 1; got ${n}`);
  return n;
}

/** The single definition of a curve: the monotone cubic (Fritsch-Carlson) through the points, constant outside them (engine.md 4.9). */
export function evalCurve(points: readonly CurvePoint[], x: number): number {
  return evalSpline(spline(points), x);
}

export function bakeCurve(points: readonly CurvePoint[], n: number = 1024): Float32Array {       // n defaults to 1024
  const out = new Float32Array(sampleCount(n));
  const s = spline(points);
  for (let i = 0; i < n; i++) out[i] = evalSpline(s, n === 1 ? 0 : i / (n - 1));
  return out;
}

/** Where two stops share one `t`, the later one gives the sample at exactly that `t`. */
export function bakeGradient(stops: readonly GradientStop[], n: number = 256): Float32Array {   // n defaults to 256; n × 4 floats
  const out = new Float32Array(sampleCount(n) * 4);
  const last = stops.length - 1;
  let k = 0;
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    let rgb: readonly number[] = [0, 0, 0];
    if (last >= 0) {
      while (k < last && stops[k + 1]!.t <= t) k++;
      const a = stops[k]!;
      const b = stops[Math.min(k + 1, last)]!;
      const f = t > a.t && b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
      rgb = [0, 1, 2].map((c) => a.color[c]! + (b.color[c]! - a.color[c]!) * f);
    }
    out.set([rgb[0]!, rgb[1]!, rgb[2]!, 1], i * 4);
  }
  return out;
}
