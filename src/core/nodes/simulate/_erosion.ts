import type { NodeDef } from '../../api.ts';
import fluvialErosion from './fluvial-erosion.ts';
import hydraulicErosion from './hydraulic-erosion.ts';
import sediment from './sediment.ts';
import snow from './snow.ts';
import thermalErosion from './thermal-erosion.ts';

export const nodes: readonly NodeDef[] = [fluvialErosion, hydraulicErosion, sediment, snow, thermalErosion];
