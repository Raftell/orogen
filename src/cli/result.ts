// What one rendered node came to (testing.md 8.6): the record `render` prints and `gallery` lists, its exit
// code, and a failed node in words. Pure.

import { HARD_CEILING_MS, type EvaluateResult, type NodeError } from '../core/runtime.ts';
import type { Given } from './document.ts';
import type { Tone } from './preview.ts';

/** runtime.md 3.5: no slice may be measured above this. */
export { HARD_CEILING_MS };

export interface RenderResult {
  readonly type: string;
  readonly res: number;
  readonly status: EvaluateResult['status'];
  /** One per failed node of the document, the wiring included. */
  readonly errors: readonly NodeError[];
  /** node-done of the rendered node: 0, null and 0 when it did not finish. */
  readonly wallMs: number;
  readonly gpuMs: number | null;
  readonly peakBytes: number;
  /** Over every slice of the evaluation: the node's, those of what feeds it, and the engine's own. */
  readonly longestSliceMs: number;
  readonly longestSliceKernels: readonly string[];
  readonly engineErrors: readonly string[];
  /** Every picture written, as a path under the output folder with `/`. */
  readonly files: readonly string[];
  /** The main picture of each output that was drawn, by port name. */
  readonly pictures: Readonly<Record<string, WrittenPicture>>;
  /** The `3d` view of each colour output that has one, by port name. */
  readonly views: Readonly<Record<string, WrittenPicture>>;
  /** The pictures of what the node's inputs were given, where they were asked for and the node has two or more connected. */
  readonly inputs: readonly WrittenInput[];
}

/** A picture in the output folder: its path under that folder with `/`, its size in pixels, and for a data output the scale it is drawn on. */
export interface WrittenPicture { readonly file: string; readonly width: number; readonly height: number; readonly tone?: Tone }

/** The picture of what one input was given: a terrain, the mask, a colouring, or what the input is named for. */
export interface WrittenInput extends WrittenPicture { readonly port: string; readonly kind: Given }

/** Whether the run broke what keeps a GPU pre-emptible: a slice above the hard ceiling, or an error outside every scope. */
export function overran(result: Pick<RenderResult, 'longestSliceMs' | 'engineErrors'>): boolean {
  return result.longestSliceMs > HARD_CEILING_MS || result.engineErrors.length > 0;
}

/** The exit code of one rendered node (testing.md 8.6). */
export function exitCodeOf(result: RenderResult): number {
  if (result.status === 'device-lost') return 3;
  if (result.status === 'aborted') return 130;
  if (result.status === 'errors') return 1;
  return overran(result) ? 1 : 0;
}

/**
 * A NodeError as lines for a person: the sentence, then the kernel, the shader diagnostic and the detail when
 * there are any. `ids` is false for a document made for a node type, whose node ids nobody has seen.
 */
export function describeError(error: NodeError, ids: boolean): string {
  const lines = [`${error.nodeType}${ids ? ` (node "${error.nodeId}")` : ''} failed, ${error.kind}: ${error.message}`];
  if (error.kernel !== undefined) lines.push(`  kernel: ${error.kernel}`);
  if (error.wgsl) {
    lines.push(`  ${error.wgsl.origin}, line ${error.wgsl.line}, column ${error.wgsl.column}: ${error.wgsl.message}`);
    for (const line of error.wgsl.excerpt.slice(0, 5)) lines.push(`    ${line}`);
  }
  if (error.detail !== undefined && error.detail !== error.message) {
    for (const line of error.detail.split('\n').slice(0, 12)) lines.push(`  ${line}`);
  }
  return lines.join('\n');
}
