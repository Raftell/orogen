// What the graph does to the document and to the selection. Every change is a transaction of docStore that
// calls the commands of runtime.md 4.6, so each of these is one step of the history; the panel's commands
// (index.ts) and its gestures (GraphPanel.tsx) both end here. No DOM and no React: the window-free tests run
// these on stores of their own.

import type { StoreApi } from 'zustand/vanilla';

import {
  addNode, canBypass, connect, copyNodes, disconnect, inputsOf, moveNodes, newId, pasteNodes, removeGroups, removeNodes, setGraphViewport, setGroup,
  setNodeFlags, setView, validateConnection,
  type GraphDoc, type NodeRegistry, type PortRef, type ViewBinding,
} from '../../../core/runtime.ts';
import type { DocState } from '../../state/doc-store.ts';
import { selectNodes, setSelection, setViewLocked, type UiState } from '../../state/ui-store.ts';
import { fragmentFromText, fragmentToText } from './clipboard.ts';
import { applyInsert, insertPlan, pendingConnection, portForWire, type Pending } from './connect.ts';
import { createFlowMapper, shapeOfType, type NodeView } from './flow.ts';
import { GROUP_MIN_HEIGHT, GROUP_MIN_WIDTH, groupRectAround, nodeHeight, nodeWidth, portY, type GraphViewport, type Point, type Rect } from './geometry.ts';
import { groupContents, rectsOf } from './hits.ts';
import { nodeTitle, own, type PortTone } from './model.ts';
import { graphStore, selectWiresAndGroups, type GraphUiState } from './state.ts';

/** The members of CommandContext (runtime.md 8.8) these functions use. `local` is the panel's own store; a test gives one of its own. */
export interface GraphContext {
  readonly doc: StoreApi<DocState>;
  readonly ui: StoreApi<UiState>;
  readonly registry: NodeRegistry;
  readonly local?: StoreApi<GraphUiState>;
}

const localOf = (ctx: GraphContext): StoreApi<GraphUiState> => ctx.local ?? graphStore;
const docOf = (ctx: GraphContext): GraphDoc => ctx.doc.getState().doc;

/** The selected nodes that the document holds, in the order selected. */
export function selectedNodes(ctx: GraphContext): string[] {
  const doc = docOf(ctx);
  return ctx.ui.getState().selection.filter((id) => Object.hasOwn(doc.nodes, id));
}

export function selectedEdges(ctx: GraphContext): string[] {
  const doc = docOf(ctx);
  return localOf(ctx).getState().edgeSelection.filter((id) => Object.hasOwn(doc.edges, id));
}

export function selectedGroups(ctx: GraphContext): string[] {
  const doc = docOf(ctx);
  return localOf(ctx).getState().groupSelection.filter((id) => Object.hasOwn(doc.groups, id));
}

/** The wire a node from the palette would go into: the one wire that is selected, with nothing else. */
export function insertTarget(ctx: GraphContext): string | null {
  const edges = selectedEdges(ctx);
  return edges.length === 1 && selectedNodes(ctx).length === 0 && selectedGroups(ctx).length === 0 ? edges[0]! : null;
}

/** One mapper for the functions here: it keeps the views of the document it saw last, so asking again costs nothing. */
const mapper = createFlowMapper();

/** What each node of the document shows, and with it how large it is. */
export function viewsOf(ctx: GraphContext): ReadonlyMap<string, NodeView> {
  return mapper({ doc: docOf(ctx), registry: ctx.registry, selection: [], dragPositions: null, edgeSelection: [], groupSelection: [], groupRects: null, dropEdge: null }).views;
}

/** Positions are whole pixels: a file is not filled with the fractions of a pointer. */
const whole = (p: Point): Point => ({ x: Math.round(p.x), y: Math.round(p.y) });

/** Offset between copies that would otherwise lie exactly on each other. */
const NUDGE = 24;

/** `at`, moved down and right until no node has exactly that position: a second paste does not hide the first. */
export function freeSpot(doc: GraphDoc, at: Point): Point {
  let spot = whole(at);
  const taken = new Set(Object.values(doc.nodes).map((node) => `${node.position.x},${node.position.y}`));
  for (let tries = 0; tries < 64 && taken.has(`${spot.x},${spot.y}`); tries++) spot = { x: spot.x + NUDGE, y: spot.y + NUDGE };
  return spot;
}

// ---- adding ----------------------------------------------------------------------------------------------------------

export interface AddOptions {
  /** `position` is where the node's centre goes; else its top-left corner. */
  readonly centered?: boolean;
  /** `position` is where the port goes that takes the wire of `pending`: where that wire was let go. */
  readonly atPort?: boolean;
  /** The fixed end of a dragged wire: the new node is connected to it. */
  readonly pending?: Pending | null;
  readonly tone?: PortTone | null;
  /** The wire the new node is inserted into. */
  readonly intoEdge?: string | null;
}

/** Adds a node of `type` and selects it. Returns its id, or null for a type the registry lacks. */
export function addNodeAt(ctx: GraphContext, type: string, position: Point, options: AddOptions = {}): string | null {
  const def = ctx.registry.get(type);
  if (!def) return null;
  const shape = shapeOfType(def);
  const width = nodeWidth(shape);
  let corner = position;
  if (options.centered) {
    corner = { x: position.x - width / 2, y: position.y - nodeHeight(shape) / 2 };
  } else if (options.atPort && options.pending) {
    const ports = options.pending.from ? inputsOf(def) : def.outputs;
    const name = portForWire(def, options.pending, options.tone ?? null);
    const row = Math.max(0, ports.findIndex((port) => port.name === name));
    corner = { x: options.pending.from ? position.x : position.x - width, y: position.y - portY(row) };
  }
  const spot = freeSpot(docOf(ctx), corner);
  let id = '';
  ctx.doc.getState().transact(`Add ${def.title}`, (draft) => {
    id = addNode(draft, ctx.registry, type, spot);
    if (options.pending) {
      const wire = pendingConnection(def, id, options.pending, options.tone ?? null);
      if (wire && validateConnection(draft, ctx.registry, wire.from, wire.to) === null) connect(draft, ctx.registry, wire.from, wire.to);
    } else if (options.intoEdge) {
      const plan = insertPlan(draft, ctx.registry, id, options.intoEdge);
      if (plan) applyInsert(draft, ctx.registry, id, plan);
    }
    // Inside the recipe, so that the entry of the history records it (8.5 rule 2).
    setSelection(ctx.ui, [id]);
  });
  selectWiresAndGroups(localOf(ctx), [], []);
  return id;
}

// ---- "add this node now" (8.7 rule 8) -----------------------------------------------------------------------------

/** The room a node that is added beside another keeps to it: a wire between the two is drawn in it. */
export const BESIDE_GAP = 72;
/** The room a node the application places keeps to the box of every other node. */
export const CLEAR_MARGIN = 16;
/** The step by which a clear place is looked for, and how far: 40 steps in every direction. */
const CLEAR_STEP = 24;
const CLEAR_REACH = 40;

/** Every offset of the search, nearest first; of two as near the one that stays in the column, and of those the lower. */
const CLEAR_OFFSETS: readonly Point[] = (() => {
  const offsets: Point[] = [];
  for (let dy = -CLEAR_REACH; dy <= CLEAR_REACH; dy++) for (let dx = -CLEAR_REACH; dx <= CLEAR_REACH; dx++) offsets.push({ x: dx * CLEAR_STEP, y: dy * CLEAR_STEP });
  return offsets.sort((a, b) => (a.x * a.x + a.y * a.y) - (b.x * b.x + b.y * b.y) || Math.abs(a.x) - Math.abs(b.x) || b.y - a.y);
})();

/**
 * The corner nearest `corner` at which a box of `size` lies clear of the box of every node, with a margin: a
 * node the application puts down itself covers no other, and none of its ports. Whole pixels. Where the graph is
 * full as far as the search reaches, the corner as it was asked for.
 */
export function clearSpot(ctx: GraphContext, corner: Point, size: { readonly w: number; readonly h: number }): Point {
  const doc = docOf(ctx);
  const taken = rectsOf(doc, viewsOf(ctx), Object.keys(doc.nodes))
    .map((rect) => ({ x: rect.x - CLEAR_MARGIN, y: rect.y - CLEAR_MARGIN, w: rect.w + 2 * CLEAR_MARGIN, h: rect.h + 2 * CLEAR_MARGIN }));
  const from = whole(corner);
  for (const offset of CLEAR_OFFSETS) {
    const box = { x: from.x + offset.x, y: from.y + offset.y, w: size.w, h: size.h };
    if (!taken.some((rect) => box.x < rect.x + rect.w && rect.x < box.x + box.w && box.y < rect.y + rect.h && rect.y < box.y + box.h)) return { x: box.x, y: box.y };
  }
  return from;
}

/**
 * Adds a node that was asked for from outside the graph, by a double click or Enter in the library, where no
 * place was pointed at. With one node selected whose first output the new node can take, the new node is put to
 * the right of it and connected to it, the wire into the first of its inputs that takes what that output carries:
 * a chain is built by adding its nodes one after the other. Otherwise the node goes where it covers no other,
 * as near `center` (the middle of what the graph shows) as that allows. It is selected. One step of the history.
 */
export function addNodeNow(ctx: GraphContext, type: string, center: Point): string | null {
  const def = ctx.registry.get(type);
  if (!def) return null;
  const shape = shapeOfType(def);
  const size = { w: nodeWidth(shape), h: nodeHeight(shape) };
  const doc = docOf(ctx);
  const selected = selectedNodes(ctx);
  const from = selected.length === 1 && selectedEdges(ctx).length === 0 && selectedGroups(ctx).length === 0 ? selected[0]! : null;
  const view = from === null ? undefined : viewsOf(ctx).get(from);
  const output = view?.known ? view.outputs[0] : undefined;
  if (from !== null && view && output && inputsOf(def).length > 0) {
    const pending: Pending = { from: { node: from, port: output.name } };
    const port = portForWire(def, pending, output.tone);
    const row = Math.max(0, inputsOf(def).findIndex((candidate) => candidate.name === port));
    const place = doc.nodes[from]!.position;
    // The wire runs level: the input it ends at is at the height of the output it comes from.
    const beside = { x: place.x + view.width + BESIDE_GAP, y: place.y + portY(output.row) - portY(row) };
    return addNodeAt(ctx, type, clearSpot(ctx, beside, size), { pending, tone: output.tone });
  }
  return addNodeAt(ctx, type, clearSpot(ctx, { x: center.x - size.w / 2, y: center.y - size.h / 2 }, size));
}

// ---- the selection ---------------------------------------------------------------------------------------------------

export function selectAll(ctx: GraphContext): void {
  const doc = docOf(ctx);
  selectWiresAndGroups(localOf(ctx), [], Object.keys(doc.groups));
  selectNodes(ctx, Object.keys(doc.nodes));
}

export function clearSelection(ctx: GraphContext): void {
  selectWiresAndGroups(localOf(ctx), [], []);
  setSelection(ctx.ui, []);
}

export function hasSelection(ctx: GraphContext): boolean {
  return selectedNodes(ctx).length > 0 || selectedEdges(ctx).length > 0 || selectedGroups(ctx).length > 0;
}

/** Deletes the selected nodes with their wires, the selected wires, and the selected groups; a group's contents stay. */
export function deleteSelection(ctx: GraphContext): boolean {
  const nodes = selectedNodes(ctx);
  const edges = selectedEdges(ctx);
  const groups = selectedGroups(ctx);
  if (nodes.length + edges.length + groups.length === 0) return false;
  const label = nodes.length > 0 ? 'Delete' : edges.length > 0 ? 'Delete Wire' : 'Delete Group';
  ctx.doc.getState().transact(label, (draft) => {
    disconnect(draft, edges);
    removeNodes(draft, nodes);
    removeGroups(draft, groups);
  });
  selectWiresAndGroups(localOf(ctx), [], []);
  return true;
}

// ---- clipboard -------------------------------------------------------------------------------------------------------

/**
 * The groups that go with copied nodes: the selected ones, and every group all of whose nodes are copied, so
 * that a box drawn around a framed part of the graph takes the frame along.
 */
export function groupsWith(ctx: GraphContext, nodes: readonly string[]): string[] {
  const doc = docOf(ctx);
  const views = viewsOf(ctx);
  const copied = new Set(nodes);
  const selected = new Set(selectedGroups(ctx));
  return Object.keys(doc.groups).filter((id) => {
    if (selected.has(id)) return true;
    const held = groupContents(doc, views, id).nodes;
    return held.length > 0 && held.every((node) => copied.has(node));
  });
}

/** The selected nodes, the wires between them and the groups that frame them, as clipboard text; null when no node is selected. */
export function copyText(ctx: GraphContext): string | null {
  const nodes = selectedNodes(ctx);
  if (nodes.length === 0) return null;
  const doc = docOf(ctx);
  return fragmentToText(copyNodes(doc, nodes), groupsWith(ctx, nodes).map((id) => doc.groups[id]!));
}

export function cutText(ctx: GraphContext): string | null {
  const text = copyText(ctx);
  if (text === null) return null;
  const nodes = selectedNodes(ctx);
  const groups = groupsWith(ctx, nodes);
  ctx.doc.getState().transact('Cut', (draft) => {
    removeNodes(draft, nodes);
    removeGroups(draft, groups);
  });
  selectWiresAndGroups(localOf(ctx), [], []);
  return text;
}

/**
 * Pastes the nodes a clipboard text holds with the top-left corner of their bounding box at `at`, and selects
 * them. Returns their ids; null for a text that holds no nodes.
 */
export function pasteText(ctx: GraphContext, text: string, at: Point, label = 'Paste'): string[] | null {
  const fragment = fragmentFromText(text);
  if (!fragment) return null;
  const spot = freeSpot(docOf(ctx), at);
  // The groups keep their place to the nodes: both are moved by as much as the nodes' top-left corner is.
  const places = fragment.nodes.map((node) => (node as { position?: { x?: unknown; y?: unknown } } | null)?.position)
    .filter((place): place is { x: number; y: number } => typeof place?.x === 'number' && Number.isFinite(place.x) && typeof place.y === 'number' && Number.isFinite(place.y));
  const delta = places.length === 0 ? { x: 0, y: 0 } : { x: spot.x - Math.min(...places.map((place) => place.x)), y: spot.y - Math.min(...places.map((place) => place.y)) };
  let made: string[] = [];
  ctx.doc.getState().transact(label, (draft) => {
    made = pasteNodes(draft, ctx.registry, fragment, spot);
    if (made.length > 0) {
      for (const group of fragment.groups) {
        setGroup(draft, { ...group, id: newId(), rect: { ...group.rect, x: Math.round(group.rect.x + delta.x), y: Math.round(group.rect.y + delta.y) } });
      }
    }
    setSelection(ctx.ui, made);
  });
  if (made.length === 0) return null;
  selectWiresAndGroups(localOf(ctx), [], []);
  return made;
}

/** Copies of the selected nodes, with the wires between them, a little down and right of the originals. */
export function duplicateSelection(ctx: GraphContext): string[] {
  const nodes = selectedNodes(ctx);
  if (nodes.length === 0) return [];
  const doc = docOf(ctx);
  const fragment = copyNodes(doc, nodes);
  const left = Math.min(...fragment.nodes.map((node) => node.position.x));
  const top = Math.min(...fragment.nodes.map((node) => node.position.y));
  const spot = freeSpot(doc, { x: left + NUDGE, y: top + NUDGE });
  let made: string[] = [];
  ctx.doc.getState().transact('Duplicate', (draft) => {
    made = pasteNodes(draft, ctx.registry, fragment, spot);
    setSelection(ctx.ui, made);
  });
  selectWiresAndGroups(localOf(ctx), [], []);
  return made;
}

// ---- flags and names -------------------------------------------------------------------------------------------------

/** The selected nodes that can be bypassed (engine.md 4.14). */
export function bypassable(ctx: GraphContext): string[] {
  const doc = docOf(ctx);
  return selectedNodes(ctx).filter((id) => {
    const def = ctx.registry.get(doc.nodes[id]!.type);
    return def !== undefined && canBypass(def);
  });
}

/** Bypasses the selected nodes, or takes the bypass off when all of them have it. */
export function toggleBypass(ctx: GraphContext): boolean {
  const nodes = bypassable(ctx);
  if (nodes.length === 0) return false;
  const doc = docOf(ctx);
  const bypass = nodes.some((id) => doc.nodes[id]!.bypass !== true);
  ctx.doc.getState().transact(bypass ? 'Bypass' : 'Remove Bypass', (draft) => {
    for (const id of nodes) setNodeFlags(draft, id, { bypass });
  });
  return true;
}

export function toggleCollapsed(ctx: GraphContext): boolean {
  const nodes = selectedNodes(ctx);
  if (nodes.length === 0) return false;
  const doc = docOf(ctx);
  const collapsed = nodes.some((id) => doc.nodes[id]!.collapsed !== true);
  ctx.doc.getState().transact(collapsed ? 'Collapse' : 'Expand', (draft) => {
    for (const id of nodes) setNodeFlags(draft, id, { collapsed });
  });
  return true;
}

/** Names of nodes and groups are one line of at most this many characters. */
export const TITLE_MAX_LENGTH = 64;

const cleanTitle = (title: string): string => title.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX_LENGTH);

/** Gives the node a title of its own; an empty title, or the title of its type, gives it back the type's. */
export function renameNode(ctx: GraphContext, id: string, title: string): void {
  const node = own(docOf(ctx).nodes, id);
  if (!node) return;
  const def = ctx.registry.get(node.type);
  const wanted = cleanTitle(title);
  const next = wanted === '' || wanted === (def?.title ?? node.type) ? null : wanted;
  if ((node.title ?? null) === next) return;
  ctx.doc.getState().transact('Rename', (draft) => setNodeFlags(draft, id, { title: next }));
}

export function renameGroup(ctx: GraphContext, id: string, title: string): void {
  const group = own(docOf(ctx).groups, id);
  const wanted = cleanTitle(title);
  if (!group || group.title === wanted) return;
  ctx.doc.getState().transact('Rename Group', (draft) => setGroup(draft, { ...group, title: wanted }));
}

/** What F2 renames: the one selected node; else the one selected group. */
export function renameTarget(ctx: GraphContext): { readonly kind: 'node' | 'group'; readonly id: string } | null {
  const nodes = selectedNodes(ctx);
  if (nodes.length === 1) return { kind: 'node', id: nodes[0]! };
  const groups = selectedGroups(ctx);
  return nodes.length === 0 && groups.length === 1 ? { kind: 'group', id: groups[0]! } : null;
}

// ---- the view (runtime.md 7.4) ---------------------------------------------------------------------------------------

/** The first output of the one selected node: what G makes the terrain. */
export function terrainCandidate(ctx: GraphContext): PortRef | null {
  const nodes = selectedNodes(ctx);
  if (nodes.length !== 1) return null;
  const port = ctx.registry.get(docOf(ctx).nodes[nodes[0]!]!.type)?.outputs[0];
  return port ? { node: nodes[0]!, port: port.name } : null;
}

/**
 * Makes the selected node the terrain shown: `view.height` (8.8). An overlay of that same output goes, since
 * it would lie on itself; a lock stays. Like every change of the view, not a step of the history.
 */
export function useAsTerrain(ctx: GraphContext): boolean {
  const ref = terrainCandidate(ctx);
  if (!ref) return false;
  const current = docOf(ctx).ui.view;
  const overlay = current?.overlay;
  const keep = overlay && !(overlay.ref.node === ref.node && overlay.ref.port === ref.port);
  const next: ViewBinding = { height: ref, ...(keep ? { overlay } : {}), ...(current?.locked ? { locked: true } : {}) };
  ctx.doc.getState().transact('View', (draft) => setView(draft, next), { undoable: false });
  return true;
}

/** Whether the view names something to lock, or is locked. */
export function canToggleViewLock(ctx: GraphContext): boolean {
  const view = docOf(ctx).ui.view;
  return view?.locked === true || view?.height !== undefined || view?.overlay !== undefined || terrainCandidate(ctx) !== null;
}

/**
 * The pin (7.4 rule 4). Locking first shows the one selected node, so that what is locked is what the user
 * points at; unlocking lets the view follow the selection again, at once.
 */
export function toggleViewLock(ctx: GraphContext): boolean {
  if (!canToggleViewLock(ctx)) return false;
  const locked = docOf(ctx).ui.view?.locked === true;
  if (locked) {
    setViewLocked(ctx, false);
    selectNodes(ctx, selectedNodes(ctx));
  } else {
    selectNodes(ctx, selectedNodes(ctx));
    setViewLocked(ctx, true);
  }
  return true;
}

// ---- groups ----------------------------------------------------------------------------------------------------------

export const GROUP_TITLE = 'Group';

/** A group around the selected nodes. It is selected in their place, and its name is the next thing typed. */
export function groupSelection(ctx: GraphContext): string | null {
  const nodes = selectedNodes(ctx);
  const rect = groupRectAround(rectsOf(docOf(ctx), viewsOf(ctx), nodes));
  if (!rect) return null;
  const id = newId();
  ctx.doc.getState().transact('Group', (draft) => {
    setGroup(draft, { id, title: GROUP_TITLE, rect });
    setSelection(ctx.ui, []);
  });
  const local = localOf(ctx);
  selectWiresAndGroups(local, [], [id]);
  local.setState({ renaming: { kind: 'group', id } });
  return id;
}

/** Selects the nodes the selected groups hold, in place of the groups. */
export function selectContents(ctx: GraphContext): boolean {
  const groups = selectedGroups(ctx);
  if (groups.length === 0) return false;
  const doc = docOf(ctx);
  const views = viewsOf(ctx);
  const nodes = new Set(groups.flatMap((id) => groupContents(doc, views, id).nodes));
  selectWiresAndGroups(localOf(ctx), [], []);
  selectNodes(ctx, [...nodes]);
  return true;
}

/** `color` is '#rrggbb', or null for the plain frame. */
export function setGroupColor(ctx: GraphContext, ids: readonly string[], color: string | null): void {
  const doc = docOf(ctx);
  const groups = ids.flatMap((id) => own(doc.groups, id) ?? []);
  if (groups.length === 0) return;
  ctx.doc.getState().transact('Group Color', (draft) => {
    for (const group of groups) {
      const { color: _was, ...rest } = group;
      setGroup(draft, color === null ? rest : { ...rest, color });
    }
  });
}

export function resizeGroup(ctx: GraphContext, id: string, rect: Rect): void {
  const group = own(docOf(ctx).groups, id);
  if (!group) return;
  const next = { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.max(GROUP_MIN_WIDTH, Math.round(rect.w)), h: Math.max(GROUP_MIN_HEIGHT, Math.round(rect.h)) };
  ctx.doc.getState().transact('Resize Group', (draft) => setGroup(draft, { ...group, rect: next }), { mergeKey: `group:${id}` });
}

// ---- moving ----------------------------------------------------------------------------------------------------------

export interface MoveCommit {
  /** Names the drag: the key of its one entry in the history (8.5 rule 4). */
  readonly dragId: string;
  /** Node id → where the node was dropped. */
  readonly positions: Readonly<Record<string, Point>>;
  /** Group id → where the group was dropped. */
  readonly groups: Readonly<Record<string, Rect>>;
  /** The one dragged node goes into this wire. */
  readonly insert?: { readonly node: string; readonly edge: string } | null;
}

/**
 * The end of a drag: one transaction that moves every node and group that was dragged, and puts a node that was
 * dropped on a wire into it (8.5 rule 8). Nothing that did not move makes no entry.
 */
export function commitMove(ctx: GraphContext, move: MoveCommit): void {
  const doc = docOf(ctx);
  const deltas = new Map<string, { delta: Point; ids: string[] }>();
  for (const [id, dropped] of Object.entries(move.positions)) {
    const node = own(doc.nodes, id);
    if (!node) continue;
    const delta = { x: Math.round(dropped.x) - node.position.x, y: Math.round(dropped.y) - node.position.y };
    if (delta.x === 0 && delta.y === 0) continue;
    const key = `${delta.x},${delta.y}`;
    const bucket = deltas.get(key);
    if (bucket) bucket.ids.push(id);
    else deltas.set(key, { delta, ids: [id] });
  }
  const groups = Object.entries(move.groups).flatMap(([id, rect]) => {
    const group = own(doc.groups, id);
    if (!group) return [];
    const x = Math.round(rect.x), y = Math.round(rect.y);
    return x === group.rect.x && y === group.rect.y ? [] : [{ ...group, rect: { ...group.rect, x, y } }];
  });
  const insert = move.insert ?? null;
  const inserted = insert ? own(doc.nodes, insert.node) : undefined;
  if (deltas.size === 0 && groups.length === 0 && !inserted) return;

  const label = inserted && insertPlan(doc, ctx.registry, insert!.node, insert!.edge)
    ? `Insert ${nodeTitle(inserted, ctx.registry.get(inserted.type))}`
    : deltas.size === 0 ? 'Move Group' : 'Move';
  ctx.doc.getState().transact(label, (draft) => {
    for (const { delta, ids } of deltas.values()) moveNodes(draft, ids, delta);
    for (const group of groups) setGroup(draft, group);
    if (insert) {
      const plan = insertPlan(draft, ctx.registry, insert.node, insert.edge);
      if (plan) applyInsert(draft, ctx.registry, insert.node, plan);
    }
  }, { mergeKey: `move:${move.dragId}` });
}

// ---- wires -----------------------------------------------------------------------------------------------------------

/** Connects two ports. Returns the reason when the connection is refused (4.3), else null. */
export function connectPorts(ctx: GraphContext, from: PortRef, to: PortRef): string | null {
  const problem = validateConnection(docOf(ctx), ctx.registry, from, to);
  if (problem !== null) return problem;
  ctx.doc.getState().transact('Connect', (draft) => { connect(draft, ctx.registry, from, to); });
  return null;
}

/**
 * Moves a wire to other ports, as one step: the wire goes and the new connection is made. Returns the reason when
 * the new connection is refused (4.3), and then nothing changes; a wire moved to where it is changes nothing either.
 */
export function reconnectEdge(ctx: GraphContext, edgeId: string, from: PortRef, to: PortRef): string | null {
  const doc = docOf(ctx);
  const edge = own(doc.edges, edgeId);
  if (!edge) return connectPorts(ctx, from, to);
  if (edge.from.node === from.node && edge.from.port === from.port && edge.to.node === to.node && edge.to.port === to.port) return null;
  const problem = validateConnection(doc, ctx.registry, from, to);
  if (problem !== null) return problem;
  ctx.doc.getState().transact('Reconnect', (draft) => {
    disconnect(draft, [edgeId]);
    connect(draft, ctx.registry, from, to);
  });
  const local = localOf(ctx);
  selectWiresAndGroups(local, local.getState().edgeSelection.filter((id) => id !== edgeId), local.getState().groupSelection);
  return null;
}

export function disconnectEdges(ctx: GraphContext, ids: readonly string[], label = 'Disconnect'): boolean {
  const doc = docOf(ctx);
  const edges = ids.filter((id) => Object.hasOwn(doc.edges, id));
  if (edges.length === 0) return false;
  ctx.doc.getState().transact(label, (draft) => disconnect(draft, edges));
  const local = localOf(ctx);
  selectWiresAndGroups(local, local.getState().edgeSelection.filter((id) => !edges.includes(id)), local.getState().groupSelection);
  return true;
}

// ---- the graph's own viewport ----------------------------------------------------------------------------------------

/** Keeps the graph's viewport in the document's interface state (4.1). Not a step of the history, and not a change to save (8.5 rule 5). */
export function saveViewport(ctx: GraphContext, viewport: GraphViewport): void {
  if (![viewport.x, viewport.y, viewport.zoom].every(Number.isFinite) || viewport.zoom <= 0) return;
  const next = { x: Math.round(viewport.x * 100) / 100, y: Math.round(viewport.y * 100) / 100, zoom: Math.round(viewport.zoom * 10000) / 10000 };
  const held = docOf(ctx).ui.graphViewport;
  if (held && held.x === next.x && held.y === next.y && held.zoom === next.zoom) return;
  ctx.doc.getState().transact('Graph viewport', (draft) => setGraphViewport(draft, next), { undoable: false });
}
