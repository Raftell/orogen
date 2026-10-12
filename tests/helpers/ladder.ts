import type { NodeDef } from '../../src/core/api.ts';
import type { FieldData } from './field-data.ts';
import type { RenderOptions } from './render.ts';

/** Keeps every 2^levels-th row and column. Throws unless (width − 1) is divisible by 2^levels. */
export function decimate(f: FieldData, levels?: number): FieldData {     // levels defaults to 1
  throw new Error('not implemented: decimate');
}

export interface LadderDiff {
  readonly max: number;
  readonly rms: number;
  readonly std: number;          // standard deviation of `coarse` (RGB channels together for a colour)
  readonly rel: number;          // rms / max(std, 1e-12)
}
/** Decimates `fine` to the size of `coarse` and compares. Throws unless (fine.width − 1) / (coarse.width − 1) is a power of two. */
export function compareLadder(coarse: FieldData, fine: FieldData): LadderDiff {
  throw new Error('not implemented: compareLadder');
}
export function expectLadder(coarse: FieldData, fine: FieldData, tol: { max?: number; rms?: number; rel?: number }): LadderDiff {
  throw new Error('not implemented: expectLadder');
}

/** Renders the node at each resolution with the same options; fixture inputs are taken at each resolution. */
export function renderLadder(
  def: NodeDef,
  opts?: RenderOptions & { readonly resolutions?: readonly number[] },   // default [257, 513]
): Promise<Readonly<Record<number, Readonly<Record<string, FieldData>>>>> {
  throw new Error('not implemented: renderLadder');
}
