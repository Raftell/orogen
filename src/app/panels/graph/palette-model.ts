// What the add-node palette lists: the node catalogue of the application (src/app/ui/node-catalog.ts), which is
// what the library lists too, narrowed by the wire it was opened for, by a category and by what the user typed.
// The search is the application's one search over that catalogue (src/app/ui/node-search.ts): a few letters of a
// title, a keyword, or the name another tool has for the node find it in both places, in the same order. The
// engine's reference nodes are no part of the catalogue and are not offered. Pure: no DOM, no React.

import type { NodeRegistry } from '../../../core/runtime.ts';
import { catalogOf, type CatalogEntry, type ProductCategory } from '../../ui/node-catalog.ts';
import { createSearchIndex, matchText, searchCatalog, titleRuns, type SearchIndex } from '../../ui/node-search.ts';
import { acceptsWire, type Pending } from './connect.ts';

export interface PaletteEntry {
  readonly type: string;
  readonly title: string;
  readonly category: ProductCategory;
  readonly description: string;
  /** The keywords in one line, as they are shown. */
  readonly keywords: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
}

/** The entries a palette offers, in their order, with what finds them. */
export interface PaletteList extends ReadonlyArray<PaletteEntry> {
  readonly index: SearchIndex;
}

function entryOf(entry: CatalogEntry): PaletteEntry {
  return {
    type: entry.type,
    title: entry.title,
    category: entry.category,
    description: entry.description,
    keywords: entry.keywords.join(', '),
    inputs: entry.inputs.map((port) => port.label),
    outputs: entry.outputs.map((port) => port.label),
  };
}

/**
 * The types the palette offers, by category in the order of engine.md 4.1 and by title within one: the product's
 * nodes, as the library lists them. For a dragged wire only the types the wire can end at: every field and
 * colour connects (runtime.md 4.3 rule 4), so that is every type with a port on the other side.
 */
export function paletteEntries(registry: NodeRegistry, pending: Pending | null = null): PaletteList {
  const catalog = catalogOf(registry);
  const kept = catalog.entries.filter((entry) => {
    const def = registry.get(entry.type);
    return def !== undefined && acceptsWire(def, pending);
  });
  const offered = new Set(kept.map((entry) => entry.type));
  const narrowed = { groups: catalog.groups, entries: kept, get: (type: string) => (offered.has(type) ? catalog.get(type) : undefined) };
  return Object.assign(kept.map(entryOf), { index: createSearchIndex(narrowed) });
}

/** A piece of a title: `match` marks the letters the search found. */
export interface TitlePart { readonly text: string; readonly match: boolean }

export interface PaletteRow {
  readonly entry: PaletteEntry;
  readonly title: readonly TitlePart[];
  /** What the search found the type by when it was not its title: a keyword, or "Erosion2 in Gaea"; else null. */
  readonly matchedKeywords: string | null;
}

function found(entries: PaletteList, text: string): PaletteRow[] {
  if (text.trim() === '') return entries.map((entry) => ({ entry, title: [{ text: entry.title, match: false }], matchedKeywords: null }));
  const byType = new Map(entries.map((entry) => [entry.type, entry]));
  return searchCatalog(entries.index, text).map((hit) => ({
    entry: byType.get(hit.entry.type)!,
    title: titleRuns(hit.entry.title, hit.titleIndexes).map((run) => ({ text: run.text, match: run.strong })),
    matchedKeywords: matchText(hit),
  }));
}

/**
 * The rows for a search: without text every entry in its order, with text the matches, best first. `category`
 * narrows either to one category.
 */
export function searchPalette(entries: PaletteList, text: string, category: ProductCategory | null = null): PaletteRow[] {
  const rows = found(entries, text);
  return category === null ? rows : rows.filter((row) => row.entry.category === category);
}

export interface CategoryCount { readonly category: ProductCategory | null; readonly count: number }

/** The categories that have a match for the text, with how many: first all of them together, then each in its order. */
export function paletteCategories(entries: PaletteList, text: string): CategoryCount[] {
  const rows = found(entries, text);
  const counts = new Map<ProductCategory, number>();
  for (const row of rows) counts.set(row.entry.category, (counts.get(row.entry.category) ?? 0) + 1);
  const order = [...new Set(entries.map((entry) => entry.category))];
  return [{ category: null, count: rows.length }, ...order.filter((category) => counts.has(category)).map((category) => ({ category, count: counts.get(category)! }))];
}

// ---- where the palette lies ------------------------------------------------------------------------------------------

/** The room the palette keeps to the edge of the window. */
export const PALETTE_MARGIN = 8;

/**
 * The top-left corner of the palette in a window of `bounds`, opened for the point `at`. It lies beside the point,
 * on the side asked for when it fits there and on the other when it fits only there, so that what led to the
 * point (a wire from the left, or one from the right) stays in sight; up and down it is moved until it fits. In a
 * window narrower than two palettes it lies as near the point as the window allows.
 */
export function palettePlace(
  at: { readonly x: number; readonly y: number }, bounds: { readonly width: number; readonly height: number },
  size: { readonly width: number; readonly height: number }, side: 'right' | 'left' = 'right',
): { readonly left: number; readonly top: number } {
  const clamp = (value: number, most: number): number => Math.max(PALETTE_MARGIN, Math.min(value, most));
  const fits = { right: at.x + size.width + PALETTE_MARGIN <= bounds.width, left: at.x - size.width - PALETTE_MARGIN >= 0 };
  const other = side === 'right' ? 'left' : 'right';
  const chosen = fits[side] ? side : fits[other] ? other : null;
  const left = chosen === 'left' ? at.x - size.width : at.x;
  return { left: Math.round(clamp(left, bounds.width - size.width - PALETTE_MARGIN)), top: Math.round(clamp(at.y, bounds.height - size.height - PALETTE_MARGIN)) };
}
