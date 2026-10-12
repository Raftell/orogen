import { isPlainObject, type Edge, type GraphDoc, type NodeGroup, type NodeInstance, type PortRef, type ViewBinding } from './doc.ts';
import { loadNode } from './migrate.ts';
import type { NodeRegistry } from './registry.ts';
import { DEFAULT_SETTINGS, normalizeSettings } from './settings.ts';
import { invalidEdges } from './validate.ts';

export interface DocProblem { readonly nodeId?: string; readonly edgeId?: string; readonly message: string }
export class DocFormatError extends Error {
  override name = 'DocFormatError';
}

/** NodeGroup.color (runtime.md 4.1). */
export const GROUP_COLOR = /^#[0-9a-fA-F]{6}$/;

type Raw = Record<string, unknown>;
type Report = (problem: DocProblem) => void;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPortRef = (v: unknown): v is PortRef => isPlainObject(v) && typeof v.node === 'string' && typeof v.port === 'string';
const isXy = (v: unknown): boolean => isPlainObject(v) && finite(v.x) && finite(v.y);
/** A record is keyed by id. `__proto__` as a key would be the prototype of every copy made by assignment. */
const usableId = (id: string): boolean => id !== '' && id !== '__proto__';

/**
 * `raw` with the members of `set` replaced and those of `drop` removed, in the order `raw` holds them; members
 * of `set` that `raw` lacks follow at the end. `raw` itself when nothing differs.
 */
function patched<T>(raw: Raw, set: Raw, drop: readonly string[] = []): T {
  const names = Object.keys(set);
  if (drop.length === 0 && names.every((name) => Object.hasOwn(raw, name) && raw[name] === set[name])) return raw as T;
  const entries = Object.entries(raw)
    .filter(([name]) => !drop.includes(name) && name !== '__proto__')
    .map(([name, value]): [string, unknown] => [name, Object.hasOwn(set, name) ? set[name] : value]);
  for (const name of names) if (!Object.hasOwn(raw, name)) entries.push([name, set[name]]);
  return Object.fromEntries(entries) as T;
}

/** The entries of a collection that `shape` accepts, as the same object when every entry is kept as it is. */
function readRecord<T>(doc: Raw, member: string, report: Report, shape: (id: string, value: unknown) => T | null): Record<string, T> {
  const raw = doc[member];
  if (!isPlainObject(raw)) {
    report({ message: `"${member}" is ${raw === undefined ? 'missing' : 'not an object'}; an empty one is used` });
    return {};
  }
  let same = true;
  const entries: [string, T][] = [];
  for (const [id, value] of Object.entries(raw)) {
    const item = usableId(id) ? shape(id, value) : null;
    if (!usableId(id)) report({ message: `"${member}" has an entry with the id ${JSON.stringify(id)}, which cannot be used; it is removed` });
    if (item !== value) same = false;
    if (item !== null) entries.push([id, item]);
  }
  return same ? raw as Record<string, T> : Object.fromEntries(entries);
}

function shapeNode(id: string, value: unknown, registry: NodeRegistry, report: Report): NodeInstance | null {
  const say = (message: string): void => report({ nodeId: id, message });
  if (!isPlainObject(value) || typeof value.type !== 'string') {
    say('The entry is not a node with a type; it is removed');
    return null;
  }
  const set: Raw = {};
  const drop: string[] = [];
  if (value.id !== id) {
    set.id = id;
    say(`"id" differs from the key the node is stored under; "${id}" is used`);
  }
  if (!Number.isInteger(value.version) || (value.version as number) < 1) {
    set.version = 1;
    say('"version" is not a whole number of at least 1; 1 is used');
  }
  if (!isXy(value.position)) {
    set.position = { x: 0, y: 0 };
    say('"position" is not a pair of numbers; the node is placed at 0, 0');
  }
  if (!isPlainObject(value.params)) {
    set.params = {};
    say('"params" is not an object; the defaults are used');
  }
  for (const [flag, type] of [['title', 'string'], ['bypass', 'boolean'], ['collapsed', 'boolean']] as const) {
    if (value[flag] !== undefined && typeof value[flag] !== type) {
      drop.push(flag);
      say(`"${flag}" is not a ${type}; it is removed`);
    }
  }
  const loaded = loadNode(registry, patched<NodeInstance>(value, set, drop));
  for (const message of loaded.problems) say(message);
  return loaded.node;
}

function shapeEdge(id: string, value: unknown, report: Report): Edge | null {
  if (!isPlainObject(value) || !isPortRef(value.from) || !isPortRef(value.to)) {
    report({ edgeId: id, message: 'The entry is not an edge between two ports; it is removed' });
    return null;
  }
  if (value.id !== id) report({ edgeId: id, message: `"id" differs from the key the edge is stored under; "${id}" is used` });
  return patched<Edge>(value, { id });
}

function shapeGroup(id: string, value: unknown, report: Report): NodeGroup | null {
  const rect = isPlainObject(value) ? value.rect : null;
  if (!isPlainObject(value) || !isXy(rect) || !isPlainObject(rect) || !finite(rect.w) || !finite(rect.h)) {
    report({ message: `group "${id}": the entry is not a group with a rectangle; it is removed` });
    return null;
  }
  const set: Raw = { id };
  const drop: string[] = [];
  if (value.id !== id) report({ message: `group "${id}": "id" differs from the key the group is stored under; "${id}" is used` });
  if (typeof value.title !== 'string') {
    set.title = '';
    report({ message: `group "${id}": "title" is not a text; an empty one is used` });
  }
  if (value.color !== undefined && !(typeof value.color === 'string' && GROUP_COLOR.test(value.color))) {
    drop.push('color');
    report({ message: `group "${id}": "color" is not of the form #rrggbb; it is removed` });
  }
  return patched<NodeGroup>(value, set, drop);
}

function shapeView(value: unknown, report: Report): ViewBinding | undefined {
  if (!isPlainObject(value)) {
    report({ message: '"ui.view" is not an object; it is removed' });
    return undefined;
  }
  const drop: string[] = [];
  const overlay = value.overlay;
  if (value.height !== undefined && !isPortRef(value.height)) drop.push('height');
  if (overlay !== undefined && !(isPlainObject(overlay) && isPortRef(overlay.ref) && finite(overlay.opacity)
      && (overlay.as === 'color' || overlay.as === 'mask' || overlay.as === 'heat'))) drop.push('overlay');
  if (value.locked !== undefined && typeof value.locked !== 'boolean') drop.push('locked');
  for (const name of drop) report({ message: `"ui.view.${name}" is not valid; it is removed` });
  return patched<ViewBinding>(value, {}, drop);
}

function readUi(doc: Raw, report: Report): GraphDoc['ui'] {
  const raw = doc.ui;
  if (!isPlainObject(raw)) {
    report({ message: `"ui" is ${raw === undefined ? 'missing' : 'not an object'}; an empty one is used` });
    return {};
  }
  const set: Raw = {};
  const drop: string[] = [];
  if (raw.view !== undefined) {
    const view = shapeView(raw.view, report);
    if (view === undefined) drop.push('view');
    else set.view = view;
  }
  const viewport = raw.graphViewport;
  if (viewport !== undefined && !(isXy(viewport) && isPlainObject(viewport) && finite(viewport.zoom))) {
    drop.push('graphViewport');
    report({ message: '"ui.graphViewport" is not valid; it is removed' });
  }
  return patched<GraphDoc['ui']>(raw, set, drop);
}

export function parseDoc(text: string, registry: NodeRegistry): { readonly doc: GraphDoc; readonly problems: readonly DocProblem[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new DocFormatError('Not an Orogen project: the file is not JSON');
  }
  if (!isPlainObject(raw) || raw.format !== 'orogen') throw new DocFormatError('Not an Orogen project: "format" is not "orogen"');
  if (typeof raw.version === 'number' && raw.version > 1) throw new DocFormatError('This project was written by a newer version of Orogen');

  const problems: DocProblem[] = [];
  const report: Report = (problem) => { problems.push(problem); };
  if (raw.version !== 1) report({ message: '"version" is not 1; the file is read as version 1' });

  const settings = normalizeSettings(isPlainObject(raw.settings) ? raw.settings : {});
  for (const message of settings.problems) report({ message });

  const doc = patched<GraphDoc>(raw, {
    format: 'orogen',
    version: 1,
    settings: settings.settings,
    nodes: readRecord(raw, 'nodes', report, (id, value) => shapeNode(id, value, registry, report)),
    edges: readRecord(raw, 'edges', report, (id, value) => shapeEdge(id, value, report)),
    groups: readRecord(raw, 'groups', report, (id, value) => shapeGroup(id, value, report)),
    ui: readUi(raw, report),
  });
  for (const { edgeId, message } of invalidEdges(doc, registry)) report({ edgeId, message });
  return { doc, problems };
}

export function serializeDoc(doc: GraphDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function newDoc(): GraphDoc {       // the settings defaults of 4.2, no nodes
  return { format: 'orogen', version: 1, settings: { ...DEFAULT_SETTINGS }, nodes: {}, edges: {}, groups: {}, ui: {} };
}

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export function newId(): string {          // 10 characters of base 36 from crypto.getRandomValues; the only source of the ids the commands create
  let id = '';
  while (id.length < 10) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      // 252 is 7 × 36: a byte below it gives every character with the same probability.
      if (byte < 252 && id.length < 10) id += ID_ALPHABET[byte % 36];
    }
  }
  return id;
}
