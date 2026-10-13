import type { OpContext } from '../eval/context.ts';
import type { Field, FieldKind } from '../gpu/field.ts';
import { blend } from './blend.ts';
import { blur } from './blur.ts';
import { coarseToFine } from './coarse-to-fine.ts';
import { copy } from './copy.ts';
import { minMax } from './min-max.ts';
import { normal } from './normal.ts';
import { occlusion, type OcclusionOptions } from './occlusion.ts';
import { remap } from './remap.ts';
import { resample } from './resample.ts';
import { shadow, type ShadowOptions } from './shadow.ts';
import { slope } from './slope.ts';
import { fit, restore, scale, smooth, type Fitted, type FitWants, type Scale, type SmoothOptions } from './smooth.ts';
import type { Img, LadderLevel, ResampleFilter } from './types.ts';

export const ops: {
  copy<K extends FieldKind>(ctx: OpContext, src: Field<K>, dst: Field<NoInfer<K>>): void;
  resample<K extends Img>(ctx: OpContext, src: Field<K>, opts: { size: number; filter?: ResampleFilter; ring?: { readonly src?: boolean; readonly out?: boolean } }): Field<K>;
  blur<K extends Img>(ctx: OpContext, src: Field<K>, sigma: number): Field<K>;
  smooth<K extends Img>(ctx: OpContext, src: Field<K>, sigma: number, opts?: SmoothOptions): Field<K>;
  scale<K extends Img>(ctx: OpContext, src: Field<K>, sigma: number, opts?: SmoothOptions): Scale<K>;
  fit<K extends Img>(ctx: OpContext, scale: Scale<K>, src: Field<NoInfer<K>>, axis: 0 | 1, want: FitWants): Fitted<K>;
  restore<K extends Img>(ctx: OpContext, scale: Scale<K>, field: Field<NoInfer<K>>): Field<K>;
  blend<K extends Img>(ctx: OpContext, a: Field<K>, b: Field<NoInfer<K>>, mask: Field<'field'> | number): Field<K>;
  slope(ctx: OpContext, height: Field<'field'>): Field<'field'>;
  normal(ctx: OpContext, height: Field<'field'>): Field<'color'>;
  shadow(ctx: OpContext, height: Field<'field'>, opts: ShadowOptions): Promise<Field<'field'>>;
  occlusion(ctx: OpContext, height: Field<'field'>, radius: number, opts?: OcclusionOptions): Promise<Field<'field'>>;
  minMax(ctx: OpContext, src: Field<'field'>): Field<'vec2'>;
  remap(ctx: OpContext, src: Field<'field'>, opts: {
    from: readonly [number, number] | Field<'vec2'>;
    to?: readonly [number, number];
    clamp?: boolean;
  }): Field<'field'>;
  coarseToFine<S>(ctx: OpContext, opts: {
    coarsestCell: number;
    begin(level: LadderLevel): S;
    simulate(level: LadderLevel, state: S): Promise<void>;
    refine(coarse: LadderLevel, fine: LadderLevel, state: S): S;
  }): Promise<S>;
} = { copy, resample, blur, smooth, scale, fit, restore, blend, slope, normal, shadow, occlusion, minMax, remap, coarseToFine };
