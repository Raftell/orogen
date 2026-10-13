// tests/nodes/io/_reference.ts
// What the import nodes do with a decoded picture, on the CPU in float64: the square a picture that is not square
// is cut to or set into, and the reading of a picture between its texels, with straight lines and with the
// limited cubic.
import type { FieldData } from '../../helpers/index.ts';

/** A decoded picture: `channels` floats per texel, row-major, top row first. */
export interface Picture { readonly width: number; readonly height: number; readonly channels: number; readonly data: ArrayLike<number> }

export function picture(width: number, height: number, channels: number, fn: (x: number, y: number, c: number) => number): Picture {
  const data = new Float64Array(width * height * channels);
  for (let y = 0, i = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < channels; c++) data[i++] = fn(x, y, c);
  return { width, height, channels, data };
}

const texel = (p: Picture, x: number, y: number, c: number): number =>
  p.data[(Math.min(Math.max(y, 0), p.height - 1) * p.width + Math.min(Math.max(x, 0), p.width - 1)) * p.channels + c]!;

/**
 * The square of `fit`: `cover` cuts the middle square out of the picture, `contain` sets the picture into the
 * middle of a square whose other texels are `beside` (per channel), `stretch` leaves it as it is.
 */
export function squared(p: Picture, fit: 'stretch' | 'contain' | 'cover', beside: readonly number[]): Picture {
  if (fit === 'stretch' || p.width === p.height) return p;
  const side = fit === 'cover' ? Math.min(p.width, p.height) : Math.max(p.width, p.height);
  const shiftX = fit === 'cover' ? Math.floor((p.width - side) / 2) : -Math.floor((side - p.width) / 2);
  const shiftY = fit === 'cover' ? Math.floor((p.height - side) / 2) : -Math.floor((side - p.height) / 2);
  return picture(side, side, p.channels, (x, y, c) => {
    const sx = x + shiftX, sy = y + shiftY;
    return sx < 0 || sy < 0 || sx >= p.width || sy >= p.height ? beside[c]! : texel(p, sx, sy, c);
  });
}

const weights = (f: number): readonly number[] => {
  const f2 = f * f, f3 = f2 * f;
  return [-0.5 * f3 + f2 - 0.5 * f, 1.5 * f3 - 2.5 * f2 + 1, -1.5 * f3 + 2 * f2 + 0.5 * f, 0.5 * f3 - 0.5 * f2];
};

/**
 * Channel `c` of the picture on a grid of `res` vertices a side, where texel px of the grid lies at
 * `px * (size - 1) / (res - 1)` of the picture: `linear` between the two texels around it on each axis, `cubic`
 * with the Catmull-Rom cubic through the four and, with `limited`, kept within the range of the 2 x 2 texels it
 * lies between, as a color is. With `whole` the picture is shown whole in the middle of the grid instead of
 * stretched over it.
 */
export function onGrid(p: Picture, res: number, read: 'linear' | 'cubic', c = 0, limited = false, whole?: { readonly beside: number }): FieldData {
  const data = new Float32Array(res * res);
  // `whole`: the picture lies in the middle of the square of its longer side, and is read within itself alone;
  // the grid beside it is `beside`.
  const side = Math.max(p.width, p.height);
  const lastX = whole ? side - 1 : p.width - 1, lastY = whole ? side - 1 : p.height - 1;
  const shiftX = whole ? Math.floor((side - p.width) / 2) : 0, shiftY = whole ? Math.floor((side - p.height) / 2) : 0;
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      // In whole numbers, as the kernel finds it: exact at the vertices the two grids share.
      const sx = x * lastX - shiftX * (res - 1), sy = y * lastY - shiftY * (res - 1);
      if (sx < 0 || sy < 0 || sx > (p.width - 1) * (res - 1) || sy > (p.height - 1) * (res - 1)) {
        data[y * res + x] = whole!.beside;
        continue;
      }
      const bx = Math.floor(sx / (res - 1)), by = Math.floor(sy / (res - 1));
      const fx = (sx - bx * (res - 1)) / (res - 1), fy = (sy - by * (res - 1)) / (res - 1);
      let v: number;
      if (read === 'linear') {
        v = (1 - fy) * ((1 - fx) * texel(p, bx, by, c) + fx * texel(p, bx + 1, by, c)) + fy * ((1 - fx) * texel(p, bx, by + 1, c) + fx * texel(p, bx + 1, by + 1, c));
      } else {
        const wx = weights(fx), wy = weights(fy);
        let sum = 0, lo = Infinity, hi = -Infinity;
        for (let j = -1; j <= 2; j++) {
          for (let i = -1; i <= 2; i++) {
            const t = texel(p, bx + i, by + j, c);
            sum += wy[j + 1]! * wx[i + 1]! * t;
            if (i >= 0 && i <= 1 && j >= 0 && j <= 1) {
              lo = Math.min(lo, t);
              hi = Math.max(hi, t);
            }
          }
        }
        v = limited ? Math.min(Math.max(sum, lo), hi) : sum;
      }
      data[y * res + x] = v;
    }
  }
  return { kind: 'field', width: res, height: res, channels: 1, data };
}

/** The field without its outermost `margin` texels on every side. */
export function inner(f: FieldData, margin: number): FieldData {
  const size = f.width - 2 * margin;
  const data = new Float32Array(size * size * f.channels);
  for (let y = 0; y < size; y++) {
    data.set(f.data.subarray(((y + margin) * f.width + margin) * f.channels, ((y + margin) * f.width + margin + size) * f.channels), y * size * f.channels);
  }
  return { ...f, width: size, height: size, data };
}
