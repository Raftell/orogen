// The rows of the library's node list over the catalogue (src/app/ui/node-catalog.ts, which the graph's add-node
// palette reads as well): the sections, the recently used nodes, and the row a key moves to. No DOM and no React.

import type { Catalog, CatalogEntry, ProductCategory } from '../../ui/node-catalog.ts';
import type { SearchHit } from '../../ui/node-search.ts';

export * from '../../ui/node-catalog.ts';

// ---- the rows of the list -------------------------------------------------------------------------------------------

/** The section of recently used nodes, above the categories. */
export const RECENT_SECTION = 'recent';
/** What the rows of a search belong to: they have no section header. */
export const SEARCH_SECTION = 'search';
export type SectionId = ProductCategory | typeof RECENT_SECTION | typeof SEARCH_SECTION;

export type Row =
  | { readonly kind: 'section'; readonly key: string; readonly section: SectionId; readonly title: string; readonly hint: string; readonly count: number; readonly open: boolean }
  /** `hit`: how a search found the node; absent in the catalogue. */
  | { readonly kind: 'node'; readonly key: string; readonly section: SectionId; readonly entry: CatalogEntry; readonly hit?: SearchHit };

export const sectionKey = (section: SectionId): string => `section:${section}`;
export const nodeKey = (section: SectionId, type: string): string => `${section}:${type}`;

/**
 * The rows of the catalogue when nothing is searched: the recently used nodes, newest first, then each category
 * with its nodes. A collapsed section is its header alone. A recent type the catalogue lacks is left out.
 */
export function catalogRows(catalog: Catalog, recent: readonly string[], collapsed: readonly string[]): Row[] {
  const rows: Row[] = [];
  const section = (id: SectionId, title: string, hint: string, entries: readonly CatalogEntry[]): void => {
    const open = !collapsed.includes(id);
    rows.push({ kind: 'section', key: sectionKey(id), section: id, title, hint, count: entries.length, open });
    if (open) for (const entry of entries) rows.push({ kind: 'node', key: nodeKey(id, entry.type), section: id, entry });
  };
  const used = recent.map((type) => catalog.get(type)).filter((entry): entry is CatalogEntry => entry !== undefined);
  if (used.length > 0) section(RECENT_SECTION, 'Recently Used', 'The nodes added to a graph last, newest first', used);
  for (const group of catalog.groups) section(group.category, group.title, group.hint, group.entries);
  return rows;
}

export type Move = 'next' | 'previous' | 'first' | 'last' | 'pageDown' | 'pageUp';
/** Rows a page key moves by. */
export const PAGE_ROWS = 8;

/** The key of the row a navigation key moves to from `active`. Without an active row, the first or the last. */
export function moveActive(rows: readonly { readonly key: string }[], active: string | null, move: Move): string | null {
  if (rows.length === 0) return null;
  const last = rows.length - 1;
  const at = active === null ? -1 : rows.findIndex((row) => row.key === active);
  let to: number;
  switch (move) {
    case 'first': to = 0; break;
    case 'last': to = last; break;
    case 'next': to = at < 0 ? 0 : Math.min(last, at + 1); break;
    case 'previous': to = at < 0 ? last : Math.max(0, at - 1); break;
    case 'pageDown': to = at < 0 ? 0 : Math.min(last, at + PAGE_ROWS); break;
    case 'pageUp': to = at < 0 ? last : Math.max(0, at - PAGE_ROWS); break;
  }
  return rows[to]!.key;
}
