import type { TextureRef } from '../eval/evaluator.ts';
import { DeviceLostError, type GpuContext } from '../gpu/device.ts';
import type { AnyFieldHandle } from '../gpu/pool.ts';
import type { PortRef, ProjectSettings } from '../graph/doc.ts';

export interface ViewportSize { readonly width: number; readonly height: number; readonly dpr: number }   // CSS pixels, device pixel ratio

export type CameraState =
  | { readonly kind: 'orbit';
      readonly target: readonly [number, number, number];   // metres, in the frame of engine.md 1.8
      readonly yaw: number;                                  // degrees; the viewing direction, by the direction convention of engine.md 1.8
      readonly pitch: number;                                // degrees the camera looks down, −89.9 .. 89.9; below 0 it looks up, as a camera that flies does
      readonly distance: number;                             // metres from the target
      readonly fovY: number }                                // degrees
  | { readonly kind: 'top';
      readonly center: readonly [number, number];            // uv
      readonly span: number };                               // uv width visible across the canvas

export interface ViewportDisplay {
  readonly verticalScale: number;     // display only; default 1
  readonly showSea: boolean;          // draw the plane at the document's seaLevel
  readonly sunAzimuth: number;        // degrees, direction towards the sun, engine.md 1.8
  readonly sunElevation: number;      // degrees above the horizon
}

export interface PickResult {
  readonly uv: readonly [number, number];
  readonly height: number;                                   // normalised
  readonly position: readonly [number, number, number];      // metres
}

/** What the interface calls. */
export interface ViewportHost {
  attach(canvas: OffscreenCanvas, size: ViewportSize): void;   // may be called again with a new canvas
  detach(): void;
  resize(size: ViewportSize): void;
  setCamera(camera: CameraState): void;
  setDisplay(display: ViewportDisplay): void;
  pick(x: number, y: number): Promise<PickResult | null>;      // CSS pixels from the canvas's top-left; null: no terrain there
}

/** What the session drives. Implemented in src/viewport/. `TextureRef` is declared in 5.2. */
export interface ViewportContent {
  readonly height: TextureRef | null;
  readonly overlay: { readonly texture: TextureRef; readonly as: 'color' | 'mask' | 'heat'; readonly opacity: number } | null;
  readonly terrainSize: number;
  readonly heightRange: number;
  readonly seaLevel: number;
}

export interface ViewportRenderer extends ViewportHost {
  /** Called once, and again after every device replacement. */
  init(gpu: GpuContext, ledger: { reserve(bytes: number, label: string): { release(): void } }): void;
  setContent(content: ViewportContent | null): void;
  /**
   * The content is withdrawn and the next one is on its way (7.5 rule 2): from now on the renderer uses no view of
   * it, and it keeps the picture it has drawn until the next `setContent`, whatever else changes meanwhile.
   */
  keep(): void;
  dispose(): void;
}

// ---- the session's side (7.4, 7.5 rule 2) --------------------------------------------------------------------------

/** One result as the session shows it: the handles of its view targets and what the renderer needs beside them. */
export interface ShownResult {
  readonly height: AnyFieldHandle | null;
  readonly overlay: { readonly handle: AnyFieldHandle; readonly as: 'color' | 'mask' | 'heat'; readonly opacity: number } | null;
  readonly settings: ProjectSettings;
}

/** The ports a view names, for loans (7.5 rule 2). */
export interface LoanView {
  readonly height: PortRef | null;
  readonly overlay: { readonly ref: PortRef; readonly as: 'color' | 'mask' | 'heat'; readonly opacity: number } | null;
  readonly settings: ProjectSettings;
}

/**
 * What the session does with its renderer: it holds the handles of the shown result, which pins that content
 * (7.4 rule 3), and tells the renderer synchronously whenever what is to be drawn changes.
 */
export interface ViewBinder {
  /** EngineSession.viewport: the renderer's host methods, or calls that are ignored when there is no renderer. */
  readonly host: ViewportHost;
  /** Called once, and again after every device replacement. */
  init(gpu: GpuContext, ledger: { reserve(bytes: number, label: string): { release(): void } }): void;
  /**
   * Shows a result, or nothing. The handles of the result shown before are released when the renderer has
   * switched. False when the result cannot be shown, because its device is gone or the binder is disposed: its
   * handles are then still the caller's.
   */
  show(result: ShownResult | null): boolean;
  /**
   * The running node lends (or, with null, withdraws) its working state. A loan stands in for the published
   * texture of the port the view names, when its kind is the kind the view asks for. When the loans on screen are
   * withdrawn, the node's result is what follows them: the renderer keeps its picture (`keep`) and is given no
   * earlier content meanwhile (7.5 rule 2).
   */
  lend(view: LoanView, nodeId: string, loans: Readonly<Record<string, TextureRef>> | null): void;
  /**
   * A view target of the evaluation under way was delivered: the result of the node the view names. Where a loan
   * of that evaluation stood in for this part of the view, the result takes the loan's place at once and stays
   * until `show` or `revert` (7.5 rule 2): the nodes that still run after a simulation do not bring the earlier
   * terrain back. The binder takes a handle of its own; `handle` stays the caller's.
   */
  deliver(view: LoanView, part: 'height' | 'overlay', handle: AnyFieldHandle): void;
  /**
   * The node ended without a result (`node-error`, `node-skipped`). When the picture was kept for its result after
   * its loans, nothing follows them: what was drawn before them is drawn again (5.11 rule 5).
   */
  failed(nodeId: string): void;
  /** The evaluation under way has ended without a result to show: what `show` was last given is drawn again (5.11 rule 5). */
  revert(): void;
  /** The device is lost: the renderer draws nothing and the handles are dropped without being released (7.8 rule 1). */
  lost(): void;
  /** Releases the handles and disposes the renderer. */
  dispose(): void;
}

const refOf = (handle: AnyFieldHandle): TextureRef => ({ view: handle.view, width: handle.width, height: handle.height, kind: handle.kind });

function contentOf(shown: ShownResult): ViewportContent {
  return {
    height: shown.height ? refOf(shown.height) : null,
    overlay: shown.overlay ? { texture: refOf(shown.overlay.handle), as: shown.overlay.as, opacity: shown.overlay.opacity } : null,
    terrainSize: shown.settings.terrainSize,
    heightRange: shown.settings.heightRange,
    seaLevel: shown.settings.seaLevel,
  };
}

function release(shown: ShownResult | null): void {
  for (const handle of [shown?.height, shown?.overlay?.handle]) {
    try {
      handle?.release();
    } catch (thrown) {
      console.error('[orogen] a view handle could not be released', thrown);
    }
  }
}

export function createViewBinder(renderer: ViewportRenderer | null): ViewBinder {
  let shown: ShownResult | null = null;
  /** What the renderer was last given for `shown`; null when it draws nothing. */
  let content: ViewportContent | null = null;
  /**
   * What the renderer draws while no loan stands: `content`, or `content` with the parts `deliver` replaced.
   * One object per state: a renderer keeps its picture when it is given an object it was given before (7.5 rule 2).
   */
  let base: ViewportContent | null = null;
  /** A loan is in the content the renderer has. */
  let lending = false;
  /**
   * The node whose loans were withdrawn while the renderer keeps their picture for its result; null when none.
   * Its result (`deliver`), its failure, the end of the evaluation or another loan ends the wait.
   */
  let kept: string | null = null;
  /** The parts of the view a loan has stood in for since the last `show` or `revert`. */
  const lent = { height: false, overlay: false };
  /** The binder's own handles on what `deliver` put in a loan's place. */
  const interim: { height: AnyFieldHandle | null; overlay: AnyFieldHandle | null } = { height: null, overlay: null };
  let disposed = false;

  /** Forgets the loans and what was delivered in their place. Returns the handles to release once the renderer has switched. */
  function settle(): (AnyFieldHandle | null)[] {
    const held = [interim.height, interim.overlay];
    interim.height = null;
    interim.overlay = null;
    lent.height = false;
    lent.overlay = false;
    lending = false;
    kept = null;
    base = content;
    return held;
  }

  function releaseHandles(handles: readonly (AnyFieldHandle | null)[]): void {
    for (const handle of handles) {
      try {
        handle?.release();
      } catch (thrown) {
        console.error('[orogen] a view handle could not be released', thrown);
      }
    }
  }

  const host: ViewportHost = {
    attach: (canvas, size) => { if (!disposed) renderer?.attach(canvas, size); },
    detach: () => { if (!disposed) renderer?.detach(); },
    resize: (size) => { if (!disposed) renderer?.resize(size); },
    setCamera: (camera) => { if (!disposed) renderer?.setCamera(camera); },
    setDisplay: (display) => { if (!disposed) renderer?.setDisplay(display); },
    pick: (x, y) => (renderer && !disposed ? renderer.pick(x, y) : Promise.resolve(null)),
  };

  return {
    host,

    init(gpu, ledger) {
      renderer?.init(gpu, ledger);
    },

    show(result) {
      if (disposed) return false;
      let next: ViewportContent | null;
      try {
        next = result ? contentOf(result) : null;
      } catch (thrown) {
        // The device went between the evaluation and here: the handles are dead, and lost() is on its way.
        if (!(thrown instanceof DeviceLostError)) throw thrown;
        return false;
      }
      const previous = shown;
      shown = result;
      content = next;
      const stood = settle();
      // 7.5 rule 2: when setContent returns, the renderer uses no view of the previous content.
      renderer?.setContent(next);
      release(previous);
      releaseHandles(stood);
      return true;
    },

    lend(view, nodeId, loans) {
      if (disposed) return;
      const height = view.height?.node === nodeId ? loans?.[view.height.port] : undefined;
      const over = view.overlay?.ref.node === nodeId ? loans?.[view.overlay.ref.port] : undefined;
      const lentHeight = height?.kind === 'field' ? height : null;
      const lentOverlay = view.overlay && over?.kind === (view.overlay.as === 'color' ? 'color' : 'field') ? over : null;
      if (!lentHeight && !lentOverlay) {
        if (lending) {
          // The lent texture goes back to the pool after this call, and the node's result is what comes next: the
          // content of before is not given, so no frame of it can be drawn while the node settles (7.5 rule 2).
          lending = false;
          kept = nodeId;
          renderer?.keep();
        }
        return;
      }
      lending = true;
      kept = null;
      if (lentHeight) lent.height = true;
      if (lentOverlay) lent.overlay = true;
      renderer?.setContent({
        height: lentHeight ?? base?.height ?? null,
        overlay: lentOverlay ? { texture: lentOverlay, as: view.overlay!.as, opacity: view.overlay!.opacity } : base?.overlay ?? null,
        terrainSize: view.settings.terrainSize,
        heightRange: view.settings.heightRange,
        seaLevel: view.settings.seaLevel,
      });
    },

    deliver(view, part, handle) {
      if (disposed || !lent[part] || (part === 'overlay' && !view.overlay)) return;
      let own: AnyFieldHandle;
      let texture: TextureRef;
      try {
        own = handle.retain();
        texture = refOf(own);
      } catch (thrown) {
        // The device went: lost() is on its way, and there is nothing to draw.
        if (!(thrown instanceof DeviceLostError)) throw thrown;
        return;
      }
      const previous = interim[part];
      interim[part] = own;
      base = {
        height: part === 'height' ? texture : base?.height ?? null,
        overlay: part === 'overlay' ? { texture, as: view.overlay!.as, opacity: view.overlay!.opacity } : base?.overlay ?? null,
        terrainSize: view.settings.terrainSize,
        heightRange: view.settings.heightRange,
        seaLevel: view.settings.seaLevel,
      };
      // While another loan stands the renderer keeps it; this content is what it steps back to.
      if (!lending) {
        kept = null;
        renderer?.setContent(base);
      }
      releaseHandles([previous]);
    },

    failed(nodeId) {
      if (disposed || kept !== nodeId) return;
      kept = null;
      renderer?.setContent(base);
    },

    revert() {
      if (disposed) return;
      const changed = lending || kept !== null || base !== content;
      const stood = settle();
      if (changed) renderer?.setContent(content);
      releaseHandles(stood);
    },

    lost() {
      shown = null;
      content = null;
      // Handles of the lost device are dropped, not released.
      settle();
      base = null;
      if (!disposed) renderer?.setContent(null);
    },

    dispose() {
      if (disposed) return;
      const previous = shown;
      shown = null;
      content = null;
      const stood = settle();
      base = null;
      try {
        renderer?.setContent(null);
      } finally {
        disposed = true;
        release(previous);
        releaseHandles(stood);
        renderer?.dispose();
      }
    },
  };
}
