// The viewport renderer (runtime.md 7.5, 8.10): what the engine worker and the tests import of this folder.

export { createViewportRenderer, lightCapFor, multisampleLimitFor } from './renderer.ts';
export type { RendererOptions, RendererState, Viewport } from './renderer.ts';
export { DEFAULT_DISPLAY, PALETTES, resolveDisplay } from './display.ts';
export type { DisplayOptions, Palette, ResolvedDisplay, Shading, TopStyle } from './display.ts';
