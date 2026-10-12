import type { NodeDef } from '../../api.ts';
import { nodes as basics } from './_basics.ts';
import { nodes as landforms } from './_landforms.ts';

// Two owners share the category by file (nodes.md section 1): each lists its nodes in its own private index
// module, and neither edits this file.
export const nodes: readonly NodeDef[] = [...basics, ...landforms].sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
