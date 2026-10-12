// Pictures of fields for a person to look at, for the tests of this folder that hold their data as plain
// arrays: the harness's writePreview (testing.md 2.7) with the array given its size. One drawing for every
// picture a test writes; the bytes are never compared. Not a test file.

import { writePreview, type FieldData } from '../helpers/index.ts';

const fieldOf = (data: Float32Array, width: number): FieldData => ({ kind: 'field', width, height: data.length / width, channels: 1, data });

/** The style `grey`: `range` mapped to black..white, 'auto' the field's own minimum and maximum. Resolves with the path of the file. */
export function writeGrey(name: string, data: Float32Array, width: number, range: readonly [number, number] | 'auto' = [0, 1]): Promise<string> {
  return writePreview(name, fieldOf(data, width), { style: 'grey', range });
}

/** The style `hillshade` of the physical surface. Resolves with the path of the file. */
export function writeHillshade(name: string, heights: Float32Array, width: number, terrainSize: number, heightRange: number): Promise<string> {
  return writePreview(name, fieldOf(heights, width), { style: 'hillshade', terrainSize, heightRange });
}
