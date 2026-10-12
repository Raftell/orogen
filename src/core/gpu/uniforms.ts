import type { UniformType } from './kernel.ts';

export const WGSL_LAYOUT = {
  f32: [4, 4], i32: [4, 4], u32: [4, 4], vec2f: [8, 8], vec2i: [8, 8], vec2u: [8, 8], vec3f: [16, 12], vec4f: [16, 16],
} as const;   // [alignment, size]

export interface ParamsLayout {
  fields: { name: string; type: UniformType; offset: number }[];
  size: number;
}

/** engine.md 3.10: declaration order, WGSL layout rules, nothing reordered. */
export function packLayout(params: Record<string, UniformType>): ParamsLayout {
  let cursor = 0, maxAlign = 4;
  const fields: { name: string; type: UniformType; offset: number }[] = [];
  for (const [name, type] of Object.entries(params)) {
    const [align, size] = WGSL_LAYOUT[type];
    const offset = Math.ceil(cursor / align) * align;
    fields.push({ name, type, offset });
    cursor = offset + size;
    maxAlign = Math.max(maxAlign, align);
  }
  return { fields, size: Math.ceil(cursor / maxAlign) * maxAlign };
}

/** Components and scalar representation of each uniform type. */
export const UNIFORM_SHAPE: Readonly<Record<UniformType, { readonly count: 1 | 2 | 3 | 4; readonly scalar: 'f32' | 'i32' | 'u32' }>> = {
  f32: { count: 1, scalar: 'f32' }, i32: { count: 1, scalar: 'i32' }, u32: { count: 1, scalar: 'u32' },
  vec2f: { count: 2, scalar: 'f32' }, vec2i: { count: 2, scalar: 'i32' }, vec2u: { count: 2, scalar: 'u32' },
  vec3f: { count: 3, scalar: 'f32' }, vec4f: { count: 4, scalar: 'f32' },
};

/** Writes the values of one run's params at `offset`. The values have passed checkBindings. */
export function writeParams(layout: ParamsLayout, values: Readonly<Record<string, number | boolean | readonly number[]>>, target: DataView, offset: number): void {
  for (const field of layout.fields) {
    const { count, scalar } = UNIFORM_SHAPE[field.type];
    const value = values[field.name]!;
    for (let k = 0; k < count; k++) {
      const component = typeof value === 'object' ? value[k]! : value === true ? 1 : value === false ? 0 : value;
      const at = offset + field.offset + 4 * k;
      if (scalar === 'f32') target.setFloat32(at, component, true);
      else if (scalar === 'i32') target.setInt32(at, component, true);
      else target.setUint32(at, component, true);
    }
  }
}

/** The members of `struct Frame` (engine.md section 2). */
export interface FrameValues {
  readonly res: readonly [number, number];
  readonly tileOrigin: readonly [number, number];
  readonly terrainSize: number;
  readonly cellSize: number;
  readonly heightRange: number;
  readonly seed: number;
  readonly iteration: number;
  readonly bound: number;
}

/** Size of `struct Frame` in bytes. */
export const FRAME_BYTES = 40;
/** Size of one slot of the uniform arena: a Frame or a Params (engine.md 3.11, runtime.md 3.2). */
export const UNIFORM_SLOT_BYTES = 256;

export function writeFrame(frame: FrameValues, target: DataView, offset: number): void {
  target.setUint32(offset + 0, frame.res[0], true);
  target.setUint32(offset + 4, frame.res[1], true);
  target.setUint32(offset + 8, frame.tileOrigin[0], true);
  target.setUint32(offset + 12, frame.tileOrigin[1], true);
  target.setFloat32(offset + 16, frame.terrainSize, true);
  target.setFloat32(offset + 20, frame.cellSize, true);
  target.setFloat32(offset + 24, frame.heightRange, true);
  target.setUint32(offset + 28, frame.seed, true);
  target.setUint32(offset + 32, frame.iteration, true);
  target.setUint32(offset + 36, frame.bound, true);
}
