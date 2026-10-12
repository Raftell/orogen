import type { GpuContext } from './device.ts';
import type { FieldKind, Rgba } from './field.ts';
import { BYTES_PER_TEXEL } from './pool.ts';
import { guarded, type ScopeResult } from './scopes.ts';

/** The framework-owned 1 x 1 textures of engine.md 3.11. */
export interface DefaultTextures {
  /** What an unbound input with the given default reads. A number fills every channel. Cached by value. */
  input(value: number | Rgba): GPUTextureView;
  /** The sink of a null target of the given kind. `slot` is the index of the target among the run's writable targets: a distinct sink per slot. */
  sink(kind: FieldKind, slot: number): GPUTextureView;
  /** The pops of the textures created since the last call, for the owner on whose behalf they were made (runtime.md 5.8 rule 3). */
  takeScopes(): readonly ScopeResult[];
  /** Not called for a lost device. */
  dispose(): void;
}

export function createDefaultTextures(gpu: GpuContext, reserve: (bytes: number, label: string) => { release(): void }): DefaultTextures {
  const device = gpu.device;
  const inputs = new Map<string, GPUTextureView>();
  const sinks = new Map<string, GPUTextureView>();
  const owned: { readonly texture: GPUTexture; readonly reservation: { release(): void } }[] = [];
  let scopes: ScopeResult[] = [];

  function create(format: GPUTextureFormat, usage: number, label: string, fill?: Float32Array<ArrayBuffer>): GPUTextureView {
    const made = guarded(device, () => {
      const texture = device.createTexture({ label, size: [1, 1], format, usage });
      // A new texture: no encoded command refers to it yet, so this write needs no place in the stream's order.
      if (fill) device.queue.writeTexture({ texture }, fill, {}, [1, 1]);
      return { texture, view: texture.createView() };
    });
    scopes.push(made.scopes);
    owned.push({ texture: made.value.texture, reservation: reserve(BYTES_PER_TEXEL[format as keyof typeof BYTES_PER_TEXEL], label) });
    return made.value.view;
  }

  return {
    input(value) {
      const rgba = typeof value === 'number' ? [value, value, value, value] : [...value];
      const key = rgba.join(',');
      let view = inputs.get(key);
      if (!view) {
        // One format serves every channel count: ld reads .r, ld2 .rg and ld4 all four.
        view = create('rgba32float', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, `default ${key}`, new Float32Array(rgba));
        inputs.set(key, view);
      }
      return view;
    },
    sink(kind, slot) {
      const format = gpu.caps.formats[kind];
      const key = `${format}/${slot}`;
      let view = sinks.get(key);
      if (!view) {
        view = create(format, GPUTextureUsage.STORAGE_BINDING, `sink ${key}`);
        sinks.set(key, view);
      }
      return view;
    },
    takeScopes() {
      const taken = scopes;
      scopes = [];
      return taken;
    },
    dispose() {
      for (const { texture, reservation } of owned) {
        texture.destroy();
        reservation.release();
      }
      owned.length = 0;
      inputs.clear();
      sinks.clear();
    },
  };
}
