// A node of the graph: the header in the colour of its category, its ports, a thumbnail and a status line
// (runtime.md 8.7). What the node shows of the document comes in its `data`, made by flow.ts; what the engine
// reports of it the node reads itself from engineStore, by its id (8.5), so that a progress event of one node
// renders one node. The thumbnail is drawn into a 2D canvas through a ref and is in no state at all.

import { Handle, Position, type NodeProps } from '@xyflow/react';
import { memo, useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import type { EngineSession } from '../../../core/runtime.ts';
import { thumbnails as applicationThumbnails, THUMBNAIL_SIZE as THUMBNAIL_PIXELS, type ThumbnailCache } from '../../engine/thumbnails.ts';
import type { EngineState } from '../../state/engine-store.ts';
import { Icon, TextField, Tooltip, useApp, useCommandContext } from '../../ui/index.ts';
import { renameNode, TITLE_MAX_LENGTH } from './actions.ts';
import { isCurrent, isPaused, isStale, nodeFeed, runtimeOf } from './engine-feed.ts';
import type { NodeView, PortView } from './flow.ts';
import { BORDER, portY } from './geometry.ts';
import styles from './graph.module.css';
import { nodeTitle, own } from './model.ts';
import { graphHost, graphStore } from './state.ts';
import { nodeStatus } from './status.ts';

/** The cache the engine client fills (8.5): the client's own when it names one, else the application's. */
export function thumbnailsOf(engine: EngineSession): ThumbnailCache {
  const held = (engine as { readonly thumbnails?: ThumbnailCache }).thumbnails;
  return held ?? applicationThumbnails;
}

/**
 * What engineStore holds of one node, kept current: the component renders again when `read` gives another value
 * for this node, and is not even asked when an event concerns other nodes (engine-feed.ts).
 */
function useNodeEngine<T>(store: StoreApi<EngineState>, id: string, read: (state: EngineState, id: string) => T): T {
  const subscribe = useCallback((listener: () => void) => nodeFeed(store).subscribe(id, listener), [store, id]);
  return useSyncExternalStore(subscribe, () => read(store.getState(), id));
}

const CANVAS_SETTINGS: CanvasRenderingContext2DSettings = { willReadFrequently: true };

/** The last image of the node, drawn when the cache says there is another. */
const Thumbnail = memo(function Thumbnail(props: { readonly id: string }) {
  const { id } = props;
  const { engine, engineState } = useCommandContext();
  const canvas = useRef<HTMLCanvasElement>(null);
  const stale = useNodeEngine(engineState, id, isStale);

  useEffect(() => {
    const cache = thumbnailsOf(engine);
    const element = canvas.current;
    const draw = (): void => {
      const entry = cache.get(id);
      if (!element) return;
      if (!entry) {
        // The cache gave the image up (another project's node of this id, 8.5): nothing of it stays on the canvas.
        if (element.parentElement?.getAttribute('data-thumbnail') === 'drawn') {
          element.getContext('2d', CANVAS_SETTINGS)?.clearRect(0, 0, element.width, element.height);
          element.parentElement.setAttribute('data-thumbnail', 'empty');
        }
        return;
      }
      // Kept in main memory: a canvas kept by the GPU is emptied when the GPU process goes (runtime.md 7.8), and
      // the engine sends a thumbnail once for a content key (5.12), so nothing would fill it again.
      element.getContext('2d', CANVAS_SETTINGS)?.putImageData(entry.image as ImageData, 0, 0);
      element.parentElement?.setAttribute('data-thumbnail', 'drawn');
    };
    draw();
    // A canvas that was emptied all the same is drawn again from the cache.
    element?.addEventListener('contextrestored', draw);
    const stop = cache.subscribe(id, draw);
    return () => {
      stop();
      element?.removeEventListener('contextrestored', draw);
    };
  }, [engine, id]);

  return (
    <div className={styles.thumbnail} data-thumbnail="empty" data-stale={stale ? '' : undefined}>
      <canvas ref={canvas} width={THUMBNAIL_PIXELS} height={THUMBNAIL_PIXELS} />
    </div>
  );
});

/**
 * The field a name is typed into. Enter takes the text, Escape leaves the name as it was, and so does nothing
 * but leaving the field: a window that is not in front sends no focus events (testing.md 8.5).
 */
export function RenameField(props: { readonly value: string; readonly label: string; onDone(text: string | null): void }) {
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const finish = (text: string | null): void => {
    if (done.current) return;
    done.current = true;
    props.onDone(text);
  };
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  return (
    <TextField
      ref={input}
      className={`${styles.rename} nodrag nopan`}
      aria-label={props.label}
      data-graph="rename"
      maxLength={TITLE_MAX_LENGTH}
      value={props.value}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          finish(event.currentTarget.value);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish(null);
        }
      }}
      onBlur={(event) => finish(event.currentTarget.value)}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    />
  );
}

const SHOWN_TEXT = { terrain: 'Shown as the terrain', overlay: 'Shown over the terrain', both: 'Shown as the terrain and over it' } as const;

function Port(props: { readonly port: PortView }) {
  const { port } = props;
  return (
    <div
      className={styles.port}
      data-port={port.name}
      data-connected={port.connected ? '' : undefined}
      data-optional={port.optional ? '' : undefined}
      data-missing={port.missing ? '' : undefined}
    >
      <span className={styles.portLabel} title={port.missing ? `${port.label}: nothing is connected` : port.label}>{port.label}</span>
    </div>
  );
}

const TONE_TEXT = { height: 'a terrain', mask: 'a mask', data: 'data', color: 'a color', any: null } as const;

/** What the pointer shows on the dot of a port: its name, what it carries, and what is amiss. Zoomed out, the labels are not drawn. */
function portTitle(port: PortView, side: 'in' | 'out'): string {
  const carried = TONE_TEXT[port.tone];
  const what = carried === null ? port.label : `${port.label}: ${carried}`;
  if (port.missing) return `${what}; nothing is connected`;
  return side === 'in' && port.optional ? `${what} (optional)` : what;
}

function PortHandle(props: { readonly port: PortView; readonly side: 'in' | 'out' }) {
  const { port, side } = props;
  return (
    <Handle
      id={port.handle}
      title={portTitle(port, side)}
      type={side === 'in' ? 'target' : 'source'}
      position={side === 'in' ? Position.Left : Position.Right}
      className={styles.handle}
      style={{ top: portY(port.row) }}
      data-tone={port.tone}
      data-port={port.name}
      data-side={side}
      data-connected={port.connected ? '' : undefined}
      data-optional={port.optional ? '' : undefined}
      data-missing={port.missing ? '' : undefined}
    />
  );
}

const NodeBody = memo(function NodeBody(props: { readonly view: NodeView; readonly selected: boolean }) {
  const { view, selected } = props;
  const app = useApp();
  const ctx = app.ctx;
  const runtime = useNodeEngine(ctx.engineState, view.id, runtimeOf);
  const current = useNodeEngine(ctx.engineState, view.id, isCurrent);
  const paused = useNodeEngine(ctx.engineState, view.id, isPaused);
  const upstream = runtime?.upstream ?? null;
  const upstreamTitle = useStore(ctx.doc, (state) => {
    const node = upstream === null ? undefined : own(state.doc.nodes, upstream);
    return node ? nodeTitle(node, ctx.registry.get(node.type)) : null;
  });
  const renaming = useStore(graphStore, (state) => state.renaming?.kind === 'node' && state.renaming.id === view.id);
  const status = nodeStatus(view, runtime, current, upstreamTitle, paused);
  const hasBody = view.inputs.length > 0 || view.outputs.length > 0 || view.thumbnail;

  // The line is cut where the node ends: the pointer shows the whole of it.
  const statusLine = <span className={styles.status} data-role="status" title={status.detail === null && status.text !== '' ? status.text : undefined}>{status.text}</span>;
  return (
    <div
      className={styles.node}
      data-node={view.id}
      data-type={view.type}
      data-category={view.category ?? undefined}
      data-status={status.state}
      data-selected={selected ? '' : undefined}
      data-failed={status.failed ? '' : undefined}
      data-bypassed={view.bypassed ? '' : undefined}
      data-shown={view.shown ?? undefined}
      data-locked={view.locked ? '' : undefined}
    >
      <div className={styles.header}>
        {renaming ? (
          <RenameField
            value={view.title}
            label="Node name"
            onDone={(text) => {
              graphStore.setState({ renaming: null });
              if (text !== null) renameNode(ctx, view.id, text);
              graphHost()?.focus();
            }}
          />
        ) : (
          <span
            className={styles.title}
            data-role="title"
            title={view.title === view.typeTitle ? view.title : `${view.title} (${view.typeTitle})`}
            onDoubleClick={(event) => {
              event.stopPropagation();
              graphStore.setState({ renaming: { kind: 'node', id: view.id } });
            }}
          >
            {view.title}
          </span>
        )}
        <span className={styles.badges}>
          {view.bypassed ? <span className={styles.badge} data-badge="bypass" title={`Bypassed: the first input passes through (${app.keyLabel('graph.toggleBypass') ?? 'no key'})`}>Off</span> : null}
          {view.shown ? (
            <Tooltip content={view.locked ? `${SHOWN_TEXT[view.shown]}; the view is locked to this node` : SHOWN_TEXT[view.shown]} keyLabel={view.locked ? app.keyLabel('graph.toggleViewLock') : null} side="top">
              <span className={styles.badge} data-badge="shown" data-shown={view.shown}><Icon name={view.locked ? 'lock' : 'eye'} /></span>
            </Tooltip>
          ) : null}
          {status.failed ? (
            <Tooltip content={status.detail ?? status.text} side="top">
              <span className={styles.badge} data-badge="error"><Icon name="error" /></span>
            </Tooltip>
          ) : null}
        </span>
        {status.fraction !== null ? <div className={styles.progress} data-role="progress" style={{ transform: `scaleX(${status.fraction})` }} /> : null}
      </div>
      {hasBody ? (
        <div className={styles.body}>
          <div className={styles.ports} data-side="in" style={{ flexBasis: view.inputColumn - BORDER }}>{view.inputs.map((port) => <Port key={port.name} port={port} />)}</div>
          {view.thumbnail ? <Thumbnail id={view.id} /> : null}
          <div className={styles.ports} data-side="out">{view.outputs.map((port) => <Port key={port.name} port={port} />)}</div>
        </div>
      ) : null}
      <div className={styles.footer}>
        <span className={styles.dot} />
        {status.detail ? <Tooltip content={status.detail} side="bottom">{statusLine}</Tooltip> : statusLine}
      </div>
      {view.inputs.map((port) => <PortHandle key={port.handle} port={port} side="in" />)}
      {view.outputs.map((port) => <PortHandle key={port.handle} port={port} side="out" />)}
    </div>
  );
});

/**
 * What the library mounts for a node. It is rendered again for every pixel a node is dragged, because the
 * library passes it the position; the body below it is not.
 */
export const TerrainNode = memo(function TerrainNode(props: NodeProps) {
  return <NodeBody view={props.data as unknown as NodeView} selected={props.selected === true} />;
});
