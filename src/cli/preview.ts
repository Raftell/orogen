// The pictures of testing.md 2.7, computed on the CPU from the data alone: a picture depends on the values and
// never on the adapter. This module is the drawing and nothing else, and it imports nothing: the harness's
// writePreview and the `render` and `gallery` subcommands draw with this one implementation.

export interface Raster {
  readonly kind: 'field' | 'color';
  readonly width: number;
  readonly height: number;
  readonly channels: 1 | 4;
  readonly data: Float32Array;              // row-major, tightly packed
}

/** 8-bit RGB, row 0 first: pixel (x, y) is at (y * width + x) * 3. */
export interface Picture {
  readonly width: number;
  readonly height: number;
  readonly rgb: Uint8Array;
}

export type DrawStyle = 'grey' | 'hillshade' | '3d' | 'color' | 'sheet';

/**
 * How the values of a field become black to white: linearly from `lo` to `hi`, or, with `log`, by their
 * logarithm, where `lo` and everything below it is black.
 */
export interface Tone { readonly lo: number; readonly hi: number; readonly log: boolean }

export interface DrawOptions {
  readonly style?: DrawStyle;                                 // default: 'sheet' for a field, 'color' for a colour
  /**
   * The values drawn black and white. Default [0, 1]; 'auto' is [min, max]; 'data' is 'auto' for most fields and
   * a logarithmic scale for one that spans orders of magnitude (toneOf); a Tone is taken as it is.
   */
  readonly range?: readonly [number, number] | 'auto' | 'data' | Tone;
  readonly height?: Raster;                                   // the terrain to shade when `f` is a mask or a colour, which is drawn over it
  readonly lit?: boolean;                                     // '3d' of a colour over a terrain: false draws the colour as it is. Default true
  readonly terrainSize?: number;                              // metres; default 4096
  readonly heightRange?: number;                              // metres; default 1024
  readonly crop?: readonly [x: number, y: number, size: number];
}

const BACKGROUND: readonly [number, number, number] = [0x1a, 0x1a, 0x1a];
const MAGENTA: readonly [number, number, number] = [1, 0, 1];
/** What a mask or a data field of value 1 turns the shaded terrain into. */
const TINT: readonly [number, number, number] = [1, 0.28, 0.08];
const VIEW_WIDTH = 768;
const VIEW_HEIGHT = 512;
const PANEL = 512;
const GAP = 8;

// The light of a shaded field: towards the light, normalize(−1, −1, √2), the upper left of the map.
const LIGHT: readonly [number, number, number] = [-0.5, -0.5, Math.SQRT1_2];
/**
 * The light of a colour drawn over a terrain in the `3d` view: normalize(−1, 1, √2), the light of the map
 * mirrored to the viewer's side. The view looks at the slopes that face +Y, and the light of the map comes
 * from −Y, behind them: every face a viewer sees was in the shade, and a colouring looked dark whatever it was.
 */
const VIEW_LIGHT: readonly [number, number, number] = [-0.5, 0.5, Math.SQRT1_2];

/** `map`: the light of a shaded field. `view`: that of a colour seen in the 3d view. `flat`: none; what is drawn over the terrain is shown as it is. */
type Lighting = 'map' | 'view' | 'flat';

/**
 * Intensity of a surface with the unit normal n: 0.10 + 0.80·((1 + n·L) / 2)², which is 0.68 on level ground
 * and stays within 0.10..0.90. The wrapped term keeps a gradation on slopes that face away from the light,
 * where max(n·L, 0) is 0 on every slope above 45°: a terrain of physical steepness is otherwise drawn in two
 * tones. Measured on `ref/fbm` at 513 with the test settings (mean slope 44°): a quarter of the texels each in
 * 0.2..0.4, 0.4..0.6, 0.6..0.8 and 0.8..0.9, none clipped.
 *
 * Under the light of the view a colour keeps more of itself: 0.30 + 0.70·((1 + n·L) / 2)², 0.81 on level ground
 * and 1 on a face turned to the light, so that a colouring is seen as bright as it is where the viewer looks.
 */
function lit(nx: number, ny: number, nz: number, lighting: Lighting = 'map'): number {
  if (lighting === 'flat') return 1;
  const light = lighting === 'view' ? VIEW_LIGHT : LIGHT;
  const wrapped = 0.5 + 0.5 * (nx * light[0] + ny * light[1] + nz * light[2]);
  return lighting === 'view' ? 0.30 + 0.70 * wrapped * wrapped : 0.10 + 0.80 * wrapped * wrapped;
}

const saturate = (v: number): number => Math.min(1, Math.max(0, v));
const srgb = (linear: number): number => {
  const c = saturate(linear);
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
};
const byte = (unit: number): number => Math.round(saturate(unit) * 255);

/** The pixels of a picture of the background colour. */
function backdrop(width: number, height: number): Uint8Array {
  const rgb = new Uint8Array(width * height * 3);
  for (let at = 0; at < rgb.length; at += 3) {
    rgb[at] = BACKGROUND[0];
    rgb[at + 1] = BACKGROUND[1];
    rgb[at + 2] = BACKGROUND[2];
  }
  return rgb;
}

function checkRaster(r: Raster, what: string): void {
  const kindOk = (r?.kind === 'field' && r.channels === 1) || (r?.kind === 'color' && r.channels === 4);
  if (!kindOk || !(r.data instanceof Float32Array) || r.data.length !== r.width * r.height * r.channels || r.width < 1 || r.height < 1) {
    throw new TypeError(`${what} is not field data of width x height x channels floats`);
  }
}

function cropped(r: Raster, window: readonly [number, number, number]): Raster {
  const [x0, y0, size] = window;
  if (![x0, y0, size].every(Number.isInteger) || size < 1 || x0 < 0 || y0 < 0 || x0 + size > r.width || y0 + size > r.height) {
    throw new RangeError(`The crop [${window.join(', ')}] is not a square window of a ${r.width} x ${r.height} field`);
  }
  const data = new Float32Array(size * size * r.channels);
  for (let y = 0; y < size; y++) {
    const from = ((y0 + y) * r.width + x0) * r.channels;
    data.set(r.data.subarray(from, from + size * r.channels), y * size * r.channels);
  }
  return { kind: r.kind, width: size, height: size, channels: r.channels, data };
}

/** One number per texel: the value of a field, the luma of a colour. */
function scalar(r: Raster, texel: number): number {
  if (r.channels === 1) return r.data[texel]!;
  const at = texel * 4;
  return 0.2126 * r.data[at]! + 0.7152 * r.data[at + 1]! + 0.0722 * r.data[at + 2]!;
}

/** At most this many values of a field are ranked for a percentile; a larger field is read at a stride. */
const RANKED = 1 << 20;
/** A field whose largest value is more than this many times its mean spans orders of magnitude: drawn linearly its picture is black. */
const LOG_SPREAD = 100;
/** A logarithmic scale reaches this far below the largest value at the most: four decades. */
const LOG_DEPTH = 1e4;

const isTone = (range: DrawOptions['range']): range is Tone => typeof range === 'object' && range !== null && !Array.isArray(range);

/**
 * The scale `range` gives the values of `r`.
 *
 * `'data'` is the scale of a data output. It is `'auto'`, the smallest value black and the largest white, unless
 * the field holds no negative value and its largest value is more than a hundred times its mean. Such a field
 * spans orders of magnitude between what is typical of it and what is largest: a drainage area, a discharge,
 * the depth of rivers, which are lines on a terrain where there is none. Drawn linearly it is black but for a few
 * texels, its mean under a hundredth of white, so it is drawn by the logarithm of its values: the largest is
 * white, and black is the first percentile of the positive values or a ten-thousandth of the largest, whichever
 * is larger. Zero is black. The percentile is that of every `stride`-th value where the field has more than 2^20.
 */
export function toneOf(r: Raster, range: DrawOptions['range']): Tone {
  if (isTone(range)) {
    if (!(Number.isFinite(range.lo) && Number.isFinite(range.hi) && range.lo <= range.hi && (!range.log || range.lo > 0))) {
      throw new RangeError(`The scale ${JSON.stringify(range)} is not a pair of numbers in order, above 0 for a logarithmic one`);
    }
    return range;
  }
  if (range !== undefined && range !== 'auto' && range !== 'data') {
    if (!(Number.isFinite(range[0]) && Number.isFinite(range[1]) && range[0] <= range[1])) throw new RangeError(`The range [${range.join(', ')}] is not a pair of numbers in order`);
    return { lo: range[0], hi: range[1], log: false };
  }
  if (range === undefined) return { lo: 0, hi: 1, log: false };
  const count = r.width * r.height;
  let lo = Infinity, hi = -Infinity, sum = 0, finite = 0;
  for (let i = 0; i < count; i++) {
    const v = scalar(r, i);
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    sum += v;
    finite++;
  }
  if (!(lo <= hi)) return { lo: 0, hi: 1, log: false };
  if (range === 'auto' || lo < 0 || !(hi > LOG_SPREAD * (sum / finite))) return { lo, hi, log: false };

  const stride = Math.max(1, Math.ceil(count / RANKED));
  const positive = new Float32Array(Math.ceil(count / stride));
  let kept = 0;
  for (let i = 0; i < count; i += stride) {
    const v = scalar(r, i);
    if (Number.isFinite(v) && v > 0) positive[kept++] = v;
  }
  // Every stride-th value may miss the few that are above 0: the foot of the scale is then its depth below the largest.
  const ranked = positive.subarray(0, kept).sort();
  const first = kept > 0 ? ranked[Math.floor(0.01 * (kept - 1))]! : 0;
  return { lo: Math.min(hi, Math.max(first, hi / LOG_DEPTH)), hi, log: true };
}

/** Where `v` lies on the scale: 0 at black, 1 at white; outside 0..1 beyond them. A scale without a span puts every value in the middle. */
function placed(tone: Tone, v: number): number {
  if (tone.log) return v <= tone.lo ? 0 : tone.hi > tone.lo ? Math.log(v / tone.lo) / Math.log(tone.hi / tone.lo) : 0.5;
  return tone.hi > tone.lo ? (v - tone.lo) / (tone.hi - tone.lo) : 0.5;
}

/**
 * The scale mapped to black..white; below a linear one blue, above it red, a value that is not finite magenta.
 * Below a logarithmic scale lies what counts as nothing, which is black as the foot of the scale is.
 */
function drawGrey(f: Raster, tone: Tone): Picture {
  const rgb = new Uint8Array(f.width * f.height * 3);
  for (let i = 0; i < f.width * f.height; i++) {
    const v = scalar(f, i);
    const at = i * 3;
    if (!Number.isFinite(v)) {
      rgb[at] = 255;
      rgb[at + 2] = 255;
    } else if (!tone.log && v < tone.lo) rgb[at + 2] = 255;
    else if (v > tone.hi) rgb[at] = 255;
    else {
      // A constant field under 'auto' has no span: it is drawn mid-grey.
      const grey = tone.hi > tone.lo ? byte(placed(tone, v)) : 128;
      rgb[at] = grey;
      rgb[at + 1] = grey;
      rgb[at + 2] = grey;
    }
  }
  return { width: f.width, height: f.height, rgb };
}

/** Linear RGB encoded as sRGB, clamped; alpha ignored. */
function drawColor(f: Raster): Picture {
  if (f.kind !== 'color') throw new TypeError("The style 'color' draws a colour; a field is drawn with 'grey', 'hillshade', '3d' or 'sheet'");
  const rgb = new Uint8Array(f.width * f.height * 3);
  for (let i = 0; i < f.width * f.height; i++) {
    for (let c = 0; c < 3; c++) {
      const v = f.data[i * 4 + c]!;
      rgb[i * 3 + c] = byte(srgb(Number.isFinite(v) ? v : 0));
    }
    if (![0, 1, 2].every((c) => Number.isFinite(f.data[i * 4 + c]!))) rgb.set([255, 0, 255], i * 3);
  }
  return { width: f.width, height: f.height, rgb };
}

interface Surface {
  readonly width: number;
  readonly height: number;
  /** Heights in metres, with 0 where the data is not finite. All 0 when there is no terrain to shade. */
  readonly z: Float32Array;
  /** What the surface shows at each texel, in display units 0..1: the shading times what is drawn over it. */
  readonly rgb: Float32Array;
}

/** The shaded terrain: `opts.height` with `f` drawn over it, or `f` itself when it is a field and no terrain is given. */
function surfaceOf(f: Raster, opts: DrawOptions, lighting: Lighting = 'map'): Surface {
  const terrainSize = opts.terrainSize ?? 4096;
  const heightRange = opts.heightRange ?? 1024;
  if (!(terrainSize > 0) || !(heightRange > 0)) throw new RangeError('terrainSize and heightRange are metres above 0');
  const over = opts.height !== undefined;
  const terrain = opts.height ?? (f.kind === 'field' ? f : null);
  if (terrain && (terrain.kind !== 'field' || terrain.width !== f.width || terrain.height !== f.height)) {
    throw new TypeError(`The terrain to shade is a field of the size of the data drawn over it (${f.width} x ${f.height})`);
  }
  const { width, height } = f;
  const count = width * height;
  const z = new Float32Array(count);
  const bad = new Uint8Array(count);
  if (terrain) {
    for (let i = 0; i < count; i++) {
      const h = terrain.data[i]!;
      if (Number.isFinite(h)) z[i] = Math.min(4, Math.max(-4, h)) * heightRange;   // a height far outside the range is drawn at its edge
      else bad[i] = 1;
    }
  }

  const tone = over && f.kind === 'field' ? toneOf(f, opts.range) : null;
  const rgb = new Float32Array(count * 3);
  const cellX = terrainSize / Math.max(width - 1, 1);
  const cellY = terrainSize / Math.max(height - 1, 1);
  for (let y = 0; y < height; y++) {
    const up = Math.max(y - 1, 0), down = Math.min(y + 1, height - 1);
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const left = Math.max(x - 1, 0), right = Math.min(x + 1, width - 1);
      // Central differences of the physical surface; one-sided on the border.
      const dx = right > left ? (z[y * width + right]! - z[y * width + left]!) / ((right - left) * cellX) : 0;
      const dy = down > up ? (z[down * width + x]! - z[up * width + x]!) / ((down - up) * cellY) : 0;
      const norm = Math.hypot(dx, dy, 1);
      const intensity = lit(-dx / norm, -dy / norm, 1 / norm, lighting);

      // What is drawn over the shading: nothing (white), the colour, or the tint of a mask or a data field.
      let red = 1, green = 1, blue = 1;
      let broken = bad[i] === 1;
      if (f.kind === 'color') {
        const r = f.data[i * 4]!, g = f.data[i * 4 + 1]!, b = f.data[i * 4 + 2]!;
        if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
          red = srgb(r);
          green = srgb(g);
          blue = srgb(b);
        } else broken = true;
      } else if (over) {
        const v = f.data[i]!;
        if (Number.isFinite(v)) {
          const t = tone!.hi > tone!.lo ? saturate(placed(tone!, v)) : 0;
          red = 1 + (TINT[0] - 1) * t;
          green = 1 + (TINT[1] - 1) * t;
          blue = 1 + (TINT[2] - 1) * t;
        } else broken = true;
      }
      rgb[i * 3] = broken ? MAGENTA[0] : intensity * red;
      rgb[i * 3 + 1] = broken ? MAGENTA[1] : intensity * green;
      rgb[i * 3 + 2] = broken ? MAGENTA[2] : intensity * blue;
    }
  }
  return { width, height, z, rgb };
}

function drawHillshade(surface: Surface): Picture {
  const rgb = new Uint8Array(surface.rgb.length);
  for (let i = 0; i < rgb.length; i++) rgb[i] = byte(surface.rgb[i]!);
  return { width: surface.width, height: surface.height, rgb };
}

/**
 * Orthographic view from 30° above the horizon, looking towards −Y and turned 25° about Z: row 0 is at the
 * back and +X runs to the right, so the view is the top view tilted, never its mirror image. Heights and
 * distances have one scale. The two sides that face the viewer are drawn down to height 0.
 */
function drawView(surface: Surface, terrainSize: number): Picture {
  const { width, height, z } = surface;
  const rgb = backdrop(VIEW_WIDTH, VIEW_HEIGHT);

  const turn = (25 * Math.PI) / 180;
  const elevation = (30 * Math.PI) / 180;
  const cosT = Math.cos(turn), sinT = Math.sin(turn), sinE = Math.sin(elevation), cosE = Math.cos(elevation);
  let zMin = 0, zMax = 0;
  for (const v of z) {
    if (v < zMin) zMin = v;
    if (v > zMax) zMax = v;
  }
  // Across the screen the terrain spans its two projected sides; down the screen the same span foreshortened, plus the relief.
  const half = 0.5 * terrainSize * (cosT + sinT);
  const margin = 16;
  const scale = Math.min((VIEW_WIDTH - 2 * margin) / (2 * half), (VIEW_HEIGHT - 2 * margin) / (2 * half * sinE + (zMax - zMin) * cosE));
  const centreX = VIEW_WIDTH / 2;
  const centreY = VIEW_HEIGHT / 2 + 0.5 * (zMax + zMin) * cosE * scale;

  const texelsX = (width - 1) / terrainSize, texelsY = (height - 1) / terrainSize;
  const maxX0 = Math.max(width - 2, 0), maxY0 = Math.max(height - 2, 0);
  const colors = surface.rgb;

  // The side through which a column of the screen enters the terrain: the front (normal +Y) or the left (normal −X).
  // Both stand out from the background, and the lit one from the other.
  const front = 0.2 + 0.4 * lit(0, 1, 0), side = 0.2 + 0.4 * lit(-1, 0, 0);
  const step = 0.5 / (scale * sinE);              // half a pixel down the screen per sample
  const steps = Math.ceil((2 * half) / step) + 2;   // the bound of the march along one column

  for (let sx = 0; sx < VIEW_WIDTH; sx++) {
    const across = (sx + 0.5 - centreX) / scale;
    // Along the column, towards the viewer by `b` metres: (x, y) = centre + across·(cosT, sinT) + b·(−sinT, cosT).
    const baseX = terrainSize / 2 + across * cosT, baseY = terrainSize / 2 + across * sinT;
    // The part of the column inside the terrain square: 0 <= x <= size and 0 <= y <= size.
    const nearX = baseX / sinT, farX = (baseX - terrainSize) / sinT;
    const nearY = (terrainSize - baseY) / cosT, farY = -baseY / cosT;
    const near = Math.min(nearX, nearY), far = Math.max(farX, farY);
    if (!(near > far)) continue;
    const wall = nearY <= nearX ? front : side;

    let horizon = Infinity;
    for (let n = 0, b = near; n < steps && b >= far; n++, b = near - n * step) {
      // Bilinear between the four texels around the terrain position (px, py), in metres.
      const px = baseX - b * sinT, py = baseY + b * cosT;
      const fx = Math.min(Math.max(px * texelsX, 0), width - 1), fy = Math.min(Math.max(py * texelsY, 0), height - 1);
      const x0 = Math.min(Math.floor(fx), maxX0), y0 = Math.min(Math.floor(fy), maxY0);
      const tx = fx - x0, ty = fy - y0;
      const i00 = y0 * width + x0, i10 = y0 * width + Math.min(x0 + 1, width - 1);
      const i01 = Math.min(y0 + 1, height - 1) * width + x0, i11 = i01 + (i10 - i00);
      const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
      const h = z[i00]! * w00 + z[i10]! * w10 + z[i01]! * w01 + z[i11]! * w11;
      const sy = centreY + (b * sinE - h * cosE) * scale;
      if (n === 0) {
        // The side, from the surface down to height 0. Where the surface lies below 0 the side faces inwards and is not seen.
        const foot = centreY + b * sinE * scale;
        if (sy < foot) fillColumn(rgb, sx, sy, foot, wall, wall, wall);
        horizon = sy;
        continue;
      }
      if (sy >= horizon) continue;
      // A sample that reaches no new pixel centre is hidden as well as one below the horizon.
      if (Math.ceil(sy - 0.5) < Math.ceil(horizon - 0.5)) {
        fillColumn(
          rgb, sx, sy, horizon,
          colors[i00 * 3]! * w00 + colors[i10 * 3]! * w10 + colors[i01 * 3]! * w01 + colors[i11 * 3]! * w11,
          colors[i00 * 3 + 1]! * w00 + colors[i10 * 3 + 1]! * w10 + colors[i01 * 3 + 1]! * w01 + colors[i11 * 3 + 1]! * w11,
          colors[i00 * 3 + 2]! * w00 + colors[i10 * 3 + 2]! * w10 + colors[i01 * 3 + 2]! * w01 + colors[i11 * 3 + 2]! * w11,
        );
      }
      horizon = sy;
    }
  }
  return { width: VIEW_WIDTH, height: VIEW_HEIGHT, rgb };
}

/** Paints the pixels of one screen column whose centres lie in [from, to). */
function fillColumn(rgb: Uint8Array, sx: number, from: number, to: number, r: number, g: number, b: number): void {
  const first = Math.max(Math.ceil(from - 0.5), 0), last = Math.min(Math.ceil(to - 0.5), VIEW_HEIGHT);
  for (let sy = first; sy < last; sy++) {
    const at = (sy * VIEW_WIDTH + sx) * 3;
    rgb[at] = byte(r);
    rgb[at + 1] = byte(g);
    rgb[at + 2] = byte(b);
  }
}

/** `picture` scaled to PANEL x PANEL by taking the nearest texel, written into `sheet` at column `left`. */
function placeScaled(sheet: Picture, picture: Picture, left: number): void {
  for (let y = 0; y < PANEL; y++) {
    const fromY = Math.min(Math.floor(((y + 0.5) * picture.height) / PANEL), picture.height - 1);
    for (let x = 0; x < PANEL; x++) {
      const fromX = Math.min(Math.floor(((x + 0.5) * picture.width) / PANEL), picture.width - 1);
      const from = (fromY * picture.width + fromX) * 3, to = (y * sheet.width + left + x) * 3;
      sheet.rgb[to] = picture.rgb[from]!;
      sheet.rgb[to + 1] = picture.rgb[from + 1]!;
      sheet.rgb[to + 2] = picture.rgb[from + 2]!;
    }
  }
}

/** The picture of `f` in one style of testing.md 2.7. */
export function drawPreview(f: Raster, opts: DrawOptions = {}): Picture {
  checkRaster(f, 'The data to draw');
  if (opts.height) checkRaster(opts.height, 'The terrain to shade');
  const style = opts.style ?? (f.kind === 'color' ? 'color' : 'sheet');
  if (opts.crop) {
    const { crop, ...rest } = opts;
    return drawPreview(cropped(f, crop), { ...rest, ...(opts.height ? { height: cropped(opts.height, crop) } : {}) });
  }
  const terrainSize = opts.terrainSize ?? 4096;
  // The view of a colour is lit from the viewer's side, or not at all; a field keeps the light of the map in
  // every picture, so that its view is its top view tilted.
  const viewLighting: Lighting = f.kind !== 'color' ? 'map' : opts.lit === false ? 'flat' : 'view';
  // One scale for the panels of a sheet: a percentile is ranked once.
  const scaled = f.kind === 'field' && (style === 'grey' || style === 'sheet' || opts.height !== undefined) ? { ...opts, range: toneOf(f, opts.range) } : opts;
  switch (style) {
    case 'grey': return drawGrey(f, toneOf(f, scaled.range));
    case 'color': return drawColor(f);
    case 'hillshade': return drawHillshade(surfaceOf(f, scaled));
    case '3d': return drawView(surfaceOf(f, scaled, viewLighting), terrainSize);
    case 'sheet': {
      const surface = surfaceOf(f, scaled);
      const sheetWidth = 2 * PANEL + VIEW_WIDTH + 2 * GAP;
      const sheet: Picture = { width: sheetWidth, height: PANEL, rgb: backdrop(sheetWidth, PANEL) };
      placeScaled(sheet, f.kind === 'color' ? drawColor(f) : drawGrey(f, toneOf(f, scaled.range)), 0);
      placeScaled(sheet, drawHillshade(surface), PANEL + GAP);
      const view = drawView(viewLighting === 'map' ? surface : surfaceOf(f, scaled, viewLighting), terrainSize);
      for (let y = 0; y < VIEW_HEIGHT; y++) {
        const row = view.rgb.subarray(y * VIEW_WIDTH * 3, (y + 1) * VIEW_WIDTH * 3);
        sheet.rgb.set(row, (y * sheet.width + 2 * (PANEL + GAP)) * 3);
      }
      return sheet;
    }
    default: throw new TypeError(`"${String(style)}" is not a preview style; the styles are grey, hillshade, 3d, color and sheet`);
  }
}
