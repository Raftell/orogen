# Orogen UI stack: node graph, docking, state/undo, widgets, WebGPU viewport, file formats, UX conventions

Research date: 2026-10-12. Target: Electron + TypeScript + React renderer, raw WebGPU, Windows 11 / RTX 3080 10 GB (ship), Ubuntu 24.04 / GTX 1660 Ti 6 GB (dev).

## 0. How to read this report

### 0.1 Confidence tags

| Tag | Meaning |
|---|---|
| **[V]** | Verified in this session against the cited primary source (npm registry, GitHub API, official docs, paper, or source file) on 2026-10-12. |
| **[R]** | Recalled from a stable primary source (a spec or long-standing API) but not re-fetched in this session. Low risk, but re-check before hard-coding. |
| **[U] UNVERIFIED** | Estimate, inference, or something I could not confirm. Do not hard-code without a local test. |

Nothing in this report was measured on a GPU. Every performance figure is either quoted from a cited paper or is a [U] estimate that the local-testing agent must confirm.

### 0.2 Decisions in one table

| Area | Pick | Runner-up | Rejected |
|---|---|---|---|
| UI framework | React 19.3.0 (keep the default) | - | Vue/Svelte: no evidence strong enough to leave React |
| Node graph | `@xyflow/react` 12.12.0, pinned exactly | Rete.js v2 | LiteGraph (original stale, maintained fork is inside a GPL-3.0 repo), BaklavaJS (Vue only), raw canvas (cost) |
| Docking | `dockview-react` 8.5.1 (MIT tier) | `flexlayout-react` 0.11.1 | golden-layout (last npm release 2022), rc-dock (smaller, Apache-2.0) |
| State | `zustand` 5.0.15 vanilla store + `immer` 11.1.21 patches, hand-written history | `mutative` 1.3.0 for patches | zundo (no transactions), yjs (CRDT cost with no collaboration need) |
| Widgets | Custom scrub field, curve editor, gradient editor on top of `@base-ui/react` 1.9.0 primitives and `react-colorful` 5.8.1 | Radix UI, React Aria | leva / tweakpane as the product property panel |
| Terrain geometry | CDLOD quadtree mesh drawn straight from the full-resolution `r32float` height texture | Max-mip heightfield ray-march (used anyway for shadow bake and picking) | Geometry clipmaps, single brute-force grid above 2049 |
| Lighting | Baked-to-texture sun visibility + AO (compute, progressive), slope map with mips, Hillaire sky LUTs, analytic height fog | Per-pixel shadow ray-march | Cascaded shadow maps |
| PNG16 / R16 / EXR / TIFF / OBJ / GLB writers | Small custom writers on `node:zlib` (no native modules) | `sharp` 0.35.5 for PNG/TIFF | `fast-png` for encoding (filter type 0 only, whole-buffer, sync) |
| Readers | `fast-png` 8.0.0, `geotiff` 3.0.5, `parse-exr` 1.0.2 (or three.js `EXRLoader`) | `tiff` 7.1.3 | `utif`, `upng-js`, `pngjs` (stale) |

### 0.3 Versions (npm registry `npm view`, 2026-10-12) [V]

| Package | Latest | Published | Licence | Notes |
|---|---|---|---|---|
| electron | 44.7.0 | 2026-10-07 | MIT | Chromium 152.0.7977.130, Node 24.21.0, V8 15.2 (https://releases.electronjs.org/release/v44.7.0) |
| react / react-dom | 19.3.0 | 2026-09-09 | MIT | |
| typescript | 7.0.2 | 2026-07-08 | Apache-2.0 | |
| vite / electron-vite | 8.3.4 / 5.0.0 | 2026-10-08 / 2025-12-07 | MIT | |
| @xyflow/react | 12.12.0 (`next`: 13.0.0-next.0, 2026-10-11) | 2026-09-24 | MIT | deps: zustand ^4.4.0, classcat, @xyflow/system 0.0.83; peer react >=17 |
| rete / rete-area-plugin / rete-react-plugin | 2.0.6 / 2.3.2 / 2.1.2 | 2025-06-30 / 2026-07-08 / 2026-07-10 | MIT | `rete-scopes-plugin` 2.1.1 is **CC-BY-NC-SA-4.0** |
| litegraph.js | 0.7.18 | 2024-01-08 | MIT | repo last push 2024-08-01 |
| @comfyorg/litegraph | 0.17.2 | 2025-08-06 | MIT | **deprecated on npm**; code moved into Comfy-Org/ComfyUI_frontend (GPL-3.0) |
| baklavajs | 2.8.1 | 2025-11-02 | MIT | Vue renderer only |
| dockview / dockview-react / dockview-core | 8.5.1 | 2026-10-10 | MIT | `dockview-enterprise` 8.5.1 is proprietary |
| flexlayout-react | 0.11.1 | 2026-09-26 | MIT | peer react ^18 or ^19, ESM only |
| rc-dock | 4.1.0 | 2026-09-30 | Apache-2.0 | |
| golden-layout | 2.6.0 | 2022-09-26 | MIT | |
| zustand | 5.0.15 | 2026-08-13 | MIT | |
| immer | 11.1.21 | 2026-10-02 | MIT | |
| mutative | 1.3.0 | 2025-09-21 | MIT | |
| zundo | 2.3.0 | 2024-11-17 | MIT | |
| yjs | 13.6.33 | 2026-09-23 | MIT | |
| @base-ui/react | 1.9.0 | 2026-10-09 | MIT | (`@base-ui-components/react` is the old name, frozen at 1.0.0-rc.0) |
| radix-ui | 1.7.0 | 2026-10-05 | MIT | |
| react-aria-components | 1.22.1 | 2026-10-09 | Apache-2.0 | |
| react-colorful | 5.8.1 | 2026-09-01 | MIT | |
| leva | 0.10.1 | 2025-10-31 | MIT | repo last push 2025-11-09 |
| tweakpane | 4.0.5 | 2024-11-03 | MIT | vanilla JS |
| cmdk / fuzzysort | 1.1.1 / 4.0.2 | 2025-03-14 / 2026-08-13 | MIT | |
| tinykeys / react-hotkeys-hook | 4.0.1 / 5.3.3 | 2026-09-25 / 2026-06-26 | MIT | |
| @webgpu/types | 0.1.74 | 2026-09-19 | BSD-3-Clause | |
| webgpu (Dawn for Node) | 0.6.2 | 2026-10-02 | MIT | 137 MB unpacked; CLI/tests only, never bundle into the Electron app |
| wgpu-matrix | 3.4.2 | 2026-02-12 | MIT | |
| webgpu-spd | 3.0.0 | 2025-08-03 | MIT | single-pass downsampler port (mip / min-max pyramids) |
| webgpu-sky-atmosphere | 1.2.0 | 2025-04-06 | MIT | WebGPU port of Hillaire's sky; 18 months without a release |
| fast-png | 8.0.0 | 2025-12-18 | MIT | ESM; deps fflate ^0.8.2, iobuffer |
| pngjs / upng-js | 7.0.0 / 2.1.0 | 2023-02-20 / 2017-12-12 | MIT | stale |
| sharp | 0.35.5 | 2026-09-27 | Apache-2.0 | Node >= 20.9; `@img/sharp-win32-x64` is "Apache-2.0 AND LGPL-3.0-or-later" (bundled libvips 1.3.4) |
| fflate / pako | 0.8.3 / 3.0.2 | 2026-05-16 / 2026-09-12 | MIT / (MIT AND Zlib) | |
| tiff (image-js) | 7.1.3 | 2025-12-18 | MIT | decode only |
| geotiff | 3.0.5 | 2026-03-11 | MIT | |
| utif2 / utif | 4.1.0 / 3.1.0 | 2023-05-06 / 2019-06-18 | MIT | stale |
| parse-exr | 1.0.2 | 2025-07-10 | MIT | engines: node >= 22; port of three.js EXRLoader |
| three | 0.186.1 | 2026-09-24 | MIT | only as a source of `EXRLoader`/`EXRExporter` reference code |
| @gltf-transform/core | 4.5.1 | 2026-09-28 | MIT | |
| meshoptimizer | 1.3.0 | 2026-09-25 | MIT | |
| delatin / @mapbox/martini | 0.2.0 / 0.2.0 | 2019-10-04 / 2020-01-31 | ISC | old but small and stable |

Repo activity (GitHub REST API, 2026-10-12) [V]: xyflow/xyflow 38.6k stars, pushed 2026-10-09; retejs/rete 12.3k, pushed 2026-09-27; jagenjo/litegraph.js 8.2k, pushed 2024-08-01; Comfy-Org/litegraph.js 254, pushed 2026-01-14 (README says merged into ComfyUI_frontend on 2025-08-05); newcat/baklavajs 2.1k, pushed 2026-09-16; dockview/dockview 3.5k, pushed 2026-10-11; caplin/FlexLayout 1.4k, pushed 2026-10-09; golden-layout 6.7k, pushed 2026-09-12 (npm still 2.6.0 from 2022); ticlo/rc-dock 814, pushed 2026-10-09; pmndrs/zustand 58.8k; immerjs/immer 29.0k; charkour/zundo 894, pushed 2026-01-30; yjs/yjs 22.9k.

---

## (a) Node-graph editor

### a.1 Recommendation

Use **`@xyflow/react` 12.12.0** (MIT), pinned to the exact version, in controlled mode, with the app's own document store, undo, clipboard, and search palette. Do not buy React Flow Pro for the examples; the paid examples (undo/redo, copy/paste, helper lines, selection grouping) are things Orogen has to own anyway because they must go through its document and history model.

### a.2 Comparison (state on 2026-10-12)

| Criterion | @xyflow/react 12.12.0 | Rete.js v2 (rete 2.0.6) | LiteGraph | BaklavaJS 2.8.1 | Raw canvas / WebGPU |
|---|---|---|---|---|---|
| Licence | MIT [V] | Core and most plugins MIT; **`rete-scopes-plugin` (nested groups) is CC-BY-NC-SA-4.0** [V] | Original MIT; maintained fork now lives inside Comfy-Org/ComfyUI_frontend, a **GPL-3.0** repo [V]. Licence of the litegraph sub-tree inside that repo: [U] | MIT [V] | n/a |
| Maintenance | 12.0.0 shipped 2024-07-09; 7 releases between 2026-06-22 (12.11.1) and 2026-09-24 (12.12.0); v13 prerelease published 2026-10-11 [V] | Core last published 2025-06; area/react/history/comment plugins 2026-07; connection, minimap, reroute plugins untouched since 2024-08 [V]. Single maintainer [R] | Original: last npm 2024-01, last push 2024-08. `@comfyorg/litegraph`: deprecated on npm, repo archived per its README [V] | Released 2025-11, repo pushed 2026-09 [V] | You |
| Rendering | DOM nodes inside one CSS-transformed viewport, SVG edges [R] | DOM nodes via React/Vue/Angular/Svelte/Lit renderers [V] | One Canvas2D for everything | Vue 3 components [V] | Full control |
| React fit | Native | `rete-react-plugin` (React 19 support since 2.1.0) [V] | None; imperative canvas API | None (would force Vue) | None |
| Typed ports, many outputs | `<Handle id>` per port, `sourceHandle`/`targetHandle` on edges, `isValidConnection` [V] | Sockets with compatibility rules [R] | Slot types [R] | Interface types plugin [V] | DIY |
| Reroute | Not built in; a 1-in/1-out custom node (trivial) | `rete-connection-reroute-plugin` 2.0.3 [V] | Built in [R] | [U] | DIY |
| Groups/frames | `parentId` sub-flows, `type:'group'`, `NodeResizer` [V]; dynamic grouping examples are Pro [V] | Comment plugin (MIT), scopes plugin (non-commercial licence) [V] | Built in [R] | Subgraphs [R] | DIY |
| Minimap | `<MiniMap pannable zoomable>` [V] | `rete-minimap-plugin` [V] | No [R] | Yes [R] | DIY |
| Copy/paste, undo/redo | Not built in (Pro examples) [V] | History plugin 2.2.0 [V]; copy/paste DIY | Clipboard built in, no undo [R] | Both built in (commands/history) [R] | DIY |
| Drag from port to create | `onConnectEnd(event, connectionState)` + `screenToFlowPosition` [V] | Via connection plugin events [R] | Built-in "search on link release" [R] | [U] | DIY |
| Performance at 300+ nodes with a canvas each | No published benchmark; perf work in 12.9 to 12.11 (below). DOM cost is manageable at this size if nodes are memoised. **[U] must be measured** | Same DOM approach, less perf tooling; [U] | Best raw throughput (single canvas) | [U] | Best |

Sources: npm registry and GitHub API (section 0.3); https://reactflow.dev/api-reference ; https://reactflow.dev/examples ; https://retejs.org/docs/ ; https://github.com/Comfy-Org/litegraph.js ; https://github.com/newcat/baklavajs .

### a.3 Why not the others

- **LiteGraph**: the original (jagenjo) is effectively unmaintained. The only actively developed line is ComfyUI's, which was merged into the ComfyUI_frontend monorepo on 2025-08-05; the standalone package `@comfyorg/litegraph` 0.17.2 carries an npm deprecation notice [V] (https://github.com/Comfy-Org/litegraph.js , `npm view @comfyorg/litegraph`). ComfyUI_frontend is GPL-3.0 [V], which is a problem for a closed-source or commercially licensed tool. On top of that ComfyUI itself is moving node rendering *off* the LiteGraph canvas to DOM (Vue) nodes ("Nodes 2.0") because, in their words, small UI changes on the canvas could take days; they also say the DOM renderer is still being optimised toward canvas-level performance and may show issues in very large workflows [V] (https://docs.comfy.org/interface/nodes-2). That is the best available real-world evidence on the canvas-versus-DOM trade-off: canvas wins on raw speed, DOM wins on development velocity and rich widgets.
- **Rete.js v2**: a credible second choice (MIT core, React renderer, plugins for minimap, reroute, history, comments). Reasons it loses: smaller team and uneven plugin maintenance (three core plugins untouched for 26 months), the grouping plugin's non-commercial licence, and a dataflow engine Orogen does not need.
- **BaklavaJS**: requires Vue 3. No evidence strong enough to leave React.
- **Raw canvas / WebGPU**: only justified for graphs of several thousand nodes. Hit-testing, text input, IME, accessibility, minimap, selection and context menus all become your problem. ComfyUI's migration away from it is the counter-evidence. Not for a solo developer.

### a.4 React Flow 12 facts and changes that matter [V]

From https://reactflow.dev/whats-new (read 2026-10-12):

- 12.12.0 (2026-09-24): `onResizeEnd` always fires after `onResizeStart`.
- 12.11.2 (2026-07-06), a performance release: viewport pan/zoom transform applied imperatively so the `Viewport` component renders once; `MiniMap` no longer re-renders on every store update; drag handlers created only for draggable nodes; zoom-pane extent cached (no forced synchronous layout while panning).
- 12.11.1 (2026-06-22): handles read connection state from context instead of each subscribing to the store.
- 12.11.0 (2026-06-01): `autoPanOnSelection`.
- 12.10.0 (2025-12-04): `zIndexMode` prop (`'basic'` default, `'auto'`, `'manual'`); `experimental_useOnNodesChangeMiddleware`.
- 12.9.0 (2025-10-20): `EdgeToolbar`; faster adding of nodes and edges.
- 12.8.5 (2025-09-17): nodes with predefined dimensions and handles skip the measure-then-render pass.
- 12.8.0 (2025-07-09): `connectionDragThreshold`.
- 12.5.0 (2025-04-07): `fitView` works immediately after node changes.
- 12.4.0 (2025-01-16): `useNodeConnections` replaces `useHandleConnections`.
- 12.0.0 (2024-07-09): package renamed to `@xyflow/react`; measured size lives in `node.measured`; `parentNode` renamed `parentId`; `colorMode`; `onBeforeDelete`; `isValidConnection` on `<ReactFlow>`.
- A `13.0.0-next.0` build exists on npm (2026-10-11) with zustand ^5, peer react >=18 and a `react-compiler-runtime` dependency [V] (`npm view @xyflow/react@13.0.0-next.0`). I found no release notes for it. **[U]** what breaks. Pin 12.12.0 and plan one migration later.

API surface confirmed in the 12.x reference [V] (https://reactflow.dev/api-reference , https://reactflow.dev/api-reference/react-flow , https://reactflow.dev/api-reference/types/react-flow-instance):

- Components: `ReactFlow`, `ReactFlowProvider`, `Background`, `Controls`, `MiniMap`, `Panel`, `ViewportPortal`, `NodeResizer`, `NodeResizeControl`, `NodeToolbar`, `EdgeToolbar`, `EdgeLabelRenderer`, `BaseEdge`, `Handle`.
- Hooks: `useReactFlow`, `useStore`, `useStoreApi`, `useNodesData`, `useNodeConnections`, `useConnection`, `useInternalNode`, `useUpdateNodeInternals`, `useKeyPress`, `useOnSelectionChange`, `useOnViewportChange`, `useViewport`, `useNodesInitialized`, `useNodeId`.
- Utils: `addEdge`, `applyNodeChanges`, `applyEdgeChanges`, `reconnectEdge`, `getBezierPath`, `getSmoothStepPath`, `getStraightPath`, `getSimpleBezierPath`, `getOutgoers`, `getIncomers`, `getConnectedEdges`, `getNodesBounds`, `getViewportForBounds`.
- Instance methods used below: `screenToFlowPosition(pos, {snapToGrid?, snapGrid?})`, `flowToScreenPosition`, `getIntersectingNodes(node|rect, partially?)`, `updateNodeData`, `deleteElements` (returns a Promise), `fitView`, `setCenter`, `getZoom`, `toObject`.
- Prop defaults worth knowing: `connectionMode 'strict'`, `connectionRadius 20`, `onlyRenderVisibleElements false`, `selectionOnDrag false`, `panOnDrag true` (accepts `number[]` of mouse buttons), `selectionMode 'full'`, `deleteKeyCode 'Backspace'`, `multiSelectionKeyCode 'Control'` (Meta on macOS), `minZoom 0.5`, `maxZoom 2`, `elevateNodesOnSelect true`, `nodeDragThreshold 1`, `panActivationKeyCode 'Space'`, `selectionKeyCode 'Shift'`, `noDragClassName 'nodrag'`, `noPanClassName 'nopan'`, `noWheelClassName 'nowheel'`, `reconnectRadius 10`, `edgesReconnectable true`, `autoPanSpeed 15`.
- `MiniMap` props: `pannable`, `zoomable`, `nodeColor` (string or function), `nodeStrokeColor`, `nodeComponent` (must render SVG), `maskColor`, `bgColor`, `zoomStep 10`, `inversePan` (https://reactflow.dev/api-reference/components/minimap).

Official performance guidance [V] (https://reactflow.dev/learn/advanced-use/performance): wrap custom nodes and edges in `React.memo`; keep `nodeTypes`/`edgeTypes` and all callbacks referentially stable; never select the whole `nodes`/`edges` array in a component (it changes on every drag tick); keep derived state such as selected ids in its own store field; simplify CSS (shadows, gradients, animations) when node counts grow. `onlyRenderVisibleElements` helps large graphs but "adds overhead" (prop docs), and there are old reports of it making panning worse (https://github.com/xyflow/xyflow/issues/967).

### a.5 Recommended configuration

```tsx
import { ReactFlow, MiniMap, Background, ConnectionMode, SelectionMode } from '@xyflow/react';
import '@xyflow/react/dist/style.css';           // or base.css and own theme

const NODE_TYPES = { op: OpNode, reroute: RerouteNode, frame: FrameNode, portalIn: PortalInNode, portalOut: PortalOutNode };
const EDGE_TYPES = { wire: WireEdge };            // module scope: never recreate

<ReactFlow
  nodes={rfNodes} edges={rfEdges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES}
  onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
  onConnect={onConnect} onConnectEnd={onConnectEnd} onReconnect={onReconnect}
  isValidConnection={isValidConnection}
  onNodeDragStart={beginMoveGesture} onNodeDragStop={commitMoveGesture}
  connectionMode={ConnectionMode.Strict} connectionRadius={24}
  panOnDrag={[1, 2]}                 // MMB and RMB pan (UE Blueprint habit); LMB is free for marquee
  selectionOnDrag selectionMode={SelectionMode.Partial}
  panActivationKeyCode="Space"       // Space+LMB pan (Houdini habit)
  minZoom={0.1} maxZoom={2.5} zoomOnDoubleClick={false}
  deleteKeyCode={null}               // route Delete through the app command system (undo)
  elevateNodesOnSelect={false}       // frames must stay behind nodes when selected
  nodesFocusable={false} edgesFocusable={false}   // frees the Tab key for the search palette
  colorMode="dark" proOptions={{ hideAttribution: true }}
  onlyRenderVisibleElements={false}  // benchmark both settings (see a.8)
/>
```

`zoomOnDoubleClick`, `nodesFocusable`, `edgesFocusable` are long-standing props [R]; the rest are [V]. Whether a right-click without movement still raises `onPaneContextMenu` when button 2 is in `panOnDrag` is **[U]**: test it, and fall back to `panOnDrag={[1]}` if the context menu is lost.

### a.6 How each required feature maps onto React Flow

| Feature | Implementation | Gotchas |
|---|---|---|
| Typed ports, multiple outputs | One `<Handle type="source" id={port.id} position={Position.Right}>` per output and `type="target"` on the left per input. Edges store `sourceHandle`/`targetHandle`. Colour the handle by port type. | Every handle needs a unique `id`. Call `useUpdateNodeInternals()(nodeId)` after ports are added, removed or moved. Hide ports with `opacity:0`/`visibility:hidden`, never `display:none` (handle size becomes 0 and edges misplace) [V] (https://reactflow.dev/learn/customization/handles). |
| Connection validation | `isValidConnection={(c) => c.source !== c.target && canConvert(typeOf(c.source,c.sourceHandle), typeOf(c.target,c.targetHandle)) && !wouldCycle(c.source, c.target)}` on `<ReactFlow>` (preferred over the per-`Handle` prop for performance [V]). Cycle check: DFS downstream from `c.target` looking for `c.source` (official "Preventing Cycles" example uses `getOutgoers`). | Since 12.10.1 the callback stays current during an in-flight connection [V]. |
| One wire per input | In `onConnect`, delete any existing edge with the same `target` + `targetHandle`, then add the new one, in a single history transaction. | React Flow itself allows many edges into one target handle. |
| Rewire by dragging a wire end | `onReconnect(oldEdge, newConnection)` with `reconnectEdge` semantics; drop on empty pane deletes the edge (official "Delete Edge on Drop" example). | |
| Drag from a port to create a node | `onConnectEnd(event, connectionState)`: if `!connectionState.isValid`, open the search palette at the pointer, pre-filtered to node types that have a port compatible with `connectionState.fromHandle`; on pick, add the node at `screenToFlowPosition({x: clientX, y: clientY})` and connect its first compatible port [V] (official "Add Node On Edge Drop" example). | `onPaneClick` no longer fires when a connection ends on the pane (12.11.1) [V]. |
| Tab search to add a node | Own `keydown` listener on the graph panel: `Tab` opens the palette at the last pointer position (track with `onPaneMouseMove`). Fuzzy match with `fuzzysort` 4.0.2 over name, aliases and short codes; `Enter` creates. Build the list UI with `cmdk` 1.1.1 or a 100-line custom list. | Must `preventDefault()` on Tab and disable RF's node focus traversal (`nodesFocusable={false}`). |
| Reroute nodes | Node type `reroute`: 12 px dot, one target and one source handle stacked at the centre, fixed `width`/`height` and `handles` on the node object so RF skips measuring. Create by double-clicking a wire (`onEdgeDoubleClick`), by Alt+click on a wire (Houdini), or by Shift+RMB-drag across wires (Blender). The engine resolves reroutes at graph-compile time (no texture copy). | Port type is inherited from upstream; recolour when the upstream changes. |
| Groups / frames | Node type `frame` with `<NodeResizer>`, low `zIndex`, title, colour. Use **geometric containment** (UE comment-box behaviour): on frame drag start, collect `getIntersectingNodes(frame, false)` (fully inside) and move them with the frame in the same history transaction. | Avoids RF `parentId` sub-flows, whose rules are: parents must precede children in the array, child positions become parent-relative, and edges of child nodes render above nodes [V] (https://reactflow.dev/learn/layouting/sub-flows). Set `elevateNodesOnSelect={false}` or `zIndexMode="manual"` so a selected frame does not cover its nodes. |
| Minimap | `<MiniMap pannable zoomable nodeColor={n => CATEGORY[n.data.category]} />`, toggled with a hotkey (`O` in Houdini). | Custom minimap nodes must be SVG. |
| Copy / paste / duplicate | Serialise selected nodes plus the edges whose both ends are selected to JSON `{orogenClipboard: 1, nodes, edges}`; write with `navigator.clipboard.writeText`. Paste: remap ids, offset to the pointer, add in one transaction, select the pasted set. Listen to the DOM `copy`/`cut`/`paste` events on the graph container, not to key codes, so text fields keep native behaviour. | Paid "Copy and Paste" example exists but is not needed. |
| Undo / redo | Not React Flow's job. See section (c). | The paid "Undo and Redo" example snapshots whole node arrays; do not copy that model. |
| Keyboard UX | One app-level keymap (`tinykeys` 4.0.1 or own). RF's own key handling reduced to pan activation. | RF ignores key presses that originate in inputs [R]. |
| Widgets inside nodes | Add class `nodrag` to interactive elements, `nowheel` to scrollable ones, `nopan` where needed [V]. | Pointer coordinates inside a node are in CSS-scaled space: multiply by `1 / getZoom()` when mapping to canvas pixels [V] (https://reactflow.dev/learn/troubleshooting/common-errors). |

### a.7 Live thumbnails (300+ nodes, 96 CSS px each)

Do **not** give each node its own WebGPU canvas context. The WebGPU fundamentals article on multiple canvases shows the pattern works (one device, one `getContext('webgpu')` + `configure` per canvas) but calls drawing 200 canvases "heavy" and recommends drawing only visible ones [V] (https://webgpufundamentals.org/webgpu/lessons/webgpu-multiple-canvases.html). Each context also owns swap-chain textures.

Recommended pipeline:

1. The engine renders each dirty node's thumbnail (hillshaded height, greyscale mask, or colour) into a cell of an `rgba8unorm` **atlas texture** (for example 2048 x 2048 = 256 cells of 128 x 128).
2. `copyTextureToBuffer` the dirty cells and `mapAsync` once per frame at most.
3. On the UI thread: `ctx2d.putImageData(new ImageData(bytes, 128, 128), 0, 0)` into a plain 2D `<canvas width=128 height=128 style="width:96px;height:96px">` owned by the node component and addressed through a ref (no React state, no re-render).
4. Keep the last `ImageData` per node id in a `Map` so a node that remounts (zoom LOD, `onlyRenderVisibleElements`) repaints immediately.

Numbers: `copyTextureToBuffer` requires `bytesPerRow` to be a multiple of 256 [V] (https://developer.mozilla.org/en-US/docs/Web/API/GPUCommandEncoder/copyTextureToBuffer). A 96 px row is 384 bytes and would need padding to 512; a **128 px** row is exactly 512 bytes and a 192 px row is 768, so render thumbnails at 128 (or 192) and display them at 96 CSS px. 128 x 128 x 4 = 65,536 bytes per thumbnail; 300 thumbnails = 19.7 MB of CPU memory. Throttle: update at most N thumbnails per frame, visible nodes first.

### a.8 Performance plan for the graph (must be measured, all [U])

- `React.memo` every node and edge component; node components subscribe to their own node's document slice by id.
- Thumbnails and progress bars are drawn imperatively through refs.
- Zoom LOD: `const far = useStore(s => s.transform[2] < 0.35)` returns a boolean, so components re-render only when the threshold is crossed; when `far`, render header + ports only (official "Contextual Zoom" example).
- No `box-shadow`, `filter`, `backdrop-filter` or animated dashed edges on nodes/wires at rest.
- Give nodes explicit `width`/`height`/`handles` where possible (12.8.5 fast path).
- Spike test before committing: 400 nodes, 600 edges, each node with a 128 px canvas; measure frame time for pan, zoom, single-node drag and 50-node drag on both machines with `onlyRenderVisibleElements` on and off. Pass criterion: under 8 ms scripting + layout per frame on the i7-13700KF.
- Escape hatch if the test fails: draw wires on one overlay `<canvas>` synced through `useOnViewportChange` and keep nodes in the DOM.

---

## (b) Dockable panel layout

### b.1 Pick: `dockview-react` 8.5.1 (MIT)

Evidence [V]:

- Most active of the four: repo pushed 2026-10-11, releases 8.0.0 (2026-08-10) through 8.5.1 (2026-10-10), 5.0.0 on 2026-02-16 and 6.0.0 on 2026-05-02 (`npm view dockview time`, https://github.com/dockview/dockview/releases).
- Zero runtime dependencies; React bindings accept react ^16.8 to ^19 (`npm view dockview-react peerDependencies`).
- Free tier contains everything Orogen needs: dockable grid, nested layouts, tab drag and drop, group drag and drop, floating groups, popout windows, edge groups, maximise/restore, locked groups, tab and chip context menus, custom tab components and header actions, `toJSON`/`fromJSON` layout persistence, CSS-variable theming and built-in themes, render modes (https://dockview.dev/docs/overview/licence).

**Licence caveat, new in 2026** [V]: since v8.0.0 dockview is open-core. The repo README states everything is MIT except `dockview-enterprise`, which is proprietary and needs a licence key (watermark without one; 30-day trial). Enterprise-only features: pinned tabs, multi-row tabs, advanced overflow (search, recent-first), DnD compass, smart guides, auto-hide edge groups, dock-to-edge groups, layout history (undo/redo of layout), spatial keyboard navigation, keyboard docking (https://dockview.dev/docs/overview/licence , https://dockview.dev/docs/releases/whats-new/whats-new-v8). None of these is required. Risk: future features may land in the paid tier only. Mitigation: depend only on `dockview-react`, pin the version, and keep `flexlayout-react` as the documented fallback.

### b.2 Alternatives

| Library | Verdict |
|---|---|
| flexlayout-react 0.11.1 (MIT, 2026-09-26) | Solid fallback. JSON model, tabsets, border tabsets with auto-hide, popout windows and floating panels, maximise, themes via CSS variables, undo/redo hook, React 18/19, ESM-only [V] (https://github.com/caplin/FlexLayout). Smaller community (1.4k stars), React-only, still 0.x. |
| rc-dock 4.1.0 (Apache-2.0, 2026-09-30) | Works (float, popup window, save/load layout) [V] (https://github.com/ticlo/rc-dock); smallest community (814 stars), fewer features, SCSS theming. |
| golden-layout 2.6.0 (MIT) | Last npm release 2022-09-26 [V]; README points to an unstable 3.0 dev branch; no React bindings mentioned [V]. Do not start a 2026 project on it. |

### b.3 API notes and gotchas (dockview 8.x)

```tsx
import { DockviewReact, type DockviewReadyEvent, type IDockviewPanelProps, themeAbyss } from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';

const components = { graph: GraphPanel, viewport: ViewportPanel, props: PropertiesPanel, library: LibraryPanel, log: LogPanel };

<DockviewReact components={components} theme={themeAbyss} defaultRenderer="always" onReady={(e: DockviewReadyEvent) => {
  const saved = loadLayoutJson();
  if (saved) { try { e.api.fromJSON(saved); return; } catch { /* fall through to default */ } }
  const vp = e.api.addPanel({ id: 'viewport', component: 'viewport', renderer: 'always' });
  e.api.addPanel({ id: 'graph', component: 'graph', renderer: 'always', position: { referencePanel: vp, direction: 'below' } });
  e.api.addPanel({ id: 'props', component: 'props', position: { referencePanel: vp, direction: 'right' } });
}} />
```

- Import path, CSS path and theme objects as shown are from the current docs search results (docs list v8.2.0) [V]; exact export names `DockviewReact`, `DockviewReadyEvent`, `IDockviewPanelProps`, `themeAbyss`, and the `position: {referencePanel, direction}` shape are [R] and should be checked against https://dockview.dev/typedocs/ when the code is written.
- **Render mode matters for canvases** [V] (https://dockview.dev/docs/core/panels/rendering): the default `'onlyWhenVisible'` removes a hidden panel's DOM element from the tree (state such as scroll position is lost, size measures as 0); `'always'` keeps it mounted with `visibility:hidden`. Use `'always'` for the 3D viewport and the graph (set per panel or `defaultRenderer`). Under `'always'`, `requestAnimationFrame` loops keep running while hidden, so pause rendering on `panel.api.onDidVisibilityChange`.
- Popout windows need a blank same-origin HTML page (default `/popout.html`, configurable `popoutUrl`); popout groups cannot be maximised [V] (https://dockview.dev/docs/core/groups/popoutGroups). In Electron allow the `window.open` in `webContents.setWindowOpenHandler` [R]. Whether a configured `GPUCanvasContext` survives its `<canvas>` being moved into another window's document is **[U]**; plan to re-`configure()` the context after a move, and ship floating groups first (same window, no document change).
- v8 breaking changes from v7: reported panel dimensions are now the content area (header excluded); `moveToNext/Previous` renamed `activateNext/Previous` [V].
- Persist `api.toJSON()` in app settings on `onDidLayoutChange` (debounced), with a schema version and a "Reset layout" command.

Default layout proposal: 3D/2D viewport top-left (largest), graph bottom-left, properties on the right full height, node library as a left edge tab, build/log/stats as bottom tabs. (Gaea's own arrangement is three areas: viewport, graph, properties [V] https://docs.quadspinner.com/Guide/Interface/Getting-around.html .)

---

## (c) State management and undo/redo

### c.1 Pick

`zustand` 5.0.15 **vanilla store** (`createStore` from `zustand/vanilla`) holding an immutable JSON document, mutated only through transactions built on `immer` 11.1.21 `produceWithPatches`. History is a hand-written stack of patch pairs. React reads with `useStore(store, selector)`.

Why:

- Immer's patch API is exactly the primitive an undo stack needs: `enablePatches()` once, `produceWithPatches(state, recipe)` returns `[next, patches, inversePatches]`, `applyPatches(state, patches)` replays; patches are `{op: 'add'|'replace'|'remove', path: (string|number)[], value}` [V] (https://immerjs.github.io/immer/patches/). Immer is actively maintained (11.1.21 on 2026-10-02) [V].
- `zundo` 2.3.0 stores full snapshots by default (optional user-supplied `diff`), and has **no transaction grouping**: the README's only tool for merging rapid changes is throttling/debouncing `handleSet` [V] (https://github.com/charkour/zundo). Slider drags, node drags and multi-step commands need explicit grouping. Its last release is 2024-11.
- `yjs` 13.6.33 gives `Y.UndoManager` (groups edits within `captureTimeout`, default 500 ms; `stopCapturing()`; `trackedOrigins`) [V] (https://docs.yjs.dev/api/undo-manager), but the whole document must live in Y types and every read goes through them. That cost buys real-time collaboration, which a solo-developer tool does not need. Revisit only if multi-user editing becomes a goal.
- `mutative` 1.3.0 is a faster Immer-like library with built-in patches and is an acceptable swap; Immer is chosen for its documentation and zustand's first-party middleware. (`zustand-travel`/`travels` 2.2.0 are Mutative-based undo libraries; not evaluated, [U].)
- React Flow 12 bundles its own zustand 4 internally; the app's zustand 5 store is separate and the two coexist [V] (dependency lists).

### c.2 Stores

| Store | Contents | Undoable | Persisted |
|---|---|---|---|
| `docStore` | `nodes: Record<NodeId, {type, params, pos:[x,y], label?, bypass?}>`, `edges: Record<EdgeId, {from:[NodeId, PortId], to:[NodeId, PortId]}>`, `frames`, `portals`, `graphSettings` (resolution, seed, terrain size/height) | Yes | `.orogen` JSON file |
| `uiStore` | selection, graph viewport, pinned/preview node, panel state, in-flight drag positions, RF `measured` sizes | No | partly, in the file or app settings |
| `runtimeStore` | per-node status, progress, timings, thumbnail revision, errors | No | No |

Rules:

- The document is plain JSON-serialisable data keyed by id (objects, not arrays or `Map`), so patches are small and stable.
- No typed arrays, GPU handles or class instances in `docStore`. Large blobs (painted masks, imported images) live in a content-addressed blob store; the document holds `{blob: sha256}` and history only ever swaps references. Garbage-collect blobs that are referenced neither by the document nor by any history entry.
- Validate and migrate on load with a schema library (`zod` 4.6.6 [V version]).

### c.3 Undo model

```ts
import { createStore } from 'zustand/vanilla';
import { enablePatches, produceWithPatches, applyPatches, type Patch } from 'immer';
enablePatches();

interface Entry { label: string; fwd: Patch[]; inv: Patch[]; mergeKey?: string; t: number;
                  selBefore: string[]; selAfter: string[]; }
const MERGE_MS = 600, MAX_ENTRIES = 500;

function transact(label: string, recipe: (d: Doc) => void, opt: { mergeKey?: string } = {}) {
  const s = store.getState();
  const [doc, fwd, inv] = produceWithPatches(s.doc, recipe);
  if (fwd.length === 0) return;
  const top = s.past[s.past.length - 1], now = performance.now();
  const merge = top && opt.mergeKey && top.mergeKey === opt.mergeKey &&
                (s.gesture === opt.mergeKey || now - top.t < MERGE_MS);
  const past = merge
    ? [...s.past.slice(0, -1), { ...top, fwd: [...top.fwd, ...fwd], inv: [...inv, ...top.inv], t: now }]
    : [...s.past, { label, fwd, inv, mergeKey: opt.mergeKey, t: now, selBefore: sel(), selAfter: sel() }].slice(-MAX_ENTRIES);
  store.setState({ doc, past, future: [], rev: s.rev + 1 });
  engine.invalidate(dirtyFromPatches(fwd));
}
function undo() { const e = pop(past); doc = applyPatches(doc, e.inv); push(future, e); engine.invalidate(dirtyFromPatches(e.inv)); restoreSelection(e.selBefore); }
function redo() { const e = pop(future); doc = applyPatches(doc, e.fwd); push(past, e); engine.invalidate(dirtyFromPatches(e.fwd)); restoreSelection(e.selAfter); }
```

- **Inverse order**: when two transactions merge, the combined inverse is the newer inverse followed by the older one (prepend), the combined forward is older then newer (append).
- **Gestures**: `beginGesture(key)` on pointer-down, `endGesture()` on pointer-up. All `transact` calls with that `mergeKey` between the two collapse into one entry regardless of time. Use key `param:${nodeId}:${paramId}` for slider scrubs, `move:${gestureId}` for node drags, `curve:${nodeId}` for curve-point drags. Typing in a number field merges by time (`MERGE_MS`).
- **Patch compaction** (optional): within one merged entry, for repeated `replace` ops on the same path keep the first inverse and the last forward. Immer does not promise minimal patches [V].
- **Dirty propagation**: `dirtyFromPatches` reads only patch paths: `['nodes', id, 'params', ...]` or `'bypass'` marks node `id` dirty; `['edges', ...]` marks the edge's target node dirty; `['nodes', id, 'pos']`, labels, frames mark nothing. The engine then invalidates downstream caches. Undo therefore re-evaluates exactly what an edit would.
- **Node drags**: while dragging, positions live in `uiStore` (React Flow change events applied with `applyNodeChanges`); on `onNodeDragStop` commit one `transact('Move nodes', ...)` with the final positions. Controlled flows must still apply RF's `dimensions` and `select` changes to the array they pass back, otherwise nodes never finish initialising [R] (see "drag a node that is not initialized" in https://reactflow.dev/learn/troubleshooting/common-errors).
- **Not undoable**: selection, viewport, panel layout, pinned preview node. Each entry stores selection before/after so undo restores a sensible selection.
- **Save point**: remember `savedRev`; the document is dirty when `rev !== savedRev`. Autosave and crash-recovery files serialise `doc` only.
- **Limits**: 500 entries; also cap total serialised patch size (for example 64 MB) and drop the oldest.
- **History panel**: entries carry labels ("Erosion: Duration 0.35 -> 0.50"), which gives a Gaea-style readable undo list for free.

Bridging to React Flow: derive `rfNodes`/`rfEdges` from `docStore` + `uiStore` with a reconciler that reuses the previous RF node object when the document node, selection flag and measured size are unchanged (identity stability is what keeps memoised nodes from re-rendering).

---

## (d) Property-panel widgets

### d.1 Verdict: custom widgets on headless primitives

| Need | Existing library | Verdict |
|---|---|---|
| Whole property panel | `leva` 0.10.1 (MIT; last release 2025-10-31, repo "under heavy development", 129 open issues) [V]; `tweakpane` 4.0.5 (MIT; vanilla JS, last release 2024-11-03) [V] | Good for throwaway debug panels. Both own their state and styling, which fights a schema-driven panel bound to the document store with gesture-grouped undo. Do not use for the product panel. |
| Number field with drag-scrub | `@base-ui/react` 1.9.0 `NumberField` has `ScrubArea`/`ScrubAreaCursor` parts, uses the Pointer Lock API, `smallStep` (Alt, default 0.1), `largeStep` (Shift, default 10), `allowWheelScrub`, `pixelSensitivity` (default 2), `teleportDistance` [V] (https://base-ui.com/react/components/number-field) | Usable, but its modifier mapping is the web convention (Shift = bigger), the opposite of Blender/Houdini (Shift = finer). Whether the mapping is configurable is [U]. Write a custom scrub field (about 200 lines); it is the most-used widget in the app and must feel right. |
| Popover, menu, context menu, select, tooltip, switch, checkbox, tabs, scroll area, dialog | `@base-ui/react` 1.9.0 (MIT, published 2026-10-09) or `radix-ui` 1.7.0 (MIT, 2026-10-05) [V] | Use one of them (Base UI suggested) for all commodity behaviour: focus management, dismissal, positioning, ARIA. Unstyled, so the house theme applies. |
| Colour picker | `react-colorful` 5.8.1 (MIT, 2026-09-01) [V]; React Aria Components 1.22.1 has `ColorArea`, `ColorSlider`, `ColorWheel`, `ColorField`, `ColorSwatch` (Apache-2.0) [V version; component list R] | `react-colorful` inside a popover plus own hex / float RGB / HSV fields. |
| Curve editor | No maintained React curve-editor package found (`react-curve-editor` is not on npm [V]); Tweakpane/Leva bezier plugins edit one cubic-bezier segment only [R] | Custom SVG component. |
| Gradient (colour ramp) editor | `react-best-gradient-color-picker` 3.0.14 (MIT, 2024-12-31) targets CSS gradient strings [V version; scope R] | Custom component. |

### d.2 Parameter schema drives everything

```ts
type ParamDef =
  | { kind: 'float'; id: string; label: string; default: number; min?: number; max?: number;      // hard limits
      softMin: number; softMax: number; step?: number; scale?: 'linear' | 'log'; unit?: 'm' | '%' | 'deg' | 'px' }
  | { kind: 'int';   id: string; label: string; default: number; min?: number; max?: number; softMin: number; softMax: number }
  | { kind: 'seed';  id: string; label: string; default: number }                                  // uint32
  | { kind: 'bool';  id: string; label: string; default: boolean }
  | { kind: 'enum';  id: string; label: string; default: string; options: { value: string; label: string }[] }
  | { kind: 'vec2';  id: string; label: string; default: [number, number]; softMin: number; softMax: number; linkable?: boolean }
  | { kind: 'curve'; id: string; label: string; default: CurvePoint[] }
  | { kind: 'gradient'; id: string; label: string; default: GradientStop[] }
  | { kind: 'color'; id: string; label: string; default: [number, number, number] };              // linear RGB floats
// common: group?: string; visibleIf?: (params) => boolean; tooltip?: string
```

The panel renders from `ParamDef[]`, writes through `transact(..., {mergeKey: 'param:' + nodeId + ':' + id})`, and the same schema drives serialisation, defaults, presets, randomise, and "expose as variable".

### d.3 Scrub field / slider behaviour spec

Conventions taken from Blender's field controls [V] (https://docs.blender.org/manual/en/latest/interface/controls/buttons/fields.html , Blender 5.2 manual): drag horizontally to change; **Ctrl snaps to discrete steps; Shift is precision**; click or Enter to type; Esc or RMB cancels; Tab / Shift+Tab move between fields; Ctrl+wheel steps the hovered field; expressions such as `3*2` are accepted; **dragging is limited to the soft range while typed values may go up to the hard limit**.

| Interaction | Behaviour |
|---|---|
| Pointer down + move > 3 px | Start scrub: `beginGesture`, `element.requestPointerLock()`, use `movementX`. Value change per pixel = `(softMax - softMin) / trackWidthPx` for bounded params; `step` per 2 px otherwise. Log-scale params scrub in log space. |
| Shift while scrubbing | x 0.1 (fine). |
| Ctrl while scrubbing | Snap to `step` (or to 1/10 of the soft range). |
| Pointer up | `document.exitPointerLock()`, `endGesture()`: exactly one undo entry. |
| Esc during scrub | Restore the starting value, drop the entry. |
| Click without drag, Enter, or F2 | Inline text edit, select all. Accept arithmetic (`1024/3`), relative edits (`+=5`, `*=2`), and units. Enter commits, Esc cancels, Tab commits and moves on. |
| Arrow Up/Down in edit mode | +/- step; Shift x 10, Alt x 0.1 (web convention, same as Base UI [V]). |
| Ctrl+wheel over the field | +/- step. Plain wheel scrolls the panel. |
| Double-click the label, or context menu "Reset" | Reset to default (one undo entry). |
| Context menu | Reset, Copy value, Paste value, Expose as variable, Edit range. |
| Visuals | Filled track from softMin to the value (Blender-style), value text right-aligned with unit, modified-from-default marker (dot or bold label). |

Electron note: `pointerLock` is one of the permission strings passed to `session.setPermissionRequestHandler` [V] (https://www.electronjs.org/docs/latest/api/session). If the app installs a permission handler it must allow `pointerLock`. Without a handler Electron approves permission requests by default [R].

Performance rule: while a gesture is active the engine should evaluate at a reduced preview resolution and refine on `endGesture` (the property panel only needs to emit begin/end).

Other widgets:

- **Seed**: integer field + dice button (`crypto.getRandomValues(new Uint32Array(1))[0]`), plus "Reseed all" at graph level.
- **Enum**: segmented control when there are 4 or fewer options, otherwise a select with type-ahead.
- **vec2**: two scrub fields with a link toggle (uniform scale); optional 2D pad popover; positions should also get an on-viewport gizmo (section g).
- **Toggle**: checkbox/switch; clicking the label toggles.
- **Color**: swatch opens a popover with `react-colorful`, hex field, linear-float fields, eyedropper from the viewport.

### d.4 Curve editor (Curves node)

- Model: `CurvePoint = { x: number; y: number; mode: 'smooth' | 'linear' | 'step' }`, sorted by `x`, `x` and `y` in [0, 1], minimum two points, endpoints may be pinned in `x`.
- Evaluation: **monotone cubic Hermite (Fritsch-Carlson / PCHIP)** per smooth segment so the curve never overshoots between points [R: standard algorithm]. One TypeScript function `evalCurve(points, x)` is the single source of truth.
- GPU hand-off: bake `evalCurve` into a 1D LUT (1024 samples, `r32float`, or pack into a uniform/storage buffer) and have the WGSL node do one linear lookup. The UI curve and the terrain result then match exactly, and WGSL never re-implements the spline.
- Rendering: SVG, 256 px square by default, resizable; grid at 0.25; polyline of about 128 evaluated samples; optional histogram underlay of the input heightfield (256 bins computed on the GPU) so the user can see where the terrain's heights sit.
- Interaction: click on empty space adds a point on the curve; drag moves it (clamped between neighbours in `x`); Shift = fine, Ctrl = snap to 1/16 grid; double-click or Delete removes; right-click sets the point mode; number fields for the selected point; presets (linear, S-curve, invert, ease-in, ease-out, terrace); `beginGesture`/`endGesture` around drags.

### d.5 Gradient editor (colour ramps)

- Model: `GradientStop = { t: number; color: [r, g, b] /* linear */; }` plus ramp-level `interpolation: 'linear' | 'smooth' | 'constant'` and `space: 'linear-srgb' | 'oklab'`.
- GPU hand-off: bake to a 256 x 1 (or 1024 x 1) `rgba8unorm-srgb` or `rgba16float` LUT sampled with a linear sampler.
- Rendering: a `<canvas>` strip drawn from the same `evalGradient` function; stop markers below.
- Interaction: click the strip to add a stop (colour sampled from the ramp); drag a stop; drag it vertically away to delete; double-click opens the colour popover; Alt+drag duplicates; flip, distribute evenly, and "load from image row" commands (Gaea's SatMap-style workflow), presets.

---

## (e) Terrain viewport in raw WebGPU on the compute device

### e.1 Constraints that shape the design

WebGPU limits and features (defaults; request more from the adapter where needed):

| Fact | Value | Source |
|---|---|---|
| `maxTextureDimension2D` default | 8192, so an 8129 x 8129 texture needs no raised limit | [V] https://www.w3.org/TR/webgpu/ (CRD 2026-09-15), https://developer.mozilla.org/en-US/docs/Web/API/GPUSupportedLimits |
| `maxBufferSize` default | 268,435,456 bytes | [V] MDN |
| `maxStorageBufferBindingSize` default | 134,217,728 bytes | [V] MDN |
| `maxStorageTexturesPerShaderStage` / `maxSampledTexturesPerShaderStage` | 4 / 16 | [V] MDN |
| `maxComputeInvocationsPerWorkgroup`, workgroup size X/Y | 256, 256/256 | [V] MDN |
| `r32float` sampling | "unfilterable-float" unless the optional feature `float32-filterable` is enabled (feature added in Chrome 119) | [V] https://developer.chrome.com/blog/new-in-webgpu-119 , MDN GPUSupportedFeatures |
| `read_write` storage textures in core | only `r32float`, `r32sint`, `r32uint` | [V] https://webgpufundamentals.org/webgpu/lessons/webgpu-storage-textures.html |
| Storage-capable formats in core | rgba8unorm/snorm/uint/sint, rgba16float/uint/sint, r32*, rg32*, rgba32* (not rg16float, not r8unorm, not rg8unorm) | [V] same article |
| `texture-formats-tier1` | adds r16unorm/snorm, rg16unorm/snorm, rgba16unorm/snorm (renderable, read-only or write-only storage) and makes the 8-bit snorm formats renderable; `texture-formats-tier2` adds read-write storage for more formats (Chrome 142+) | [V] https://developer.chrome.com/blog/new-in-webgpu-142 ; exact feature strings `texture-formats-tier1`/`-tier2` per the W3C `GPUFeatureName` list |
| `copyTextureToBuffer` | `bytesPerRow` must be a multiple of 256 | [V] MDN |
| Depth readback | Dawn accepts the depth aspect of `depth32float` in texture-to-buffer copies; `depth24plus` is rejected; multisampled textures cannot be copied | [V for depth32float vs depth24plus, from Dawn validation code (2020-21)]; multisample restriction [R] |
| WebGPU in workers | `WorkerNavigator.gpu` exists; an `OffscreenCanvas` can be configured for WebGPU in a dedicated worker | [V] https://developer.mozilla.org/en-US/docs/Web/API/WorkerNavigator/gpu for the first half; second half [R] |

Sizes at N = 8129 (N^2 = 66,080,641):

| Resource | Bytes |
|---|---|
| Height `r32float` | 264,322,564 (252 MiB) |
| Full-image `r32float` readback buffer, rows padded to 32,768 bytes | 266,370,820, which is under the 268,435,456 default `maxBufferSize` by only 2.06 MB |
| Min/max pyramid `rg32float`, levels >= 1 | about 176 MB (2/3 of the height texture) |
| Slope map `rg16float` at N with mips | 264 MB + 88 MB |
| Slope map `rg16float` capped at 4096 with mips | 67 MB + 22 MB |
| Light map `rgba8unorm` at 4096 with mips (two channels used; `rg8unorm` is not a core storage format) | 67 MB + 22 MB |
| Colour map `rgba8unorm` at N with mips | 264 MB + 88 MB |
| HDR target `rgba16float` 4x MSAA at 3840 x 2160 | 265 MB (+ 133 MB for `depth32float` 4x) |

Design consequences:

1. **Zero-copy sharing**: the viewport binds the engine's output `GPUTexture` directly. Every node output texture must therefore be created with `TEXTURE_BINDING | STORAGE_BINDING | COPY_SRC | COPY_DST`, and the viewport must hold a reference (lease) so the engine's cache cannot destroy or recycle a texture that is on screen.
2. **Do not depend on `float32-filterable`**: read heights with `textureLoad` (integer texel coordinates) plus manual bilinear where needed. Put everything that needs trilinear or anisotropic filtering into filterable formats (`rg16float`, `rgba8unorm`).
3. **One device, one queue**: a long compute pass delays presentation of the viewport. The engine must cut heavy work into chunks of roughly 4 to 8 ms of GPU time (tiles or iteration batches) and `await device.queue.onSubmittedWorkDone()` between chunks so viewport frames can interleave. Chunk sizes are [U] and need tuning with the `timestamp-query` feature.
4. **Render on demand**: no free-running `requestAnimationFrame`. Render one frame when the camera moved, a displayed texture changed, a progressive bake step finished, or a UI overlay changed. An idle editor then leaves the GPU to the terrain engine.
5. **Thread placement**: a `GPUDevice` cannot be shared across threads, so the engine and the viewport renderer must live on the same thread. Design their API as message-shaped (async calls, transferable results) from day one so both can move into a dedicated Worker with `canvas.transferControlToOffscreen()` later; that would take WGSL compilation and readback callbacks off the UI thread. Start on the main thread. [U] whether the move is needed.
6. Gaea 2 itself limits viewport preview data to 512 / 1024 / 2048 / 4096 and offers AA of none/2x/4x/8x (default 4x) [V] (https://docs.gaea.app/ui ; sibling report `gaea-features.md` section d.1). Orogen should have the same "preview resolution" selector; the renderer below nevertheless handles a full 8129 texture.

### e.2 Geometry: comparison and pick

| Technique | How it fits an orbit-camera editor whose heightfield changes every few seconds | Verdict |
|---|---|---|
| Single displaced grid, fixed N x N | Trivial. Good up to about 2049 x 2049 vertices (8.4 M triangles). At 4097 (33.5 M triangles) or 8129 (132 M triangles) it is too heavy for the GTX 1660 Ti and wasteful on the RTX 3080 [U estimates]. | Use only as the degenerate one-level case of CDLOD. |
| **CDLOD** (Strugar 2010) | Quadtree of identical grid patches drawn instanced from the source heightmap; LOD by true 3D distance, so it behaves correctly when the camera orbits far above or outside the terrain; per-vertex morph removes cracks and popping without stitching meshes [V] (paper: https://github.com/fstrugar/CDLOD , `cdlod_paper_latest.pdf`; code MIT). Needs per-node min/max heights for good culling, which can come from a tiny asynchronous readback. | **Pick.** |
| Geometry clipmaps (Losasso and Hoppe 2004; Asirvatham and Hoppe, GPU Gems 2 ch. 2) | Nested rings centred on the viewer in the horizontal plane. Mesh generation needs tiles, fillers, trims and seams and is "tricky in some places"; the reference write-up has no geomorphing [V] (https://mikejsavage.co.uk/geometry-clipmaps/). LOD keyed to xy distance fits a walking camera, not an orbit camera looking at a bounded terrain from outside. | Reject. |
| Full-screen heightfield ray-march with a max-mip pyramid (Tevs, Ihrke, Seidel, I3D 2008; Dick, Kruger, Westermann, EG 2009) | Pixel-exact at any distance, no mesh, cost scales with pixels not samples. Dick et al. report about 2x the frame rate of their rasteriser on a very high resolution data set, but parity or a rasteriser win on a smoother, lower resolution one; ray-casting frame rate was steadier; the pyramid costs 1/3 extra memory and is built on the GPU [V] (https://www.cs.cit.tum.de/fileadmin/w00cfj/cg/Research/Publications/2009/GPU_Ray-Casting/EG09AreasTerrain.pdf , hardware GTX 280). Drawbacks for an editor: no MSAA on silhouettes, needs exact bilinear-patch intersection for close-ups, grazing rays cost many steps, no wireframe view, and gizmos/water/scatter previews need `frag_depth`. | Do not use for primary visibility. **Do** build the max pyramid and use the same traversal in compute for the sun-shadow bake and for exact picking. |

### e.3 CDLOD specifics (from the paper [V] unless tagged)

Quadtree and patch:

- Patch mesh: `G x G` quads, `G = 64` (the paper lists 16, 32, 64, 128 as common), one vertex buffer of `(G+1)^2` grid coordinates in [0,1]^2 and one index buffer, drawn with a single instanced `drawIndexed`. Per-instance data: `origin.xy` (texels), `size` (texels), `level`.
- Height samples are vertex-centred: N samples span N - 1 quads. 8128 = 127 x 64 is not a power of two. Use a quadtree over the next power of two (8192 quads, root = 64 x 2^7, so 8 LOD levels 0..7) and clamp every vertex's texel coordinate to `[0, N-1]`; triangles outside the terrain collapse to zero area on the border. General rule: `levels = ceil(log2((N-1)/G)) + 1` (N = 1025 gives 5 levels).
- LOD ranges double per level: `r[l] = r0 * 2^l`; the paper derives the factor 2 from the 4x triangle-count step between levels.
- Selection (paper listing, lines 01-49), recursive from the root:

```
select(node, l):
  if !node.aabb.intersectsSphere(cam, r[l]): return false            // parent covers this area
  if !frustum.intersects(node.aabb):         return true             // handled, draw nothing
  if l == 0: emit(node, l); return true
  if !node.aabb.intersectsSphere(cam, r[l-1]): emit(node, l); return true
  for child in node.children:
      if !select(child, l-1): emitQuarter(node, child.quadrant, l)   // parent draws that quarter at level l
  return true
```

  `emitQuarter` draws a `G/2 x G/2` sub-range of the same patch index buffer (four index sub-ranges prepared once).
- Morph (paper HLSL, ported):

```wgsl
// gridPos: vertex coordinate in [0,1]^2 inside the patch; worldXY: unmorphed position in texels
fn morphVertex(gridPos: vec2f, worldXY: vec2f, quadScale: f32 /* texels per quad at this level */, k: f32) -> vec2f {
  let fracPart = fract(gridPos * (G * 0.5)) * (2.0 / G);            // 0 on even vertices, 1/G on odd ones
  return worldXY - fracPart * (G * quadScale) * k;                   // g_quadScale in the paper = world size of the node
}
// k = 0 near, 1 at the far end of the level's range:
// morphStart[l] = mix(r[l-1], r[l], 1.0 - m), with r[-1] = 0;  k = clamp((dist - morphStart[l]) / (r[l] - morphStart[l]), 0, 1)
```

  The paper states that the morph area "usually covers the last 15%-30% of every LOD range", so `m = 0.3` is a sane default. (The exact constant in Strugar's demo code is [U].) `dist` must be computed from the **unmorphed** vertex position with a height sampled the same way for every node, so shared edges get identical `k`.
- Height in the vertex shader: `textureLoad(heightTex, vec2i(xy), 0)` for integer positions; morphing vertices sit between samples, so do a 4-tap manual bilinear. Always read mip 0 with a stride of `2^l` texels: vertices are world-fixed samples, so there is no swimming and no height mip chain is needed for geometry.

Choosing `r0` from a screen-space target: with viewport height `H` px, vertical FOV `f`, target on-screen quad size `tau` px, and quad size `s` world units at level 0:

```
K  = H / (2 * tan(f / 2) * tau)        // quads between camera and the end of a level's range
r0 = K * s ;  r[l] = r0 * 2^l
```

Example: H = 1440, f = 45 deg, tau = 3 px gives K = 579. Triangles per full annulus = 1.5 * pi * K^2 = 1.58 M; a 16:9 frustum sees about 20% of it (horizontal FOV 72.7 deg), so about 0.32 M triangles per level and at most about 2.7 M triangles with all 8 levels in view (camera on the ground in the middle of the terrain). An outside orbit view draws far fewer. These are [U] geometric estimates. For scale, the paper's Table 2 reports 380k to 446k rendered triangles at 520 to 760 fps on a GeForce 8800 GT and 1,198 to 1,629 fps on a Radeon HD 5870 (640x480 up to 1920x1200) [V].

Node bounds without a CPU copy of the heightfield:

1. Immediately after a height texture changes, use one conservative `[hmin, hmax]` for every node (the engine's declared height range, or the previous texture's bounds widened): slightly over-refined, never wrong.
2. A compute pass builds the min/max pyramid (needed anyway, e.4). Copy the level whose texels correspond to leaf nodes (level 6, 64 cells per texel: 127 x 127 `rg32float` = 129 KB at N = 8129) to a buffer and `mapAsync`. When it resolves (typically within a few frames [U]) switch to exact per-node bounds; coarser quadtree levels are derived on the CPU.

Extras: draw four side walls from the border samples down to a base plane for the "solid slab" look; draw the patch with `topology: 'line-list'` indices for a wireframe mode.

### e.4 Derived textures (compute and render passes that run when a displayed heightfield changes)

| Texture | Format, size | Built by | Used for |
|---|---|---|---|
| Min/max pyramid | `rg32float`, levels 1..L (level l texel = min and max over a block of `2^l` cells, where a cell's range is the range of its 4 corner samples, which bounds the bilinear patch) | Compute; one dispatch per level, or `webgpu-spd`-style single pass. Level size `ceil((N-1) / 2^l)`: 4064, 2032, 1016, 508, 254, 127, 64, 32, 16, 8, 4, 2, 1 for N = 8129. Odd sizes: clamp child coordinates. | Shadow ray-march skipping, picking, CDLOD bounds, global min/max for auto-levelling data views |
| Slope map | `rg16float` = (dh/dx, dh/dy) in metres per metre, with full mip chain; size `min(N, 4096)` by default | **Render passes** (fullscreen triangle per mip level), because `rg16float` is renderable and filterable in core WebGPU [R] but is not in the core storage-format list [V] | Per-pixel normals with trilinear + anisotropic filtering |
| Light map | `rgba8unorm` (R = soft sun visibility, G = ambient occlusion, B/A spare); size `min(N, 4096)`; mips | Compute with a write-only `rgba8unorm` storage texture; progressive (e.6) | Shading |
| Proxy heightfield | `r32float`, at most 1025 x 1025 (4.2 MB), read back to the CPU | Compute downsample + `copyTextureToBuffer` | Synchronous CPU picking, camera collision/focus, numeric readouts under the cursor |

Slope computation (central differences, cell size `c` metres, heights in metres):

```
sx = (h(x+1,y) - h(x-1,y)) / (2c) ;  sy = (h(x,y+1) - h(x,y-1)) / (2c)      // one-sided at borders
n  = normalize(vec3(-sx, -sy, 1))                                            // Z-up
```

A Sobel 3x3 kernel is the smoother alternative. Sample in the fragment shader with a sampler `{minFilter:'linear', magFilter:'linear', mipmapFilter:'linear', maxAnisotropy: 8}` (anisotropy above 1 requires all three filters to be linear [R]). Filtering slopes rather than unit normals keeps distant shading stable.

### e.5 Shading, sky, fog, water, tone mapping

Terrain fragment shader inputs: world position, slope map, light map, optional colour map (`rgba8unorm-srgb`, filterable), optional data map, sky LUTs.

```
N       = normalize(vec3(-slope.xy, 1))
sunVis  = lightmap.r ; ao = lightmap.g
albedo  = colourMap or clay (linear ~0.5 grey-beige) or colormapLUT(dataValue)
direct  = sunColor * max(dot(N, L), 0) * sunVis
ambient = mix(groundBounce, skyAmbient, N.z * 0.5 + 0.5) * ao
color   = albedo * (direct + ambient)
color   = applyHeightFog(color, camPos, worldPos)
```

**Sky**: Hillaire, "A Scalable and Production Ready Sky and Atmosphere Rendering Technique", EGSR 2020 (https://sebh.github.io/publications/egsr2020.pdf ; reference code, MIT: https://github.com/sebh/UnrealEngineSkyAtmosphere). From the reference source [V]: sky-view LUT **192 x 108** `R11G11B10_FLOAT` with a non-linear latitude mapping and 30 ray-march samples; multiple-scattering LUT **32 x 32** (20 samples, 8 x 8 = 64 directions); aerial-perspective froxel volume **32 x 32 x 32** `RGBA16F`; transmittance LUT integrated with 40 samples. The transmittance LUT size of 256 x 64 and the Earth coefficients (Rayleigh scattering (5.802, 13.558, 33.1) x 10^-6 m^-1 with 8 km scale height; Mie scattering 3.996 x 10^-6 and absorption 4.40 x 10^-6 m^-1 with 1.2 km scale height; ozone absorption (0.650, 1.881, 0.085) x 10^-6 m^-1; planet radius 6360 km, atmosphere top 6460 km) are [R] from the paper and must be checked against the PDF before use.

Editor-grade subset (recommended):

- Transmittance LUT 256 x 64 and multi-scattering LUT 32 x 32, `rgba16float`: compute once at start-up.
- Sky-view LUT 192 x 108, `rgba16float` (or `rg11b10ufloat` if `rg11b10ufloat-renderable` is present): recompute when the sun or camera altitude changes. That is 20,736 texels x 30 samples.
- Sky pixels: one LUT lookup plus an analytic sun disc. Sun colour for terrain lighting: transmittance LUT at the sun's elevation.
- Skip the froxel volume. Use analytic exponential height fog for aerial perspective.
- `webgpu-sky-atmosphere` 1.2.0 (MIT) is an existing WebGPU port; treat it as reference code rather than a dependency (no release since 2025-04; API fit [U]).
- Milestone-1 fallback: a two-colour gradient sky with a sun disc (20 lines of WGSL).

**Height fog** (closed form for density `rho(z) = rho0 * exp(-(z - z0) / Hf)`; ray from camera `o` along unit `d`, length `t`):

```
a = rho0 * exp(-(o.z - z0) / Hf)
opticalDepth = (abs(d.z) < 1e-4) ? a * t : a * Hf * (1 - exp(-d.z * t / Hf)) / d.z
fogAmount = 1 - exp(-opticalDepth)
color = mix(color, fogColor, fogAmount)        // fogColor: sky-view LUT at the horizon in the view azimuth
```

(Derivation is elementary; the same form appears in https://iquilezles.org/articles/fog/ [R].)

**Water plane** at `z = seaLevel`, drawn after the terrain with depth test on and depth write off, premultiplied-alpha blending. Because the height texture is available, water depth needs no depth-buffer read: `depthW = seaLevel - h(xy)`.

```
T        = exp(-absorb * depthW / max(refractedDir.z, 0.2))     // per channel; absorb ~ (0.45, 0.09, 0.06) per metre is a starting guess [U]
F        = F0 + (1 - F0) * pow(1 - max(dot(Nw, V), 0), 5)        // Schlick; F0 = 0.02 for water (n = 1.33)
reflect  = skyViewLUT(reflect(-V, Nw)) + sunGlint
out.rgb  = mix(deepColor * (1 - T), reflect, F) ; out.a = mix(1 - avg(T), 1, F)
foam     = 1 - smoothstep(0.0, 0.3, depthW)                     // shoreline band, metres
```

`Nw` is +Z perturbed by two small scrolling noise octaves (static is fine in an editor). Lake and river masks from simulation nodes are shown as data overlays, not through this plane.

**Tone mapping** (constants verified in three.js `tonemapping_pars_fragment.glsl.js`, dev branch 2026-10-12 [V], and for Neutral also in https://github.com/KhronosGroup/ToneMapping `pbrNeutral.glsl` [V]):

- Khronos PBR Neutral: `x = min(r,g,b); offset = x < 0.08 ? x - 6.25*x*x : 0.04; c -= offset; peak = max(r,g,b); if (peak < 0.76) return c; d = 0.24; newPeak = 1 - d*d / (peak + d - 0.76); c *= newPeak / peak; g = 1 - 1 / (0.15 * (peak - newPeak) + 1); return mix(c, vec3(newPeak), g)`.
- ACES Filmic (Hill fit): `c *= exposure / 0.6`; input matrix columns (0.59719, 0.07600, 0.02840), (0.35458, 0.90834, 0.13383), (0.04823, 0.01566, 0.83777); `RRTAndODTFit(v) = (v*(v + 0.0245786) - 0.000090537) / (v*(0.983729*v + 0.4329510) + 0.238081)`; output matrix columns (1.60475, -0.10208, -0.00327), (-0.53108, 1.10813, -0.07276), (-0.07367, -0.00605, 1.07602); clamp.
- AgX: inset matrix columns (0.856627153315983, 0.137318972929847, 0.11189821299995), (0.0951212405381588, 0.761241990602591, 0.0767994186031903), (0.0482516061458583, 0.101439036467562, 0.811302368396859); `AgxMinEv = -12.47393`, `AgxMaxEv = 4.026069`; contrast polynomial `15.5x^6 - 40.14x^5 + 31.96x^4 - 6.868x^3 + 0.4298x^2 + 0.1191x - 0.00232`; outset matrix columns (1.1271005818144368, -0.1413297634984383, -0.14132976349843826), (-0.11060664309660323, 1.157823702216272, -0.11060664309660294), (-0.016493938717834573, -0.016493938717834257, 1.2519364065950405); then `pow(max(c, 0), 2.2)`. three.js wraps this in linear-sRGB to Rec.2020 and back.

Recommendation: exposure in EV (`c *= 2^EV`), then **ACES Filmic for the "Realistic" style** (closest in spirit to Unreal's default filmic tone mapper [R]), **PBR Neutral for colour-map authoring** (leaves colours below 0.76 untouched), and **no tone mapping for data views**. Encode to sRGB in the shader, add +/- 0.5/255 of noise (interleaved gradient noise) to remove banding in sky gradients, and present to a canvas configured with `format: navigator.gpu.getPreferredCanvasFormat()`, `alphaMode: 'opaque'`.

**Data-map and colour-map overlays**: bind the selected node output as a second texture; `value = textureLoad(...)` with manual bilinear for `r32float`; map through a 256 x 1 colormap LUT (greyscale, red, blue, spectrum to mirror Gaea's mask palettes; add viridis and turbo); `albedo = mix(base, lutColor, opacity)`; "auto-level" uses the global min/max from the pyramid. Contour lines and grids are analytic: `g = h / interval; line = 1 - smoothstep(0, 1.5 * fwidth(g), abs(fract(g - 0.5) - 0.5))`. An Unreal component grid (every 127 or 254 quads for an 8129 landscape, per the UE 5.8 table) is a useful overlay for the target user.

### e.6 Sun shadows and ambient occlusion: bake to the light map

Rationale: camera moves vastly outnumber sun moves and terrain edits, so lighting belongs in a texture. Per frame the cost is then one filtered texture fetch, independent of terrain size. This is horizon-mapping thinking (Max 1988; Sloan and Cohen 2000) with a per-sun-direction bake instead of stored horizons. GPU heightfield self-shadowing references: Timonen and Westerholm, "Scalable Height Field Self-Shadowing", CGF 29(2) 2010 (horizon per azimuth in time linear in field size; 23 fps at 1024^2 with 64 directions on a GTX 280) [V abstract] (https://diglib.eg.org/handle/10.2312/CGF.v29i2pp723-731); Snyder and Nowrouzezahrai, "Fast Soft Self-Shadowing on Dynamic Height Fields", CGF 27(4) 2008 (multi-resolution pyramid for horizons) [V title/abstract]. Soft-shadow penumbra estimate from a single ray: Quilez, https://iquilezles.org/articles/rmshadows/ (`res = min(res, k*h/t)`, and Aaltonen's improved variant) [V].

Sun visibility per light-map texel (compute, tiled):

```
p0 = (x, y, h(x,y) + bias)                      // xy in texels, z in metres
d  = (sunDir.xy / |sunDir.xy|, tan(elev) * cell) // advance 1 texel horizontally per unit t; z in metres per texel
alpha = sun angular radius (true sun 0.27 deg; 1 to 3 deg looks nicer in an editor)
vis = 1 ; t = 1
while t < tMax:                                  // tMax = (hmaxGlobal - p0.z) / d.z
    // pyramid skip: at the coarsest level whose cell contains the ray position and satisfies
    //   rayZ_at_cell_entry - cellMax >= tan(alpha) * cell * t_exit   -> jump to the cell's exit
    // otherwise descend; at level 0:
    clearance = rayZ(t) - h_bilinear(p0.xy + d.xy * t)
    vis = min(vis, 0.5 + 0.5 * clearance / (tan(alpha) * cell * t))
    if vis <= 0: break
    t += 1
store saturate(vis)
```

AO per texel (uniform sky, cosine-weighted, surface approximated as horizontal): for each of `D` azimuths take the maximum slope to the horizon, then

```
tanH[phi] = max over samples i of max(0, (h(p + dir*r_i) - h(p)) / (r_i * cell))
AO        = (1/D) * sum over phi of 1 / (1 + tanH[phi]^2)          // = mean of cos^2(horizon angle)
```

The identity follows from integrating `cos(theta) sin(theta)` from the zenith down to the horizon elevation in each azimuth slice. Use `D = 8` to 16 directions (rotate the set per texel with a 4 x 4 pattern, then blur 4 x 4) and `S = 12` exponentially spaced radii `r_i = 1.6^i` texels (reaching about 280 texels); read the height for radius `r_i` from the *mean* of the pyramid at level `floor(log2(r_i))` to avoid aliasing. Store mean alongside min/max if this is used (pyramid becomes `rgba32float` or two textures).

Scheduling: run both bakes at 1/4 resolution first (1/16 of the work) for immediate feedback, then at full light-map resolution in tiles of 256 x 256 or 512 x 512 texels per submit. Sun drag: recompute only the visibility channel, at 1/4 resolution while dragging. Cost estimates for a 4096^2 light map (16.8 M texels; AO about 100 to 200 texture reads per texel): under about 1 s on the RTX 3080 and a few seconds on the GTX 1660 Ti, spread over many frames. **[U]: measure.**

### e.7 Camera conventions

World frame: adopt Unreal's frame so that what the user sees is what the landscape will be: **left-handed, Z up, +X forward, +Y right** [V] (https://dev.epicgames.com/documentation/en-us/unreal-engine/coordinate-system-and-spaces-in-unreal-engine , UE 5.8). Internal unit: metres (UE uses centimetres [R]; multiply on export). Heightfield column index maps to +X and row index to +Y; **[U]**: confirm the orientation by importing an asymmetric test heightmap into UE 5.8.

Projection: reverse-Z with an infinite far plane and a `depth32float` attachment (`depthCompare: 'greater'`, clear to 0). In view space looking down -Z, clip-space z in [0,1]:

```
f = 1 / tan(fovY / 2)
P = | f/aspect  0   0    0   |
    | 0         f   0    0   |
    | 0         0   0    near|
    | 0         0  -1    0   |        // ndc.z = near / (-z_view): 1 at the near plane, 0 at infinity
```

(Build it with `wgpu-matrix` 3.4.2 primitives or by hand; a left-handed view matrix only changes the view transform.) Near plane: `max(0.05 m, 0.001 * orbitDistance)`.

Navigation (support both families; they do not collide):

| Action | Binding | Origin |
|---|---|---|
| Orbit | Alt+LMB drag; also MMB drag | UE/Maya [V] (https://dev.epicgames.com/documentation/en-us/unreal-engine/viewport-controls-in-unreal-engine); Blender MMB [R] |
| Pan (track) | Alt+MMB drag; also Shift+MMB drag | UE/Maya [V]; Blender [R] |
| Dolly | Alt+RMB drag; mouse wheel (zoom toward the point under the cursor) | UE/Maya [V] |
| Fly | Hold RMB + W/A/S/D, Q down / E up; wheel while RMB is held changes speed | UE [V]; Gaea also uses WASD + Q/E [V] |
| Frame terrain / selection | F (and Space to centre, as in Gaea 1.3 docs [V]) | UE F [V] |
| Rotate sun | Shift+RMB drag (Substance Designer uses Ctrl+Shift+RMB for the environment [V] https://experienceleague.adobe.com/en/docs/substance-3d-designer/using/getting-started/shortcuts ) | choice |
| Top / front / side / ortho toggle | Numpad 7 / 1 / 3 / 5 | Blender [R] |

Orbit model: turntable. State `{pivot: vec3, yaw, pitch, distance}`; yaw about world Z, pitch clamped to [-89.9, +89.9] degrees; `distance *= exp(-wheelDelta * 0.0015)`; on orbit start set `pivot` to the picked point under the cursor (falls back to the terrain centre). Fly speed scales with terrain size; Shift x 3, Ctrl x 0.3.

### e.8 Picking the world position under the cursor

1. **Synchronous CPU pick against the proxy heightfield** (at most 1025^2, already read back): march the cursor ray across the grid (2D DDA, bilinear patch test below). Zero latency; accurate to about one proxy texel. Use it for hover readouts, orbit pivot, gizmo dragging.
2. **Exact GPU pick on demand** (click, measurement tool): a one-invocation compute shader marches the same ray through the min/max pyramid at full resolution and writes `{hit, worldPos, texel, height}` (32 bytes) to a storage buffer; `copyBufferToBuffer` then `mapAsync`. Latency is a few frames [U].

Depth-buffer readback is the weaker option here because the scene depth is multisampled (not copyable) and would need an extra resolve or a 1 x 1 scissored re-render.

Max-pyramid traversal (after Tevs et al. 2008 and Dick et al. 2009, section 3 [V]; adapted to vertex-centred, non-power-of-two fields):

```
// ray: o + t*d in texel units for xy, metres for z; clip to the box [0,N-1]^2 x [hmin,hmax] first
level = L - 1
loop (max 256 iterations):
    cell  = floor(p.xy / 2^level)                         // p = o + t*d
    tExit = min over axes a of ((cell[a] + (d[a] > 0 ? 1 : 0)) * 2^level - o[a]) / d[a]
    zMin  = min(p.z, o.z + tExit * d.z)
    cMax  = level == 0 ? max of the 4 corner heights : pyramid[level][cell].max
    if zMin > cMax:                                       // ray stays above everything in this cell
        t = tExit + eps
        if floor(p'.xy / 2^(level+1)) changed: level = min(level + 1, L - 1)     // ascend at parent borders
    else if level > 0: level -= 1                         // descend, keep t
    else:                                                 // leaf: intersect the bilinear patch
        solve a*s^2 + b*s + c = 0 on s in [0, tExit - t]  (u0,v0 = local entry coords; du,dv,dz = d)
            A = h10 - h00 ; B = h01 - h00 ; k = h00 - h10 - h01 + h11
            a = k*du*dv
            b = A*du + B*dv + k*(u0*dv + v0*du) - dz
            c = h00 + A*u0 + B*v0 + k*u0*v0 - z0
        if a root exists: return hit at t + s
        t = tExit + eps
```

Dick et al. start at the second-coarsest level and force the coordinate on the crossed texel edge to the exact integer to avoid infinite loops from round-off; do the same.

### e.9 Recommended pass structure

On "displayed heightfield changed" (per node output shown in the viewport):

| # | Pass | Type | Output |
|---|---|---|---|
| D1 | Min/max (+mean) pyramid | compute, one dispatch per level | `rg32float` mips |
| D2 | Slope map level 0, then mips | render (fullscreen triangle) | `rg16float` |
| D3 | Proxy 1025^2 + leaf-node min/max | compute, then `copyTextureToBuffer` + `mapAsync` | CPU arrays |
| D4 | Light-map bake: sun visibility, AO | compute, progressive tiles, coarse first | `rgba8unorm` storage (R, G used) + mips |

On "sun changed": D4 (visibility channel only) and S2. At start-up: S1.

| # | Pass | Type | Output |
|---|---|---|---|
| S1 | Transmittance 256 x 64, multi-scattering 32 x 32 | compute or render, once | `rgba16float` |
| S2 | Sky-view LUT 192 x 108 | compute or render | `rgba16float` |

Per rendered frame (only when dirty):

| # | Pass | Details |
|---|---|---|
| F0 | CPU: CDLOD select | Quadtree traversal, write the instance buffer (`device.queue.writeBuffer`), a few hundred instances at most |
| F1 | Main HDR pass | Colour `rgba16float`, 4x MSAA with `resolveTarget`; depth `depth32float` 4x, reverse-Z. Draw order: terrain (instanced CDLOD), side walls, sky (fullscreen triangle at ndc z = 0 with `depthCompare: 'equal'`, or drawn first without depth), water plane (blend, no depth write), 3D gizmos / bounds / grid / compass |
| F2 | Tone map + sRGB encode + dither | Fullscreen triangle from the resolved HDR texture to the canvas texture |
| F3 | LDR overlays | Selection outlines, 2D gizmo handles, measurement labels (or do these in DOM/SVG above the canvas) |
| P | Pick (on demand) | 1-invocation compute + 32-byte readback |

MSAA is optional (expose none / 4x; WebGPU supports sample counts 1 and 4 only [R]); when off, add FXAA in F2. `rgba16float` supports multisampling and resolve in core WebGPU [R]. The 2D viewport is a second pipeline on the same textures: orthographic, top-down, same shading or flat data view.

---

## (f) File formats in JS/TS

### f.1 Summary

| Format | Write | Read | Notes |
|---|---|---|---|
| PNG 16-bit grey (Unreal landscape) | **Custom streaming encoder on `node:zlib`** (about 80 lines, f.3) | `fast-png` 8.0.0 | UE 5.8 lists 16-bit grayscale PNG, 8-bit `.r8` and 16-bit `.r16` as heightmap formats [V] (https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-technical-guide-in-unreal-engine) |
| `.r16` / `.raw` | `fs.write` of a little-endian `Uint16Array` | `new Uint16Array(buffer)`; size must be supplied or inferred from a square file | f.4 |
| EXR 32-bit float (or half) | **Custom minimal scanline writer**: NONE / ZIPS / ZIP (f.5) | `parse-exr` 1.0.2 or three.js `EXRLoader` | no maintained standalone EXR writer on npm that I could find [U]; three.js `EXRExporter` is the reference |
| TIFF 16-bit / 32-bit float | **Custom baseline writer** (f.6) | `geotiff` 3.0.5 | also covers real-world DEM imports (GeoTIFF) |
| OBJ | Custom streaming text writer | not needed | f.7 |
| GLB | Custom binary writer; optional `@gltf-transform/core` 4.5.1 + `meshoptimizer` 1.3.0 post-processing | not needed | f.7 |

All custom writers depend only on `node:zlib` and `node:fs`, so the same code runs in the Electron main/utility process (Node 24.21 in Electron 44.7.0 [V]) and in the headless Node 26 CLI, with no native module to package.

### f.2 Getting 66 M samples off the GPU and onto disk

- Read back in **row bands** (for example 256 rows: 256 x 32,768 = 8.4 MB per band for `r32float` at N = 8129). A single full-image buffer does fit the default `maxBufferSize` (266.4 MB vs 268.4 MB, e.1) but leaves no margin, blocks the queue with one huge copy, and doubles peak memory.
- Pipeline per band: `copyTextureToBuffer` (with `origin.y` and `copySize.height` set to the band) then `mapAsync` then strip row padding (32,516 payload bytes of each 32,768-byte row) then post to the export process then quantise/convert then filter/compress then write. Apply back-pressure: wait for the writer's acknowledgement before mapping the next band. Reuse two staging buffers.
- Run the encoders outside the UI thread. Two workable hosts: an Electron `utilityProcess` fed through a `MessagePort` [R], or the main process's `worker_threads`. Cross-process messages copy the band; at 8 MB per band that is negligible [U]. In the CLI the same writer classes run in-process.
- Quantisation to 16 bits (CPU, in the export process): `u16 = clamp(round((h - hMin) / (hMax - hMin) * 65535), 0, 65535)`; `hMin`/`hMax` come from the min/max pyramid top level or from user-set "world height range".
- Unreal scale facts [V] (UE 5.8 Landscape Technical Guide): 16-bit heights map to -256 .. +255.992 units multiplied by the Z scale; Z scale 100 gives about +/-256 m; for a height range of `R` metres spread over the full 16 bits use `ZScale = R * 100 / 512` (= `R_cm * 0.001953125`). Recommended landscape sizes: 8129, 4033, 2017, 1009, 505, 253, 127 (8129 = 127 quads/section, 2x2 sections, 32 x 32 components). Derived [R]: world height in cm = `(u16 - 32768) / 128 * ZScale`, so placing `u16 = 0` at `hMin` needs actor Z = `hMin_cm + 256 * ZScale`. Write `ZScale` and the XY scale (`terrainWidth_cm / (N - 1)`) into a sidecar text/JSON file next to every export. See the sibling report `gaea-features.md` section (e) for the Gaea-to-Unreal conventions.

### f.3 PNG 16-bit greyscale at 8129 x 8129

Raw scanline data is `(1 + 2 * 8129) * 8129 = 132,169,411` bytes.

| Option | Version, licence, status | Assessment |
|---|---|---|
| `fast-png` | 8.0.0, MIT, 2025-12-18; pure JS on `fflate` (switched from pako in 8.0.0) [V] | Reads and writes 8/16-bit, 1 to 4 channels, palette, interlace, tEXt [V]. **Encoder weaknesses, verified in `src/png_encoder.ts`**: every scanline is written with filter type 0 (None); 16-bit samples are appended one at a time through an `IOBuffer`; the whole image is deflated with one synchronous `zlibSync` call (default `level: 3`) [V]. Unfiltered 16-bit terrain compresses poorly and the call blocks its thread for the whole image. Fine for decoding, small images, thumbnails. |
| `pngjs` | 7.0.0, MIT, 2023-02-20; repo last push 2024-03 [V] | Pure JS over Node zlib; supports 16-bit greyscale via `bitDepth`/`colorType` options [R]. Stale; slower than a purpose-built loop. |
| `upng-js` | 2.1.0, MIT, 2017 [V] | Unmaintained. |
| `sharp` | 0.35.5, Apache-2.0, 2026-09-27; Node >= 20.9 [V] | libvips; fast, multi-threaded. Raw input accepts `Uint16Array` with `raw: {width, height, channels: 1}`; default `limitInputPixels` is 268,402,689, above 66.1 M [V] (https://sharp.pixelplumbing.com/api-constructor/). The documented 16-bit path is `toColourspace('rgb16')`; greyscale 16-bit uses `toColourspace('grey16')`, which appears in sharp's issue tracker rather than the API page, and there are past 16-bit bugs (#3453, #3605, #3808, the last one milestone 0.33.0) [V]. **Bit-exact 16-bit grey output must be proven by a round-trip test before trusting it.** Native packaging cost: see f.8. No EXR support [V]. TIFF output options do not document 16-bit or float [V]. |
| `@napi-rs/image` | 1.15.0, MIT, 2026-09-17 [V] | Native (Rust). 16-bit greyscale encode support [U]. |
| `CompressionStream('deflate')` | Built into Chromium and Node [R] | Produces a zlib stream usable for IDAT without any library, off-thread, but with no compression-level control [R]. A fallback if the encoder ever has to run in the renderer. |
| **Custom on `node:zlib`** | Node built-in; `zlib.crc32(data[, value])` added in Node 22.2.0 / 20.15.0 [V] (https://nodejs.org/api/zlib.html) | **Pick.** Full control of filter, level, streaming and threading; no dependency; identical in Electron and the CLI. |

Encoder (streaming, one filter byte per row; samples big-endian as PNG requires [R]):

```ts
import { createDeflate, crc32 } from 'node:zlib';
import { createWriteStream, type WriteStream } from 'node:fs';
import { once } from 'node:events';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function chunk(type: string, data: Buffer): Buffer[] {
  const head = Buffer.allocUnsafe(8);
  head.writeUInt32BE(data.length, 0); head.write(type, 4, 4, 'latin1');
  const tail = Buffer.allocUnsafe(4);
  tail.writeUInt32BE(crc32(data, crc32(head.subarray(4, 8))) >>> 0, 0);   // CRC covers type + data
  return [head, data, tail];
}

export class Png16GrayWriter {
  private out: WriteStream; private z = createDeflate({ level: 3 }); private prev: Uint16Array;
  constructor(path: string, private w: number, private h: number) {
    this.out = createWriteStream(path); this.prev = new Uint16Array(w);         // row above row 0 is all zeros
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 16; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;         // 16-bit, greyscale, deflate, adaptive, no interlace
    this.out.write(SIG); for (const b of chunk('IHDR', ihdr)) this.out.write(b);
    this.z.on('data', (b: Buffer) => { for (const p of chunk('IDAT', b)) this.out.write(p); });
  }
  /** rows: k*w samples, top to bottom */
  async writeRows(rows: Uint16Array): Promise<void> {
    const w = this.w, k = rows.length / w, buf = Buffer.allocUnsafe(k * (1 + 2 * w));
    let o = 0;
    for (let y = 0; y < k; y++) {
      const cur = rows.subarray(y * w, (y + 1) * w), up = y === 0 ? this.prev : rows.subarray((y - 1) * w, y * w);
      buf[o++] = 2;                                                              // filter type 2 = Up
      for (let x = 0; x < w; x++) {
        const v = cur[x], u = up[x];
        buf[o++] = ((v >>> 8) - (u >>> 8)) & 255; buf[o++] = ((v & 255) - (u & 255)) & 255;
      }
    }
    this.prev = rows.slice((k - 1) * w, k * w);
    if (!this.z.write(buf)) await once(this.z, 'drain');
  }
  async end(): Promise<void> {
    this.z.end(); await once(this.z, 'end');
    for (const b of chunk('IEND', Buffer.alloc(0))) this.out.write(b);
    this.out.end(); await once(this.out, 'finish');
  }
}
```

This is untested reference code. Notes:

- Filter choice: Up (2) with a zero row above the first row is a reasonable fixed filter for smooth heightfields; Sub (1, `bpp = 2`) and Paeth (4) are the alternatives. Which wins on real terrain, and whether `strategy: zlib.constants.Z_FILTERED` or `Z_RLE` helps, is [U]: benchmark on an eroded 8129 terrain and fix the choice.
- Level: 1 to 3 for interactive export, 6 for "small file". Expected throughput and ratios are [U].
- Write no `gAMA`, `sRGB` or `iCCP` chunks for heightmaps; add a `tEXt` chunk with the height range if wanted.
- Optional multi-core path: split rows into bands, raw-deflate each band in a worker with a sync flush at the end, concatenate, and append one Adler-32 for the whole stream (the pigz technique) [R]; only worth it if single-thread time is a real complaint.
- Decode (import): `fast-png` 8.0.0 `decode(bytes)` returns `{width, height, depth, channels, data}` with `Uint16Array` data for 16-bit files [V]; it is ESM-only since 7.0.0 [V].

### f.4 `.r16` and `.raw`

- `.r16`: headerless, one unsigned 16-bit sample per vertex, row-major from the top row. Little-endian byte order is documented in the UDK-era page (https://docs.unrealengine.com/udk/Three/LandscapeCreating.html) [V]; the UE 5.8 page lists the format without restating endianness, so treat little-endian as [R] for 5.8. File size at 8129: 132,161,282 bytes.
- Write: on a little-endian host `fs.writeSync(fd, new Uint8Array(u16.buffer, u16.byteOffset, u16.byteLength))`; guard with an endianness check (`new Uint8Array(new Uint16Array([1]).buffer)[0] === 1`) and byte-swap otherwise.
- Read: file length must equal `2 * w * h`; when dimensions are not given, accept only perfect squares and otherwise ask the user.
- Float `.raw`/`.r32` (32-bit float, little-endian, headerless) is the same code with `Float32Array`; it is the lossless interchange format for other terrain tools.
- UE 5.8 also accepts RAW with a JSON sidecar that declares width, height and bit depth [V]; the sidecar's schema is [U].

### f.5 OpenEXR (32-bit float)

Layout verified against the official file-layout document [V] (https://openexr.com/en/latest/OpenEXRFileLayout.html):

```
magic      76 2F 31 01
version    02 00 00 00                       // version 2, single-part scanline, no flags
header     attributes: name\0 type\0 int32 size, value
  channels            chlist       per channel: name\0, int32 pixelType (0 UINT, 1 HALF, 2 FLOAT), uint8 pLinear,
                                   3 reserved bytes, int32 xSampling, int32 ySampling; then one \0
                                   (single channel "Y": 18 + 1 = 19 bytes)
  compression         compression  uint8: 0 NO, 1 RLE, 2 ZIPS, 3 ZIP, 4 PIZ, 5 PXR24, 6 B44, 7 B44A, 8 DWAA, 9 DWAB
  dataWindow          box2i        int32 xMin, yMin, xMax, yMax = 0, 0, w-1, h-1
  displayWindow       box2i        same
  lineOrder           lineOrder    uint8 0 (INCREASING_Y)
  pixelAspectRatio    float        1.0
  screenWindowCenter  v2f          0.0, 0.0
  screenWindowWidth   float        1.0
  \0                                          // end of header
offset table   one uint64 per chunk: absolute file offset of that chunk
chunks         int32 y (first scanline of the chunk), int32 dataSize, data
```

All values little-endian, no padding. Scanlines per chunk: 1 for NO/RLE/ZIPS, 16 for ZIP and PXR24, 32 for PIZ/B44/DWAA, 256 for DWAB. Inside a chunk, scanlines run top to bottom; within a scanline each channel's samples are contiguous, channels in alphabetical order. If a compressed chunk is not smaller than the raw data, the raw data is stored instead.

ZIP / ZIPS chunk compression (matches the reference library; direction of the two steps is [R], and three.js `EXRExporter` does the same with fflate [V]):

```
raw  = the chunk's scanline bytes (n bytes)
tmp  = [raw[0], raw[2], raw[4], ...] ++ [raw[1], raw[3], raw[5], ...]        // first half has ceil(n/2) bytes
for i = n-1 down to 1: tmp[i] = (tmp[i] - tmp[i-1] + 128) & 255               // delta predictor
z    = zlib.deflateSync(tmp, { level: 4 })                                    // zlib-wrapped stream
data = z.length < n ? z : raw
```

Recommendations:

- Channel name `Y` (single luminance channel), pixel type FLOAT; option for HALF (convert with `@petamoriken/float16` 3.9.3 or a native `Float16Array` where available [R]); option to write `R` instead, because some tools expect RGB [U which tools].
- Compression choices offered: NONE (fastest), ZIPS, ZIP (default). Do not implement PIZ/DWA writers; PXR24 and DWA are lossy for float data.
- Streaming: ZIP chunks are independent (16 rows each; 509 chunks at 8129 rows), so the writer can emit them band by band and patch the offset table at the end (or precompute nothing and seek back once).
- File size uncompressed at 8129: 264,322,564 bytes of pixels + 8 bytes per chunk + the offset table.
- Validation: read every written file back with `parse-exr`/`EXRLoader` in tests and compare bit-exactly; also open one in an external reader (oiiotool, Houdini, Blender).

Reading: three.js `EXRLoader` (dev branch, r186) lists NO, RLE, ZIPS, ZIP, PIZ, PXR24, B44, B44A, DWAA, DWAB and has tiled, multipart and deep-data code paths [V] (https://github.com/mrdoob/three.js/blob/dev/examples/jsm/loaders/EXRLoader.js). `parse-exr` 1.0.2 (MIT) is a dependency-light port of it: `parseExr(arrayBuffer, type?)` returns `{header, width, height, data, format, colorSpace}`; it requires Node >= 22 and depends on fflate [V] (https://github.com/dmnsgn/parse-exr). How far the port tracks the newest three.js loader is [U]; if a user file fails, fall back to vendoring the current three.js loader. `sharp` does not read or write EXR in its prebuilt binaries [V].

### f.6 TIFF (16-bit and 32-bit float)

Writing: a baseline little-endian TIFF is a header, the pixel strips and one IFD [R, TIFF 6.0]:

```
header   49 49 2A 00, uint32 offsetOfFirstIFD
strips   raw little-endian samples, RowsPerStrip rows each (for example 64)
IFD      uint16 entryCount, then 12-byte entries sorted by tag: uint16 tag, uint16 type (3 SHORT, 4 LONG), uint32 count, uint32 value-or-offset; then uint32 0
  256 ImageWidth  LONG w              257 ImageLength LONG h
  258 BitsPerSample SHORT 16 | 32     259 Compression SHORT 1 (none) | 8 (Deflate)
  262 PhotometricInterpretation SHORT 1 (BlackIsZero)
  273 StripOffsets LONG[nStrips]      277 SamplesPerPixel SHORT 1
  278 RowsPerStrip LONG               279 StripByteCounts LONG[nStrips]
  284 PlanarConfiguration SHORT 1     317 Predictor SHORT 1 | 2 (horizontal) | 3 (floating point), only when compressed
  339 SampleFormat SHORT 1 (unsigned int) | 3 (IEEE float)
```

Classic TIFF offsets are 32-bit (4 GiB limit); 8129^2 float is 264 MB, so BigTIFF is unnecessary. Ship uncompressed first, then Deflate per strip with `node:zlib` (predictors optional). Optional GeoTIFF tags (ModelPixelScale 33550, ModelTiepoint 33922) make exports open at the right scale in GIS tools [R].

Reading:

- `geotiff` 3.0.5 (MIT, 2026-03-11) [V]: strips and tiles; 8/16/32-bit integers and Float16/32/64; None, PackBits, LZW, Deflate (with horizontal or floating-point predictor), JPEG, LERC, Zstandard; limited BigTIFF; worker `Pool` for decoding; runs in Node and browsers. Its writer (`writeArrayBuffer`) is labelled beta and writes uncompressed only [V] (https://github.com/geotiffjs/geotiff.js). **Pick for import**, because users will bring real DEMs (SRTM, USGS, LiDAR-derived) as GeoTIFF.
- `tiff` 7.1.3 (image-js, MIT, 2025-12-18) [V]: decode only; 8/16/32-bit greyscale and RGB; LZW and Deflate; multi-page. Smaller and simpler, adequate for files written by other terrain tools.
- `utif2` 4.1.0 (2023) and `utif` 3.1.0 (2019) are stale [V].
- `sharp` can read TIFF [V] but would be a native dependency for one import path.

### f.7 Mesh export: OBJ and GLB

Vertex counts force limits; state them in the UI:

| Grid | Vertices | Triangles | GLB size (pos + normal + uv = 32 B/vertex, uint32 indices) | OBJ size [U] |
|---|---|---|---|---|
| 1025 | 1.05 M | 2.10 M | 59 MB | about 0.2 GB |
| 2049 | 4.20 M | 8.39 M | 235 MB | about 0.7 GB |
| 4097 | 16.8 M | 33.6 M | 940 MB | about 3 GB |
| 8129 | 66.1 M | 132 M | 3.70 GB (GLB's uint32 length caps a file at 4.29 GB) | impractical |

Default the mesh exporter to a decimated grid of at most 2049 with options for stride, tiling (K x K files) and adaptive simplification: `meshoptimizer` 1.3.0 `simplify` (MIT) [V version], or the heightfield-specific `delatin` 0.2.0 (Delaunay refinement to an error bound; ISC, 2019) and `@mapbox/martini` 0.2.0 (RTIN, needs 2^k + 1 grids; ISC, 2020) [V versions].

GLB container [R, glTF 2.0 specification section 4.4; https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html]:

```
header   uint32 magic 0x46546C67 ("glTF"), uint32 version 2, uint32 totalLength
chunk 0  uint32 length, uint32 type 0x4E4F534A ("JSON"), UTF-8 JSON padded with spaces to a multiple of 4
chunk 1  uint32 length, uint32 type 0x004E4942 ("BIN"),  binary padded with zeros to a multiple of 4
JSON     asset.version "2.0"; one buffer; bufferViews with target 34962 (vertex data) / 34963 (indices);
         accessors: POSITION / NORMAL float VEC3 (componentType 5126), TEXCOORD_0 float VEC2, indices 5125 (UNSIGNED_INT);
         the POSITION accessor must carry min and max
```

glTF is right-handed with +Y up [V], units are metres and front faces are counter-clockwise [R]. From Orogen's Unreal-style frame (left-handed, Z up) emit `(x, y, z)_gltf = (X, Z, Y)`; swapping two axes flips handedness, so check triangle winding in a viewer and after a UE 5.8 import [U]. Write the BIN chunk straight to a file descriptor in pieces; never assemble a multi-gigabyte `Buffer`. `@gltf-transform/core` 4.5.1 (MIT; `Document`, `NodeIO`) is the tool for post-processing (quantisation, meshopt compression, validation in tests), not a requirement for writing.

OBJ: `v x y z`, `vt u v`, `vn x y z`, then `f a/a/a b/b/b c/c/c` (1-based) or quads to halve the face lines. Stream it: V8's maximum string length is 536,870,888 characters (measured on Node 26.7.0 [V]), so build chunks of about 64k lines and write each with back-pressure. OBJ has no unit or up-axis convention; offer "Y up" (default) and "Z up".

### f.8 Native modules in Electron (only relevant if `sharp` is adopted)

From sharp's install guide [V] (https://sharp.pixelplumbing.com/install/): keep `sharp` external to the bundler (`build.rollupOptions.external: ['sharp']` for Vite); unpack it from the ASAR archive (electron-builder: `asarUnpack: ["**/node_modules/sharp/**/*", "**/node_modules/@img/**/*"]`; electron-forge: `packagerConfig.asar.unpack: "**/node_modules/{sharp,@img}/**/*"`); when building the Windows installer on Linux install the Windows binaries explicitly (`npm install --os=win32 --cpu=x64 sharp`, noting an npm lockfile bug with cross-platform optional dependencies); requires a Node-API v9 runtime (Node >= 20.9). The prebuilt Windows package is licensed "Apache-2.0 AND LGPL-3.0-or-later" because it bundles libvips [V], which adds notice and relinking obligations to the installer. Use it only in the main or utility process. These costs are the reason the custom writers are preferred.

---

## (g) UX conventions worth copying

### g.1 What the reference tools do (verified items)

**Gaea** (1.3 keyboard page [V] https://docs.quadspinner.com/Guide/Interface/Keyboard.html ; Gaea 2 UI overview [V] https://docs.gaea.app/ui ; more in the sibling report `gaea-features.md` section d):

- Graph: `Tab` quick node search; `Ctrl+0` zoom to fit; `F` pin node preview; `B` bypass; `Del` delete; `Ctrl+D` duplicate; `F2` rename; `F5` refresh node; `F3` mark for save/export; `Ctrl+R` reset node to defaults; `H` highlight the chain from the current node; `E` / `Shift+E` select descendants / ancestors; `F4` auto-layout selection; `Ctrl+P` convert a connection to a portal; `C` / `X` connect / disconnect menus; `F8` MultiMix selected nodes.
- App: `` ` `` suspend/resume the engine; `Esc` cancel preview build; `F6` toggle 2D viewport; `Ctrl+Shift+S` save incremental.
- Viewport: `W/A/S/D` move, `Q/E` up/down, `Space` centre the terrain; Gaea 2 modes Orbit, Free (WASD), Orthographic; preview resolution 512 to 4096; render styles realistic / clay / data; grid, bounds, compass toggles; camera save/load.
- Node categories (Gaea 2 reference [V] https://docs.gaea.app/reference): Primitive, Terrain, Modify, Surface, Simulate, Derive, Colorize, Output, Utility, Macro. **Gaea's actual node colours are [U]**; I found no published values.

**Houdini network editor** [V] (https://www.sidefx.com/docs/houdini/network/shortcuts.html , `/network/wire.html`, `/network/navigate.html`):

- `Tab` add node; clicking a connector then `Tab` creates an attached node; dropping a node on a wire inserts it; shaking a node disconnects it.
- Hold `Y` and drag across wires to cut; hold `J` and drag across nodes to connect.
- `Alt+click` a wire adds a dot (reroute); `Alt+click` a dot pins it.
- `Q` or `B` bypass; `R`, `E`, `T`, `W` other flags.
- `Shift+O` network box around the selection; `Shift+P` sticky note; `C` colour palette; `Z` shape palette.
- `A`+drag lays out upstream/downstream; `Shift+A` align; `H` frame all; `G` frame selected; `O` overview (minimap); `U` up; `I`/`Enter` dive in; `Ctrl+1..5` set quickmarks, `1..5` jump.
- MMB drag or `Space`+LMB pan; wheel zoom; MMB on a node shows its info window.

**Blender node editors** (Blender 5.2 manual [V] https://docs.blender.org/manual/en/latest/interface/controls/nodes/editing.html , `/nodes/parts.html`):

- `G` move; drag a node onto a link to insert (Alt toggles auto-attach); `Ctrl+RMB` drag cuts links; `Ctrl+Alt+RMB` drag mutes links; `Alt+LMB` drag detaches a node; `J` make links; hold Alt while dragging a link to swap.
- `Shift+D` duplicate; `Ctrl+C` / `Ctrl+V`; `X` or `Delete`; `Ctrl+Delete` delete with reconnect; `M` mute; `H` collapse; `Ctrl+H` hide unused sockets; `Shift+S` swap node type; `F` while dragging toggles frame membership; `Shift+Alt+LMB` connect to output.
- Sockets are coloured by data type (float light grey, colour yellow, vector dark blue, shader bright green, geometry sea green, boolean light pink, integer lime, string light blue) and shaped by structure (circle, diamond for fields).
- `Shift+A` add menu, `Ctrl+J` join in a frame, `Shift+RMB` drag to add a reroute [R].
- Default theme values, from `release/datafiles/userdef/userdef_default_theme.c` on `main` [V]: node editor background `#1a1a1a`, grid `#303030`, node body `#303030`, wire outline `#1a1a1a`, wire inner `#8d8d8d`, selected wire `#ffffffb3`, selected node outline `#ed5700`, active node `#ffffff`, node outline `#ffffff26`, `noodle_curving` 4. Header colours by class: input `#82354c`, output `#3e232a`, converter `#246283`, color `#6e6e23`, vector `#3c3c83`, texture `#79461d`, shader `#2b652b`, filter `#412b51`, group `#374725`, geometry `#1d725e`, attribute `#1d2546`, script `#203c3c`, frame `#0f0f0fcc`. Widgets: regular widget fill `#545454`, selected `#4772b3`, text `#e6e6e6`. 3D viewport background `#3d3d3d`, grid `#545454`, active object `#ffa028`.

**Substance 3D Designer** [V] (https://experienceleague.adobe.com/en/docs/substance-3d-designer/using/getting-started/shortcuts):

- Graph: `Space` node menu; MMB or `Ctrl+RMB` pan; wheel or `Alt+RMB` zoom; `F` fit; `Z` reset zoom; `D` dock/undock a node; `Shift+D` disable; `Ctrl+D` duplicate; `Ctrl+Shift+D` duplicate without links; `Backspace` delete and preserve links; `1`/`2`/`3` link-creation modes; `F2` cycle navigation pins.
- 3D view: LMB orbit, MMB (or `Ctrl+RMB`) pan, wheel (or `Alt+RMB`) dolly, `Ctrl+Shift+RMB` rotate the environment.

**Unreal Engine 5.8 viewport** [V] (https://dev.epicgames.com/documentation/en-us/unreal-engine/viewport-controls-in-unreal-engine): RMB + `W/A/S/D`, `Q` down / `E` up, `Z`/`C` FOV; RMB + wheel changes fly speed; `Alt+LMB` orbit, `Alt+RMB` dolly, `Alt+MMB` track; `F` focus; axis colours X red, Y green, Z blue. Blueprint graph habits [R]: RMB drag pans, RMB click opens the node palette, `C` wraps the selection in a comment box, double-clicking a wire adds a reroute node, `Alt+click` a pin breaks its links, `Ctrl+drag` moves links.

### g.2 Recommended Orogen conventions

Layout and flow: left-to-right graph (Gaea, Blender, Substance and Unreal all read horizontally; only Houdini is vertical), inputs on the left edge, outputs on the right, thumbnails inside nodes.

Colour scheme (a proposal built on the Blender values above; neutral, low-chroma chrome so terrain colours are judged correctly):

| Token | Value | Use |
|---|---|---|
| `bg.app` | `#1d1d1d` | window, gutters |
| `bg.panel` | `#303030` | panels, node bodies |
| `bg.graph` / `grid` | `#1a1a1a` / `#303030` | graph canvas, grid (minor lines at lower alpha) |
| `bg.widget` / `bg.widget.hover` | `#545454` / `#656565` | fields, buttons |
| `accent` | `#4772b3` | slider fill, focus, selected tab |
| `select` | `#ed5700` | selected node outline, selected wire glow (Unreal and Blender users both read orange as "selected") |
| `text` / `text.dim` | `#e6e6e6` / `#9a9a9a` | |
| `error` / `warn` / `ok` | `#d9534f` / `#e0a030` / `#5cb85c` | status dots |

Node header colours by category (proposal; dark, mid-saturation, same lightness band as Blender's):

| Category | Header | Rationale |
|---|---|---|
| Primitive | `#2b652b` | generators = green |
| Terrain | `#4f6a25` | landform starters, near Primitive |
| Modify | `#246283` | Blender "converter" blue |
| Surface | `#79461d` | texture-like detail = orange-brown |
| Simulate | `#1d725e` | teal; the expensive nodes should be recognisable |
| Derive (masks, data) | `#412b51` | purple |
| Colorize | `#6e6e23` | Blender "color" olive-yellow |
| Output | `#82354c` | red = leaves the graph |
| Utility | `#3a3a3a` | neutral |
| Macro / group | `#374725` | Blender "group" green |

Port and wire colours by data type (proposal): Height `#c7c7c7`, Mask `#7ac77a`, Colour `#c7c729`, Vector/flow `#6363c7`, Scalar `#a1a1a1`, Points/instances `#00d6a3`. Wires take the colour of their source port.

Wire style: horizontal cubic bezier (`getBezierPath`), 2 px, no arrowheads; 3 px with the `select` colour when selected; 40% opacity when the downstream node is bypassed; dashed for portal links; a thin animated dash only on wires feeding a node that is currently computing. Reroute dots 12 px.

Node anatomy: coloured header with icon, title and a status dot (idle, queued, running with a progress bar along the header's bottom edge, error); 96 px thumbnail; port rows with type-coloured dots and labels; footer line with resolution and last build time on hover. Badges: pinned preview (eye/lock), underlay, marked for export, bypassed (body dimmed and title struck through), cached/baked.

Keymap (graph focus unless noted):

| Key | Action | Borrowed from |
|---|---|---|
| `Tab`, RMB click on empty graph | Add-node search palette (name, aliases, short codes; `Enter` creates). Substance uses `Space` for this, but `Space` is reserved here for Space+LMB panning | Gaea, Houdini, Unreal |
| Drag from a port to empty space | Palette filtered to compatible nodes, auto-connect | Unreal, Blender |
| Drag a node onto a wire | Insert | Houdini, Blender, Gaea |
| `Alt+click` wire, double-click wire | Add reroute | Houdini, Unreal |
| `Y`+drag, `Ctrl+RMB` drag | Cut wires | Houdini, Blender |
| `Alt+click` port | Disconnect | Unreal |
| `B` | Bypass | Gaea, Houdini |
| `F` | Pin (lock) viewport preview to the node | Gaea |
| `G` | Use as underlay | Gaea 2 |
| `Ctrl+G`, `C` | Frame/group the selection | Gaea 2, Unreal |
| `Ctrl+D`; `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | Duplicate; clipboard | all |
| `Del`; `Backspace` | Delete; delete and reconnect | Substance |
| `F2`; `Ctrl+R`; `F5` | Rename; reset node; rebuild node | Gaea |
| `E` / `Shift+E`; `H` | Select downstream / upstream; highlight chain | Gaea |
| `Ctrl+0`, `Home` | Fit graph | Gaea |
| `F4`; `Shift+A` | Auto-layout selection; align | Gaea, Houdini |
| `O` | Toggle minimap | Houdini |
| `Ctrl+P`; `P` | Wire to portal; portal manager | Gaea |
| `F3` | Mark for export | Gaea |
| `` ` `` ; `Esc` | Suspend engine; cancel build / close popups | Gaea |
| `Ctrl+Z`; `Ctrl+Y`, `Ctrl+Shift+Z` | Undo; redo | all |
| `Ctrl+S`; `Ctrl+Shift+S` | Save; save incremental | Gaea |
| `F6` | Toggle 2D / 3D viewport | Gaea |
| `F1` or `Ctrl+Shift+P` | Command palette | Gaea 2 "Lazy Menu" on F1 |
| Viewport focus: `F`, `Space` | Frame terrain | Unreal, Gaea |
| Viewport focus: `W` / `E` / `R` (RMB not held) | Move / rotate / scale gizmo | Unreal [R] |

Make every binding data-driven (one keymap table, user-rebindable, shown in tooltips and the command palette).

Viewport gizmos and overlays:

- Position/size gizmos for parametric features (mountain centre, island shape, crop region, mask shapes): draggable handles in the 2D view and a ground-following handle in 3D (drag = CPU pick against the proxy heightfield). Gaea 2.3 added 2D gizmos for node positions (sibling report).
- Sun gizmo: a compass ring with a draggable sun marker (azimuth, elevation), plus Shift+RMB drag anywhere.
- Always-available overlays: bounds box with dimensions in metres, compass/north arrow, axis triad in Unreal colours, scale bar, sea-level plane toggle, contour lines, Unreal component grid, measurement tool (two clicks: 2D distance, 3D distance, height difference), height readout under the cursor (metres, percent, raw 0..1; Gaea's "Height Picker").
- Gizmos keep constant screen size, draw after the terrain with a dimmed pass where occluded, and hit-test on the CPU.

---

## Risks, unknowns and spike tests

Spike tests to run before building on these choices:

1. **React Flow at scale**: 400 nodes, 600 wires, a 128 px canvas per node; pan, zoom, drag; `onlyRenderVisibleElements` on and off; both machines (a.8).
2. **WebGPU in Electron 44 on the Linux dev box**: does `navigator.gpu.requestAdapter()` succeed on NVIDIA/X11 without flags in Chromium 152? If not, test `app.commandLine.appendSwitch('enable-unsafe-webgpu')` and `('enable-features', 'Vulkan')`. Current default status on Linux is [U]; the public gpuweb implementation-status wiki still described Linux as flag-gated when I checked, without a date.
3. **Shared device contention**: run a long erosion compute while orbiting; find the chunk size that keeps frames under 16 ms.
4. **CDLOD**: validate crack-free morphing with the clamped power-of-two quadtree on an 8129 texture and `textureLoad`-only sampling; count triangles and time F1 on the GTX 1660 Ti at 1080p and the RTX 3080 at 1440p/4K.
5. **Light-map bake cost** at 4096^2 and at 1/4 resolution on both GPUs.
6. **PNG16 export**: time and size for Up vs Sub vs Paeth, levels 1/3/6, default vs `Z_FILTERED`, on a real eroded 8129 terrain; then import into UE 5.8 and compare heights.
7. **EXR and TIFF round-trips** through `parse-exr`/`geotiff` and one external tool each.
8. **Heightmap orientation and winding** in UE 5.8 with an asymmetric test pattern (PNG, R16, GLB).
9. **dockview popout** with a WebGPU canvas inside Electron.

Open items carried as [U] in the text: React Flow 13 breaking changes; dockview export names in 8.x typings; `float32-filterable` availability on both GPUs (design does not depend on it); whether `textureGather` is usable on `r32float` with a non-filtering sampler; exact Hillaire constants and the 256 x 64 transmittance size; Gaea's real node colours; UE RAW JSON sidecar schema; `.r16` endianness wording in 5.8 docs; licence status of the litegraph sub-tree inside the GPL ComfyUI_frontend repo.

## Source index

Node graph: https://reactflow.dev/whats-new , https://reactflow.dev/api-reference , https://reactflow.dev/api-reference/react-flow , https://reactflow.dev/api-reference/types/react-flow-instance , https://reactflow.dev/api-reference/components/minimap , https://reactflow.dev/examples , https://reactflow.dev/pro , https://reactflow.dev/learn/advanced-use/performance , https://reactflow.dev/learn/layouting/sub-flows , https://reactflow.dev/learn/customization/handles , https://reactflow.dev/learn/troubleshooting/common-errors , https://github.com/xyflow/xyflow/issues/967 , https://retejs.org/docs/ , https://github.com/Comfy-Org/litegraph.js , https://docs.comfy.org/interface/nodes-2 , https://github.com/newcat/baklavajs

Docking: https://github.com/dockview/dockview , https://dockview.dev/docs/overview/licence , https://dockview.dev/docs/releases/whats-new/whats-new-v8 , https://dockview.dev/docs/core/panels/rendering , https://dockview.dev/docs/core/groups/popoutGroups , https://github.com/caplin/FlexLayout , https://github.com/ticlo/rc-dock , https://github.com/golden-layout/golden-layout

State: https://immerjs.github.io/immer/patches/ , https://github.com/immerjs/immer/releases , https://github.com/charkour/zundo , https://docs.yjs.dev/api/undo-manager

Widgets: https://base-ui.com/react/components/number-field , https://github.com/pmndrs/leva , https://www.electronjs.org/docs/latest/api/session , https://docs.blender.org/manual/en/latest/interface/controls/buttons/fields.html

Rendering: https://www.w3.org/TR/webgpu/ , https://developer.mozilla.org/en-US/docs/Web/API/GPUSupportedLimits , https://developer.mozilla.org/en-US/docs/Web/API/GPUSupportedFeatures , https://developer.chrome.com/blog/new-in-webgpu-119 , https://developer.chrome.com/blog/new-in-webgpu-142 , https://webgpufundamentals.org/webgpu/lessons/webgpu-storage-textures.html , https://webgpufundamentals.org/webgpu/lessons/webgpu-multiple-canvases.html , https://developer.mozilla.org/en-US/docs/Web/API/GPUCommandEncoder/copyTextureToBuffer , https://developer.mozilla.org/en-US/docs/Web/API/WorkerNavigator/gpu , https://github.com/fstrugar/CDLOD (paper PDF in repo) , https://www.cs.cit.tum.de/fileadmin/w00cfj/cg/Research/Publications/2009/GPU_Ray-Casting/EG09AreasTerrain.pdf , https://pure.mpg.de/pubman/item/item_1325622_5/component/file_3590464/i3d08.pdf (Tevs et al.; server refused the fetch, cited through Dick et al.) , https://developer.nvidia.com/gpugems/gpugems2/part-i-geometric-complexity/chapter-2-terrain-rendering-using-gpu-based-geometry (not fetched) , https://mikejsavage.co.uk/geometry-clipmaps/ , https://sebh.github.io/publications/egsr2020.pdf (too large to fetch; constants taken from https://github.com/sebh/UnrealEngineSkyAtmosphere source) , https://diglib.eg.org/handle/10.2312/CGF.v29i2pp723-731 , https://iquilezles.org/articles/rmshadows/ , https://github.com/mrdoob/three.js/blob/dev/src/renderers/shaders/ShaderChunk/tonemapping_pars_fragment.glsl.js , https://github.com/KhronosGroup/ToneMapping , https://dev.epicgames.com/documentation/en-us/unreal-engine/viewport-controls-in-unreal-engine , https://dev.epicgames.com/documentation/en-us/unreal-engine/coordinate-system-and-spaces-in-unreal-engine , https://docs.gaea.app/ui

Files: https://github.com/image-js/fast-png (`src/png_encoder.ts`, `CHANGELOG.md`) , https://sharp.pixelplumbing.com/api-constructor/ , https://sharp.pixelplumbing.com/api-output/ , https://sharp.pixelplumbing.com/install/ , https://github.com/lovell/sharp/issues/3808 , https://nodejs.org/api/zlib.html , https://openexr.com/en/latest/OpenEXRFileLayout.html , https://github.com/mrdoob/three.js/blob/dev/examples/jsm/exporters/EXRExporter.js , https://github.com/mrdoob/three.js/blob/dev/examples/jsm/loaders/EXRLoader.js , https://github.com/dmnsgn/parse-exr , https://github.com/geotiffjs/geotiff.js , https://github.com/image-js/tiff , https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html , https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-technical-guide-in-unreal-engine , https://docs.unrealengine.com/udk/Three/LandscapeCreating.html

UX: https://docs.quadspinner.com/Guide/Interface/Keyboard.html , https://docs.quadspinner.com/Guide/Interface/Getting-around.html , https://docs.gaea.app/ui , https://docs.gaea.app/reference , https://www.sidefx.com/docs/houdini/network/shortcuts.html , https://www.sidefx.com/docs/houdini/network/wire.html , https://www.sidefx.com/docs/houdini/network/navigate.html , https://docs.blender.org/manual/en/latest/interface/controls/nodes/editing.html , https://docs.blender.org/manual/en/latest/interface/controls/nodes/parts.html , Blender source `release/datafiles/userdef/userdef_default_theme.c` and `source/blender/makesrna/intern/rna_userdef.cc` (main branch) , https://experienceleague.adobe.com/en/docs/substance-3d-designer/using/getting-started/shortcuts

