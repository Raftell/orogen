import { CHANNELS, type FieldKind, type Rgba } from './field.ts';
import type { KernelDef } from './kernel.ts';
import { orderLibs, type WgslLib } from './lib.ts';
import { packLayout, type ParamsLayout } from './uniforms.ts';

export interface InputShape {
  readonly name: string;
  readonly kind: FieldKind;
  readonly channels: 1 | 2 | 4;
  /** What the input reads when unbound; null for a required input. */
  readonly default: number | Rgba | null;
  readonly saturate: boolean;
  readonly size: 'grid' | 'any';
}

/** A kernel definition with its defaults applied and its records as ordered lists: what every consumer of a KernelDef reads. */
export interface KernelShape {
  readonly mode: 'map' | 'raw';
  readonly workgroup: readonly [number, number];
  readonly tiled: boolean;
  readonly cost: number;
  readonly inputs: readonly InputShape[];
  readonly outputs: readonly { readonly name: string; readonly kind: FieldKind; readonly channels: 1 | 2 | 4 }[];
  readonly inPlace: readonly string[];
  readonly unsafe: readonly string[];
  readonly luts: readonly { readonly name: string; readonly type: 'f32' | 'vec4f' }[];
  /** null when the kernel declares no params. */
  readonly params: ParamsLayout | null;
  /** The included libraries, each once, after its dependencies. */
  readonly libs: readonly WgslLib[];
}

const shapes = new WeakMap<KernelDef, KernelShape>();

export function kernelShape(def: KernelDef): KernelShape {
  let shape = shapes.get(def);
  if (!shape) {
    const params = def.params ?? {};
    shape = {
      mode: def.mode ?? 'map',
      workgroup: def.workgroup ?? [8, 8],
      tiled: def.tiled ?? true,
      cost: def.cost ?? 8,
      inputs: Object.entries(def.inputs ?? {}).map(([name, decl]) => {
        const options = typeof decl === 'string' ? { kind: decl } : decl;
        return {
          name,
          kind: options.kind,
          channels: CHANNELS[options.kind],
          default: 'default' in options && options.default !== undefined ? options.default : null,
          saturate: 'saturate' in options && options.saturate === true,
          size: 'size' in options && options.size === 'any' ? 'any' : 'grid',
        };
      }),
      outputs: Object.entries(def.outputs ?? {}).map(([name, kind]) => ({ name, kind, channels: CHANNELS[kind] })),
      inPlace: Object.keys(def.inPlace ?? {}),
      unsafe: Object.keys(def.unsafeReadWrite ?? {}),
      luts: Object.entries(def.luts ?? {}).map(([name, type]) => ({ name, type })),
      params: Object.keys(params).length > 0 ? packLayout(params) : null,
      libs: orderLibs(def.includes ?? []).ordered,
    };
    shapes.set(def, shape);
  }
  return shape;
}
