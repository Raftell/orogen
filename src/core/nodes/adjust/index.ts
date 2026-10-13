import type { NodeDef } from '../../api.ts';
import autolevel from './autolevel.ts';
import biasGain from './bias-gain.ts';
import clamp from './clamp.ts';
import combine from './combine.ts';
import curve from './curve.ts';
import equalize from './equalize.ts';
import heightBlend from './height-blend.ts';
import invert from './invert.ts';
import levels from './levels.ts';
import math from './math.ts';
import switchNode from './switch.ts';

export const nodes: readonly NodeDef[] = [autolevel, biasGain, clamp, combine, curve, equalize, heightBlend, invert, levels, math, switchNode];
