import type { NodeDef } from '../../api.ts';
import cracks from './cracks.ts';
import fault from './fault.ts';
import outcrops from './outcrops.ts';
import ripples from './ripples.ts';
import roughen from './roughen.ts';
import scatter from './scatter.ts';
import stones from './stones.ts';
import strata from './strata.ts';
import terraces from './terraces.ts';

export const nodes: readonly NodeDef[] = [cracks, fault, outcrops, ripples, roughen, scatter, stones, strata, terraces];
