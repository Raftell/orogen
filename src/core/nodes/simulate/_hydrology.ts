import type { NodeDef } from '../../api.ts';
import fill from './fill.ts';
import flow from './flow.ts';
import lakes from './lakes.ts';
import rivers from './rivers.ts';
import sea from './sea.ts';

export const nodes: readonly NodeDef[] = [fill, flow, lakes, rivers, sea];
