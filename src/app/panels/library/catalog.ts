// The node catalogue as the library shows it: every product node of the registry, in the categories and the
// order of engine.md 4.1, with what a row and the details of a node say. No DOM and no React.

import type { Category, NodeDef, PortDef } from '../../../core/api.ts';
import type { NodeRegistry } from '../../../core/runtime.ts';
import { ALIASES, type Alias } from './aliases.ts';
import type { SearchHit } from './search.ts';

/** The categories a user builds with: `ref` holds the engine's reference nodes and is never shown. */
export type ProductCategory = Exclude<Category, 'ref'>;

/** In the order of engine.md 4.1, with the titles of the user documentation. */
export const CATEGORIES: readonly { readonly id: ProductCategory; readonly title: string; readonly hint: string }[] = [
  { id: 'generate', title: 'Generate', hint: 'Terrains and masks made from nothing: noises, gradients, shapes and whole landforms' },
  { id: 'adjust', title: 'Adjust', hint: 'Changes of each value and combinations of two inputs' },
  { id: 'filter', title: 'Filter', hint: 'Blurs, warps and transforms' },
  { id: 'simulate', title: 'Simulate', hint: 'Erosion, snow and the routing of water' },
  { id: 'select', title: 'Select', hint: 'Masks read from a terrain: height, slope, curvature, exposure, distance' },
  { id: 'color', title: 'Color', hint: 'Everything that makes or changes a color map' },
  { id: 'surface', title: 'Surface', hint: 'Detail and structure added without simulation' },
  { id: 'io', title: 'Import and Export', hint: 'Image files read into the graph, and what a build writes' },
];

/** What a port carries, in the words of the user documentation. */
export type PortKind = 'terrain' | 'mask' | 'data' | 'color' | 'any' | 'same';

export interface PortInfo {
  readonly name: string;
  readonly label: string;
  readonly kind: PortKind;
  /** What the port carries, as text: 'terrain', 'mask', 'data', 'color', 'terrain or color', 'same as In'. */
  readonly carries: string;
  readonly optional: boolean;
}

export interface CatalogEntry {
  readonly type: string;
  readonly title: string;
  readonly category: ProductCategory;
  readonly description: string;
  readonly keywords: readonly string[];
  /** The names other tools use for the operation (aliases.ts). */
  readonly aliases: readonly Alias[];
  readonly inputs: readonly PortInfo[];
  readonly outputs: readonly PortInfo[];
  /** What the details say beside the ports, each a short sentence without a full stop. */
  readonly notes: readonly string[];
}

export interface CatalogGroup {
  readonly category: ProductCategory;
  readonly title: string;
  readonly hint: string;
  readonly entries: readonly CatalogEntry[];
}

export interface Catalog {
  /** Every category that has nodes, in the order of CATEGORIES; the entries of each by title. */
  readonly groups: readonly CatalogGroup[];
  /** All entries, in the order of the groups. */
  readonly entries: readonly CatalogEntry[];
  get(type: string): CatalogEntry | undefined;
}

const capital = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

function portInfo(port: PortDef, ports: readonly PortDef[]): PortInfo {
  const label = port.label ?? capital(port.name);
  const optional = port.optional === true;
  if (typeof port.type === 'object') {
    const source = ports.find((candidate) => candidate.name === (port.type as { sameAs: string }).sameAs);
    return { name: port.name, label, kind: 'same', carries: `same as ${source?.label ?? capital((port.type as { sameAs: string }).sameAs)}`, optional };
  }
  if (port.type === 'color') return { name: port.name, label, kind: 'color', carries: 'color', optional };
  if (port.type === 'any') return { name: port.name, label, kind: 'any', carries: 'terrain or color', optional };
  const role = port.role ?? 'height';
  const kind: PortKind = role === 'height' ? 'terrain' : role;
  return { name: port.name, label, kind, carries: kind, optional };
}

/** The mask input a `maskable` node gets beside its own (engine.md 4.13). */
const MASK_PORT: PortInfo = { name: 'mask', label: 'Mask', kind: 'mask', carries: 'mask', optional: true };

function entryOf(def: NodeDef, category: ProductCategory): CatalogEntry {
  const inputs = def.inputs.map((port) => portInfo(port, def.inputs));
  if (def.maskable) inputs.push(MASK_PORT);
  const notes: string[] = [];
  if (def.maskable) notes.push('A mask limits where it acts');
  if (def.export) notes.push('A build writes what is connected to it');
  if (def.uses?.includes('seaLevel')) notes.push("Reads the project's sea level");
  if (def.resolutionDependent) notes.push('Measures the whole terrain, so a preview can differ from the build');
  if (def.params.some((param) => param.kind === 'file')) notes.push('Reads a file');
  return {
    type: def.type,
    title: def.title,
    category,
    description: def.description,
    keywords: def.keywords ?? [],
    aliases: ALIASES[def.type] ?? [],
    inputs,
    // An output's `sameAs` names an input.
    outputs: def.outputs.map((port) => portInfo(port, def.inputs)),
    notes,
  };
}

/** The catalogue of a registry. A node of a category that is not listed, `ref` among them, is left out. */
export function catalogOf(registry: NodeRegistry): Catalog {
  const byCategory = new Map<ProductCategory, CatalogEntry[]>();
  for (const { id } of CATEGORIES) byCategory.set(id, []);
  for (const def of registry.list()) {
    const list = byCategory.get(def.category as ProductCategory);
    if (list) list.push(entryOf(def, def.category as ProductCategory));
  }
  const groups: CatalogGroup[] = [];
  for (const { id, title, hint } of CATEGORIES) {
    const entries = byCategory.get(id)!.sort((a, b) => a.title.localeCompare(b.title, 'en'));
    if (entries.length > 0) groups.push({ category: id, title, hint, entries });
  }
  const entries = groups.flatMap((group) => group.entries);
  const byType = new Map(entries.map((entry) => [entry.type, entry]));
  return { groups, entries, get: (type) => byType.get(type) };
}

export const categoryTitle = (category: ProductCategory): string => CATEGORIES.find((entry) => entry.id === category)?.title ?? capital(category);

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
