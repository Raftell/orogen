// The document as the node-graph library draws it (runtime.md 8.9: controlled mode). `createFlowMapper` makes
// the nodes and wires of @xyflow/react from docStore and uiStore, and gives back the very objects it gave before
// for everything that did not change: the library compares by identity, and a drag of one node among three
// hundred must not make three hundred new ones. Pure: no DOM, no React, and no code of the library (its types
// are matched by shape).

import type { Category, NodeDef, PortDef } from '../../../core/api.ts';
import {
  canBypass, inputKey, inputSources, inputsOf, missingInputs, portLabel,
  type Edge, type GraphDoc, type NodeGroup, type NodeInstance, type NodeRegistry, type PortRef,
} from '../../../core/runtime.ts';
import {
  GROUP_MIN_HEIGHT, GROUP_MIN_WIDTH, HANDLE_SIZE, inputAnchor, nodeHeight, nodeWidth, outputAnchor, portColumn, portY,
  type NodeShape, type Point, type Rect,
} from './geometry.ts';
import { cycleNodes, declaredTone, edgeEndsExist, nodeTitle, outputTones, own, portKey, shownAs, type PortTone, type Shown } from './model.ts';

// ---- ids -------------------------------------------------------------------------------------------------------------
// A document id is any string (runtime.md 4.5) and nodes and groups have records of their own, so a node and a
// group may share an id. The library has one list for both and builds CSS selectors from ids: each id is given
// a prefix for its kind and written without the characters a selector would trip over.

export const nodeFlowId = (id: string): string => `n-${encodeURIComponent(id)}`;
export const groupFlowId = (id: string): string => `g-${encodeURIComponent(id)}`;
export const edgeFlowId = (id: string): string => `e-${encodeURIComponent(id)}`;
export const handleId = (side: 'in' | 'out', port: string): string => `${side}-${encodeURIComponent(port)}`;

function decode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/** The document id behind an id of the library; null for an id this module did not make. */
export function parseFlowId(flowId: string): { readonly kind: 'node' | 'group' | 'edge'; readonly id: string } | null {
  const kind = flowId.startsWith('n-') ? 'node' : flowId.startsWith('g-') ? 'group' : flowId.startsWith('e-') ? 'edge' : null;
  const id = kind === null ? null : decode(flowId.slice(2));
  return kind === null || id === null ? null : { kind, id };
}

export function parseHandleId(handle: string | null | undefined): { readonly side: 'in' | 'out'; readonly port: string } | null {
  if (typeof handle !== 'string') return null;
  const side = handle.startsWith('in-') ? 'in' : handle.startsWith('out-') ? 'out' : null;
  const port = side === null ? null : decode(handle.slice(side.length + 1));
  return side === null || port === null ? null : { side, port };
}

// ---- what a node shows -----------------------------------------------------------------------------------------------

export interface PortView {
  readonly name: string;
  readonly label: string;
  readonly tone: PortTone;
  readonly connected: boolean;
  /** A required input nothing is connected to, on a node that is not bypassed. */
  readonly missing: boolean;
  readonly optional: boolean;
  readonly handle: string;
  /** The row of the port, from 0. */
  readonly row: number;
}

export interface NodeView {
  readonly id: string;
  readonly type: string;
  /** False for a node whose type this build lacks: it is drawn, with the ports its wires name. */
  readonly known: boolean;
  readonly title: string;
  /** The title of the type; the node's own title differs when the user renamed it. */
  readonly typeTitle: string;
  readonly category: Category | null;
  readonly inputs: readonly PortView[];
  readonly outputs: readonly PortView[];
  /** The bypass is in effect: the flag is set and the node can be bypassed (engine.md 4.14). */
  readonly bypassed: boolean;
  readonly canBypass: boolean;
  readonly collapsed: boolean;
  readonly thumbnail: boolean;
  /** Labels of the required inputs nothing is connected to. */
  readonly missing: readonly string[];
  /** An export node: it runs when the project is built, and in no preview (it is never "paused"). */
  readonly exports: boolean;
  /** The node lies on a cycle of wires: it can never be computed (runtime.md 4.3 rule 5). */
  readonly cycle: boolean;
  readonly shown: Shown;
  /** The view is locked and this node is what it shows. */
  readonly locked: boolean;
  readonly width: number;
  readonly height: number;
  /** The width of the column of the inputs; the outputs have what the thumbnail leaves of the rest. */
  readonly inputColumn: number;
}

export interface GroupView {
  readonly id: string;
  readonly title: string;
  readonly color: string | null;
  readonly width: number;
  readonly height: number;
}

export interface FlowHandle {
  readonly id: string;
  readonly type: 'source' | 'target';
  readonly position: 'left' | 'right';
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface FlowNode {
  readonly id: string;
  readonly type: 'terrain' | 'frame';
  readonly position: Point;
  readonly data: NodeView | GroupView;
  readonly selected: boolean;
  readonly width: number;
  readonly height: number;
  /** Given, so that the library neither hides the node until it has measured it nor measures it at all. */
  readonly measured: { readonly width: number; readonly height: number };
  readonly handles?: readonly FlowHandle[];
  readonly zIndex: number;
  /**
   * False for a group: the library would select it with every box that touches its frame, and a frame is as
   * large as what it holds. A group is selected by a press on its title bar, which the panel handles itself.
   */
  readonly selectable?: boolean;
  /** A group is dragged by its title bar; the rest of it lets the pointer through to what lies inside. */
  readonly dragHandle?: string;
  readonly style?: { readonly pointerEvents: 'none' };
}

export interface WireData { readonly tone: PortTone; readonly drop: boolean }

export interface FlowEdge {
  readonly id: string;
  readonly type: 'wire';
  readonly source: string;
  readonly target: string;
  readonly sourceHandle: string;
  readonly targetHandle: string;
  readonly selected: boolean;
  readonly data: WireData;
}

export interface FlowInput {
  readonly doc: GraphDoc;
  readonly registry: NodeRegistry;
  readonly selection: readonly string[];
  /** uiStore.dragPositions: where the nodes being dragged are (runtime.md 8.5 rule 8). */
  readonly dragPositions: Readonly<Record<string, Point>> | null;
  readonly edgeSelection: readonly string[];
  readonly groupSelection: readonly string[];
  /** Where the groups being moved or resized are. */
  readonly groupRects: Readonly<Record<string, Rect>> | null;
  /** The wire a dragged node would be inserted into. */
  readonly dropEdge: string | null;
}

export interface FlowGraph {
  readonly nodes: readonly FlowNode[];
  readonly edges: readonly FlowEdge[];
  /** Node id → what the node shows. The same map while the document's nodes, edges and view are the same objects. */
  readonly views: ReadonlyMap<string, NodeView>;
}

// ---- the views -------------------------------------------------------------------------------------------------------

/** The ports of a node of an unknown type: the ones its wires name, so that the wires stay visible. */
function portsFromEdges(doc: GraphDoc, nodeId: string): { inputs: PortDef[]; outputs: PortDef[] } {
  const inputs = new Map<string, PortDef>();
  const outputs = new Map<string, PortDef>();
  for (const edge of Object.values(doc.edges)) {
    if (edge.to.node === nodeId && !inputs.has(edge.to.port)) inputs.set(edge.to.port, { name: edge.to.port, type: 'any', optional: true });
    if (edge.from.node === nodeId && !outputs.has(edge.from.port)) outputs.set(edge.from.port, { name: edge.from.port, type: 'field' });
  }
  return { inputs: [...inputs.values()], outputs: [...outputs.values()] };
}

interface Facts {
  /** Input, by the core's `inputKey` → the output the evaluator reads there. */
  readonly sources: ReadonlyMap<string, PortRef>;
  /** Output → its tone. */
  readonly tones: ReadonlyMap<string, PortTone>;
  /** Outputs and inputs a drawn wire ends at. */
  readonly wired: ReadonlySet<string>;
  /** The nodes on a cycle. */
  readonly cycle: ReadonlySet<string>;
}

function factsOf(doc: GraphDoc, registry: NodeRegistry): Facts {
  const sources = inputSources(doc, registry);
  const tones = outputTones(doc, registry, sources);
  const wired = new Set<string>();
  for (const edge of Object.values(doc.edges)) {
    if (!drawable(doc, registry, edge)) continue;
    wired.add(`out ${portKey(edge.from.node, edge.from.port)}`);
    wired.add(`in ${portKey(edge.to.node, edge.to.port)}`);
  }
  return { sources, tones, wired, cycle: cycleNodes(doc, sources) };
}

/**
 * Whether a wire is drawn for the edge: both nodes exist, and a node of a known type has the port. An end at a
 * node of an unknown type is drawn at a port made for it.
 */
function drawable(doc: GraphDoc, registry: NodeRegistry, edge: Edge): boolean {
  if (edge.from.node === edge.to.node) return false;
  const source = own(doc.nodes, edge.from.node);
  const target = own(doc.nodes, edge.to.node);
  if (!source || !target) return false;
  const sourceDef = registry.get(source.type);
  const targetDef = registry.get(target.type);
  if (sourceDef && targetDef) return edgeEndsExist(doc, registry, edge.from, edge.to);
  return (!sourceDef || sourceDef.outputs.some((port) => port.name === edge.from.port))
    && (!targetDef || inputsOf(targetDef).some((port) => port.name === edge.to.port));
}

function viewOf(doc: GraphDoc, registry: NodeRegistry, instance: NodeInstance, def: NodeDef | undefined, facts: Facts): NodeView {
  const id = instance.id;
  const declared = def ? { inputs: inputsOf(def), outputs: def.outputs } : portsFromEdges(doc, id);
  const bypassable = def !== undefined && canBypass(def);
  const bypassed = instance.bypass === true && bypassable;

  const inputs = declared.inputs.map((port, row): PortView => {
    const source = facts.sources.get(inputKey({ node: id, port: port.name }));
    const connected = facts.wired.has(`in ${portKey(id, port.name)}`);
    return {
      name: port.name,
      label: portLabel(port),
      tone: declaredTone(port) ?? (source ? facts.tones.get(portKey(source.node, source.port)) ?? 'any' : 'any'),
      connected,
      missing: def !== undefined && !bypassed && !port.optional && source === undefined,
      optional: port.optional === true,
      handle: handleId('in', port.name),
      row,
    };
  });
  const outputs = declared.outputs.map((port, row): PortView => ({
    name: port.name,
    label: portLabel(port),
    tone: facts.tones.get(portKey(id, port.name)) ?? 'any',
    connected: facts.wired.has(`out ${portKey(id, port.name)}`),
    missing: false,
    optional: false,
    handle: handleId('out', port.name),
    row,
  }));

  const collapsed = instance.collapsed === true;
  const thumbnail = outputs.length > 0 && def !== undefined && !collapsed;
  const shape: NodeShape = { inputs: inputs.length, outputs: outputs.length, thumbnail, inputLabel: longestLabel(inputs), outputLabel: longestLabel(outputs) };
  const shown = shownAs(doc, id);
  return {
    id,
    type: instance.type,
    known: def !== undefined,
    title: nodeTitle(instance, def),
    typeTitle: def?.title ?? instance.type,
    category: def?.category ?? null,
    inputs,
    outputs,
    bypassed,
    canBypass: bypassable,
    collapsed,
    thumbnail,
    // The evaluator's own rule (5.3), asked of the document: the engine reports it only for a node of the plan it evaluates.
    missing: missingInputs(doc, registry, id, facts.sources).map(portLabel),
    exports: def?.export !== undefined,
    cycle: facts.cycle.has(id),
    shown,
    locked: shown !== null && doc.ui.view?.locked === true,
    width: nodeWidth(shape),
    height: nodeHeight(shape),
    inputColumn: portColumn(shape.inputLabel ?? 0),
  };
}

const longestLabel = (ports: readonly { readonly label: string }[]): number => ports.reduce((most, port) => Math.max(most, port.label.length), 0);

/** The shape of a new node of a type: what its size is before it is in a document. */
export function shapeOfType(def: NodeDef): NodeShape {
  const inputs = inputsOf(def);
  const labels = (ports: readonly PortDef[]): number => longestLabel(ports.map((port) => ({ label: portLabel(port) })));
  return { inputs: inputs.length, outputs: def.outputs.length, thumbnail: def.outputs.length > 0, inputLabel: labels(inputs), outputLabel: labels(def.outputs) };
}

const portSignature = (port: PortView): string => `${port.name}/${port.label}/${port.tone}/${port.connected ? 1 : 0}${port.missing ? 1 : 0}${port.optional ? 1 : 0}`;

/** Everything a view holds, as text: two views with one signature draw the same node. */
function signature(view: NodeView): string {
  return [
    view.type, view.known, view.title, view.typeTitle, view.category, view.bypassed, view.canBypass, view.collapsed, view.thumbnail,
    view.shown, view.locked, view.width, view.height, view.cycle, view.exports, view.missing.join(','), view.inputs.map(portSignature).join(';'), view.outputs.map(portSignature).join(';'),
  ].join('|');
}

function handlesOf(view: NodeView): FlowHandle[] {
  const half = HANDLE_SIZE / 2;
  return [
    ...view.inputs.map((port): FlowHandle => ({ id: port.handle, type: 'target', position: 'left', x: -half, y: portY(port.row) - half, width: HANDLE_SIZE, height: HANDLE_SIZE })),
    ...view.outputs.map((port): FlowHandle => ({ id: port.handle, type: 'source', position: 'right', x: view.width - half, y: portY(port.row) - half, width: HANDLE_SIZE, height: HANDLE_SIZE })),
  ];
}

// ---- the mapper ------------------------------------------------------------------------------------------------------

interface HeldView {
  /** What the view was made from: while all of it is the same, the view is. */
  readonly instance: NodeInstance;
  readonly def: NodeDef | undefined;
  readonly facts: Facts;
  readonly shown: Shown;
  readonly locked: boolean;
  readonly signature: string;
  readonly view: NodeView;
  readonly handles: readonly FlowHandle[];
}
interface HeldNode { readonly view: NodeView; readonly x: number; readonly y: number; readonly selected: boolean; readonly node: FlowNode }
interface HeldGroup { readonly group: NodeGroup; readonly rect: Rect; readonly selected: boolean; readonly node: FlowNode }
interface HeldEdge { readonly edge: Edge; readonly tone: PortTone; readonly selected: boolean; readonly drop: boolean; readonly flow: FlowEdge }

/** The frame of a group: never smaller than its title bar needs, whatever a file holds. */
export function groupRect(group: NodeGroup, live?: Rect): Rect {
  const rect = live ?? group.rect;
  return { x: rect.x, y: rect.y, w: Math.max(GROUP_MIN_WIDTH, rect.w), h: Math.max(GROUP_MIN_HEIGHT, rect.h) };
}

export function createFlowMapper(): (input: FlowInput) => FlowGraph {
  // What the last call saw, by the objects it depended on.
  let seen: { nodes: GraphDoc['nodes']; edges: GraphDoc['edges']; view: GraphDoc['ui']['view']; registry: NodeRegistry } | null = null;
  let facts: Facts | null = null;
  let views = new Map<string, NodeView>();
  let heldViews = new Map<string, HeldView>();
  let heldNodes = new Map<string, HeldNode>();
  let heldGroups = new Map<string, HeldGroup>();
  let heldEdges = new Map<string, HeldEdge>();
  let lastNodes: readonly FlowNode[] = [];
  let lastEdges: readonly FlowEdge[] = [];
  let last: FlowGraph | null = null;
  let wires: { edges: GraphDoc['edges']; facts: Facts; selection: readonly string[]; drop: string | null } | null = null;

  return (input) => {
    const { doc, registry } = input;

    // ---- views: only when the nodes, the edges or the view changed ----
    if (!seen || seen.nodes !== doc.nodes || seen.edges !== doc.edges || seen.view !== doc.ui.view || seen.registry !== registry) {
      // Positions and parameters change `doc.nodes` without changing what a wire carries: the facts of the edges
      // are found again only when an edge changed, or a node came, went or changed its type.
      const sameWiring = seen !== null && facts !== null && seen.edges === doc.edges && seen.registry === registry && sameTypes(seen.nodes, doc.nodes);
      const current = sameWiring ? facts! : factsOf(doc, registry);
      facts = current;
      const nextHeld = new Map<string, HeldView>();
      const nextViews = new Map<string, NodeView>();
      let changed = heldViews.size !== Object.keys(doc.nodes).length;
      const lockedView = doc.ui.view?.locked === true;
      for (const [id, instance] of Object.entries(doc.nodes)) {
        const def = registry.get(instance.type);
        const shown = shownAs(doc, id);
        const locked = shown !== null && lockedView;
        const before = heldViews.get(id);
        let kept: HeldView;
        // A node whose own object, definition, wiring and part in the view are what they were shows what it showed.
        if (before && before.instance === instance && before.def === def && before.facts === current && before.shown === shown && before.locked === locked) {
          kept = before;
        } else {
          const made = viewOf(doc, registry, instance, def, current);
          const text = signature(made);
          const same = before !== undefined && before.signature === text;
          kept = { instance, def, facts: current, shown, locked, signature: text, view: same ? before.view : made, handles: same ? before.handles : handlesOf(made) };
          if (!same) changed = true;
        }
        nextHeld.set(id, kept);
        nextViews.set(id, kept.view);
      }
      heldViews = nextHeld;
      if (changed) views = nextViews;
      seen = { nodes: doc.nodes, edges: doc.edges, view: doc.ui.view, registry };
    }

    // ---- nodes ----
    const selected = new Set(input.selection);
    const selectedGroups = new Set(input.groupSelection);
    const nodes: FlowNode[] = [];
    const nextGroups = new Map<string, HeldGroup>();
    for (const [id, group] of Object.entries(doc.groups)) {
      const live = input.groupRects ? own(input.groupRects, id) : undefined;
      const rect = groupRect(group, live);
      const isSelected = selectedGroups.has(id);
      const before = heldGroups.get(id);
      const same = before && before.group === group && before.selected === isSelected
        && before.rect.x === rect.x && before.rect.y === rect.y && before.rect.w === rect.w && before.rect.h === rect.h;
      const held: HeldGroup = same ? before : {
        group, rect, selected: isSelected,
        node: {
          id: groupFlowId(id),
          type: 'frame',
          position: { x: rect.x, y: rect.y },
          data: { id, title: group.title, color: group.color ?? null, width: rect.w, height: rect.h },
          selected: isSelected,
          width: rect.w,
          height: rect.h,
          measured: { width: rect.w, height: rect.h },
          zIndex: -1,
          selectable: false,
          dragHandle: '[data-group-drag]',
          style: { pointerEvents: 'none' },
        },
      };
      nextGroups.set(id, held);
      nodes.push(held.node);
    }
    heldGroups = nextGroups;

    const nextNodes = new Map<string, HeldNode>();
    for (const [id, instance] of Object.entries(doc.nodes)) {
      const { view, handles } = heldViews.get(id)!;
      const position = (input.dragPositions ? own(input.dragPositions, id) : undefined) ?? instance.position;
      const isSelected = selected.has(id);
      const before = heldNodes.get(id);
      const held: HeldNode = before && before.view === view && before.x === position.x && before.y === position.y && before.selected === isSelected ? before : {
        view, x: position.x, y: position.y, selected: isSelected,
        node: {
          id: nodeFlowId(id),
          type: 'terrain',
          position: { x: position.x, y: position.y },
          data: view,
          selected: isSelected,
          width: view.width,
          height: view.height,
          measured: { width: view.width, height: view.height },
          handles,
          zIndex: 0,
        },
      };
      nextNodes.set(id, held);
      nodes.push(held.node);
    }
    heldNodes = nextNodes;
    if (nodes.length !== lastNodes.length || nodes.some((node, i) => node !== lastNodes[i])) lastNodes = nodes;

    // ---- wires: only when an edge, what a wire carries, or what is marked changed ----
    if (!wires || wires.edges !== doc.edges || wires.facts !== facts || wires.selection !== input.edgeSelection || wires.drop !== input.dropEdge) {
      const selectedEdges = new Set(input.edgeSelection);
      const edges: FlowEdge[] = [];
      const nextEdges = new Map<string, HeldEdge>();
      for (const [id, edge] of Object.entries(doc.edges)) {
        if (!drawable(doc, registry, edge)) continue;
        const tone = facts!.tones.get(portKey(edge.from.node, edge.from.port)) ?? 'any';
        const isSelected = selectedEdges.has(id);
        const drop = input.dropEdge === id;
        const before = heldEdges.get(id);
        const held: HeldEdge = before && before.edge === edge && before.tone === tone && before.selected === isSelected && before.drop === drop ? before : {
          edge, tone, selected: isSelected, drop,
          flow: {
            id: edgeFlowId(id),
            type: 'wire',
            source: nodeFlowId(edge.from.node),
            target: nodeFlowId(edge.to.node),
            sourceHandle: handleId('out', edge.from.port),
            targetHandle: handleId('in', edge.to.port),
            selected: isSelected,
            data: { tone, drop },
          },
        };
        nextEdges.set(id, held);
        edges.push(held.flow);
      }
      heldEdges = nextEdges;
      if (edges.length !== lastEdges.length || edges.some((edge, i) => edge !== lastEdges[i])) lastEdges = edges;
      wires = { edges: doc.edges, facts: facts!, selection: input.edgeSelection, drop: input.dropEdge };
    }

    // The very result of the last call when nothing in it changed: a store's snapshot must be the same object then.
    if (!last || last.nodes !== lastNodes || last.edges !== lastEdges || last.views !== views) last = { nodes: lastNodes, edges: lastEdges, views };
    return last;
  };
}

function sameTypes(a: GraphDoc['nodes'], b: GraphDoc['nodes']): boolean {
  if (a === b) return true;
  const ids = Object.keys(b);
  if (ids.length !== Object.keys(a).length) return false;
  return ids.every((id) => own(a, id)?.type === b[id]!.type);
}

// ---- where things are ------------------------------------------------------------------------------------------------

/** Where a node is: its position in the document, or where it is being dragged. */
export function positionOf(doc: GraphDoc, id: string, dragPositions?: Readonly<Record<string, Point>> | null): Point | null {
  const instance = own(doc.nodes, id);
  if (!instance) return null;
  return (dragPositions ? own(dragPositions, id) : undefined) ?? instance.position;
}

export function rectOfNode(doc: GraphDoc, views: ReadonlyMap<string, NodeView>, id: string, dragPositions?: Readonly<Record<string, Point>> | null): Rect | null {
  const position = positionOf(doc, id, dragPositions);
  const view = views.get(id);
  return position && view ? { x: position.x, y: position.y, w: view.width, h: view.height } : null;
}

/** The two ends of the wire of an edge, where it is drawn; null for an edge that is not drawn. */
export function wireEnds(
  doc: GraphDoc, views: ReadonlyMap<string, NodeView>, edge: Edge, dragPositions?: Readonly<Record<string, Point>> | null,
): { readonly from: Point; readonly to: Point } | null {
  const from = views.get(edge.from.node);
  const output = from?.outputs.find((port) => port.name === edge.from.port);
  const input = views.get(edge.to.node)?.inputs.find((port) => port.name === edge.to.port);
  const source = positionOf(doc, edge.from.node, dragPositions);
  const target = positionOf(doc, edge.to.node, dragPositions);
  if (!from || !output || !input || !source || !target) return null;
  return { from: outputAnchor(source, output.row, from.width), to: inputAnchor(target, input.row) };
}
