import type { NodeDef } from '../../api.ts';
import aspect from './aspect.ts';
import curvature from './curvature.ts';
import distance from './distance.ts';
import edge from './edge.ts';
import exposure from './exposure.ts';
import height from './height.ts';
import occlusion from './occlusion.ts';
import peaks from './peaks.ts';
import roughness from './roughness.ts';
import slope from './slope.ts';

export const nodes: readonly NodeDef[] = [aspect, curvature, distance, edge, exposure, height, occlusion, peaks, roughness, slope];
