// The recently used nodes: the types of the nodes that were added to a graph last, newest first, whoever added
// them: the library, the graph's own palette, a drop. No DOM and no React.

import type { DocState } from '../../state/doc-store.ts';

/** How many types the list keeps. */
export const RECENT_MAX = 8;

/** `type` at the front of the list, once. */
export function pushRecent(recent: readonly string[], type: string, max: number = RECENT_MAX): string[] {
  return [type, ...recent.filter((held) => held !== type)].slice(0, Math.max(0, max));
}

/** A stored list, as far as it is one: strings, each once, at most RECENT_MAX. Anything else is an empty list. */
export function cleanRecent(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const types: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item !== '' && !types.includes(item)) types.push(item);
    if (types.length === RECENT_MAX) break;
  }
  return types;
}

export type DocSnapshot = Pick<DocState, 'doc' | 'past' | 'future'>;

/**
 * The type of the node a user has just added, read from two states of the document store, or null. It is a
 * transaction of its own that added exactly one node: not an undo or a redo, which bring back what was used
 * before; not a project that was opened; and not a paste or a duplicate of several nodes, which would fill the
 * list with one gesture.
 */
export function addedType(previous: DocSnapshot, next: DocSnapshot): string | null {
  if (next.doc === previous.doc || next.doc.nodes === previous.doc.nodes) return null;
  const entry = next.past[next.past.length - 1];
  // A loaded project has no history; an undo ends on an entry that was there before; a redo on one that was undone.
  if (!entry || previous.past.includes(entry) || previous.future.includes(entry)) return null;
  let added: string | null = null;
  for (const id of Object.keys(next.doc.nodes)) {
    if (Object.hasOwn(previous.doc.nodes, id)) continue;
    if (added !== null) return null;
    added = next.doc.nodes[id]!.type;
  }
  return added;
}
