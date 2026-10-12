// src/core/nodes/ref/image.ts
import { decodeImage, defineCpuTask, defineNode, ops } from '../../api.ts';

// The first channel of interleaved samples. It visits every texel, so it is a CPU task and not a loop in evaluate().
const firstChannel = defineCpuTask({
  name: 'ref/image.channel',
  run({ data, channels }: { data: Float32Array; channels: number }): Float32Array {
    const out = new Float32Array(data.length / channels);
    for (let i = 0; i < out.length; i++) out[i] = data[i * channels];
    return out;
  },
});

export default defineNode({
  type: 'ref/image',
  title: 'Image (Reference)',
  category: 'ref',
  description: 'Loads the first channel of a PNG image as a terrain, and fails while no file is selected; the reference node for file inputs.',
  keywords: ['import', 'heightmap', 'png', 'file'],
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    { kind: 'file', name: 'file', label: 'File', default: '', filters: ['png'], help: 'The image to load. Black is the lowest height and white the highest.' },
  ],
  kernels: [],
  cpuTasks: [decodeImage, firstChannel],
  async evaluate(ctx) {
    const { file } = ctx.params;
    if (file === '') throw new Error('No file selected');
    const bytes = await ctx.readFile(file);
    // Decoding is CPU work in another thread. The buffers are moved there and back, not copied.
    const image = await ctx.cpu(decodeImage, { bytes }, [bytes.buffer]);
    const heights = image.channels === 1
      ? image.data
      : await ctx.cpu(firstChannel, { data: image.data, channels: image.channels }, [image.data.buffer]);

    // The upload keeps the image's own size, row for row; bringing it onto the evaluation grid is the GPU's work.
    const source = ctx.alloc('field', { size: [image.width, image.height] });
    ctx.write(source, heights);
    const out = ops.resample(ctx, source, { size: ctx.res });
    ctx.release(source);
    ctx.output('out', out);
  },
});
