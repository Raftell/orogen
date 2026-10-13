// The example projects of the library: the list in examples/index.json, and what the Examples tab says of a
// project file. The files themselves reach the page through example-files.ts. No DOM and no React.

import { parseDoc, type DocProblem, type GraphDoc, type NodeRegistry } from '../../../core/runtime.ts';

export interface ExampleInfo {
  /** The file name without its extension: 'alpine-range'. */
  readonly id: string;
  /** The project file, beside the index: 'alpine-range.orogen'. */
  readonly file: string;
  /** The picture, beside the index: 'alpine-range.png'. */
  readonly image: string;
  readonly title: string;
  /** One or two sentences: what the project makes and what a user learns from it. */
  readonly description: string;
}

const FILE = /^[a-z0-9][a-z0-9-]*\.orogen$/;
const IMAGE = /^[a-z0-9][a-z0-9-]*\.png$/;
export const EXAMPLE_TITLE_MAX = 24;
export const EXAMPLE_DESCRIPTION_MAX = 200;

/** The examples of an index file, in its order. Throws an Error that names the entry which is not one. */
export function parseExampleIndex(text: string): ExampleInfo[] {
  let held: unknown;
  try {
    held = JSON.parse(text);
  } catch (thrown) {
    throw new Error(`The example index is not JSON: ${(thrown as Error).message}`);
  }
  const list = (held as { examples?: unknown } | null)?.examples;
  if (!Array.isArray(list)) throw new Error('The example index has no list "examples"');
  const seen = new Set<string>();
  return list.map((item: unknown, at): ExampleInfo => {
    const entry = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    const where = `Example ${at + 1} of the index`;
    const text = (name: string): string => {
      const value = entry[name];
      if (typeof value !== 'string' || value.trim() === '') throw new Error(`${where} has no "${name}"`);
      return value;
    };
    const file = text('file');
    const image = text('image');
    const title = text('title');
    const description = text('description');
    if (!FILE.test(file)) throw new Error(`${where} names the file "${file}": a lower-case name that ends in .orogen`);
    if (!IMAGE.test(image)) throw new Error(`${where} names the picture "${image}": a lower-case name that ends in .png`);
    if (title.length > EXAMPLE_TITLE_MAX) throw new Error(`${where}: the title "${title}" has more than ${EXAMPLE_TITLE_MAX} characters`);
    if (description.length > EXAMPLE_DESCRIPTION_MAX) throw new Error(`${where}: the description of "${title}" has more than ${EXAMPLE_DESCRIPTION_MAX} characters`);
    if (seen.has(file)) throw new Error(`${where} names "${file}" a second time`);
    seen.add(file);
    return { id: file.slice(0, -'.orogen'.length), file, image, title, description };
  });
}

export interface ExampleSummary {
  readonly nodes: number;
  /** Landscape layers a build writes: the Landscape Layer nodes, and with them the base layer that takes what they leave. */
  readonly layers: number;
  /** Texture and image exports. */
  readonly textures: number;
  readonly landscape: boolean;
}

/** What a project file holds, counted from its document. */
export function summarize(doc: GraphDoc): ExampleSummary {
  let layers = 0, textures = 0, landscape = false;
  for (const node of Object.values(doc.nodes)) {
    if (node.params.enabled === false) continue;
    if (node.type === 'io/export-landscape') landscape = true;
    else if (node.type === 'io/export-layer') layers++;
    else if (node.type.startsWith('io/export-')) textures++;
  }
  return { nodes: Object.keys(doc.nodes).length, layers: landscape && layers > 0 ? layers + 1 : 0, textures, landscape };
}

/** '21 nodes · 5 layers'; a project without layers is its nodes alone. Short: it shares a line with the button of a card. */
export function summaryText(summary: ExampleSummary): string {
  const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  const parts = [count(summary.nodes, 'node', 'nodes')];
  if (summary.layers > 0) parts.push(count(summary.layers, 'layer', 'layers'));
  return parts.join(' · ');
}

export type GridMove = 'left' | 'right' | 'up' | 'down' | 'first' | 'last';

/**
 * The index a navigation key moves to in a grid of `count` cards laid out in rows of `columns`, from the card
 * `at` (−1: none is selected, and the first or the last is). Left and right go through the cards in their order
 * and stop at both ends; up and down keep the column and stay where there is no card to go to.
 */
export function gridMove(count: number, columns: number, at: number, move: GridMove): number {
  if (count <= 0) return -1;
  const last = count - 1;
  const step = Math.max(1, Math.floor(columns));
  if (move === 'first') return 0;
  if (move === 'last') return last;
  if (at < 0 || at > last) return move === 'left' || move === 'up' ? last : 0;
  switch (move) {
    case 'left': return Math.max(0, at - 1);
    case 'right': return Math.min(last, at + 1);
    case 'up': return at - step >= 0 ? at - step : at;
    case 'down': return at + step <= last ? at + step : at;
  }
}

/**
 * The name the application gives a project: its file without the folder and the extension, `Untitled` for a
 * project without a file. The shell has the same function (src/app/shell/format.ts), which a panel may not
 * import; tests/ui/library/unit/examples.test.ts holds the two to each other.
 */
export function projectName(path: string | null): string {
  if (path === null) return 'Untitled';
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  return name.toLowerCase().endsWith('.orogen') ? name.slice(0, -'.orogen'.length) || name : name;
}

/** The document of an example's project file. Throws what parseDoc throws for a text that is no project. */
export function exampleDoc(text: string, registry: NodeRegistry): { readonly doc: GraphDoc; readonly problems: readonly DocProblem[] } {
  return parseDoc(text, registry);
}
