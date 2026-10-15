// The import guide the panel opens: the import by hand of docs/user/unreal-import.md, sections 1 to 4, word for
// word (guide-text.ts holds the text, written by tests/ui/build/make-guide.ts), and which of a build's numbers
// belong to which of its steps. Every statement about Unreal keeps the mark the documentation gives it: the
// procedure has been run once, on Unreal Engine 5.8 (unreal-import.md 6.5). No DOM and no React.

export interface GuideItem {
  readonly text: string;
  /** The points listed under the item. */
  readonly bullets?: readonly string[];
  /** Paragraphs that follow the points, still part of the item. */
  readonly more?: readonly string[];
}

export interface GuideSection {
  readonly number: number;
  readonly title: string;
  readonly before: readonly string[];
  readonly list: 'ordered' | 'bullets' | null;
  readonly items: readonly GuideItem[];
  readonly after: readonly string[];
}

/** The section whose items are the steps of the import. */
export const STEPS_SECTION = 2;

/** The groups of `importGroups` (manifest.ts) shown under a step of section 2, by the step's number. */
export const STEP_GROUPS: Readonly<Record<number, readonly string[]>> = {
  3: ['heightmap'],
  6: ['layout'],
  7: ['scale'],
  8: ['location'],
  10: ['layers'],
  11: ['partition'],
  13: ['check'],
  16: ['textures'],
};

export type InlinePart = { readonly kind: 'text' | 'code' | 'strong'; readonly text: string };

/** The inline marks the guide's text uses: `code` and **strong**. Everything else is text as it stands. */
export function inlineParts(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let at = 0;
  for (const found of text.matchAll(pattern)) {
    if (found.index > at) parts.push({ kind: 'text', text: text.slice(at, found.index) });
    parts.push(found[1] !== undefined ? { kind: 'code', text: found[1] } : { kind: 'strong', text: found[2]! });
    at = found.index + found[0].length;
  }
  if (at < text.length) parts.push({ kind: 'text', text: text.slice(at) });
  return parts;
}
