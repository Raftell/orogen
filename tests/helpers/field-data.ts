export interface FieldData {
  readonly kind: 'field' | 'color';
  readonly width: number;
  readonly height: number;
  readonly channels: 1 | 4;
  readonly data: Float32Array;              // row-major, tightly packed: the layout of ctx.read (engine.md 4.7)
}

export function fieldOf(res: number, fn: (u: number, v: number) => number): FieldData {
  throw new Error('not implemented: fieldOf');
}
export function colorOf(res: number, fn: (u: number, v: number) => readonly [number, number, number, number]): FieldData {
  throw new Error('not implemented: colorOf');
}
export function at(f: FieldData, x: number, y: number, channel?: number): number {      // channel defaults to 0
  throw new Error('not implemented: at');
}
export function channelOf(f: FieldData, channel: 0 | 1 | 2 | 3): FieldData {            // a 'field' holding one channel of a colour
  throw new Error('not implemented: channelOf');
}
