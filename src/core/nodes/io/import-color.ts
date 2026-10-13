// src/core/nodes/io/import-color.ts
import { decodeImage, defineCpuTask, defineNode } from '../../api.ts';
import { filter, fit, IMAGE_FILTERS, place, placeKernels, readImage } from './_import.ts';

/** The largest value a channel of a color holds: the largest finite half float. */
const COLOR_MAX = 65504;

// Decoded samples as opaque linear RGBA. Whole-number samples are sRGB-encoded: each is decoded through a table
// of the 65536 values 16 bits can hold, which is exact for 8 and for 16 bits. It visits every texel, so it is a
// CPU task and not a loop in evaluate().
const toLinear = defineCpuTask({
  name: 'io/import-color.linear',
  run({ data, channels, linear }: { data: Float32Array; channels: number; linear: boolean }): Float32Array {
    let decode: Float32Array | null = null;
    if (!linear) {
      decode = new Float32Array(65536);
      for (let i = 0; i < 65536; i++) {
        const c = i / 65535;
        decode[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      }
    }
    // Linear samples are taken as they are, up to the largest value a color holds: beyond it the stored half float is infinite.
    const value = (v: number): number => (decode === null ? Math.min(COLOR_MAX, Math.max(-COLOR_MAX, v)) : decode[Math.round(Math.min(1, Math.max(0, v)) * 65535)]);
    const count = data.length / channels;
    // Four channels are converted where they lie; the file's alpha is not kept.
    const out = channels === 4 ? data : new Float32Array(count * 4);
    for (let i = 0, from = 0, to = 0; i < count; i++, from += channels, to += 4) {
      const r = value(data[from]);
      out[to + 1] = channels === 1 ? r : value(data[from + 1]);
      out[to + 2] = channels === 1 ? r : value(data[from + 2]);
      out[to] = r;
      out[to + 3] = 1;
    }
    return out;
  },
});

export default defineNode({
  type: 'io/import-color',
  title: 'Import Image',
  category: 'io',
  description: 'Loads a PNG, TIFF or OpenEXR image file as a color map, and fails while no file is selected.',
  keywords: ['load', 'open', 'file', 'texture', 'picture', 'photo', 'png', 'tiff', 'exr', 'satellite'],
  inputs: [],
  outputs: [{ name: 'out', type: 'color' }],
  params: [
    {
      kind: 'file', name: 'file', label: 'File', default: '', filters: IMAGE_FILTERS,
      help: 'The image to load. PNG and whole-number TIFF files are read as sRGB colors, OpenEXR and float TIFF files as linear ones. Transparency is ignored.',
    },
    fit,
    filter,
  ],
  kernels: [...placeKernels.color],
  cpuTasks: [decodeImage, toLinear],
  async evaluate(ctx) {
    const { image, linear } = await readImage(ctx, ctx.params.file, false);
    const rgba = await ctx.cpu(toLinear, { data: image.data, channels: image.channels, linear }, [image.data.buffer]);

    // The upload keeps the image's own size, row for row; bringing it onto the evaluation grid is the GPU's work.
    const source = ctx.alloc('color', { size: [image.width, image.height] });
    ctx.write(source, rgba);
    ctx.output('out', place(ctx, source, ctx.params.fit, ctx.params.filter));
  },
});
