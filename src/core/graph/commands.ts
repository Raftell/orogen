import {
  cloneJson, isPlainObject, isPortRef, jsonEqual, own,
  type Edge, type GraphDoc, type NodeGroup, type NodeInstance, type PortRef, type ProjectSettings, type ViewBinding,
} from './doc.ts';
import type { NodeDef } from './node.ts';
import { normalizeParams } from './params.ts';
import type { NodeRegistry } from './registry.ts';
import { GROUP_COLOR, newId, readNode } from './serialize.ts';
import { normalizeSettings } from './settings.ts';
import { endpointProblem, hasCycle, reaches, validateConnection } from './validate.ts';

// Each command is a recipe: it mutates the draft it is given and touches nothing else (runtime.md 4.6).

/** T with every `readonly` removed, at every depth. Mutually assignable with immer's Draft<T>, which the recipes of 8.5 receive. */
export type Mutable<T> =
  T extends readonly (infer E)[] ? Mutable<E>[]
  : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> }
  : T;
export type DocDraft = Mutable<GraphDoc>;
export interface DocFragment { readonly nodes: readonly NodeInstance[]; readonly edges: readonly Edge[] }   // clipboard content

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function requireFinite(what: string, ...values: readonly unknown[]): void {
  if (!values.every(finite)) throw new TypeError(`${what} must be finite numbers`);
}

function freshId(taken: Readonly<Record<string, unknown>>): string {
  // Two equal ids among 36^10 do not happen by chance; the bound is for a random source that repeats itself.
  for (let attempt = 0; attempt < 16; attempt++) {
    const id = newId();
    if (!Object.hasOwn(taken, id)) return id;
  }
  throw new Error('newId returns ids that are already in use');
}

function nodeOf(doc: DocDraft, nodeId: string): Mutable<NodeInstance> {
  const node = own(doc.nodes, nodeId);
  if (!node) throw new Error(`Node "${nodeId}" does not exist`);
  return node;
}

/** The node and its definition, when its params are in the format this build reads (runtime.md 4.5). */
function editable(doc: DocDraft, registry: NodeRegistry, nodeId: string, name: string): { node: Mutable<NodeInstance>; def: NodeDef } {
  const node = nodeOf(doc, nodeId);
  const def = registry.get(node.type);
  if (!def) throw new Error(`Unknown node type "${node.type}"`);
  const version = def.version ?? 1;
  if (node.version !== version) throw new Error(`Saved with version ${node.version} of this node; this build has version ${version}`);
  if (!def.params.some((p) => p.name === name)) throw new Error(`${def.title} has no parameter "${name}"`);
  return { node, def };
}

function store(node: Mutable<NodeInstance>, name: string, value: unknown): void {
  if (!jsonEqual(own(node.params, name), value)) node.params[name] = cloneJson(value);
}

/** Stores every declared param at its default, so that a later change of a default does not change a saved project. */
export function addNode(doc: DocDraft, registry: NodeRegistry, type: string, position: { x: number; y: number }): string {   // returns the id
  const def = registry.get(type);
  if (!def) throw new Error(`Unknown node type "${type}"`);
  requireFinite('A position', position.x, position.y);
  const id = freshId(doc.nodes);
  const params: Record<string, unknown> = {};
  for (const param of def.params) params[param.name] = cloneJson(param.default);
  doc.nodes[id] = { id, type, version: def.version ?? 1, position: { x: position.x, y: position.y }, params };
  return id;
}

export function removeNodes(doc: DocDraft, ids: readonly string[]): void {                 // also removes their edges
  const gone = new Set(ids);
  for (const id of gone) if (Object.hasOwn(doc.nodes, id)) delete doc.nodes[id];
  for (const [edgeId, edge] of Object.entries(doc.edges)) {
    if (gone.has(edge.from.node) || gone.has(edge.to.node)) delete doc.edges[edgeId];
  }
}

export function connect(doc: DocDraft, registry: NodeRegistry, from: PortRef, to: PortRef): string {   // replaces the edge into `to`; throws when validateConnection fails
  const problem = validateConnection(doc, registry, from, to);
  if (problem !== null) throw new Error(problem);
  let kept: string | null = null;
  for (const [edgeId, edge] of Object.entries(doc.edges)) {
    if (edge.to.node !== to.node || edge.to.port !== to.port) continue;
    if (kept === null && edge.from.node === from.node && edge.from.port === from.port) kept = edgeId;
    else delete doc.edges[edgeId];
  }
  if (kept !== null) return kept;
  const id = freshId(doc.edges);
  doc.edges[id] = { id, from: { node: from.node, port: from.port }, to: { node: to.node, port: to.port } };
  return id;
}

export function disconnect(doc: DocDraft, edgeIds: readonly string[]): void {
  for (const id of edgeIds) if (Object.hasOwn(doc.edges, id)) delete doc.edges[id];
}

export function setParam(doc: DocDraft, registry: NodeRegistry, nodeId: string, name: string, value: unknown): void {   // stores the normalised value
  const { node, def } = editable(doc, registry, nodeId, name);
  const { values, error } = normalizeParams(def, { [name]: value });
  if (error !== null) throw new Error(error);
  store(node, name, values[name]);
}

export function resetParam(doc: DocDraft, registry: NodeRegistry, nodeId: string, name: string): void {
  const { node, def } = editable(doc, registry, nodeId, name);
  store(node, name, def.params.find((p) => p.name === name)!.default);
}

/** A flag that is off and a title that is null or empty are removed from the node, which is their default. */
export function setNodeFlags(doc: DocDraft, nodeId: string, flags: { bypass?: boolean; collapsed?: boolean; title?: string | null }): void {
  const node = nodeOf(doc, nodeId);
  for (const flag of ['bypass', 'collapsed'] as const) {
    if (flags[flag] === undefined) continue;
    if (flags[flag]) {
      if (node[flag] !== true) node[flag] = true;
    } else if (Object.hasOwn(node, flag)) {
      delete node[flag];
    }
  }
  if (flags.title === undefined) return;
  if (flags.title === null || flags.title === '') {
    if (Object.hasOwn(node, 'title')) delete node.title;
  } else if (node.title !== flags.title) {
    node.title = flags.title;
  }
}

export function moveNodes(doc: DocDraft, ids: readonly string[], delta: { x: number; y: number }): void {
  requireFinite('A move', delta.x, delta.y);
  for (const id of new Set(ids)) {
    const node = own(doc.nodes, id);
    if (!node) continue;
    if (delta.x !== 0) node.position.x += delta.x;
    if (delta.y !== 0) node.position.y += delta.y;
  }
}

export function copyNodes(doc: GraphDoc, ids: readonly string[]): DocFragment {             // the nodes and the edges between them
  const wanted = new Set(ids);
  return {
    nodes: Object.entries(doc.nodes).filter(([id]) => wanted.has(id)).map(([, node]) => cloneJson(node)),
    edges: Object.values(doc.edges).filter((edge) => wanted.has(edge.from.node) && wanted.has(edge.to.node)).map((edge) => cloneJson(edge)),
  };
}

/**
 * The fragment's nodes with new ids, placed so that the top-left corner of their bounding box is at `at`, and
 * its edges between them. A fragment is clipboard content and may come from another build, so each node is
 * read as the loader reads it and an entry that is no node or no edge is left out. An edge is also left out
 * when it would be a second edge into an input, close a cycle or, between nodes of known types, break rule 1
 * of 4.3.
 */
export function pasteNodes(doc: DocDraft, registry: NodeRegistry, fragment: DocFragment, at: { x: number; y: number }): string[] {   // new ids
  requireFinite('A position', at.x, at.y);
  const content: Readonly<Record<string, unknown>> = isPlainObject(fragment) ? fragment : {};
  const entries = (list: unknown): readonly unknown[] => (Array.isArray(list) ? list : []);

  const sources: NodeInstance[] = [];
  const known = new Set<string>();
  for (const entry of entries(content.nodes)) {
    const id: unknown = isPlainObject(entry) ? entry.id : undefined;
    if (typeof id !== 'string' || known.has(id)) continue;
    const node = readNode(id, entry, registry, () => {});
    if (node === null) continue;
    known.add(id);
    sources.push(node);
  }
  const left = sources.reduce((min, node) => Math.min(min, node.position.x), Infinity);
  const top = sources.reduce((min, node) => Math.min(min, node.position.y), Infinity);

  const ids = new Map<string, string>();
  for (const source of sources) {
    const id = freshId(doc.nodes);
    ids.set(source.id, id);
    const node = cloneJson(source);
    node.id = id;
    node.position = { x: source.position.x - left + at.x, y: source.position.y - top + at.y };
    doc.nodes[id] = node;
  }

  // The pasted nodes are new, so only the pasted edges can reach them: the checks below need no other edge.
  const plausible: Edge[] = [];
  for (const entry of entries(content.edges)) {
    if (!isPlainObject(entry) || !isPortRef(entry.from) || !isPortRef(entry.to)) continue;
    const fromNode = ids.get(entry.from.node);
    const toNode = ids.get(entry.to.node);
    if (fromNode === undefined || toNode === undefined) continue;
    const from: PortRef = { node: fromNode, port: entry.from.port };
    const to: PortRef = { node: toNode, port: entry.to.port };
    const typed = registry.get(doc.nodes[fromNode]!.type) && registry.get(doc.nodes[toNode]!.type);
    if (typed && endpointProblem(doc, registry, from, to) !== null) continue;
    plausible.push({ id: '', from, to });
  }
  // A fragment copied from a document made by the commands has no cycle; then no edge needs the search.
  const cyclic = hasCycle(plausible);
  const taken = new Set<string>();
  const added: Edge[] = [];
  for (const { from, to } of plausible) {
    const input = JSON.stringify([to.node, to.port]);
    if (taken.has(input)) continue;
    if (cyclic && reaches(added, to.node, from.node)) continue;
    taken.add(input);
    const id = freshId(doc.edges);
    const edge: Edge = { id, from, to };
    added.push(edge);
    doc.edges[id] = cloneJson(edge);
  }
  return [...ids.values()];
}

export function setGroup(doc: DocDraft, group: NodeGroup): void {
  if (typeof group.id !== 'string' || group.id === '' || group.id === '__proto__') throw new TypeError('A group needs an id');
  if (typeof group.title !== 'string') throw new TypeError('A group needs a title');
  requireFinite('The rectangle of a group', group.rect.x, group.rect.y, group.rect.w, group.rect.h);
  if (group.color !== undefined && !GROUP_COLOR.test(group.color)) throw new TypeError('The color of a group has the form #rrggbb');

  const existing = own(doc.groups, group.id);
  if (!existing) {
    doc.groups[group.id] = {
      id: group.id,
      title: group.title,
      ...(group.color !== undefined ? { color: group.color } : {}),
      rect: { x: group.rect.x, y: group.rect.y, w: group.rect.w, h: group.rect.h },
    };
    return;
  }
  if (existing.title !== group.title) existing.title = group.title;
  if (group.color === undefined) {
    if (Object.hasOwn(existing, 'color')) delete existing.color;
  } else if (existing.color !== group.color) {
    existing.color = group.color;
  }
  for (const side of ['x', 'y', 'w', 'h'] as const) {
    if (existing.rect[side] !== group.rect[side]) existing.rect[side] = group.rect[side];
  }
}

export function removeGroups(doc: DocDraft, ids: readonly string[]): void {
  for (const id of ids) if (Object.hasOwn(doc.groups, id)) delete doc.groups[id];
}

const SETTINGS: readonly (keyof ProjectSettings)[] = ['terrainSize', 'heightRange', 'seed', 'buildResolution', 'previewLevel', 'seaLevel'];

/**
 * Writes the members the patch names, normalised (4.2), and nothing else, with one exception: a patch of
 * buildResolution also lowers previewLevel when its level is no longer defined. A transaction on
 * buildResolution or previewLevel therefore touches only those two paths (8.5).
 */
export function setSettings(doc: DocDraft, patch: Partial<ProjectSettings>): void {         // validates; fixes previewLevel
  const named = SETTINGS.filter((name) => patch[name] !== undefined);
  if (named.length === 0) return;
  const merged: Record<string, unknown> = { ...doc.settings };
  for (const name of named) merged[name] = patch[name];
  const { settings } = normalizeSettings(merged);
  if (named.includes('buildResolution') && !named.includes('previewLevel')) named.push('previewLevel');
  for (const name of named) {
    if (doc.settings[name] !== settings[name]) doc.settings[name] = settings[name];
  }
}

export function setView(doc: DocDraft, view: ViewBinding | null): void {
  if (view === null) {
    if (Object.hasOwn(doc.ui, 'view')) delete doc.ui.view;
    return;
  }
  if (view.overlay) requireFinite('The opacity of an overlay', view.overlay.opacity);
  if (!jsonEqual(doc.ui.view, view)) doc.ui.view = cloneJson(view);
}

export function setGraphViewport(doc: DocDraft, viewport: { x: number; y: number; zoom: number }): void {
  requireFinite('A viewport', viewport.x, viewport.y, viewport.zoom);
  const next = { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
  if (!jsonEqual(doc.ui.graphViewport, next)) doc.ui.graphViewport = next;
}
