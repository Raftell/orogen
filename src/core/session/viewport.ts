import type { TextureRef } from '../eval/evaluator.ts';
import type { GpuContext } from '../gpu/device.ts';

export interface ViewportSize { readonly width: number; readonly height: number; readonly dpr: number }   // CSS pixels, device pixel ratio

export type CameraState =
  | { readonly kind: 'orbit';
      readonly target: readonly [number, number, number];   // metres, in the frame of engine.md 1.8
      readonly yaw: number;                                  // degrees; the viewing direction, by the direction convention of engine.md 1.8
      readonly pitch: number;                                // degrees the camera looks down, 0 .. 89.9
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
  dispose(): void;
}
