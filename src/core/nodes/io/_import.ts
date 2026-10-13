// src/core/nodes/io/_import.ts
// What the two import nodes share: reading and decoding the file, making a picture that is not square fit the
// square terrain, and bringing it onto the evaluation grid.
import {
  decodeImage, decodeRaw, defineKernel, ops,
  type DecodedImage, type EnumParam, type Field, type OpContext,
} from '../../api.ts';

export const fit = {
  kind: 'enum', name: 'fit', label: 'Fit', default: 'stretch',
  // Stored in documents: values are never renamed or reordered, and new ones are appended.
  options: [
    { value: 'stretch', label: 'Stretch' },
    { value: 'contain', label: 'Contain' },
    { value: 'cover', label: 'Cover' },
  ],
  help: 'How an image that is not square is placed: stretched to the terrain, shown whole with level ground beside it, or filling the terrain with its ends cut off.',
} as const satisfies EnumParam;

export const filter = {
  kind: 'enum', name: 'filter', label: 'Filter', default: 'cubic',
  options: [
    { value: 'nearest', label: 'Nearest' },
    { value: 'linear', label: 'Linear' },
    { value: 'cubic', label: 'Cubic' },
  ],
  help: 'How an image coarser than the terrain is read between its pixels: as blocks, with straight lines, or with smooth curves. A finer image is averaged, except with Nearest.',
} as const satisfies EnumParam;

export type Fit = (typeof fit.options)[number]['value'];
export type Filter = (typeof filter.options)[number]['value'];

/** The sample type of a headerless file, by its extension. Such a file has nothing else to be recognised by. */
const RAW_SAMPLES: Readonly<Record<string, 'u8' | 'u16' | 'f32'>> = { r8: 'u8', r16: 'u16', raw: 'u16', r32: 'f32' };

/** The extensions the file dialogs offer. */
export const IMAGE_FILTERS = ['png', 'tif', 'tiff', 'exr'] as const;
export const HEIGHT_FILTERS = [...IMAGE_FILTERS, 'r16', 'r32', 'r8', 'raw'] as const;

const extensionOf = (file: string): string => /\.([A-Za-z0-9]+)$/.exec(file)?.[1]?.toLowerCase() ?? '';

/**
 * Whether the samples of an image file are linear values: those of an OpenEXR file, and of a TIFF whose samples
 * are floats. Integer samples of a color image are sRGB-encoded. Reads the header only.
 */
export function holdsLinearSamples(bytes: Uint8Array): boolean {
  if (bytes.length >= 4 && bytes[0] === 0x76 && bytes[1] === 0x2f && bytes[2] === 0x31 && bytes[3] === 0x01) return true;
  const little = bytes[0] === 0x49 && bytes[1] === 0x49, big = bytes[0] === 0x4d && bytes[1] === 0x4d;
  if (bytes.length < 8 || (!little && !big)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(2, little) !== 42) return false;
  const directory = view.getUint32(4, little);
  if (directory + 2 > bytes.length) return false;
  const entries = view.getUint16(directory, little);
  for (let i = 0; i < entries; i++) {
    const entry = directory + 2 + 12 * i;
    if (entry + 12 > bytes.length) return false;
    if (view.getUint16(entry, little) !== 339) continue;
    // SampleFormat: one SHORT per sample. Up to two lie in the entry itself, more behind an offset.
    const at = view.getUint32(entry + 4, little) <= 2 ? entry + 8 : view.getUint32(entry + 8, little);
    return at + 2 <= bytes.length && view.getUint16(at, little) === 3;
  }
  return false;
}

/** The file of a `file` parameter, decoded off the engine thread, and whether its samples are linear values. */
export async function readImage(ctx: OpContext, file: string, raw: boolean): Promise<{ readonly image: DecodedImage; readonly linear: boolean }> {
  if (file === '') throw new Error('No file selected');
  const bytes = await ctx.readFile(file);
  const sample = raw ? RAW_SAMPLES[extensionOf(file)] : undefined;
  if (sample !== undefined) return { image: await ctx.cpu(decodeRaw, { bytes, sample }, [bytes.buffer]), linear: true };
  const linear = holdsLinearSamples(bytes);
  return { image: await ctx.cpu(decodeImage, { bytes }, [bytes.buffer]), linear };
}

// What lies beside a picture that is shown whole: level ground at height 0, opaque black for a color.
const BESIDE = { field: '0.0', color: 'vec4f(0.0, 0.0, 0.0, 1.0)' } as const;

// A square cut out of the middle of a picture, or the picture in the middle of a square: texel for texel.
const square = (kind: 'field' | 'color') => defineKernel({
  name: `io/import.square#${kind}`,
  inputs: { src: { kind, size: 'any' } },
  outputs: { out: kind },
  // The source texel of the square's first texel.
  params: { shift: 'vec2i' },
  cost: 1,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> out_t {
  let p = px + P.shift;
  if (any(p < vec2i(0)) || any(p >= vec2i(src_res()))) { return ${BESIDE[kind]}; }
  return src_at(p);
}`,
});

// A picture coarser than the grid, read between its texels with the Catmull-Rom cubic through the 4 x 4 around
// the position: slopes stay continuous where straight lines would facet a magnified terrain.
//
// Heights are left as the cubic gives them. Limiting them to the texels they lie between flattens every crest and
// hollow between two texels, which shading shows as a dimple at each: at 4033 from an image of 193 the terrain
// was pitted all over. A color is limited to the range of the 2 x 2 texels it lies between, so that no channel
// leaves the colors of the image, below 0 for one.
const LIMITED = { field: false, color: true } as const;
const cubic = (kind: 'field' | 'color') => defineKernel({
  name: `io/import.cubic#${kind}`,
  inputs: { src: { kind, size: 'any' } },
  outputs: { out: kind },
  // The last texel of the square the picture fills and of the written grid, per axis: texel px lies at
  // px * last / span of that square. `shift` is the texel of the square at which the picture begins: (0, 0) for a
  // picture that fills it, and more for one that is shown whole in its middle.
  params: { last: 'vec2i', span: 'vec2i', shift: 'vec2i' },
  cost: 16,
  code: /* wgsl */ `
fn weights(f: f32) -> vec4f {
  let f2 = f * f;
  let f3 = f2 * f;
  return vec4f(-0.5 * f3 + f2 - 0.5 * f, 1.5 * f3 - 2.5 * f2 + 1.0, -1.5 * f3 + 2.0 * f2 + 0.5 * f, 0.5 * f3 - 0.5 * f2);
}

fn compute(px: vec2i, uv: vec2f) -> out_t {
  // In whole numbers: at a vertex the two grids share, the position is that texel and the result is its value.
  let span = max(P.span, vec2i(1));
  let scaled = px * P.last - P.shift * span;
  // Beside a picture that is shown whole the cubic is not asked: read across the picture's border it would dip
  // below the level ground along it and rise above the picture's edge.
  if (any(scaled < vec2i(0)) || any(scaled > (vec2i(src_res()) - vec2i(1)) * span)) { return ${BESIDE[kind]}; }
  let base = scaled / span;
  let f = vec2f(scaled - base * span) / vec2f(span);
  let wx = weights(f.x);
  let wy = weights(f.y);
  // Summed as differences from the texel at or just before the position: a constant stays that constant and an
  // opaque color opaque, bit for bit.
  let anchor = src_at(base);
  var lo = anchor;
  var hi = anchor;
  var sum = out_t(0.0);
  for (var j = -1; j <= 2; j++) {
    var row = out_t(0.0);
    for (var i = -1; i <= 2; i++) {
      let v = src_at(base + vec2i(i, j));
      row += wx[i + 1] * (v - anchor);
      if (i >= 0 && i <= 1 && j >= 0 && j <= 1) {
        lo = min(lo, v);
        hi = max(hi, v);
      }
    }
    sum += wy[j + 1] * row;
  }
  return ${LIMITED[kind] ? 'clamp(anchor + sum, lo, hi)' : 'anchor + sum'};
}`,
});

const squares = { field: square('field'), color: square('color') };
const cubics = { field: cubic('field'), color: cubic('color') };

/** The kernels `place` may run for a picture of each kind: what a node lists in `kernels`. */
export const placeKernels = { field: [squares.field, cubics.field], color: [squares.color, cubics.color] } as const;

/**
 * Brings an uploaded picture of any size onto the evaluation grid and releases it. Row y of the picture stays
 * row y: nothing is flipped. A picture of exactly the grid's size is returned as it is.
 */
export function place<K extends 'field' | 'color'>(ctx: OpContext, picture: Field<K>, how: Fit, read: Filter): Field<K> {
  let source = picture;
  const { width, height } = picture;
  const res = ctx.res;
  // A picture shown whole and read with the cubic is not set into a square first: the cubic keeps to the picture.
  let inset: { readonly side: number; readonly shift: readonly [number, number] } | null = null;
  if (how !== 'stretch' && width !== height) {
    // Cover cuts the middle square out of the picture; contain sets the picture into the middle of a square.
    const side = how === 'cover' ? Math.min(width, height) : Math.max(width, height);
    const shift = how === 'cover'
      ? [Math.floor((width - side) / 2), Math.floor((height - side) / 2)] as const
      : [-Math.floor((side - width) / 2), -Math.floor((side - height) / 2)] as const;
    if (how === 'contain' && read === 'cubic' && side < res) inset = { side, shift: [-shift[0], -shift[1]] };
    else {
      source = ctx.alloc(picture.kind, { size: side }) as Field<K>;
      ctx.run(squares[picture.kind], { in: { src: picture }, out: { out: source }, params: { shift } });
      ctx.release(picture);
    }
  }

  if (source.width === res && source.height === res) return source;
  let out: Field<K>;
  if (read === 'nearest') out = ops.resample(ctx, source, { size: res, filter: 'nearest' });
  else if (inset) {
    out = ctx.alloc(source.kind) as Field<K>;
    ctx.run(cubics[source.kind], { in: { src: source }, out: { out }, params: { last: [inset.side - 1, inset.side - 1], span: [res - 1, res - 1], shift: inset.shift } });
  } else if (read === 'cubic' && (source.width < res || source.height < res)) {
    // The cubic reads every axis on which the picture is coarser than the grid. A picture that is finer than the
    // grid on its other axis keeps its texels there (at one texel per texel the cubic is the texel itself), and
    // the triangle then averages them: a wide strip is not read with straight lines along its short side. The
    // triangle is square, so it also softens the curve along that side, by less than a texel of the picture.
    const side = Math.max(res, source.width, source.height);
    const curved = ctx.alloc(source.kind, { size: side }) as Field<K>;
    ctx.run(cubics[source.kind], {
      in: { src: source }, out: { out: curved },
      params: { last: [source.width - 1, source.height - 1], span: [side - 1, side - 1], shift: [0, 0] },
    });
    if (side === res) out = curved;
    else {
      out = ops.resample(ctx, curved, { size: res, filter: 'tent' });
      ctx.release(curved);
    }
  } else {
    // A triangle as wide as the reduction where the picture is finer than the grid: its texels are averaged, not
    // skipped. Where it is coarser the triangle is the straight line between two texels.
    out = ops.resample(ctx, source, { size: res, filter: 'tent' });
  }
  ctx.release(source);
  return out;
}
