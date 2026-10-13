// Which pictures `render` and `gallery` make of a node's output (testing.md 8.6), and how one is written.

import type { PortDef } from '../core/api.ts';
import type { FileSink } from '../core/runtime.ts';
import { createPngEncoder } from '../export/encode/png.ts';
import type { Given } from './document.ts';
import { drawPreview, toneOf, type DrawOptions, type Picture, type Raster, type Tone } from './preview.ts';

/** How many bytes of a picture are handed to the encoder at once. */
const STRIP_BYTES = 4 << 20;

/** Writes `picture` as an 8-bit RGB PNG at `relPath` of the sink: the file appears whole or not at all. */
export async function writePicture(sink: FileSink, relPath: string, picture: Picture): Promise<void> {
  const writer = await sink.create(relPath);
  try {
    const encoder = createPngEncoder(writer, { width: picture.width, height: picture.height, channels: 3, bits: 8 });
    const rowBytes = picture.width * 3;
    const rows = Math.max(1, Math.floor(STRIP_BYTES / rowBytes));
    for (let y = 0; y < picture.height; y += rows) {
      await encoder.write(picture.rgb.subarray(y * rowBytes, Math.min(y + rows, picture.height) * rowBytes));
    }
    await encoder.end();
    await writer.close();
  } catch (thrown) {
    await writer.abort();
    throw thrown;
  }
}

export interface OutputPicture {
  /** Follows `<output>-<res>` in the file name. */
  readonly suffix: '' | '-3d' | '-crop';
  /** Draws it. A picture is drawn when it is written, so that one field is never held as several pictures at once. */
  draw(): Picture;
  /** The scale of a data output, which its sheet and its crop share: what black and white stand for. */
  readonly tone?: Tone;
}

/**
 * Node types whose colour output is itself a lit rendering of the terrain. Shaded once more in the `3d` view it
 * would show its light and the picture's on top of each other; it is drawn there as it is.
 */
const LIT_RENDERINGS: ReadonlySet<string> = new Set(['color/hillshade']);

/** Whether the `3d` view lights the colour outputs of a node of this type: not those that are lit renderings already. */
export const viewIsLit = (type: string): boolean => !LIT_RENDERINGS.has(type);

/**
 * The pictures of one output, the main one first. A field is a `sheet`; a mask or a data field is drawn over
 * `terrain` when there is one, and a data field on the scale of its own values (`'data'`: linear, or logarithmic
 * for a field that spans orders of magnitude), as the conformance suite draws them. A colour is a `color` picture
 * and a `3d` view of `terrain` with the colour drawn over it, lit from the viewer's side unless `lit` is false.
 * `terrain` is the node's first output where that is a height, else its first height input (testing.md 8.6).
 * `crop` adds the centre window of that many texels at one texel per pixel.
 */
export function picturesOf(
  port: Pick<PortDef, 'role'>, field: Raster, terrain: Raster | null,
  scale: { readonly terrainSize: number; readonly heightRange: number }, crop: number | null, lit = true,
): OutputPicture[] {
  const window = crop === null ? null : [Math.floor((field.width - crop) / 2), Math.floor((field.height - crop) / 2), crop] as const;
  const out: OutputPicture[] = [];
  if (field.kind === 'color') {
    out.push({ suffix: '', draw: () => drawPreview(field, { style: 'color' }) });
    if (terrain) out.push({ suffix: '-3d', draw: () => drawPreview(field, { style: '3d', height: terrain, lit, ...scale }) });
    if (window) out.push({ suffix: '-crop', draw: () => drawPreview(field, { style: 'color', crop: window }) });
    return out;
  }
  const role = port.role ?? 'height';
  // The scale of a data field is found once, on the whole field: its crop is drawn on the scale of its sheet.
  const tone = role === 'data' ? toneOf(field, 'data') : undefined;
  const over: DrawOptions = role === 'height' ? scale : { ...scale, ...(tone ? { range: tone } : {}), ...(terrain ? { height: terrain } : {}) };
  out.push({ suffix: '', draw: () => drawPreview(field, { style: 'sheet', ...over }), ...(tone ? { tone } : {}) });
  if (window) out.push({ suffix: '-crop', draw: () => drawPreview(field, { style: 'hillshade', ...over, crop: window }), ...(tone ? { tone } : {}) });
  return out;
}

/**
 * The picture of what an input of a rendered node was given, at one pixel per texel: a terrain and a landform
 * shaded, the mask and the snow black to white, the drainage on the scale of a data field, a colouring as the
 * colours it holds.
 */
export function inputPicture(kind: Given, field: Raster, scale: { readonly terrainSize: number; readonly heightRange: number }): Picture {
  if (field.kind === 'color') return drawPreview(field, { style: 'color' });
  if (kind === 'mask' || kind === 'snow') return drawPreview(field, { style: 'grey' });
  if (kind === 'flow') return drawPreview(field, { style: 'grey', range: 'data' });
  return drawPreview(field, { style: 'hillshade', ...scale });
}
