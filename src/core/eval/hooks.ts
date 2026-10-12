export interface EngineTestHooks {
  readonly sliceTargetMs?: number;        // replaces both slice targets, the bound on unmeasured kernels and the run limit of a slice
  readonly inFlightLimit?: 1 | 2;         // 2 requires timestamp-query
  readonly maxTileRows?: number;          // no tile has more rows: forces tiling at any size
  readonly failAllocAfter?: number;       // the nth texture creation from now reports GPU out of memory, once
  readonly poisonRecycled?: boolean;      // a recycled texture is filled with −1e30 before it is handed out
  readonly onSlice?: (s: { readonly nodeId: string | null; readonly service: string | null;
                           readonly kernels: readonly string[];
                           readonly work: number; readonly estimateMs: number;
                           readonly measuredMs: number; readonly resolved: boolean }) => void;
}
