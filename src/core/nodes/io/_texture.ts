// src/core/nodes/io/_texture.ts
// The size of a companion texture, as the three texture export nodes offer it.
import type { EnumParam } from '../../api.ts';

export const dimension = {
  kind: 'enum', name: 'dimension', label: 'Size', default: 'auto',
  options: [
    { value: 'auto', label: 'Auto' },
    { value: '1024', label: '1024' },
    { value: '2048', label: '2048' },
    { value: '4096', label: '4096' },
    { value: '8192', label: '8192' },
  ],
  help: 'The side of the texture. Auto is the power of two that holds the build resolution, from 1024 to 8192.',
} as const satisfies EnumParam;

/** The option of `dimension` as the size of a texture item. */
export function sizeOf(option: (typeof dimension.options)[number]['value']): 'auto' | 1024 | 2048 | 4096 | 8192 {
  return option === 'auto' ? 'auto' : (Number(option) as 1024 | 2048 | 4096 | 8192);
}
