import type { NodeDef } from '../../src/core/api.ts';
import { checkFieldData, type FieldData } from './field-data.ts';
import { isFixtureName } from './fixtures.ts';
import { renderNode, type RenderOptions } from './render.ts';
import { describeWorst, diff, fail, show } from './stats.ts';

/** Keeps every 2^levels-th row and column. Throws unless (width − 1) is divisible by 2^levels. */
export function decimate(f: FieldData, levels = 1): FieldData {     // levels defaults to 1
  checkFieldData(f, 'decimate: the field');
  if (!Number.isInteger(levels) || levels < 0 || levels > 30) throw new RangeError(`decimate: ${String(levels)} is not a number of levels`);
  const step = 2 ** levels;
  if ((f.width - 1) % step !== 0 || (f.height - 1) % step !== 0) {
    throw new RangeError(`decimate: ${f.width} x ${f.height} has no level ${levels}: (size − 1) is not divisible by ${step}`);
  }
  const width = (f.width - 1) / step + 1;
  const height = (f.height - 1) / step + 1;
  const data = new Float32Array(width * height * f.channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (y * step * f.width + x * step) * f.channels;
      const to = (y * width + x) * f.channels;
      for (let c = 0; c < f.channels; c++) data[to + c] = f.data[from + c]!;
    }
  }
  return { kind: f.kind, width, height, channels: f.channels, data };
}

export interface LadderDiff {
  readonly max: number;
  readonly rms: number;
  readonly std: number;          // standard deviation of `coarse` (RGB channels together for a colour)
  readonly rel: number;          // rms / max(std, 1e-12)
}

/** `diff` of `coarse` and the decimated `fine`, kept for the position a failure reports. */
function ladderDiff(coarse: FieldData, fine: FieldData): { readonly ladder: LadderDiff; readonly worst: string } {
  checkFieldData(coarse, 'compareLadder: the coarse field');
  checkFieldData(fine, 'compareLadder: the fine field');
  const ratio = (fine.width - 1) / Math.max(coarse.width - 1, 1);
  const levels = Math.round(Math.log2(ratio));
  if (coarse.width < 2 || !(ratio >= 1) || 2 ** levels !== ratio || (fine.height - 1) / Math.max(coarse.height - 1, 1) !== ratio) {
    throw new RangeError(`compareLadder: ${fine.width} x ${fine.height} is not a finer ladder level of ${coarse.width} x ${coarse.height}: the ratio of (size − 1) is not a power of two`);
  }
  const d = diff(coarse, decimate(fine, levels));

  // Over the finite values of the height, or of the three colour channels as one population.
  const measured = coarse.kind === 'color' ? 3 : 1;
  let count = 0, sum = 0;
  for (let i = 0; i < coarse.data.length; i++) {
    const v = coarse.data[i]!;
    if (i % coarse.channels >= measured || !Number.isFinite(v)) continue;
    count++;
    sum += v;
  }
  const mean = sum / Math.max(count, 1);
  let squares = 0;
  for (let i = 0; i < coarse.data.length; i++) {
    const v = coarse.data[i]!;
    if (i % coarse.channels < measured && Number.isFinite(v)) squares += (v - mean) ** 2;
  }
  const std = Math.sqrt(squares / Math.max(count, 1));
  return { ladder: { max: d.max, rms: d.rms, std, rel: d.rms / Math.max(std, 1e-12) }, worst: describeWorst(d, coarse.channels) };
}

/** Decimates `fine` to the size of `coarse` and compares. Throws unless (fine.width − 1) / (coarse.width − 1) is a power of two. */
export function compareLadder(coarse: FieldData, fine: FieldData): LadderDiff {
  return ladderDiff(coarse, fine).ladder;
}

export function expectLadder(coarse: FieldData, fine: FieldData, tol: { max?: number; rms?: number; rel?: number }): LadderDiff {
  if (tol?.max === undefined && tol?.rms === undefined && tol?.rel === undefined) throw new TypeError('expectLadder: the tolerance needs at least one of max, rms and rel');
  for (const [name, value] of [['max', tol.max], ['rms', tol.rms], ['rel', tol.rel]] as const) {
    if (value !== undefined && !(value >= 0)) throw new RangeError(`expectLadder: the tolerance ${name} is ${String(value)}; it is a number of at least 0`);
  }
  const { ladder, worst } = ladderDiff(coarse, fine);
  const levels = `${coarse.width} against ${fine.width}`;
  if (tol.max !== undefined && !(ladder.max <= tol.max)) fail(`${levels}: ${worst}; allowed ${show(tol.max)}`);
  if (tol.rms !== undefined && !(ladder.rms <= tol.rms)) fail(`${levels}: rms difference ${show(ladder.rms)} (${worst}); allowed ${show(tol.rms)}`);
  if (tol.rel !== undefined && !(ladder.rel <= tol.rel)) {
    fail(`${levels}: rms difference ${show(ladder.rms)} is ${show(ladder.rel)} of the standard deviation ${show(ladder.std)} (${worst}); allowed ${show(tol.rel)}`);
  }
  return ladder;
}

/** Renders the node at each resolution with the same options; fixture inputs are taken at each resolution. */
export async function renderLadder(
  def: NodeDef,
  opts: RenderOptions & { readonly resolutions?: readonly number[] } = {},   // default [257, 513]
): Promise<Readonly<Record<number, Readonly<Record<string, FieldData>>>>> {
  const { resolutions = [257, 513], ...render } = opts;
  if ('res' in render && render.res !== undefined) throw new TypeError('renderLadder: the resolutions are given as `resolutions`, not as `res`');
  // An input of a ladder comparison exists at every resolution, as the decimation of the finer one.
  const given: (readonly [string, unknown])[] = [...Object.entries(render.inputs ?? {}).map(([port, value]) => [`the input "${port}"`, value] as const)];
  if (render.mask !== undefined) given.push(['the mask', render.mask]);
  for (const [what, value] of given) {
    if (value === null) continue;
    if (!isFixtureName(value)) throw new TypeError(`renderLadder: ${what} is field data; a ladder comparison takes a fixture name, which exists at every resolution`);
    if (value === 'fbm' || value === 'impulse') throw new TypeError(`renderLadder: ${what} is the fixture "${value}", which is not band-limited; it is never used for a ladder comparison`);
  }
  const out: Record<number, Readonly<Record<string, FieldData>>> = {};
  for (const res of resolutions) out[res] = await renderNode(def, { ...render, res });
  return out;
}
