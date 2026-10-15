// What the mounted graph does with input: the changes the node-graph library reports (it is in controlled mode,
// runtime.md 8.9, so every one of them is turned into a change of a store), drags, connections, the stroke that
// cuts wires, drops from the library, the clipboard, the context menu, and the graph's own viewport. One
// controller is made per mounted panel; its handlers never change, which the library asks of its callbacks.

import type { Connection, EdgeChange, FinalConnectionState, NodeChange, ReactFlowInstance, useStoreApi } from '@xyflow/react';
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';

import { inputsOf, newId, portLabel, validateConnection, type GraphDoc } from '../../../core/runtime.ts';
import type { DocState } from '../../state/doc-store.ts';
import { selectNodes, setSelection } from '../../state/ui-store.ts';
import { ADD_NODE_EVENT, addNodeType, commandItems, keyNameOf, NODE_DRAG_TYPE, type AppServices, type CommandContext, type MenuItemSpec } from '../../ui/index.ts';
import {
  addNodeAt, addNodeNow, commitMove, connectPorts, copyText, cutText, disconnectEdges, pasteText, reconnectEdge, saveViewport, selectedGroups, selectedNodes, setGroupColor, viewsOf,
} from './actions.ts';
import { connectionRefs, portEnd, refusal, wireOntoNode, type Pending, type PortEnd } from './connect.ts';
import { edgeFlowId, groupRect, nodeFlowId, parseFlowId, positionOf, rectOfNode, type FlowGraph } from './flow.ts';
import { MIN_ZOOM, boundsOf, containsRect, inputAnchor, lodOf, outputAnchor, titleStepOf, toFlow, viewportShowing, visibleRect, wirePathOn, type Point, type Rect } from './geometry.ts';
import { groupContents, nodesIn, rectsOf, wireAtPoint, wiresCut, wireUnderNode, type GroupContents } from './hits.ts';
import { CATEGORIES, nodeTitle, own, type PortTone } from './model.ts';
import { graphStore, selectWiresAndGroups, type GraphHost, type PaletteRequest } from './state.ts';

/** How long the viewport rests before it is written to the document, and the visible nodes before their thumbnails are asked for. */
const SAVE_DELAY_MS = 300;
const THUMBNAIL_DELAY_MS = 150;
/** How long the reason of a refused connection stays after the wire was dropped. */
const REFUSAL_MS = 2600;
/** How near a wire a node from the library must be dropped to go into it, in pixels of the screen. */
const DROP_ON_WIRE_PX = 12;

type LibraryStore = ReturnType<typeof useStoreApi>;

export type ContextTarget =
  | { readonly kind: 'canvas' }
  | { readonly kind: 'node'; readonly id: string }
  | { readonly kind: 'edge'; readonly id: string }
  | { readonly kind: 'group'; readonly id: string };

interface DragSession {
  readonly id: string;
  /** Group id → what it held when the drag began, with where each of those was. */
  readonly contents: Map<string, GroupContents>;
  /** The document when the drag began: positions are counted from it. */
  readonly doc: GraphDoc;
}

function isTextField(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable);
}

/** Whether the event came from something that lies over the graph and handles its own input. */
function inOverlay(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-graph="palette"], [data-graph="toolbar"], [data-graph="rename"]') !== null;
}

/** Below this zoom the names of groups are not drawn at all (see sayZoom). */
const GROUP_TITLE_MIN_ZOOM = 0.16;

/** A document that replaced the one before it (docStore.load): the history is empty and the nodes are other objects. */
function isLoad(state: DocState, previous: DocState): boolean {
  if (state.doc === previous.doc || state.past.length > 0 || state.future.length > 0) return false;
  return state.doc.nodes !== previous.doc.nodes || state.doc.edges !== previous.doc.edges || state.doc.groups !== previous.doc.groups;
}

const sameIds = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id, i) => id === b[i]);

export interface Controller extends GraphHost {
  /** The graph as it was last rendered: the component sets it. */
  graph: FlowGraph;
  /** The size of the graph's area in the panel, in pixels. */
  size(): { readonly width: number; readonly height: number };
  /** The pointer's last place over the graph, in pixels from the panel's top-left corner; null when it is elsewhere. */
  pointer(): Point | null;
  /** Attaches everything that listens outside React. Returns what detaches it. */
  mount(root: HTMLElement, zoomLabel: HTMLElement | null, strokeLine: SVGPolylineElement | null): () => void;
  /** After a render: a fit that waited for the nodes is made. */
  rendered(): void;

  readonly onNodesChange: (changes: NodeChange[]) => void;
  readonly onEdgesChange: (changes: EdgeChange[]) => void;
  readonly onConnect: (connection: Connection) => void;
  readonly onConnectEnd: (event: MouseEvent | TouchEvent, state: FinalConnectionState) => void;
  readonly isValidConnection: (connection: { source: string | null; sourceHandle?: string | null; target: string | null; targetHandle?: string | null }) => boolean;
  readonly onNodeDrag: (event: unknown, node: { id: string }, nodes: readonly { id: string }[]) => void;
  /** A press on a node that was let go where it began. */
  readonly onNodeClick: (event: { readonly shiftKey: boolean; readonly ctrlKey: boolean; readonly metaKey: boolean; readonly button: number }, node: { id: string }) => void;
  readonly onDragStop: () => void;
  /** The library's viewport began to move; `event` is null when the graph itself moved it. */
  readonly onMoveStart: (event: MouseEvent | TouchEvent | null) => void;
  /** The connection the pointer is on is refused (the key names its two ports), or null. */
  hoverRefusal(key: string | null): void;

  readonly onPointerDownCapture: (event: ReactPointerEvent) => void;
  readonly onMouseDownCapture: (event: ReactMouseEvent) => void;
  readonly onPointerMove: (event: ReactPointerEvent) => void;
  readonly onPointerLeave: () => void;
  readonly onContextMenuCapture: (event: ReactMouseEvent) => void;
  readonly onDragOver: (event: ReactDragEvent) => void;
  readonly onDragLeave: () => void;
  readonly onDrop: (event: ReactDragEvent) => void;

  contextItems(): MenuItemSpec[];
  closePalette(): void;
  pick(type: string): void;
  /** In words, the fixed end of the wire the palette is open for. */
  wireText(request: PaletteRequest): string | null;
  /** The wire the palette is open for, drawn from its fixed end to where it was let go, in pixels of the panel; null without one. */
  pendingWire(request: PaletteRequest): { readonly path: string; readonly tone: PortTone; readonly width: number } | null;
}

export function createController(app: AppServices, flow: ReactFlowInstance, library: LibraryStore): Controller {
  const ctx: CommandContext = app.ctx;
  let root: HTMLElement | null = null;
  let zoomLabel: HTMLElement | null = null;
  let strokeLine: SVGPolylineElement | null = null;

  /** The pointer's last place over the graph, in client pixels. */
  let pointerAt: Point | null = null;
  /** Where the context menu was opened: where its commands act while the pointer is on the menu, which is not over the graph. */
  let menuAt: Point | null = null;
  let drag: DragSession | null = null;
  let contextTarget: ContextTarget = { kind: 'canvas' };
  let fitPending = false;
  /**
   * The viewport is the one a fit made for a project that brought none, and the user has not moved it since. It
   * is made again when the panel changes its size: the dock gives the panel its place after the panel has mounted.
   */
  let autoFit = false;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let thumbnailTimer: ReturnType<typeof setTimeout> | null = null;
  let refusalTimer: ReturnType<typeof setTimeout> | null = null;
  let requested: readonly string[] = [];
  /** The cutting stroke in progress, in client pixels. */
  let stroke: Point[] | null = null;
  let cutKey = false;
  /** A stroke with the secondary button has just ended: the context menu that button would open stays closed. */
  let menuSuppressed = false;
  /** Ends the stroke in progress without cutting. */
  let cancelStroke: (() => void) | null = null;
  /** The drag is being written to the document by the graph itself: that change of the document does not end it. */
  let committing = false;
  /** Escape called off the wire or the nodes being dragged: what their release would do is not done. */
  let cancelled = false;
  /** The click that the release of the button makes is nobody's: after a cutting stroke, and after a drag that Escape called off. */
  let swallowClick = false;
  /** The wire whose end at an input is being dragged to another input. */
  let replug: string | null = null;
  /** Nodes were dragged since the button went down: the click that ends that press is the end of the drag, and selects nothing. */
  let draggedSincePress = false;

  const docOf = (): GraphDoc => ctx.doc.getState().doc;
  const bounds = (): DOMRect | null => root?.getBoundingClientRect() ?? null;
  /** Whether the names of the groups were last drawn at the screen's size. */
  let titlesScaled = false;
  /**
   * Far out, and in the middle band, the name of a group is drawn at the screen's size and not the graph's, so
   * that a graph seen whole says what its parts are: at the graph's size it would be under 7 pixels high there. Below GROUP_TITLE_MIN_ZOOM a name at that size would be larger than the group it
   * names. The scale is written on the few names themselves: a property of the graph's root that changed with
   * every step of a zoom had the style of every element under it computed again (measured with 300 nodes:
   * 33 ms a step in place of 4).
   */
  const sayZoom = (zoom: number): void => {
    if (!root) return;
    const scaled = zoom > 0 && lodOf(zoom) !== 'near' && zoom >= GROUP_TITLE_MIN_ZOOM;
    if (!scaled && !titlesScaled) return;
    titlesScaled = scaled;
    root.toggleAttribute('data-group-titles', scaled);
    for (const title of root.querySelectorAll<HTMLElement>('[data-group] [data-role="title"]')) title.style.transform = scaled ? `scale(${1 / zoom})` : '';
  };
  /** The level of detail of a zoom, and the size step of the nodes' names in the middle band: attributes of the root, which change at a few zooms only. */
  const sayLod = (zoom: number): void => {
    if (!root) return;
    const lod = lodOf(zoom);
    if (root.getAttribute('data-lod') !== lod) root.setAttribute('data-lod', lod);
    const step = titleStepOf(zoom);
    if (step === null) root.removeAttribute('data-title-step');
    else if (root.getAttribute('data-title-step') !== step) root.setAttribute('data-title-step', step);
  };
  /**
   * Whether the event happened in the graph itself. React hands the graph the events of what it renders
   * elsewhere in the document as well: the context menu and the tooltips, which are no part of the canvas.
   */
  const inGraph = (target: EventTarget | null): boolean => target instanceof Node && root !== null && root.contains(target) && !inOverlay(target);
  const fromClient = (client: Point): Point => {
    const rect = bounds();
    return { x: client.x - (rect?.left ?? 0), y: client.y - (rect?.top ?? 0) };
  };

  const controller: Controller = {
    graph: { nodes: [], edges: [], views: new Map() },

    // ---- GraphHost ----
    size() {
      const rect = bounds();
      return { width: rect?.width ?? 0, height: rect?.height ?? 0 };
    },
    pointer() {
      const at = pointerAt ?? menuAt;
      return at ? fromClient(at) : null;
    },
    fit(ids) {
      const { width, height } = controller.size();
      if (width === 0 || height === 0) {
        fitPending = true;
        return;
      }
      // The library keeps a fit of nodes it does not hold yet and makes it when nodes come: asked of an empty
      // graph, it would be made for the next project, over the viewport that project brings.
      if (controller.graph.nodes.length === 0) return;
      const nodes = ids?.map((id) => ({ id: nodeFlowId(id) }));
      void flow.fitView({ ...(nodes && nodes.length > 0 ? { nodes } : {}), padding: 0.15, minZoom: MIN_ZOOM, maxZoom: 1, duration: 0 });
    },
    focus() {
      const panel = root?.closest<HTMLElement>('[data-panel]') ?? root;
      panel?.focus({ preventScroll: true });
    },

    rendered() {
      // A group that came with this render has its name at the size of the others.
      if (titlesScaled) sayZoom(flow.getZoom());
      if (!fitPending) return;
      const { width, height } = controller.size();
      // The library holds the nodes of this render only once its own effects have run: the fit is made after them.
      if (width === 0 || height === 0 || flow.getNodes().length !== controller.graph.nodes.length) return;
      // The library fits into the size it knows, which it learns a frame after the panel has it (in a window that
      // is not shown, up to a second): at start-up that is still the whole dock's. A fit made for that size would
      // show the graph nearer than it will be, and ask the engine for the thumbnails of every node it passes.
      const known = library.getState();
      if (Math.abs(known.width - width) > 1 || Math.abs(known.height - height) > 1) return;
      fitPending = false;
      autoFit = true;
      controller.fit();
    },

    onMoveStart(event) {
      // The user panned or zoomed: the viewport is theirs from now on.
      if (event) autoFit = false;
    },

    // ---- what the library reports ----
    onNodesChange(changes) {
      const doc = docOf();
      const on: string[] = [];
      const off = new Set<string>();
      const groupsOn: string[] = [];
      const groupsOff = new Set<string>();
      const movedNodes = new Map<string, Point>();
      const movedGroups = new Map<string, Point>();
      for (const change of changes) {
        if (change.type === 'select') {
          const parsed = parseFlowId(change.id);
          if (parsed?.kind === 'node') (change.selected ? on.push(parsed.id) : off.add(parsed.id));
          else if (parsed?.kind === 'group') (change.selected ? groupsOn.push(parsed.id) : groupsOff.add(parsed.id));
        } else if (change.type === 'position' && change.position) {
          // The library goes on reporting a node that an undo took away while it was dragged: only what the document holds moves.
          const parsed = parseFlowId(change.id);
          if (parsed?.kind === 'node' && Object.hasOwn(doc.nodes, parsed.id)) movedNodes.set(parsed.id, change.position);
          else if (parsed?.kind === 'group' && Object.hasOwn(doc.groups, parsed.id)) movedGroups.set(parsed.id, change.position);
        }
        // A change of dimensions is not taken: the size of a node is the one flow.ts gives it. Nothing is removed
        // by the library either: deletion is a command (8.9).
      }

      if (on.length > 0 || off.size > 0) {
        const current = ctx.ui.getState().selection;
        setSelection(ctx.ui, [...current.filter((id) => !off.has(id)), ...on.filter((id) => !current.includes(id))]);
      }
      if (groupsOn.length > 0 || groupsOff.size > 0) {
        const local = graphStore.getState();
        selectWiresAndGroups(graphStore, local.edgeSelection, [...local.groupSelection.filter((id) => !groupsOff.has(id)), ...groupsOn.filter((id) => !local.groupSelection.includes(id))]);
      }
      if (movedNodes.size === 0 && movedGroups.size === 0) return;

      // 8.5 rule 8: while nodes are dragged their positions live in uiStore; the document changes once, at the end.
      drag ??= { id: newId(), contents: new Map(), doc };
      const session = drag;
      const positions: Record<string, Point> = { ...ctx.ui.getState().dragPositions };
      const rects: Record<string, Rect> = { ...graphStore.getState().groupRects };
      for (const [id, position] of movedNodes) positions[id] = position;
      for (const [id, position] of movedGroups) {
        const group = own(session.doc.groups, id);
        if (!group) continue;
        const frame = groupRect(group);
        rects[id] = { ...frame, x: position.x, y: position.y };
        // What the group held when the drag began moves with it, by as much.
        let contents = session.contents.get(id);
        if (!contents) session.contents.set(id, contents = groupContents(session.doc, controller.graph.views, id));
        const delta = { x: position.x - frame.x, y: position.y - frame.y };
        for (const nodeId of contents.nodes) {
          const node = own(session.doc.nodes, nodeId);
          if (node && !movedNodes.has(nodeId)) positions[nodeId] = { x: node.position.x + delta.x, y: node.position.y + delta.y };
        }
        for (const groupId of contents.groups) {
          const inner = own(session.doc.groups, groupId);
          if (!inner || movedGroups.has(groupId)) continue;
          const innerFrame = groupRect(inner);
          rects[groupId] = { ...innerFrame, x: innerFrame.x + delta.x, y: innerFrame.y + delta.y };
        }
      }
      if (Object.keys(positions).length > 0) ctx.ui.setState({ dragPositions: positions });
      if (Object.keys(rects).length > 0) graphStore.setState({ groupRects: rects });
    },

    onEdgesChange(changes) {
      // A box selects nodes. The library selects the wires of those nodes along with them; they are not taken,
      // or every wire of a boxed node would be marked and would stay so when the nodes are selected no more.
      const boxing = library.getState().userSelectionRect !== null;
      const on: string[] = [];
      const off = new Set<string>();
      for (const change of changes) {
        if (change.type !== 'select') continue;
        const parsed = parseFlowId(change.id);
        if (parsed?.kind !== 'edge') continue;
        if (!change.selected) off.add(parsed.id);
        else if (!boxing) on.push(parsed.id);
      }
      if (on.length === 0 && off.size === 0) return;
      const local = graphStore.getState();
      selectWiresAndGroups(graphStore, [...local.edgeSelection.filter((id) => !off.has(id)), ...on.filter((id) => !local.edgeSelection.includes(id))], local.groupSelection);
    },

    onNodeClick(event, node) {
      const dragged = draggedSincePress;
      draggedSincePress = false;
      if (dragged || event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey) return;
      // The library keeps several selected nodes selected when one of them is pressed, so that they can be
      // dragged together. Let go without a drag, the press was a choice of that one node, as it is in the
      // node editors this one is used beside: the inspector and the viewport then show it.
      const parsed = parseFlowId(node.id);
      const current = ctx.ui.getState().selection;
      if (parsed?.kind !== 'node' || !current.includes(parsed.id)) return;
      const local = graphStore.getState();
      if (current.length === 1 && local.edgeSelection.length === 0 && local.groupSelection.length === 0) return;
      setSelection(ctx.ui, [parsed.id]);
      selectWiresAndGroups(graphStore, [], []);
    },

    onNodeDrag(_event, _node, nodes) {
      draggedSincePress = true;
      // A node dragged alone goes into the wire it is dropped on: that wire is marked while the node is over it.
      const parsed = nodes.length === 1 ? parseFlowId(nodes[0]!.id) : null;
      const wire = parsed?.kind === 'node'
        ? wireUnderNode(docOf(), ctx.registry, controller.graph.views, parsed.id, ctx.ui.getState().dragPositions)
        : null;
      if (graphStore.getState().dropEdge !== wire) graphStore.setState({ dropEdge: wire });
      // The wire itself may lie hidden under the node: the node says as well that it would go in.
      root?.toggleAttribute('data-inserting', wire !== null);
    },

    onDragStop() {
      const session = drag;
      const positions = ctx.ui.getState().dragPositions;
      const local = graphStore.getState();
      if (session && !cancelled) {
        const moved = Object.keys(positions ?? {});
        const single = moved.length === 1 && session.contents.size === 0 ? moved[0]! : null;
        committing = true;
        try {
          commitMove(ctx, {
            dragId: session.id,
            positions: positions ?? {},
            groups: local.groupRects ?? {},
            insert: single !== null && local.dropEdge !== null ? { node: single, edge: local.dropEdge } : null,
          });
        } finally {
          committing = false;
        }
      }
      // After the transaction: the document then holds the positions the drag showed, and nothing jumps.
      forgetDrag();
    },

    isValidConnection(connection) {
      const refs = connectionRefs(connection);
      return refs !== null && validateConnection(docOf(), ctx.registry, refs.from, refs.to) === null;
    },

    onConnect(connection) {
      const refs = connectionRefs(connection);
      if (!refs || cancelled) return;
      const problem = replug !== null ? reconnectEdge(ctx, replug, refs.from, refs.to) : connectPorts(ctx, refs.from, refs.to);
      if (problem !== null) app.notify({ level: 'warning', message: problem });
    },

    onConnectEnd(event, state) {
      const moved = replug;
      endReplug();
      const from = portEnd(state.fromNode?.id, state.fromHandle?.id);
      if (!from || state.isValid || cancelled) return;
      const at = state.to ?? { x: 0, y: 0 };
      if (state.toHandle) {
        // Dropped on a port that does not take the wire: the reason stays for a moment (4.3: a one-sentence reason).
        const to = portEnd(state.toHandle.nodeId, state.toHandle.id);
        const reason = to ? refusal(docOf(), ctx.registry, from, to) : null;
        if (reason !== null) showRefusal(reason, at, true);
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      if (target === null || root === null || !root.contains(target) || inOverlay(target)) return;
      // Let go over a node, off its ports: the wire goes to the first port of that node that is free for it.
      const over = target.closest('[data-node]')?.getAttribute('data-node');
      if (typeof over === 'string') {
        const found = wireOntoNode(docOf(), ctx.registry, from, over, toneOf(from), moved);
        if (typeof found === 'string') showRefusal(found, at, true);
        else if (found !== null) {
          const problem = moved !== null ? reconnectEdge(ctx, moved, found.from, found.to) : connectPorts(ctx, found.from, found.to);
          if (problem !== null) showRefusal(problem, at, true);
        }
        return;
      }
      if (target.closest('.react-flow__pane') === null || target.closest('.react-flow__node') !== null) return;
      // The end of a wire pulled off its input and let go on the empty canvas: the wire goes.
      if (moved !== null) {
        disconnectEdges(ctx, [moved]);
        return;
      }
      // A new wire dropped on the empty canvas: the palette opens with the nodes the wire can end at, and connects
      // the one chosen. Its port for the wire lies where the wire was dropped.
      const ref = { node: from.node, port: from.port };
      const pending: Pending = from.side === 'out' ? { from: ref } : { to: ref };
      graphStore.setState({ palette: { at, position: toFlow(flow.getViewport(), at), pending, tone: toneOf(from), intoEdge: null }, renaming: null });
    },

    hoverRefusal(key) {
      if (key === null) {
        if (graphStore.getState().refusal?.sticky === false) graphStore.setState({ refusal: null });
        return;
      }
      const connection = library.getState().connection;
      if (!connection.inProgress || !connection.toHandle) return;
      const from = portEnd(connection.fromNode.id, connection.fromHandle.id);
      const to = portEnd(connection.toHandle.nodeId, connection.toHandle.id);
      const reason = from && to ? refusal(docOf(), ctx.registry, from, to) : null;
      if (reason !== null) showRefusal(reason, connection.to, false);
    },

    // ---- the pointer ----
    onPointerMove(event) {
      if (!inGraph(event.target)) return;
      pointerAt = { x: event.clientX, y: event.clientY };
      menuAt = null;
    },
    onPointerLeave() {
      pointerAt = null;
    },

    onPointerDownCapture(event) {
      if (!inGraph(event.target)) return;
      menuSuppressed = false;
      menuAt = null;
      pointerAt = { x: event.clientX, y: event.clientY };
      // Y and the primary button (Houdini), or Control and the secondary button (Blender): a stroke that cuts the wires it crosses.
      const cuts = (event.button === 0 && cutKey) || (event.button === 2 && event.ctrlKey);
      if (!cuts) return;
      event.stopPropagation();
      event.preventDefault();
      startStroke({ x: event.clientX, y: event.clientY }, event.button === 2);
    },
    onMouseDownCapture(event) {
      // The library pans, selects and drags on the mouse event that follows the pointer event: not during a stroke.
      if (stroke !== null) {
        event.stopPropagation();
        return;
      }
      // The middle button pans the graph; on Windows it would also start the browser's own scrolling mode.
      if (event.button === 1 && inGraph(event.target)) event.preventDefault();
      if (event.button === 0 && inGraph(event.target) && startReplug(event.target, { x: event.clientX, y: event.clientY })) event.stopPropagation();
    },

    onContextMenuCapture(event) {
      const target = event.target instanceof Element ? event.target : null;
      // On the menu itself: its own business.
      if (target !== null && root !== null && !root.contains(target)) return;
      if (menuSuppressed || event.ctrlKey || stroke !== null || inOverlay(target)) {
        menuSuppressed = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      menuAt = { x: event.clientX, y: event.clientY };
      const node = target?.closest('[data-node]')?.getAttribute('data-node');
      const group = target?.closest('[data-group]')?.getAttribute('data-group');
      const edge = parseFlowId(target?.closest('.react-flow__edge')?.getAttribute('data-id') ?? '');
      const doc = docOf();
      // A secondary press on something that is not selected selects it alone; on a selected one the menu is for the selection.
      if (typeof node === 'string' && Object.hasOwn(doc.nodes, node)) {
        if (!ctx.ui.getState().selection.includes(node)) {
          selectWiresAndGroups(graphStore, [], []);
          selectNodes(ctx, [node]);
        }
        contextTarget = { kind: 'node', id: node };
      } else if (edge?.kind === 'edge' && Object.hasOwn(doc.edges, edge.id)) {
        if (!graphStore.getState().edgeSelection.includes(edge.id)) {
          setSelection(ctx.ui, []);
          selectWiresAndGroups(graphStore, [edge.id], []);
        }
        contextTarget = { kind: 'edge', id: edge.id };
      } else if (typeof group === 'string' && Object.hasOwn(doc.groups, group)) {
        if (!graphStore.getState().groupSelection.includes(group)) {
          setSelection(ctx.ui, []);
          selectWiresAndGroups(graphStore, [], [group]);
        }
        contextTarget = { kind: 'group', id: group };
      } else {
        contextTarget = { kind: 'canvas' };
      }
    },

    contextItems() {
      const target = contextTarget;
      if (target.kind === 'node') {
        return commandItems(app, [
          'graph.rename', 'graph.toggleBypass', 'graph.toggleCollapse', null,
          'graph.useAsTerrain', 'graph.toggleViewLock', null,
          'edit.cut', 'edit.copy', 'graph.duplicate', 'graph.delete', null,
          'graph.group',
        ]);
      }
      // A secondary press selected the wire: the commands act on the selection, as they do from a key or the menu bar.
      if (target.kind === 'edge') return commandItems(app, ['graph.insertNode', null, 'graph.delete']);
      if (target.kind === 'group') {
        const groups = selectedGroups(ctx);
        const ids = groups.includes(target.id) ? groups : [target.id];
        const current = own(docOf().groups, target.id)?.color ?? null;
        return [
          ...commandItems(app, ['graph.rename']),
          {
            type: 'submenu', label: 'Color', id: 'color',
            items: [
              { label: 'None', id: 'color-none', checked: current === null, onSelect: () => setGroupColor(ctx, ids, null) },
              ...groupColors().map((color): MenuItemSpec => ({ label: color.label, id: `color-${color.name}`, checked: current === color.value, onSelect: () => setGroupColor(ctx, ids, color.value) })),
            ],
          },
          ...commandItems(app, ['graph.selectContents', null, 'graph.delete']),
        ];
      }
      return commandItems(app, ['graph.addNode', 'edit.paste', null, 'graph.selectAll', 'graph.fit', null, 'graph.toggleMinimap']);
    },

    // ---- the palette ----
    openPalette(intoEdge) {
      openPaletteAt(controller.pointer(), intoEdge ?? null);
    },
    closePalette() {
      if (graphStore.getState().palette === null) return;
      graphStore.setState({ palette: null });
      controller.focus();
    },
    pick(type) {
      const request = graphStore.getState().palette;
      if (!request) return;
      graphStore.setState({ palette: null });
      addNodeAt(ctx, type, request.position, { centered: request.pending === null, atPort: request.pending !== null, pending: request.pending, tone: request.tone, intoEdge: request.intoEdge });
      controller.focus();
    },
    wireText(request) {
      const pending = request.pending;
      const ref = pending?.from ?? pending?.to;
      const node = ref ? own(docOf().nodes, ref.node) : undefined;
      if (!pending || !ref || !node) return request.intoEdge !== null ? 'Into the wire' : null;
      const def = ctx.registry.get(node.type);
      const port = (pending.from ? def?.outputs : def ? inputsOf(def) : undefined)?.find((candidate) => candidate.name === ref.port);
      const name = `${nodeTitle(node, def)}: ${port ? portLabel(port) : ref.port}`;
      return pending.from ? `From ${name}` : `To ${name}`;
    },

    pendingWire(request) {
      const pending = request.pending;
      const ref = pending?.from ?? pending?.to;
      const view = ref ? controller.graph.views.get(ref.node) : undefined;
      const position = ref ? positionOf(docOf(), ref.node) : null;
      const port = pending && ref ? (pending.from ? view?.outputs : view?.inputs)?.find((candidate) => candidate.name === ref.port) : undefined;
      if (!pending || !view || !position || !port) return null;
      const viewport = flow.getViewport();
      const path = pending.from
        ? wirePathOn(viewport, outputAnchor(position, port.row, view.width), request.position)
        : wirePathOn(viewport, request.position, inputAnchor(position, port.row));
      return { path, tone: request.tone ?? port.tone, width: 2 * viewport.zoom };
    },

    // ---- a node dragged from the library (8.7) ----
    onDragOver(event) {
      if (!inGraph(event.target) || !event.dataTransfer.types.includes(NODE_DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const wire = wireAtPoint(docOf(), controller.graph.views, point, DROP_ON_WIRE_PX / (flow.getZoom() || 1));
      if (graphStore.getState().dropEdge !== wire) graphStore.setState({ dropEdge: wire });
    },
    onDragLeave() {
      if (graphStore.getState().dropEdge !== null) graphStore.setState({ dropEdge: null });
    },
    onDrop(event) {
      const type = event.dataTransfer.getData(NODE_DRAG_TYPE);
      if (graphStore.getState().dropEdge !== null) graphStore.setState({ dropEdge: null });
      if (type === '' || !inGraph(event.target)) return;
      event.preventDefault();
      if (!ctx.registry.get(type)) {
        app.notify({ level: 'warning', message: `Unknown node type "${type}"` });
        return;
      }
      const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const wire = wireAtPoint(docOf(), controller.graph.views, point, DROP_ON_WIRE_PX / (flow.getZoom() || 1));
      addNodeAt(ctx, type, point, { centered: true, intoEdge: wire });
      ctx.ui.setState({ focusedPanel: 'graph' });
      controller.focus();
    },

    mount(element, label, line) {
      root = element;
      zoomLabel = label;
      strokeLine = line;
      const stops: (() => void)[] = [];
      const listen = <T extends EventTarget>(target: T, type: string, listener: (event: never) => void, capture = false): void => {
        target.addEventListener(type, listener as EventListener, capture);
        stops.push(() => target.removeEventListener(type, listener as EventListener, capture));
      };

      // ---- the graph's viewport: level of detail, thumbnails, and the document's interface state ----
      const viewChanged = (): void => {
        const [, , zoom] = library.getState().transform;
        sayLod(zoom);
        sayZoom(zoom);
        if (zoomLabel) zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
        // The palette lies where the graph was when it opened, and so does the wire drawn to it.
        controller.closePalette();
        scheduleThumbnails();
        if (saveTimer !== null) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          saveTimer = null;
          const { width, height } = controller.size();
          if (width > 0 && height > 0 && !fitPending) saveViewport(ctx, flow.getViewport());
        }, SAVE_DELAY_MS);
      };
      const sized = (): void => {
        const { width, height } = library.getState();
        // The size the library works with, which it learns a frame after the panel has it: a test waits for the two to agree.
        root?.setAttribute('data-size', `${Math.round(width)}x${Math.round(height)}`);
      };
      stops.push(library.subscribe((state, previous) => {
        // The library may hand over another array that holds the same viewport: only a viewport that moved is one that changed.
        if (state.transform !== previous.transform && state.transform.some((value, i) => value !== previous.transform[i])) viewChanged();
        if (state.width !== previous.width || state.height !== previous.height) {
          sized();
          controller.closePalette();
          scheduleThumbnails();
          if (autoFit && !fitPending) controller.fit();
          controller.rendered();
        }
      }));
      sized();
      const held = docOf().ui.graphViewport;
      if (held) void flow.setViewport(held, { duration: 0 });
      else fitPending = true;
      sayLod(flow.getZoom());
      sayZoom(flow.getZoom());
      if (zoomLabel) zoomLabel.textContent = `${Math.round(flow.getZoom() * 100)}%`;

      // ---- the document ----
      stops.push(ctx.doc.subscribe((state, previous) => {
        const changed = state.doc.edges !== previous.doc.edges || state.doc.groups !== previous.doc.groups || state.doc.nodes !== previous.doc.nodes;
        // An undo, a redo or another project while nodes are dragged: where the drag showed them is of a document
        // that is no more, and the library does not say that a drag ended whose node is gone.
        if (changed && !committing && (drag !== null || ctx.ui.getState().dragPositions !== null)) forgetDrag();
        if (isLoad(state, previous)) {
          // Another project: nothing of the one before is selected, open or being dragged.
          graphStore.setState({ edgeSelection: [], groupSelection: [], palette: null, renaming: null, groupRects: null, dropEdge: null, refusal: null });
          const viewport = state.doc.ui.graphViewport;
          autoFit = false;
          // A fit that still waited for the project before this one is not made for one that brings its viewport:
          // at start-up the project of the command line replaces the default project before the panel has a size.
          fitPending = viewport === undefined;
          if (viewport) {
            // And one the library still keeps for the project before (see fit) is withdrawn: `fitViewQueued` is
            // the library's own state (@xyflow/react 12.12), and where it has another name this does nothing.
            (library as unknown as { setState(patch: { fitViewQueued: boolean; fitViewOptions: undefined }): void }).setState({ fitViewQueued: false, fitViewOptions: undefined });
            void flow.setViewport(viewport, { duration: 0 });
          }
        } else if (changed) {
          // What an undo took away is not selected or being renamed any more.
          const local = graphStore.getState();
          const edges = local.edgeSelection.filter((id) => Object.hasOwn(state.doc.edges, id));
          const groups = local.groupSelection.filter((id) => Object.hasOwn(state.doc.groups, id));
          selectWiresAndGroups(graphStore, edges.length === local.edgeSelection.length ? local.edgeSelection : edges, groups.length === local.groupSelection.length ? local.groupSelection : groups);
          const renaming = local.renaming;
          if (renaming && !Object.hasOwn(renaming.kind === 'node' ? state.doc.nodes : state.doc.groups, renaming.id)) graphStore.setState({ renaming: null });
        }
        if (state.doc.nodes !== previous.doc.nodes || state.doc.groups !== previous.doc.groups) scheduleThumbnails();
      }));

      // 7.4: the view follows a selection of exactly one node, whoever made the selection: a click here, an
      // undo that brings a selection back, another panel. Applied after the task that changed the selection,
      // which may be the recipe of a transaction (8.5 rule 2), where no other transaction can be made.
      // A box that is being drawn passes over one node on its way to several: the view waits for the box to end.
      const follow = (): void => {
        const selection = selectedNodes(ctx);
        if (selection.length === 1 && !library.getState().userSelectionActive) selectNodes(ctx, selection);
      };
      let following = false;
      stops.push(ctx.ui.subscribe((state, previous) => {
        if (state.selection === previous.selection || following) return;
        following = true;
        queueMicrotask(() => {
          following = false;
          follow();
        });
      }));
      stops.push(library.subscribe((state, previous) => {
        if (previous.userSelectionActive && !state.userSelectionActive) follow();
      }));

      // ---- the clipboard (8.8 rules 3 and 6): DOM events at the panel, as text ----
      const panel = root.closest<HTMLElement>('[data-panel]') ?? root;
      listen(panel, 'copy', (event: ClipboardEvent) => {
        if (isTextField(event.target)) return;
        const text = copyText(ctx);
        if (text === null || !event.clipboardData) return;
        event.clipboardData.setData('text/plain', text);
        event.preventDefault();
      });
      listen(panel, 'cut', (event: ClipboardEvent) => {
        if (isTextField(event.target) || !event.clipboardData) return;
        const text = cutText(ctx);
        if (text === null) return;
        event.clipboardData.setData('text/plain', text);
        event.preventDefault();
      });
      listen(panel, 'paste', (event: ClipboardEvent) => {
        if (isTextField(event.target)) return;
        const text = event.clipboardData?.getData('text/plain') ?? '';
        const viewport = flow.getViewport();
        const pointer = controller.pointer();
        const size = controller.size();
        // At the pointer when it is over the graph; else a little inside the part of the graph that is shown.
        const at = pointer ? toFlow(viewport, pointer) : toFlow(viewport, { x: size.width * 0.3, y: size.height * 0.3 });
        if (pasteText(ctx, text, at) !== null) event.preventDefault();
      });

      // ---- "add this node now", from the library (8.7) ----
      listen(window, ADD_NODE_EVENT, (event: Event) => {
        const type = addNodeType(event);
        if (type === null) return;
        if (!ctx.registry.get(type)) {
          app.notify({ level: 'warning', message: `Unknown node type "${type}"` });
          return;
        }
        const size = controller.size();
        const added = addNodeNow(ctx, type, toFlow(flow.getViewport(), { x: size.width / 2, y: size.height / 2 }));
        // Beside the node it was connected to, which may lie at the edge of what is shown: the new node is brought into view.
        const rect = added === null ? null : rectOfNode(docOf(), viewsOf(ctx), added);
        if (rect === null) return;
        const viewport = flow.getViewport();
        const shown = viewportShowing(viewport, size, rect);
        if (shown !== viewport) void flow.setViewport(shown, { duration: 0 });
      });

      // ---- keys that are held while the pointer works: Y cuts wires, Space pans; and Escape, which calls a drag off ----
      const onKey = (event: KeyboardEvent): void => {
        if (event.code === 'Escape') {
          if (event.type === 'keydown' && cancelGesture()) {
            event.preventDefault();
            event.stopPropagation();
          }
          return;
        }
        // Y is the key that types Y, as the keys of the keymap are: on QWERTZ it lies where QWERTY has Z.
        if (keyNameOf(event) !== 'Y' && event.code !== 'Space') return;
        const held = event.type === 'keydown' && !event.ctrlKey && !event.metaKey && !event.altKey
          && !isTextField(event.target) && ctx.ui.getState().focusedPanel === 'graph' && graphStore.getState().palette === null;
        if (event.code === 'Space') {
          root?.toggleAttribute('data-panning', held);
          return;
        }
        if (held === cutKey) return;
        cutKey = held;
        if (held) root?.setAttribute('data-cutting', '');
        else if (stroke === null) root?.removeAttribute('data-cutting');
      };
      listen(window, 'keydown', onKey, true);
      listen(window, 'keyup', onKey, true);
      listen(window, 'blur', () => {
        cutKey = false;
        root?.removeAttribute('data-panning');
        if (stroke === null) root?.removeAttribute('data-cutting');
      });
      // The library says that a drag ended, except of one whose node went while it was dragged. A release of the
      // button ends every drag: one the library has not ended by the next task is ended here.
      const released = (): void => {
        setTimeout(() => { if (drag !== null) controller.onDragStop(); }, 0);
      };
      listen(window, 'mouseup', released, true);
      listen(window, 'pointercancel', released, true);
      // The library would take that click for one on the canvas, and clear the selection.
      listen(window, 'click', (event: MouseEvent) => {
        if (!swallowClick) return;
        swallowClick = false;
        event.stopPropagation();
        event.preventDefault();
      }, true);
      listen(window, 'pointerdown', () => {
        swallowClick = false;
        draggedSincePress = false;
      }, true);

      return () => {
        for (const stop of stops) stop();
        for (const timer of [saveTimer, thumbnailTimer, refusalTimer]) if (timer !== null) clearTimeout(timer);
        saveTimer = thumbnailTimer = refusalTimer = null;
        if (cancelStroke) cancelStroke();
        else endStroke(false);
        endReplug();
        forgetDrag();
        root = zoomLabel = strokeLine = null;
      };
    },
  };

  // ---- helpers that close over the controller ----

  function toneOf(end: PortEnd): PortTone | null {
    const view = controller.graph.views.get(end.node);
    return (end.side === 'out' ? view?.outputs : view?.inputs)?.find((port) => port.name === end.port)?.tone ?? null;
  }

  /** Nothing is being dragged any more: what the drag showed in place of the document is taken away. */
  function forgetDrag(): void {
    drag = null;
    root?.removeAttribute('data-inserting');
    if (ctx.ui.getState().dragPositions !== null) ctx.ui.setState({ dragPositions: null });
    const local = graphStore.getState();
    if (local.groupRects !== null || local.dropEdge !== null) graphStore.setState({ groupRects: null, dropEdge: null });
  }

  /**
   * Escape while a wire, nodes or a cutting stroke are dragged: the drag ends here and does nothing. The library
   * ends a drag only when the button is let go, so it is given a release, and what it then reports is not acted on.
   */
  function cancelGesture(): boolean {
    if (stroke !== null && cancelStroke) {
      cancelStroke();
      return true;
    }
    const connecting = library.getState().connection.inProgress;
    if (!connecting && drag === null) return false;
    const at = pointerAt ?? { x: 0, y: 0 };
    cancelled = true;
    try {
      // The library listens for the release of a wire on the document and for that of a node on the window.
      (connecting ? document : window).dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, clientX: at.x, clientY: at.y }));
      if (drag !== null) controller.onDragStop();
    } finally {
      cancelled = false;
    }
    endReplug();
    swallowClick = true;
    if (graphStore.getState().refusal !== null) graphStore.setState({ refusal: null });
    return true;
  }

  /**
   * A press on an input that has a wire takes that wire's end along (as Blender and Unreal do): the library is
   * given the press on the output the wire comes from, so what it drags is that wire, from its source. Dropped on
   * another input the wire moves there; dropped on the canvas it goes. Returns whether the press was taken.
   */
  function startReplug(target: EventTarget | null, at: Point): boolean {
    const handle = target instanceof Element ? target.closest('.react-flow__handle[data-side="in"]') : null;
    const node = handle?.closest('[data-node]')?.getAttribute('data-node');
    const name = handle?.getAttribute('data-port');
    if (!handle || typeof node !== 'string' || typeof name !== 'string' || root === null) return false;
    // The wire that is drawn into the input: of several, the first, which is the one the evaluator uses.
    const edge = Object.values(docOf().edges).find((candidate) => candidate.to.node === node && candidate.to.port === name
      && root!.querySelector(`.react-flow__edge[data-id="${CSS.escape(edgeFlowId(candidate.id))}"]`) !== null);
    if (!edge) return false;
    const source = root.querySelector(`[data-node="${CSS.escape(edge.from.node)}"] .react-flow__handle[data-side="out"][data-port="${CSS.escape(edge.from.port)}"]`);
    if (!source) return false;
    replug = edge.id;
    root.querySelector(`.react-flow__edge[data-id="${CSS.escape(edgeFlowId(edge.id))}"]`)?.setAttribute('data-moving', '');
    source.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1, clientX: at.x, clientY: at.y }));
    // A press without a drag starts no connection, and the library then says nothing: the release ends it here.
    const release = (): void => {
      window.removeEventListener('mouseup', release, false);
      setTimeout(() => { if (!library.getState().connection.inProgress) endReplug(); }, 0);
    };
    window.addEventListener('mouseup', release, false);
    return true;
  }

  function endReplug(): void {
    if (replug === null) return;
    replug = null;
    for (const marked of root?.querySelectorAll('.react-flow__edge[data-moving]') ?? []) marked.removeAttribute('data-moving');
  }

  function showRefusal(message: string, at: Point, sticky: boolean): void {
    if (refusalTimer !== null) clearTimeout(refusalTimer);
    refusalTimer = null;
    graphStore.setState({ refusal: { message, at, sticky } });
    if (!sticky) return;
    refusalTimer = setTimeout(() => {
      refusalTimer = null;
      graphStore.setState({ refusal: null });
    }, REFUSAL_MS);
  }

  function openPaletteAt(pointer: Point | null, intoEdge: string | null): void {
    const size = controller.size();
    const at = pointer ?? { x: size.width / 2, y: size.height / 2 };
    const position = toFlow(flow.getViewport(), at);
    // A wire a node cannot go into at all is not offered as one to insert into.
    const edge = intoEdge !== null && Object.hasOwn(docOf().edges, intoEdge) ? intoEdge : null;
    graphStore.setState({ palette: { at, position, pending: null, tone: null, intoEdge: edge }, renaming: null });
  }

  /** What follows from the part of the graph the panel shows, once it has rested a moment: the thumbnails asked for, and whether the minimap has anything to say. */
  function scheduleThumbnails(): void {
    if (thumbnailTimer !== null) return;
    thumbnailTimer = setTimeout(() => {
      thumbnailTimer = null;
      const viewport = flow.getViewport();
      const size = controller.size();
      const views = controller.graph.views;
      const doc = docOf();
      const area = visibleRect(viewport, size);
      // The minimap is drawn while something lies outside the panel: with the whole graph in view it would only cover a part of it.
      const all = size.width === 0 ? null : boundsOf([...rectsOf(doc, views, Object.keys(doc.nodes)), ...Object.values(doc.groups).map((group) => groupRect(group))]);
      const offscreen = all !== null && !containsRect(area, all);
      if (graphStore.getState().offscreen !== offscreen) graphStore.setState({ offscreen });
      // 7.1: the node ids whose thumbnails the graph currently shows. Zoomed far out it shows none (geometry.ts).
      const visible = size.width === 0 || lodOf(viewport.zoom) === 'far'
        ? []
        : nodesIn(doc, views, area).filter((id) => views.get(id)?.thumbnail === true);
      if (sameIds(visible, requested)) return;
      requested = visible;
      ctx.engine.requestThumbnails(visible);
    }, THUMBNAIL_DELAY_MS);
  }

  function drawStroke(): void {
    if (!strokeLine) return;
    strokeLine.setAttribute('points', (stroke ?? []).map((point) => {
      const local = fromClient(point);
      return `${local.x},${local.y}`;
    }).join(' '));
  }

  function startStroke(at: Point, secondary: boolean): void {
    stroke = [at];
    root?.setAttribute('data-cutting', '');
    const move = (event: PointerEvent): void => {
      if (!stroke) return;
      const last = stroke[stroke.length - 1]!;
      // A point every few pixels: a stroke is a few dozen segments however long it is drawn.
      if (Math.hypot(event.clientX - last.x, event.clientY - last.y) < 3 || stroke.length >= 512) return;
      stroke.push({ x: event.clientX, y: event.clientY });
      drawStroke();
    };
    const up = (event: PointerEvent): void => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
      if (stroke) stroke.push({ x: event.clientX, y: event.clientY });
      menuSuppressed = secondary;
      // The library saw neither the press nor the release of a stroke: the click they make would clear the selection.
      swallowClick = !secondary;
      endStroke(true);
    };
    const cancel = (): void => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
      endStroke(false);
    };
    cancelStroke = cancel;
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel, true);
    drawStroke();
  }

  function endStroke(cut: boolean): void {
    const drawn = stroke;
    stroke = null;
    cancelStroke = null;
    drawStroke();
    if (!cutKey) root?.removeAttribute('data-cutting');
    if (!cut || !drawn || drawn.length < 2) return;
    const line = drawn.map((point) => flow.screenToFlowPosition(point));
    const edges = wiresCut(docOf(), controller.graph.views, line);
    if (edges.length > 0) disconnectEdges(ctx, edges, edges.length === 1 ? 'Cut Wire' : 'Cut Wires');
  }

  /** The colours a group can have: the category colours of the theme, read from it, so that none is written here (8.7 rule 4). */
  function groupColors(): { readonly name: string; readonly label: string; readonly value: string }[] {
    const labels: Readonly<Record<string, string>> = {
      generate: 'Brown', adjust: 'Blue', filter: 'Purple', simulate: 'Green', select: 'Indigo', color: 'Olive', surface: 'Teal', io: 'Red', ref: 'Moss',
    };
    const style = root ? getComputedStyle(root) : null;
    return CATEGORIES.flatMap((category) => {
      const value = style?.getPropertyValue(`--og-category-${category}`).trim().toLowerCase() ?? '';
      return /^#[0-9a-f]{6}$/.test(value) ? [{ name: category, label: labels[category]!, value }] : [];
    });
  }

  return controller;
}
