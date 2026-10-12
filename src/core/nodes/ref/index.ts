import type { NodeDef } from '../../api.ts';
import fbm from './fbm.ts';
import talus from './talus.ts';

export const nodes: readonly NodeDef[] = [fbm, talus];
