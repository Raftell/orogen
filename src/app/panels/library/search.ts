// The rows of a search in the library. The search itself is the application's one search over the node catalogue
// (src/app/ui/node-search.ts), which the graph's add-node palette uses too. No DOM and no React.

import { nodeKey, SEARCH_SECTION, type Row } from './catalog.ts';
import type { SearchHit } from '../../ui/node-search.ts';

export * from '../../ui/node-search.ts';

/** The rows of a search: its hits, best first, without sections. */
export function searchRows(hits: readonly SearchHit[]): Row[] {
  return hits.map((hit) => ({ kind: 'node', key: nodeKey(SEARCH_SECTION, hit.entry.type), section: SEARCH_SECTION, entry: hit.entry, hit }));
}
