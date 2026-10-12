import type { NodeDef } from '../api.ts';
import { nodes as adjust } from './adjust/index.ts';
import { nodes as color } from './color/index.ts';
import { nodes as filter } from './filter/index.ts';
import { nodes as generate } from './generate/index.ts';
import { nodes as io } from './io/index.ts';
import { nodes as ref } from './ref/index.ts';
import { nodes as select } from './select/index.ts';
import { nodes as simulate } from './simulate/index.ts';
import { nodes as surface } from './surface/index.ts';

/**
 * Every NodeDef of the nine categories, sorted by type. Importing this module runs every defineNode,
 * defineKernel and defineCpuTask of the product (runtime.md 5.1).
 */
export const nodes: readonly NodeDef[] = [
  ...adjust, ...color, ...filter, ...generate, ...io, ...ref, ...select, ...simulate, ...surface,
].sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
