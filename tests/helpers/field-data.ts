export interface FieldData {
  readonly kind: 'field' | 'color';
  readonly width: number;
  readonly height: number;
  readonly channels: 1 | 4;
  readonly data: Float32Array;              // row-major, tightly packed: the layout of ctx.read (engine.md 4.7)
}

function checkRes(res: number): void {
  if (!Number.isInteger(res) || res < 1 || res > 8192) throw new RangeError(`A field has 1 to 8192 texels per side, not ${String(res)}`);
}

/** uv = px / (res − 1); for a single texel the divisor is 1 (engine.md 1.1). */
const coordinate = (i: number, res: number): number => i / Math.max(res - 1, 1);

export function fieldOf(res: number, fn: (u: number, v: number) => number): FieldData {
  checkRes(res);
  const data = new Float32Array(res * res);
  for (let y = 0; y < res; y++) {
    const v = coordinate(y, res);
    for (let x = 0; x < res; x++) data[y * res + x] = fn(coordinate(x, res), v);
  }
  return { kind: 'field', width: res, height: res, channels: 1, data };
}

export function colorOf(res: number, fn: (u: number, v: number) => readonly [number, number, number, number]): FieldData {
  checkRes(res);
  const data = new Float32Array(res * res * 4);
  for (let y = 0; y < res; y++) {
    const v = coordinate(y, res);
    for (let x = 0; x < res; x++) {
      const rgba = fn(coordinate(x, res), v);
      const at = (y * res + x) * 4;
      data[at] = rgba[0];
      data[at + 1] = rgba[1];
      data[at + 2] = rgba[2];
      data[at + 3] = rgba[3];
    }
  }
  return { kind: 'color', width: res, height: res, channels: 4, data };
}

export function at(f: FieldData, x: number, y: number, channel = 0): number {      // channel defaults to 0
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= f.width || y >= f.height) {
    throw new RangeError(`(${x}, ${y}) is not a texel of a ${f.width} x ${f.height} field`);
  }
  if (!Number.isInteger(channel) || channel < 0 || channel >= f.channels) {
    throw new RangeError(`Channel ${channel} does not exist: the field has ${f.channels}`);
  }
  return f.data[(y * f.width + x) * f.channels + channel]!;
}

export function channelOf(f: FieldData, channel: 0 | 1 | 2 | 3): FieldData {            // a 'field' holding one channel of a colour
  if (!Number.isInteger(channel) || channel < 0 || channel >= f.channels) {
    throw new RangeError(`Channel ${channel} does not exist: the field has ${f.channels}`);
  }
  const count = f.width * f.height;
  const data = new Float32Array(count);
  for (let i = 0; i < count; i++) data[i] = f.data[i * f.channels + channel]!;
  return { kind: 'field', width: f.width, height: f.height, channels: 1, data };
}

/** Throws unless `f` has the shape its members claim: what every harness function that takes data relies on. */
export function checkFieldData(f: FieldData, what: string): void {
  const kindOk = (f?.kind === 'field' && f.channels === 1) || (f?.kind === 'color' && f.channels === 4);
  if (!kindOk || !(f.data instanceof Float32Array) || !Number.isInteger(f.width) || !Number.isInteger(f.height) || f.width < 1 || f.height < 1) {
    throw new TypeError(`${what} is not field data: a 'field' with 1 channel or a 'color' with 4, as Float32Array`);
  }
  if (f.data.length !== f.width * f.height * f.channels) {
    throw new RangeError(`${what} holds ${f.data.length} floats; ${f.width} x ${f.height} x ${f.channels} is ${f.width * f.height * f.channels}`);
  }
}
