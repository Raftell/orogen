// Nodes on the clipboard (runtime.md 8.8 rule 3): a fragment of a document as text, so that it can be pasted
// into another application instance, or into a text editor and back. Pure: no DOM, no React.

import type { DocFragment, NodeGroup } from '../../../core/runtime.ts';

/** What marks a clipboard text as nodes of Orogen. */
export const CLIPBOARD_FORMAT = 'orogen-nodes';
export const CLIPBOARD_VERSION = 1;

/** Clipboard text above this many characters is not looked at: nothing a person copies as nodes is that large. */
export const CLIPBOARD_MAX_LENGTH = 16 * 2 ** 20;

/** What the graph copies: nodes, the wires between them (runtime.md 4.6), and the groups that frame them. */
export interface ClipboardFragment extends DocFragment { readonly groups: readonly NodeGroup[] }

/** Groups a clipboard text may bring: a text is not trusted to be short. */
const GROUPS_MAX = 256;
const GROUP_TITLE_MAX = 64;

export function fragmentToText(fragment: DocFragment, groups: readonly NodeGroup[] = []): string {
  return JSON.stringify({
    format: CLIPBOARD_FORMAT, version: CLIPBOARD_VERSION, nodes: fragment.nodes, edges: fragment.edges,
    // Without groups the text is what it was before groups were copied: older builds read either.
    ...(groups.length > 0 ? { groups } : {}),
  }, null, 2);
}

/** A group as a clipboard text may hold it: read member by member, since the text can come from anywhere. */
function groupOf(held: unknown): NodeGroup | null {
  if (typeof held !== 'object' || held === null) return null;
  const { id, title, color, rect } = held as { id?: unknown; title?: unknown; color?: unknown; rect?: unknown };
  if (typeof rect !== 'object' || rect === null) return null;
  const { x, y, w, h } = rect as { x?: unknown; y?: unknown; w?: unknown; h?: unknown };
  if (![x, y, w, h].every((value) => typeof value === 'number' && Number.isFinite(value)) || (w as number) <= 0 || (h as number) <= 0) return null;
  return {
    id: typeof id === 'string' ? id : '',
    title: typeof title === 'string' ? title.slice(0, GROUP_TITLE_MAX) : '',
    ...(typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? { color: color.toLowerCase() } : {}),
    rect: { x: x as number, y: y as number, w: w as number, h: h as number },
  };
}

/**
 * The fragment a clipboard text holds; null for any other text, and for a fragment of a later format. What the
 * lists hold is not checked here: `pasteNodes` reads every node as the loader does and leaves out what is none
 * (runtime.md 4.6).
 */
export function fragmentFromText(text: string): ClipboardFragment | null {
  if (typeof text !== 'string' || text.length > CLIPBOARD_MAX_LENGTH) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const held = parsed as { format?: unknown; version?: unknown; nodes?: unknown; edges?: unknown; groups?: unknown };
  if (held.format !== CLIPBOARD_FORMAT || typeof held.version !== 'number' || held.version > CLIPBOARD_VERSION) return null;
  if (!Array.isArray(held.nodes) || held.nodes.length === 0) return null;
  const groups = Array.isArray(held.groups) ? held.groups.slice(0, GROUPS_MAX).flatMap((group) => groupOf(group) ?? []) : [];
  return { nodes: held.nodes, edges: Array.isArray(held.edges) ? held.edges : [], groups };
}
