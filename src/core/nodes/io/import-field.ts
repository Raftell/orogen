// src/core/nodes/io/import-field.ts
import { decodeImage, decodeRaw, defineCpuTask, defineNode } from '../../api.ts';
import { filter, fit, HEIGHT_FILTERS, place, placeKernels, readImage } from './_import.ts';

type Channel = 'red' | 'green' | 'blue' | 'alpha' | 'luma';

/** The largest number a field holds: the largest float32. */
const FIELD_MAX = 3.4028234663852886e38;

// One channel of interleaved samples, with the file's range mapped to 0..1. It visits every texel, so it is a
// CPU task and not a loop in evaluate().
const pick = defineCpuTask({
  name: 'io/import-field.channel',
  run({ data, channels, channel, inMin, inMax }: { data: Float32Array; channels: number; channel: Channel; inMin: number; inMax: number }): Float32Array {
    const count = data.length / channels;
    const out = new Float32Array(count);
    // A gray image has one channel, which every choice but alpha reads; an image without alpha is opaque.
    const index = channels === 1 ? 0 : channel === 'green' ? 1 : channel === 'blue' ? 2 : channel === 'alpha' ? 3 : 0;
    const opaque = channel === 'alpha' && channels !== 4;
    const luma = channel === 'luma' && channels >= 3;
    // A range without width maps every value to 0, as ops.remap does.
    const span = inMax - inMin;
    for (let i = 0, at = 0; i < count; i++, at += channels) {
      const v = opaque ? 1 : luma ? 0.2126 * data[at] + 0.7152 * data[at + 1] + 0.0722 * data[at + 2] : data[at + index];
      const t = span === 0 ? 0 : (v - inMin) / span;
      // A range far narrower than the values of the file gives numbers no field holds: they stay finite. The sum
      // with 0 turns the -0 of a value at or below the minimum into 0.
      out[i] = (t > FIELD_MAX ? FIELD_MAX : t < -FIELD_MAX ? -FIELD_MAX : t) + 0;
    }
    return out;
  },
});

export default defineNode({
  type: 'io/import-field',
  title: 'Import Heightmap',
  category: 'io',
  description: 'Loads a PNG, TIFF, OpenEXR or raw image file as a terrain or a mask, and fails while no file is selected.',
  keywords: ['load', 'open', 'file', 'image', 'png', 'tiff', 'exr', 'raw', 'r16', 'dem'],
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    {
      kind: 'file', name: 'file', label: 'File', default: '', filters: HEIGHT_FILTERS,
      help: 'The image to load: PNG, TIFF, OpenEXR, or raw samples in a square file (.r16 and .raw 16 bits, .r8 8 bits, .r32 floats).',
    },
    {
      kind: 'enum', name: 'channel', label: 'Channel', default: 'red',
      // Stored in documents: values are never renamed or reordered, and new ones are appended.
      options: [
        { value: 'red', label: 'Red' },
        { value: 'green', label: 'Green' },
        { value: 'blue', label: 'Blue' },
        { value: 'alpha', label: 'Alpha' },
        { value: 'luma', label: 'Brightness' },
      ],
      help: 'Which channel of a color image is read. Brightness weighs red, green and blue as the eye does. A gray image has one channel, which all but Alpha read.',
    },
    {
      kind: 'float', name: 'inMin', label: 'Input minimum', unit: 'none', default: 0, min: 0, max: 1, soft: true,
      help: 'The value in the file that becomes height 0. Whole-number formats hold 0 to 1; a float file may hold meters.',
    },
    {
      kind: 'float', name: 'inMax', label: 'Input maximum', unit: 'none', default: 1, min: 0, max: 1, soft: true,
      help: 'The value in the file that becomes height 1, the top of the height range. Below the minimum, it turns the image upside down.',
    },
    fit,
    filter,
  ],
  kernels: [...placeKernels.field],
  cpuTasks: [decodeImage, decodeRaw, pick],
  async evaluate(ctx) {
    const { file, channel, inMin, inMax } = ctx.params;
    const { image } = await readImage(ctx, file, true);
    const asStored = image.channels === 1 && channel !== 'alpha' && inMin === 0 && inMax === 1;
    const heights = asStored
      ? image.data
      : await ctx.cpu(pick, { data: image.data, channels: image.channels, channel, inMin, inMax }, [image.data.buffer]);

    // The upload keeps the image's own size, row for row; bringing it onto the evaluation grid is the GPU's work.
    const source = ctx.alloc('field', { size: [image.width, image.height] });
    ctx.write(source, heights);
    ctx.output('out', place(ctx, source, ctx.params.fit, ctx.params.filter));
  },
});
