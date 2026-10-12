import type { FieldData } from './field-data.ts';

export type PreviewStyle = 'grey' | 'hillshade' | '3d' | 'color' | 'sheet';

export interface PreviewOptions {
  readonly style?: PreviewStyle;                              // default: 'sheet' for a field, 'color' for a colour
  readonly range?: readonly [number, number] | 'auto';        // 'grey': the values drawn black and white. Default [0, 1]; 'auto' is [min, max]
  readonly height?: FieldData;                                // the terrain to shade when `f` is a mask or a colour, which is drawn over it
  readonly terrainSize?: number;                              // metres; default 4096
  readonly heightRange?: number;                              // metres; default 1024
  readonly crop?: readonly [x: number, y: number, size: number];
}

/** Writes <OROGEN_TEST_OUTPUT>/<name>.png and returns its absolute path. `name` matches /^[a-z0-9][a-z0-9/_.-]*$/. */
export function writePreview(name: string, f: FieldData, opts?: PreviewOptions): Promise<string> {
  throw new Error('not implemented: writePreview');
}
