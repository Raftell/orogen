export type ResampleFilter = 'auto' | 'nearest' | 'bilinear' | 'tent' | 'bspline';
export type Img = 'field' | 'color';

export interface LadderLevel {
  readonly res: number;                                  // vertices per side at this level
  readonly cellSize: number;                             // metres
  readonly index: number;                                // 0 = the coarsest level of this run
  readonly count: number;                                // number of levels in this run
  readonly progress: readonly [from: number, to: number];// this level's share of the node's progress
}
