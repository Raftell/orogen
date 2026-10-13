// What the add-node palette lists: every node type of the registry, narrowed by the wire it was opened for, by
// a category and by what the user typed, found by a few letters of its title or of a keyword (runtime.md 8.9:
// fuzzysort). Pure: no DOM, no React.

import fuzzysort from 'fuzzysort';

import type { Category, NodeDef } from '../../../core/api.ts';
import type { NodeRegistry } from '../../../core/runtime.ts';
import { acceptsWire, type Pending } from './connect.ts';
import { CATEGORIES, inputsOf, portLabel } from './model.ts';

export interface PaletteEntry {
  readonly type: string;
  readonly title: string;
  readonly category: Category;
  readonly description: string;
  /** The keywords in one line, as they are shown. */
  readonly keywords: string;
  readonly keywordList: readonly string[];
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
}

function entryOf(def: NodeDef): PaletteEntry {
  return {
    type: def.type,
    title: def.title,
    category: def.category,
    description: def.description,
    keywords: (def.keywords ?? []).join(', '),
    keywordList: def.keywords ?? [],
    inputs: inputsOf(def).map(portLabel),
    outputs: def.outputs.map(portLabel),
  };
}

/**
 * The types the palette offers, by category in the order of engine.md 4.1 and by title within one. For a
 * dragged wire only the types the wire can end at: every field and colour connects (runtime.md 4.3 rule 4), so
 * that is every type with a port on the other side.
 */
export function paletteEntries(registry: NodeRegistry, pending: Pending | null = null): PaletteEntry[] {
  const rank = new Map(CATEGORIES.map((category, index) => [category, index]));
  return registry.list()
    .filter((def) => acceptsWire(def, pending))
    .map(entryOf)
    .sort((a, b) => (rank.get(a.category)! - rank.get(b.category)!) || a.title.localeCompare(b.title, 'en'));
}

/** A piece of a title: `match` marks the letters the search found. */
export interface TitlePart { readonly text: string; readonly match: boolean }

export interface PaletteRow {
  readonly entry: PaletteEntry;
  readonly title: readonly TitlePart[];
  /** The keyword line when the search found the type by a keyword and not by its title; else null. */
  readonly matchedKeywords: string | null;
}

/** A match in the title counts for more than the same match in a keyword, and that for more than one in the type id. */
const KEY_WEIGHTS = [1, 0.8, 0.6] as const;
/** A reference node is the template of a product node and found by the same words: the product's node comes first. */
const REFERENCE_WEIGHT = 0.9;
/** fuzzysort's score below which a type is not listed: a few scattered letters are no match. */
const THRESHOLD = 0.3;

function found(entries: readonly PaletteEntry[], text: string): PaletteRow[] {
  const query = text.trim();
  if (query === '') return entries.map((entry) => ({ entry, title: [{ text: entry.title, match: false }], matchedKeywords: null }));
  const order = new Map(entries.map((entry, index) => [entry, index]));
  const results = fuzzysort.go(query, entries, {
    keys: ['title', 'keywords', 'type'],
    limit: 0,
    threshold: THRESHOLD,
    scoreFn(result) {
      // A keyword is matched as the word it is: in the line of all of them, a word further back would count for less.
      const keyword = (result[1]?.score ?? 0) > 0 ? Math.max(0, ...result.obj.keywordList.map((word) => fuzzysort.single(query, word)?.score ?? 0), result[1]!.score * 0.5) : 0;
      const scores = [result[0]?.score ?? 0, keyword, result[2]?.score ?? 0];
      return Math.max(...KEY_WEIGHTS.map((weight, key) => scores[key]! * weight)) * (result.obj.category === 'ref' ? REFERENCE_WEIGHT : 1);
    },
  });
  // Best first; of equal matches the one that comes first in the list.
  return [...results].sort((a, b) => (b.score - a.score) || (order.get(a.obj)! - order.get(b.obj)!)).map((result) => {
    const inTitle = result[0];
    const title: TitlePart[] = inTitle && inTitle.score > 0
      ? inTitle.highlight((match): TitlePart => ({ text: match, match: true }))
        .map((part) => (typeof part === 'string' ? { text: part, match: false } : part))
        .filter((part) => part.text !== '')
      : [{ text: result.obj.title, match: false }];
    const byKeyword = (!inTitle || inTitle.score === 0) && (result[1]?.score ?? 0) > 0;
    return { entry: result.obj, title, matchedKeywords: byKeyword ? result.obj.keywords : null };
  });
}

/**
 * The rows for a search: without text every entry in its order, with text the matches, best first. `category`
 * narrows either to one category.
 */
export function searchPalette(entries: readonly PaletteEntry[], text: string, category: Category | null = null): PaletteRow[] {
  const rows = found(entries, text);
  return category === null ? rows : rows.filter((row) => row.entry.category === category);
}

export interface CategoryCount { readonly category: Category | null; readonly count: number }

/** The categories that have a match for the text, with how many: first all of them together, then each in its order. */
export function paletteCategories(entries: readonly PaletteEntry[], text: string): CategoryCount[] {
  const rows = found(entries, text);
  const counts = new Map<Category, number>();
  for (const row of rows) counts.set(row.entry.category, (counts.get(row.entry.category) ?? 0) + 1);
  return [{ category: null, count: rows.length }, ...CATEGORIES.filter((category) => counts.has(category)).map((category) => ({ category, count: counts.get(category)! }))];
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
