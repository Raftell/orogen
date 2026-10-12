// Which pictures `render` and `gallery` make of a node's output (testing.md 8.6), and how one is written.

import type { PortDef } from '../core/api.ts';
import type { FileSink } from '../core/runtime.ts';
import { createPngEncoder } from '../export/encode/png.ts';
import { drawPreview, type DrawOptions, type Picture, type Raster } from './preview.ts';

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
}

/**
 * The pictures of one output, the main one first. A field is a `sheet`; a mask or a data field is drawn over
 * the node's first height input when it has one, and a data field with the range of its own values, as the
 * conformance suite draws them. A colour is a `color` picture and a `3d` view of that height input with the
 * colour drawn over it. `crop` adds the centre window of that many texels at one texel per pixel.
 */
export function picturesOf(
  port: Pick<PortDef, 'role'>, field: Raster, terrain: Raster | null,
  scale: { readonly terrainSize: number; readonly heightRange: number }, crop: number | null,
): OutputPicture[] {
  const window = crop === null ? null : [Math.floor((field.width - crop) / 2), Math.floor((field.height - crop) / 2), crop] as const;
  const out: OutputPicture[] = [];
  if (field.kind === 'color') {
    out.push({ suffix: '', draw: () => drawPreview(field, { style: 'color' }) });
    if (terrain) out.push({ suffix: '-3d', draw: () => drawPreview(field, { style: '3d', height: terrain, ...scale }) });
    if (window) out.push({ suffix: '-crop', draw: () => drawPreview(field, { style: 'color', crop: window }) });
    return out;
  }
  const role = port.role ?? 'height';
  const over: DrawOptions = role === 'height' ? scale : { ...scale, ...(role === 'data' ? { range: 'auto' as const } : {}), ...(terrain ? { height: terrain } : {}) };
  out.push({ suffix: '', draw: () => drawPreview(field, { style: 'sheet', ...over }) });
  if (window) out.push({ suffix: '-crop', draw: () => drawPreview(field, { style: 'hillshade', ...over, crop: window }) });
  return out;
}
