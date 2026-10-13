import type { NodeDef } from '../../api.ts';
import canyon from './canyon.ts';
import crater from './crater.ts';
import craterField from './crater-field.ts';
import dunes from './dunes.ts';
import island from './island.ts';
import mountain from './mountain.ts';
import mountainRange from './mountain-range.ts';
import volcano from './volcano.ts';

export const nodes: readonly NodeDef[] = [canyon, crater, craterField, dunes, island, mountain, mountainRange, volcano];
