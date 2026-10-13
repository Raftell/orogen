// The viewport panel's component: the canvas the engine worker draws to, the toolbar, and what lies over the
// picture. The picture itself is made in the worker (runtime.md 7.5): this file owns the camera and the display
// options, turns the pointer into changes of them, and says what is shown.
//
// A camera that moves changes no React state: the store tells the engine, and the root's `data-camera` is
// written beside it. The component renders when the status, the readout or a display option changes.

import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';

import type { PickResult } from '../../../core/runtime.ts';
import { EmptyState, useApp } from '../../ui/index.ts';
import { frameTerrain, terrainOf } from './commands.ts';
import {
  centerOrbit, centerTop, dollyDrag, dolly, dragKind, dragSun, fly, flyKeys, flySpeed, isBlank, look, metres, orbit, outputTitle, pan, panTop, STATUS_TEXT,
  viewStatus, wheelFactor, zoomTop, type DragKind, type NodeState, type ViewStatus,
} from './model.ts';
import { cameraOf, untouched, viewportStore } from './state.ts';
import { Toolbar } from './Toolbar.tsx';
import styles from './viewport.module.css';

/** How often the camera moves while it flies. A timer, not an animation frame: the page's fire once a second in a window that is not shown. */
const FLY_INTERVAL_MS = 16;
const FLY_CODES: ReadonlySet<string> = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE']);

interface Drag {
  readonly kind: DragKind;
  readonly pointerId: number;
  x: number;
  y: number;
}

export function ViewportPanel() {
  const app = useApp();
  const { engine, engineState, doc, registry } = app.ctx;
  const root = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [readout, setReadout] = useState<PickResult | null>(null);
  const [dragging, setDragging] = useState<DragKind | null>(null);

  // ---- the canvas -----------------------------------------------------------------------------------------------------
  useEffect(() => {
    const element = host.current;
    if (!element) return undefined;
    let observer: ResizeObserver | null = null;
    const sizeOf = (): { width: number; height: number; dpr: number } => {
      const rect = element.getBoundingClientRect();
      return { width: Math.max(1, rect.width), height: Math.max(1, rect.height), dpr: window.devicePixelRatio || 1 };
    };
    // The size the engine is told is said on the root as well: a test waits for it, since the observer is late in a window that is not shown.
    const measured = (): { width: number; height: number; dpr: number } => {
      const size = sizeOf();
      const state = viewportStore.getState();
      if (state.width !== size.width || state.height !== size.height) viewportStore.setState({ width: size.width, height: size.height });
      root.current?.setAttribute('data-size', `${Math.round(size.width)} ${Math.round(size.height)}`);
      return size;
    };
    // A new canvas element each time: its control goes to the worker and cannot be taken back (7.5 rule 8).
    function attach(): void {
      const canvas = document.createElement('canvas');
      canvas.className = styles.canvas!;
      element!.replaceChildren(canvas);
      engine.viewport.attach(canvas.transferControlToOffscreen(), measured());
      observer?.disconnect();
      observer = new ResizeObserver(() => engine.viewport.resize(measured()));
      observer.observe(element!);
    }
    attach();
    // 7.8 rule 6: a canvas transferred before the device was lost presents nothing drawn on the new device.
    let lost = false;
    const stop = engine.subscribe((event) => {
      if (event.type === 'device-lost') lost = true;
      if (event.type === 'device-ready' && lost) {
        lost = false;
        attach();
      }
    });
    // 8.5: a `device` that is 'starting' again is the device of another engine worker. The canvas went with the old one.
    const stopStore = engineState.subscribe((next, previous) => {
      if (next.device !== previous.device && next.device.state === 'starting') {
        lost = false;
        attach();
      }
    });
    return () => {
      stop();
      stopStore();
      observer?.disconnect();
      engine.viewport.detach();
      element.replaceChildren();
    };
  }, [engine, engineState]);

  // ---- the camera and the display, as the engine is told them ---------------------------------------------------------
  useEffect(() => {
    const say = (state: ReturnType<typeof viewportStore.getState>): void => root.current?.setAttribute('data-camera', JSON.stringify(cameraOf(state)));
    const first = viewportStore.getState();
    engine.viewport.setDisplay(first.display);
    engine.viewport.setCamera(cameraOf(first));
    say(first);
    return viewportStore.subscribe((next, previous) => {
      if (next.display !== previous.display) engine.viewport.setDisplay(next.display);
      if (cameraOf(next) !== cameraOf(previous)) {
        engine.viewport.setCamera(cameraOf(next));
        say(next);
      }
    });
  }, [engine]);

  // A project of another size is another terrain to look at: both cameras are framed for it.
  useEffect(() => {
    const look = (): void => {
      const terrain = terrainOf({ doc });
      const { framed } = viewportStore.getState();
      if (framed && framed.terrainSize === terrain.terrainSize && framed.heightRange === terrain.heightRange) return;
      frameTerrain({ doc, engine });
    };
    look();
    return doc.subscribe((next, previous) => { if (next.doc.settings !== previous.doc.settings) look(); });
  }, [doc, engine]);

  // The canvas got another shape: a camera that no hand has moved since it was framed follows it, with what is
  // known of the terrain's heights. The engine is not asked: a divider that is dragged passes through many shapes.
  const aspect = useStore(viewportStore, (state) => Math.round((100 * state.width) / Math.max(1, state.height)));
  useEffect(() => {
    frameTerrain({ doc, engine }, untouched(viewportStore.getState()), false);
  }, [aspect, doc, engine]);

  // ---- the pointer ----------------------------------------------------------------------------------------------------
  useEffect(() => {
    const element = host.current;
    if (!element) return undefined;
    let drag: Drag | null = null;
    const held = new Set<string>();
    let flying: ReturnType<typeof setInterval> | null = null;
    let last = 0;
    let gear = 1;
    let mods = { shift: false, ctrl: false };
    /** The pointer's place over the canvas, in CSS pixels; null while it is elsewhere. */
    let hover: { x: number; y: number } | null = null;
    /** A question is out; `again`: the pointer or the picture has moved on since it was asked. */
    let picking = false;
    let again = false;
    let picked: { readonly at: { x: number; y: number }; readonly result: PickResult | null } | null = null;
    let alive = true;

    const place = (event: MouseEvent): { x: number; y: number } => {
      const rect = element.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    /**
     * Asks what lies under the pointer, one question at a time. An answer that the pointer or the picture has
     * outrun is not shown, and the question is asked again; what was read before stays until the new answer is in.
     */
    function pick(): void {
      if (!hover || drag) return;
      if (picking) {
        again = true;
        return;
      }
      const asked = hover;
      picking = true;
      again = false;
      engine.viewport.pick(asked.x, asked.y).then((result) => result, () => null).then((result) => {
        picking = false;
        if (!alive) return;
        if (again || drag || !hover || hover.x !== asked.x || hover.y !== asked.y) {
          pick();
          return;
        }
        picked = { at: asked, result };
        setReadout(result);
      });
    }
    function forget(): void {
      picked = null;
      setReadout(null);
    }

    function stopFlying(): void {
      if (flying !== null) clearInterval(flying);
      flying = null;
      held.clear();
    }
    function startFlying(): void {
      last = performance.now();
      flying = setInterval(() => {
        const now = performance.now();
        const seconds = Math.min(0.1, (now - last) / 1000);
        last = now;
        const state = viewportStore.getState();
        const moved = fly(state.orbit, flyKeys(held), flySpeed(terrainOf({ doc }), mods, gear), seconds);
        if (moved !== state.orbit) viewportStore.setState({ orbit: moved });
      }, FLY_INTERVAL_MS);
    }

    function onPointerDown(event: PointerEvent): void {
      if (drag) return;
      const kind = dragKind(viewportStore.getState().mode, event.button, { alt: event.altKey, shift: event.shiftKey, ctrl: event.ctrlKey });
      if (!kind) return;
      event.preventDefault();
      element!.focus({ preventScroll: true });
      try {
        element!.setPointerCapture(event.pointerId);
      } catch {
        // A pointer the browser does not know (a synthesised one) cannot be captured; its events arrive here all the same.
      }
      drag = { kind, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      mods = { shift: event.shiftKey, ctrl: event.ctrlKey };
      setDragging(kind);
      forget();
      if (kind === 'fly') startFlying();
    }

    function onPointerMove(event: PointerEvent): void {
      if (!drag) {
        hover = place(event);
        pick();
        return;
      }
      if (event.pointerId !== drag.pointerId) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      drag.x = event.clientX;
      drag.y = event.clientY;
      mods = { shift: event.shiftKey, ctrl: event.ctrlKey };
      if (dx === 0 && dy === 0) return;
      const state = viewportStore.getState();
      if (drag.kind === 'sun') viewportStore.setState({ display: dragSun(state.display, dx, dy) });
      else if (state.mode === 'top') {
        viewportStore.setState({ top: drag.kind === 'dolly' ? zoomTop(state.top, Math.exp((dy - dx) * 0.006), state.width / 2, state.height / 2, state.width, state.height) : panTop(state.top, dx, dy, state.width) });
      } else if (drag.kind === 'orbit') viewportStore.setState({ orbit: orbit(state.orbit, dx, dy) });
      else if (drag.kind === 'pan') viewportStore.setState({ orbit: pan(state.orbit, dx, dy, state.height) });
      else if (drag.kind === 'dolly') viewportStore.setState({ orbit: dollyDrag(state.orbit, dx, dy) });
      else viewportStore.setState({ orbit: look(state.orbit, dx, dy) });
    }

    /** Ends the drag wherever the pointer is: its button was released, or the window can no longer know whether it was. */
    function release(): void {
      if (!drag) return;
      try {
        element!.releasePointerCapture(drag.pointerId);
      } catch {
        // As above.
      }
      drag = null;
      stopFlying();
      setDragging(null);
    }

    function endDrag(event: PointerEvent): void {
      if (!drag || event.pointerId !== drag.pointerId) return;
      release();
      hover = place(event);
      pick();
    }

    /**
     * A window that loses the focus hears of no button and no key that is released afterwards: a camera that
     * flew on a held key would fly on for ever. The same when the capture of the pointer is taken away.
     */
    function abandon(): void {
      if (!drag) return;
      release();
      hover = null;
      forget();
    }
    function onCaptureLost(event: PointerEvent): void {
      if (drag && event.pointerId === drag.pointerId) abandon();
    }
    function onHidden(): void {
      if (document.visibilityState === 'hidden') abandon();
    }

    function onPointerLeave(): void {
      if (drag) return;
      hover = null;
      forget();
    }

    function onWheel(event: WheelEvent): void {
      event.preventDefault();
      const state = viewportStore.getState();
      if (drag?.kind === 'fly') {
        // While flying the wheel is the gear.
        gear = Math.min(16, Math.max(1 / 16, gear * Math.exp(-event.deltaY * 0.002)));
        return;
      }
      const factor = wheelFactor(event.deltaY);
      const at = place(event);
      if (state.mode === 'top') {
        viewportStore.setState({ top: zoomTop(state.top, factor, at.x, at.y, state.width, state.height) });
        return;
      }
      // Towards what is under the pointer, when that is known: with the display's vertical scale, which the
      // picture has. The point keeps its pixel, so what was read there holds for the next turn of the wheel too.
      const under = picked?.result && Math.abs(picked.at.x - at.x) < 2 && Math.abs(picked.at.y - at.y) < 2
        ? [picked.result.position[0], picked.result.position[1], picked.result.position[2] * state.display.verticalScale] as const
        : null;
      const limits = { min: terrainOf({ doc }).terrainSize * 1e-4, max: terrainOf({ doc }).terrainSize * 40 };
      viewportStore.setState({ orbit: dolly(state.orbit, factor, under, limits) });
    }

    /** A double click brings the point under the pointer to the middle: the camera turns about it from then on. */
    function onDoubleClick(event: MouseEvent): void {
      if (event.button !== 0) return;
      const at = place(event);
      engine.viewport.pick(at.x, at.y).then((result) => {
        if (!alive || !result) return;
        const state = viewportStore.getState();
        if (state.mode === 'top') viewportStore.setState({ top: centerTop(state.top, result.uv) });
        else viewportStore.setState({ orbit: centerOrbit(state.orbit, [result.position[0], result.position[1], result.position[2] * state.display.verticalScale]) });
      }, () => undefined);
    }

    function onKey(event: KeyboardEvent): void {
      if (flying === null || !FLY_CODES.has(event.code)) return;
      // The keys of a flight are the camera's while the right button is held, whatever else they are bound to.
      event.preventDefault();
      event.stopImmediatePropagation();
      mods = { shift: event.shiftKey, ctrl: event.ctrlKey };
      if (event.type === 'keydown') held.add(event.code);
      else held.delete(event.code);
    }

    /** The arrow keys turn the camera or move the top view; plus and minus dolly. */
    function onHostKey(event: KeyboardEvent): void {
      const state = viewportStore.getState();
      const step = event.shiftKey ? 15 : 5;
      const arrows: Readonly<Record<string, readonly [number, number]>> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const arrow = arrows[event.code];
      const zoom = event.code === 'Equal' || event.code === 'NumpadAdd' ? 1 / 1.2 : event.code === 'Minus' || event.code === 'NumpadSubtract' ? 1.2 : 0;
      if (!arrow && zoom === 0) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      if (state.mode === 'top') {
        viewportStore.setState({ top: arrow ? panTop(state.top, -arrow[0] * step * 8, -arrow[1] * step * 8, state.width) : zoomTop(state.top, zoom, state.width / 2, state.height / 2, state.width, state.height) });
      } else {
        viewportStore.setState({ orbit: arrow ? orbit(state.orbit, (arrow[0] * step) / 0.3, (arrow[1] * step) / 0.3) : dolly(state.orbit, zoom) });
      }
    }

    // What is under a resting pointer changes with the picture: with the camera, the vertical scale, and the terrain.
    const stopCamera = viewportStore.subscribe((next, previous) => {
      if (cameraOf(next) !== cameraOf(previous) || next.display.verticalScale !== previous.display.verticalScale) pick();
    });
    const stopView = engine.subscribe((event) => {
      if (event.type === 'view-updated') pick();
      if (event.type === 'device-lost') forget();
    });

    const noMenu = (event: Event): void => event.preventDefault();
    element.addEventListener('pointerdown', onPointerDown);
    element.addEventListener('pointermove', onPointerMove);
    element.addEventListener('pointerup', endDrag);
    element.addEventListener('pointercancel', endDrag);
    element.addEventListener('lostpointercapture', onCaptureLost);
    element.addEventListener('pointerleave', onPointerLeave);
    element.addEventListener('wheel', onWheel, { passive: false });
    element.addEventListener('dblclick', onDoubleClick);
    element.addEventListener('contextmenu', noMenu);
    element.addEventListener('keydown', onHostKey);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    window.addEventListener('blur', abandon);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      alive = false;
      stopFlying();
      stopCamera();
      stopView();
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', endDrag);
      element.removeEventListener('pointercancel', endDrag);
      element.removeEventListener('lostpointercapture', onCaptureLost);
      element.removeEventListener('pointerleave', onPointerLeave);
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('dblclick', onDoubleClick);
      element.removeEventListener('contextmenu', noMenu);
      element.removeEventListener('keydown', onHostKey);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      window.removeEventListener('blur', abandon);
      document.removeEventListener('visibilitychange', onHidden);
    };
  }, [engine, doc]);

  // ---- what is shown --------------------------------------------------------------------------------------------------
  const mode = useStore(viewportStore, (state) => state.mode);
  const display = useStore(viewportStore, (state) => state.display);
  const sent = useStore(doc, (state) => state.engineRevision);
  const heightNode = useStore(doc, (state) => state.doc.ui.view?.height?.node);
  const overlayNode = useStore(doc, (state) => state.doc.ui.view?.overlay?.ref.node);
  const named = useStore(doc, (state) => {
    const refs = [state.doc.ui.view?.height, state.doc.ui.view?.overlay?.ref];
    return refs.some((ref) => ref !== undefined && Object.hasOwn(state.doc.nodes, ref.node));
  });
  // What the toolbar names: the terrain's output, or the overlay's when the view has no terrain.
  const subject = useStore(doc, (state) => outputTitle(state.doc, registry, state.doc.ui.view?.height ?? state.doc.ui.view?.overlay?.ref));
  const locked = useStore(doc, (state) => state.doc.ui.view?.locked === true);
  const device = useStore(engineState, (state) => state.device.state);
  const shown = useStore(engineState, (state) => state.view);
  const evaluating = useStore(engineState, (state) => state.evaluation !== null && (state.evaluation.purpose === 'view' || state.evaluation.purpose === 'draft'));
  const stateOf = (id: string | undefined) => (state: ReturnType<typeof engineState.getState>): NodeState | null => {
    const known = id !== undefined && Object.hasOwn(state.nodes, id) ? state.nodes[id]! : null;
    if (known === null) return null;
    return known.state === 'error' && known.error?.kind === 'missing-input' ? 'unwired' : known.state;
  };
  const terrainState = useStore(engineState, stateOf(heightNode ?? overlayNode));
  const overlayState = useStore(engineState, stateOf(heightNode === undefined ? undefined : overlayNode));
  const status: ViewStatus = viewStatus({ device, bound: named, node: terrainState, overlay: overlayState, shown, sent, evaluating });
  const blank = isBlank(status, shown !== null);

  const cursor = dragging === 'fly' ? 'none' : dragging ? 'grabbing' : 'default';

  return (
    <div
      ref={root}
      className={styles.root}
      data-viewport="root"
      data-mode={mode}
      data-status={status}
      data-shading={display.shading}
      data-top-style={display.topStyle}
      data-palette={display.palette}
      data-drag={dragging ?? undefined}
      data-sun={`${display.sunAzimuth} ${display.sunElevation}`}
      data-scale={display.verticalScale}
      data-sea={display.showSea ? '' : undefined}
    >
      <Toolbar status={status} resolution={shown?.resolution ?? null} subject={subject} locked={locked} />
      <div className={styles.stage}>
        <div
          ref={host}
          className={styles.host}
          data-viewport="canvas"
          tabIndex={0}
          role="application"
          aria-label={mode === 'top' ? 'Terrain, top view' : 'Terrain, 3D view'}
          style={{ cursor }}
        />
        {blank ? (
          <div className={styles.cover} data-viewport="cover">
            <EmptyState title={STATUS_TEXT[status]}>
              {status === 'empty' ? 'Select a node in the graph to see its terrain'
                : status === 'error' ? 'The list of errors in the status bar says why'
                  : status === 'unwired' ? 'Connect its input in the graph to see its terrain'
                    : null}
            </EmptyState>
          </div>
        ) : null}
        {!blank && readout ? (
          <div className={styles.readout} data-viewport="readout" data-u={readout.uv[0]} data-v={readout.uv[1]} data-height={readout.height}>
            <span className={styles.readoutLabel}>X</span><span>{metres(readout.position[0])}</span>
            <span className={styles.readoutLabel}>Y</span><span>{metres(readout.position[1])}</span>
            <span className={styles.readoutLabel}>Height</span><span>{metres(readout.position[2])}</span>
            <span className={styles.readoutDim}>{readout.height.toFixed(4)}</span>
          </div>
        ) : null}
        {dragging === 'sun' ? (
          <div className={styles.note} data-viewport="note">
            Sun {Math.round(display.sunAzimuth)}° · {Math.round(display.sunElevation)}° above the horizon
          </div>
        ) : null}
        {dragging === 'fly' ? <div className={styles.note} data-viewport="note">W A S D to move · Q E down and up · wheel for speed</div> : null}
      </div>
    </div>
  );
}
