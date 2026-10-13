import type { NodeDef } from '../../api.ts';
import blur from './blur.ts';
import directionalBlur from './directional-blur.ts';
import edgeFade from './edge-fade.ts';
import flip from './flip.ts';
import growShrink from './grow-shrink.ts';
import highPass from './high-pass.ts';
import median from './median.ts';
import sharpen from './sharpen.ts';
import slopeBlur from './slope-blur.ts';
import slopeWarp from './slope-warp.ts';
import smartBlur from './smart-blur.ts';
import transform from './transform.ts';
import twirl from './twirl.ts';
import warp from './warp.ts';

export const nodes: readonly NodeDef[] = [
  blur, directionalBlur, edgeFade, flip, growShrink, highPass, median, sharpen, slopeBlur, slopeWarp, smartBlur, transform, twirl, warp,
];
