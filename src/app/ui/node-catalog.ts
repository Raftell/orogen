// The node catalogue as the application offers it, in the library and in the graph's add-node palette alike:
// every product node of the registry, in the categories and the order of engine.md 4.1, with what a row and the
// details of a node say. The engine's reference nodes are no part of it. No DOM and no React.

import type { Category, NodeDef, PortDef } from '../../core/api.ts';
import { inputsOf, portLabel, type NodeRegistry } from '../../core/runtime.ts';
import { ALIASES, type Alias } from './node-aliases.ts';

/** The categories a user builds with: `ref` holds the engine's reference nodes and is never offered. */
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
  /** A build writes what is connected to it: an export node. */
  readonly exports: boolean;
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
  const label = portLabel(port);
  const optional = port.optional === true;
  if (typeof port.type === 'object') {
    const source = ports.find((candidate) => candidate.name === (port.type as { sameAs: string }).sameAs);
    return { name: port.name, label, kind: 'same', carries: `same as ${source ? portLabel(source) : capital((port.type as { sameAs: string }).sameAs)}`, optional };
  }
  if (port.type === 'color') return { name: port.name, label, kind: 'color', carries: 'color', optional };
  if (port.type === 'any') return { name: port.name, label, kind: 'any', carries: 'terrain or color', optional };
  const role = port.role ?? 'height';
  const kind: PortKind = role === 'height' ? 'terrain' : role;
  return { name: port.name, label, kind, carries: kind, optional };
}

function entryOf(def: NodeDef, category: ProductCategory): CatalogEntry {
  // The inputs a wire can go to: the declared ones, and the mask a maskable node gets beside them (engine.md 4.13).
  const inputs = inputsOf(def).map((port) => portInfo(port, def.inputs));
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
    exports: typeof def.export === 'function',
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
