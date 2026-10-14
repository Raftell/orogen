// The one search over the node catalogue, for the library and for the graph's add-node palette: fuzzy over a
// node's title, its keywords, the names other tools use for it and its type, and by whole words over its
// description. A node is found by the best of these, and the title counts most, so that typing the start of a
// title always brings that node to the top. No DOM and no React.

import fuzzysort, { type Prepared } from 'fuzzysort';

import type { Tool } from './node-aliases.ts';
import type { Catalog, CatalogEntry } from './node-catalog.ts';

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

/** A word found without the plural it was typed with ("satmaps", "deposits") counts a little less than the word itself. */
const PLURAL_WEIGHT = 0.97;
/** A query of several words that each match another field of a node counts less than one field that holds them all. */
const SPREAD_WEIGHT = 0.9;
/**
 * An export node that is found by a part of its title stands behind a node that makes what it exports: "color"
 * is first the node that colours a terrain, then the one that writes a colour texture. Its whole title, and any
 * other field, counts in full.
 */
const EXPORT_PART_WEIGHT = 0.9;
/**
 * What a project is built for (export-unreal.md 2.2): of nodes a search finds equally well, the one that exports
 * the terrain itself comes first. "export" and "output" are then answered with it, not with the first export node
 * of the alphabet.
 */
export const PRIMARY_EXPORT = 'io/export-landscape';

/** The spellings a query is read as: British "colour" is the product's "color". */
function spelled(word: string): string {
  return word.replace(/colour/gi, 'color');
}

/** What a word that found nothing is asked for on its second reading, and how much what it then finds counts. */
const SLIP_THRESHOLD = 0.25;
const SLIP_WEIGHT = 0.6;

type Found = Omit<SearchHit, 'entry'>;

/** The best field of each entry for one piece of text (a whole query, or one word of it). */
function matches(index: SearchIndex, text: string, weight = 1): Map<number, Found> {
  const best = new Map<number, Found>();
  const found = fuzzysort.go(text, index.targets, { key: (target) => target.prepared, threshold: FUZZY_THRESHOLD, limit: 0 });
  for (const result of found) {
    const target = result.obj;
    const entry = index.entries[target.entry]!;
    const whole = result.score > 0.99;
    const part = target.field === 'title' && !whole && entry.exports ? EXPORT_PART_WEIGHT : 1;
    const score = result.score * FIELD_WEIGHT[target.field] * weight * part;
    const held = best.get(target.entry);
    if (held && held.score >= score) continue;
    best.set(target.entry, {
      score,
      field: target.field,
      matched: target.field === 'alias' || target.field === 'keyword' ? target.text : null,
      tool: target.tool,
      titleIndexes: target.field === 'title' ? [...result.indexes].sort((a, b) => a - b) : [],
    });
  }
  return best;
}

/** One word, as typed and without a plural "s": whichever finds an entry better. */
function wordMatches(index: SearchIndex, word: string): Map<number, Found> {
  const best = matches(index, word);
  if (word.length >= 5 && /s$/i.test(word) && !/ss$/i.test(word)) {
    for (const [entry, hit] of matches(index, word.slice(0, -1), PLURAL_WEIGHT)) {
      const held = best.get(entry);
      if (!held || hit.score > held.score) best.set(entry, hit);
    }
  }
  return best;
}

/**
 * The nodes a query finds, best first; of nodes found equally well the terrain's own export, then the order of
 * the catalogue. A query of several words finds the nodes that hold all of them in one field ("slope bl"), and
 * the nodes that hold each in a field of its own, in any order ("landscape export", "erosion hydraulic"). An
 * empty query finds nothing: the caller shows the catalogue itself.
 */
export function searchCatalog(index: SearchIndex, query: string): SearchHit[] {
  const text = spelled(query.trim());
  if (text === '') return [];
  const best = new Map<number, SearchHit>();
  const offer = (entry: number, hit: Found): void => {
    const held = best.get(entry);
    if (!held || hit.score > held.score) best.set(entry, { entry: index.entries[entry]!, ...hit });
  };

  const typed = text.split(/\s+/).filter((word) => word !== '');
  // The whole query against each field; one word alone is also tried without its plural.
  for (const [entry, hit] of typed.length === 1 ? wordMatches(index, text) : matches(index, text)) offer(entry, hit);
  if (typed.length > 1 && typed.length <= 6) {
    // Each word where it stands. A node counts when it holds every word; it is found as well as its weakest word.
    const perWord = typed.map((word) => wordMatches(index, word));
    for (const [entry, first] of perWord[0]!) {
      let weakest = first.score;
      let shown: Found = first;
      let all = true;
      for (const other of perWord.slice(1)) {
        const hit = other.get(entry);
        if (!hit) {
          all = false;
          break;
        }
        weakest = Math.min(weakest, hit.score);
        // The row says the word that was found outside the title, or marks the title's letters.
        if (shown.field === 'title' && hit.field !== 'title') shown = hit;
      }
      if (all) offer(entry, { ...shown, score: weakest * SPREAD_WEIGHT, titleIndexes: perWord.flatMap((found) => found.get(entry)!.titleIndexes).sort((a, b) => a - b) });
    }
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

  // Nothing at all: a word with a slip of the hand is read once more, with a doubled letter taken out
  // ("errosion") and with less asked of the match ("moutain"). What it finds stands below every sure match.
  if (best.size === 0 && typed.length === 1 && text.length >= 5) {
    const undoubled = text.replace(/(\p{L})\1/giu, '$1');
    for (const [entry, hit] of undoubled === text ? [] : matches(index, undoubled, SLIP_WEIGHT)) offer(entry, hit);
    if (best.size === 0) {
      for (const result of fuzzysort.go(text, index.targets.filter((target) => target.field === 'title'), { key: (target) => target.prepared, threshold: SLIP_THRESHOLD, limit: 0 })) {
        offer(result.obj.entry, { score: result.score * SLIP_WEIGHT, field: 'title', matched: null, tool: null, titleIndexes: [...result.indexes].sort((a, b) => a - b) });
      }
    }
  }

  const order = new Map(index.entries.map((entry, at) => [entry, at]));
  const primary = (hit: SearchHit): number => (hit.entry.type === PRIMARY_EXPORT ? 0 : 1);
  return [...best.values()].sort((a, b) => b.score - a.score || primary(a) - primary(b) || order.get(a.entry)! - order.get(b.entry)!);
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
