import { guarded, type ScopeResult } from './scopes.ts';

/** engine.md 3.12. */
const LUT_MAX_LENGTH = 1_048_576;

/** Bytes of the buffer behind a LUT of `length` elements. */
export function lutBytes(type: 'f32' | 'vec4f', length: number): number {
  return length * (type === 'vec4f' ? 16 : 4);
}

/**
 * The read-only storage buffer behind a Lut: created with its contents and never rewritten (runtime.md 3.2 rule 5).
 * RangeError for a length outside 1 .. 1 048 576 elements or, for 'vec4f', a data length that is not a multiple of 4.
 */
export function createLutBuffer(device: GPUDevice, data: Float32Array, type: 'f32' | 'vec4f'): { readonly buffer: GPUBuffer; readonly scopes: ScopeResult } {
  if (type !== 'f32' && type !== 'vec4f') throw new TypeError(`A LUT has type "f32" or "vec4f", not "${String(type)}"`);
  if (type === 'vec4f' && data.length % 4 !== 0) {
    throw new RangeError(`A vec4f LUT needs a multiple of 4 floats; the data has ${data.length}`);
  }
  const length = type === 'vec4f' ? data.length / 4 : data.length;
  if (length < 1 || length > LUT_MAX_LENGTH) {
    throw new RangeError(`A LUT has 1 to ${LUT_MAX_LENGTH} elements; the data has ${length}`);
  }
  const { value: buffer, scopes } = guarded(device, () => {
    const made = device.createBuffer({ label: `lut ${type} ${length}`, size: data.byteLength, usage: GPUBufferUsage.STORAGE, mappedAtCreation: true });
    new Float32Array(made.getMappedRange()).set(data);
    made.unmap();
    return made;
  });
  return { buffer, scopes };
}
