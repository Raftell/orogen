export type FieldKind = 'field' | 'vec2' | 'color' | 'aux' | 'half' | 'half2' | 'mask8';

export interface Field<K extends FieldKind = FieldKind> {
  readonly kind: K;
  readonly width: number;      // texels
  readonly height: number;     // texels
  readonly readOnly: boolean;  // true for inputs and for fields already passed to ctx.output()
  readonly id: number;         // unique within the engine session; appears in error messages as "field #id"
}

export type Rgba = readonly [number, number, number, number];

export type Kind1 = 'field' | 'half' | 'mask8';
export type Kind2 = 'vec2' | 'half2';
export type Kind4 = 'color' | 'aux';
/** The kinds with the same channel count as K. */
export type SameShape<K extends FieldKind> = K extends Kind1 ? Kind1 : K extends Kind2 ? Kind2 : Kind4;

/** Channels per texel of each kind (engine.md 1.2). */
export const CHANNELS: Readonly<Record<FieldKind, 1 | 2 | 4>> = {
  field: 1, vec2: 2, color: 4, aux: 4, half: 1, half2: 2, mask8: 1,
};
