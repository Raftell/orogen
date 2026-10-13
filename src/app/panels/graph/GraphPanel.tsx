// The graph panel (runtime.md 8.7): the node graph on @xyflow/react in controlled mode (8.9). The nodes and
// wires are derived from docStore and uiStore by flow.ts on every change of either; what the library reports
// goes to controller.ts, which changes a store; nothing of the graph is kept in the library alone.

import {
  Background, BackgroundVariant, ConnectionMode, MiniMap, ReactFlow, ReactFlowProvider, SelectionMode, useConnection, useReactFlow, useStoreApi,
  type Edge as LibraryEdge, type Node as LibraryNode,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type CSSProperties } from 'react';
import { useStore } from 'zustand';

import { CommandButton, ContextMenu, useApp, type CommandContext } from '../../ui/index.ts';
import { AddNodePalette } from './AddNodePalette.tsx';
import { createController, type Controller } from './controller.ts';
import { createFlowMapper, type FlowGraph, type FlowInput, type NodeView } from './flow.ts';
import {
  BODY_PADDING, BORDER, FOOTER_HEIGHT, GROUP_HEADER_HEIGHT, HANDLE_SIZE, HEADER_HEIGHT, MAX_ZOOM, MIN_ZOOM, ROW_HEIGHT, THUMBNAIL_SIZE,
} from './geometry.ts';
import styles from './graph.module.css';
import { TerrainNode } from './GraphNode.tsx';
import { GroupFrame } from './GroupFrame.tsx';
import { graphStore, setGraphHost } from './state.ts';
import { ConnectionLine, Wire } from './Wire.tsx';

// 8.9: module constants. The library builds its renderers anew when it is handed another object.
const NODE_TYPES = { terrain: TerrainNode, frame: GroupFrame };
const EDGE_TYPES = { wire: Wire };
/** The middle button pans; the primary button is free for the selection box (ui-stack.md a.5). */
const PAN_BUTTONS = [1];
const MULTI_SELECTION_KEYS = ['Shift', 'Control', 'Meta'];
const PRO_OPTIONS = { hideAttribution: true };
const MINIMAP_SIZE = { width: 168, height: 112 };

/** The sizes of geometry.ts, for the style sheet. */
const SIZES = {
  '--graph-border': `${BORDER}px`,
  '--graph-header': `${HEADER_HEIGHT}px`,
  '--graph-row': `${ROW_HEIGHT}px`,
  '--graph-pad': `${BODY_PADDING}px`,
  '--graph-thumb': `${THUMBNAIL_SIZE}px`,
  '--graph-footer': `${FOOTER_HEIGHT}px`,
  '--graph-handle': `${HANDLE_SIZE}px`,
  '--graph-group-header': `${GROUP_HEADER_HEIGHT}px`,
} as CSSProperties;

/** The graph the stores hold now, as the library draws it; the same object for as long as nothing in it changed. */
function useFlowGraph(ctx: CommandContext, mapper: (input: FlowInput) => FlowGraph): FlowGraph {
  const subscribe = useCallback((changed: () => void) => {
    const stops = [ctx.doc.subscribe(changed), ctx.ui.subscribe(changed), graphStore.subscribe(changed)];
    return () => { for (const stop of stops) stop(); };
  }, [ctx]);
  const snapshot = useCallback(() => {
    const ui = ctx.ui.getState();
    const local = graphStore.getState();
    return mapper({
      doc: ctx.doc.getState().doc,
      registry: ctx.registry,
      selection: ui.selection,
      dragPositions: ui.dragPositions,
      edgeSelection: local.edgeSelection,
      groupSelection: local.groupSelection,
      groupRects: local.groupRects,
      dropEdge: local.dropEdge,
    });
  }, [ctx, mapper]);
  return useSyncExternalStore(subscribe, snapshot);
}

/** Tells the controller which refused connection the pointer is on. It renders nothing, and only when that changes. */
function RefusalWatch(props: { readonly controller: Controller }) {
  const key = useConnection((connection) => (connection.inProgress && connection.isValid === false && connection.toHandle
    ? `${connection.fromNode.id} ${connection.fromHandle.id} ${connection.toHandle.nodeId} ${connection.toHandle.id}`
    : null));
  useEffect(() => props.controller.hoverRefusal(key), [props.controller, key]);
  return null;
}

function Refusal() {
  const refusal = useStore(graphStore, (state) => state.refusal);
  if (!refusal) return null;
  return <div className={styles.refusal} style={{ left: refusal.at.x, top: refusal.at.y }} role="status" data-graph="refusal">{refusal.message}</div>;
}

function minimapColor(node: LibraryNode): string {
  if (node.type === 'frame') return 'var(--og-bg-hover)';
  const category = (node.data as unknown as NodeView).category;
  return category ? `var(--og-category-${category})` : 'var(--og-bg-widget)';
}

function Graph() {
  const app = useApp();
  const ctx = app.ctx;
  const flow = useReactFlow();
  const library = useStoreApi();
  const root = useRef<HTMLDivElement>(null);
  const zoomLabel = useRef<HTMLSpanElement>(null);
  const strokeLine = useRef<SVGPolylineElement>(null);

  const mapper = useMemo(createFlowMapper, []);
  const graph = useFlowGraph(ctx, mapper);
  const controller = useMemo(() => createController(app, flow, library), [app, flow, library]);
  controller.graph = graph;

  const palette = useStore(graphStore, (state) => state.palette);
  // The minimap is drawn while it has something to say: while part of the graph lies outside the panel.
  const minimap = useStore(graphStore, (state) => state.minimap && state.offscreen);
  const locked = useStore(ctx.doc, (state) => state.doc.ui.view?.locked === true);
  const empty = graph.views.size === 0;
  // The viewport the document holds when the panel mounts; later ones are applied by the controller.
  const initialViewport = useMemo(() => ctx.doc.getState().doc.ui.graphViewport ?? { x: 0, y: 0, zoom: 1 }, [ctx]);

  useEffect(() => {
    if (!root.current) return undefined;
    setGraphHost(controller);
    const unmount = controller.mount(root.current, zoomLabel.current, strokeLine.current);
    return () => {
      unmount();
      setGraphHost(null);
    };
  }, [controller]);
  // After every render: a fit that waited for the library to hold the nodes.
  useEffect(() => controller.rendered());

  const closePalette = controller.closePalette;
  const origin = palette ? root.current?.getBoundingClientRect() ?? null : null;
  const pending = palette ? controller.pendingWire(palette) : null;

  return (
    <div
      ref={root}
      className={styles.root}
      style={SIZES}
      data-graph="root"
      data-lod="near"
      role="application"
      aria-label="Node graph"
      onPointerDownCapture={controller.onPointerDownCapture}
      onMouseDownCapture={controller.onMouseDownCapture}
      onPointerMove={controller.onPointerMove}
      onPointerLeave={controller.onPointerLeave}
      onContextMenuCapture={controller.onContextMenuCapture}
      onDragOver={controller.onDragOver}
      onDragLeave={controller.onDragLeave}
      onDrop={controller.onDrop}
    >
      <ContextMenu className={styles.surface} items={controller.contextItems}>
        <ReactFlow
          nodes={graph.nodes as unknown as LibraryNode[]}
          edges={graph.edges as unknown as LibraryEdge[]}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodesChange={controller.onNodesChange}
          onEdgesChange={controller.onEdgesChange}
          onConnect={controller.onConnect}
          onConnectEnd={controller.onConnectEnd}
          isValidConnection={controller.isValidConnection}
          onNodeDrag={controller.onNodeDrag}
          onNodeClick={controller.onNodeClick}
          onNodeDragStop={controller.onDragStop}
          onSelectionDragStop={controller.onDragStop}
          onMoveStart={controller.onMoveStart}
          connectionMode={ConnectionMode.Strict}
          connectOnClick={false}
          connectionRadius={22}
          connectionLineComponent={ConnectionLine}
          panOnDrag={PAN_BUTTONS}
          panActivationKeyCode="Space"
          selectionOnDrag
          selectionMode={SelectionMode.Partial}
          selectionKeyCode={null}
          multiSelectionKeyCode={MULTI_SELECTION_KEYS}
          deleteKeyCode={null}
          zoomOnDoubleClick={false}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          defaultViewport={initialViewport}
          elevateNodesOnSelect={false}
          elevateEdgesOnSelect={false}
          nodesFocusable={false}
          edgesFocusable={false}
          edgesReconnectable={false}
          disableKeyboardA11y
          nodeDragThreshold={2}
          colorMode="dark"
          proOptions={PRO_OPTIONS}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} />
          {minimap ? <MiniMap pannable zoomable style={MINIMAP_SIZE} nodeColor={minimapColor} nodeBorderRadius={2} ariaLabel="Overview of the graph" /> : null}
          <RefusalWatch controller={controller} />
        </ReactFlow>
      </ContextMenu>

      {empty ? (
        <div className={styles.empty} data-graph="empty">
          <div className={styles.emptyTitle}>The graph is empty</div>
          <div>
            Press <span className={styles.key}>{app.keyLabel('graph.addNode') ?? 'Tab'}</span> to add a node, or drag one in from the library
          </div>
        </div>
      ) : null}

      {/* A button that was pressed gives the focus back to the graph: Space would otherwise press it again instead of panning. */}
      <div className={styles.toolbar} data-graph="toolbar" onClick={controller.focus} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}>
        <CommandButton command="graph.addNode" icon="plus" size="small" />
        <CommandButton command="graph.fit" icon="fit" size="small" />
        <CommandButton command="graph.toggleViewLock" icon="lock" size="small" pressed={locked} />
        <span className={styles.zoom} ref={zoomLabel} title="Zoom of the graph" data-role="zoom">100%</span>
      </div>

      <svg className={styles.stroke} aria-hidden="true">
        <polyline ref={strokeLine} data-graph="stroke" />
        {/* The wire the palette is open for: it ends where the node chosen will have its port. */}
        {pending ? <path className={`${styles.wire} ${styles.pending}`} d={pending.path} data-tone={pending.tone} data-graph="pending-wire" style={{ strokeWidth: pending.width }} /> : null}
      </svg>
      <Refusal />
      {palette && origin ? (
        <AddNodePalette
          key={`${palette.at.x},${palette.at.y},${palette.pending?.from?.node ?? ''},${palette.pending?.to?.node ?? ''},${palette.intoEdge ?? ''}`}
          request={palette}
          registry={ctx.registry}
          origin={origin}
          wire={controller.wireText(palette)}
          onPick={controller.pick}
          onClose={closePalette}
        />
      ) : null}
    </div>
  );
}

export function GraphPanel() {
  return (
    <ReactFlowProvider>
      <Graph />
    </ReactFlowProvider>
  );
}
