import type { NodeDef } from '../../api.ts';
import cellularNoise from './cellular-noise.ts';
import constant from './constant.ts';
import erodedNoise from './eroded-noise.ts';
import fractalNoise from './fractal-noise.ts';
import gradient from './gradient.ts';
import radialGradient from './radial-gradient.ts';
import shape from './shape.ts';
import waves from './waves.ts';

export const nodes: readonly NodeDef[] = [cellularNoise, constant, erodedNoise, fractalNoise, gradient, radialGradient, shape, waves];
