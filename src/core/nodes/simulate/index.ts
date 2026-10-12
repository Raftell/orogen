import type { NodeDef } from '../../api.ts';
import { nodes as erosion } from './_erosion.ts';
import { nodes as hydrology } from './_hydrology.ts';

// Two owners share the category by file (nodes.md section 4): each lists its nodes in its own private index
// module, and neither edits this file.
export const nodes: readonly NodeDef[] = [...erosion, ...hydrology].sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
