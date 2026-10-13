// Search over the catalogue: fuzzy over a node's title, its keywords, the names other tools use for it and its
// type, and by whole words over its description. A node is found by the best of these, and the title counts
// most, so that typing the start of a title always brings that node to the top. No DOM and no React.

import fuzzysort, { type Prepared } from 'fuzzysort';

import type { Tool } from './aliases.ts';
import { nodeKey, SEARCH_SECTION, type Catalog, type CatalogEntry, type Row } from './catalog.ts';

export type MatchField = 'title' | 'alias' | 'keyword' | 'type' | 'description';

/** How much a match in each field counts. A perfect keyword ranks below a good title and above a poor one. */
export const FIELD_WEIGHT: Readonly<Record<MatchField, number>> = { title: 1, alias: 0.85, keyword: 0.75, type: 0.6, description: 0.3 };
/** The least a fuzzy match scores to count, of fuzzysort's 0 to 1, where 0.5 is "good". */
export const FUZZY_THRESHOLD = 0.45;

export interface SearchHit {
  readonly entry: CatalogEntry;
  /** 0 to 1: the fuzzy score of the best field, times that field's weight. */
  readonly score: number;
  readonly field: MatchField;
  /** What matched when it was not the title: the keyword, or the other tool's name. Null for a title or a description. */
  readonly matched: string | null;
  /** The tool whose name matched, for the field 'alias'. */
  readonly tool: Tool | null;
  /** The characters of the title that matched, for the field 'title': what a row draws bold. */
  readonly titleIndexes: readonly number[];
}

interface Target {
  readonly entry: number;
  readonly field: Exclude<MatchField, 'description'>;
  readonly text: string;
  readonly tool: Tool | null;
  readonly prepared: Prepared;
}

export interface SearchIndex {
  readonly entries: readonly CatalogEntry[];
  readonly targets: readonly Target[];
  /** The description of each entry, lower-case. */
  readonly descriptions: readonly string[];
}

export function createSearchIndex(catalog: Catalog): SearchIndex {
  const targets: Target[] = [];
  const add = (entry: number, field: Target['field'], text: string, tool: Tool | null = null): void => {
    targets.push({ entry, field, text, tool, prepared: fuzzysort.prepare(text) });
  };
  catalog.entries.forEach((entry, index) => {
    add(index, 'title', entry.title);
    for (const alias of entry.aliases) add(index, 'alias', alias.name, alias.tool);
    for (const keyword of entry.keywords) add(index, 'keyword', keyword);
    // The name part of the type: the category is not what a user types to find a node.
    add(index, 'type', entry.type.slice(entry.type.indexOf('/') + 1).replaceAll('-', ' '));
  });
  return { entries: catalog.entries, targets, descriptions: catalog.entries.map((entry) => entry.description.toLowerCase()) };
}

const WORD = /[\p{L}\p{N}]+/gu;

/**
 * The nodes a query finds, best first; nodes of equal score in the order of the catalogue. An empty query finds
 * nothing: the caller shows the catalogue itself.
 */
export function searchCatalog(index: SearchIndex, query: string): SearchHit[] {
  const text = query.trim();
  if (text === '') return [];
  const best = new Map<number, SearchHit>();
  const offer = (entry: number, hit: Omit<SearchHit, 'entry'>): void => {
    const held = best.get(entry);
    if (!held || hit.score > held.score) best.set(entry, { entry: index.entries[entry]!, ...hit });
  };

  const found = fuzzysort.go(text, index.targets, { key: (target) => target.prepared, threshold: FUZZY_THRESHOLD, limit: 0 });
  for (const result of found) {
    const target = result.obj;
    offer(target.entry, {
      score: result.score * FIELD_WEIGHT[target.field],
      field: target.field,
      matched: target.field === 'alias' || target.field === 'keyword' ? target.text : null,
      tool: target.tool,
      titleIndexes: target.field === 'title' ? [...result.indexes].sort((a, b) => a - b) : [],
    });
  }

  // A description is a sentence: fuzzy matching finds every query in it. It counts when it holds each word as typed.
  const words = text.toLowerCase().match(WORD) ?? [];
  if (words.length > 0 && words.every((word) => word.length >= 3)) {
    index.descriptions.forEach((description, entry) => {
      if (words.every((word) => description.includes(word))) {
        offer(entry, { score: FIELD_WEIGHT.description, field: 'description', matched: null, tool: null, titleIndexes: [] });
      }
    });
  }

  const order = new Map(index.entries.map((entry, at) => [entry, at]));
  return [...best.values()].sort((a, b) => b.score - a.score || order.get(a.entry)! - order.get(b.entry)!);
}

/** The rows of a search: its hits, best first, without sections. */
export function searchRows(hits: readonly SearchHit[]): Row[] {
  return hits.map((hit) => ({ kind: 'node', key: nodeKey(SEARCH_SECTION, hit.entry.type), section: SEARCH_SECTION, entry: hit.entry, hit }));
}

/** What a row says of a hit that was not found by its title: the keyword, or the other tool's name for the node. */
export function matchText(hit: SearchHit): string | null {
  if (hit.field === 'alias' && hit.matched !== null) return `${hit.matched} in ${hit.tool}`;
  if (hit.field === 'keyword') return hit.matched;
  return null;
}

/** A title cut into the runs a row draws: `strong` for the characters a search matched. */
export function titleRuns(title: string, indexes: readonly number[]): { readonly text: string; readonly strong: boolean }[] {
  if (indexes.length === 0) return [{ text: title, strong: false }];
  const marked = new Set(indexes);
  const runs: { text: string; strong: boolean }[] = [];
  for (let at = 0; at < title.length; at++) {
    const strong = marked.has(at);
    const last = runs[runs.length - 1];
    if (last && last.strong === strong) last.text += title[at];
    else runs.push({ text: title[at]!, strong });
  }
  return runs;
}
