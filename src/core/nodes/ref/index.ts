import type { NodeDef } from '../../api.ts';
import autolevel from './autolevel.ts';
import blur from './blur.ts';
import colorize from './colorize.ts';
import combine from './combine.ts';
import distance from './distance.ts';
import fail from './fail.ts';
import fbm from './fbm.ts';
import image from './image.ts';
import slopeMask from './slope-mask.ts';
import talus from './talus.ts';

export const nodes: readonly NodeDef[] = [autolevel, blur, colorize, combine, distance, fail, fbm, image, slopeMask, talus];
