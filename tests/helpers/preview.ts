import fs from 'node:fs/promises';
import path from 'node:path';

import type { FileWriter } from '../../src/core/runtime.ts';
import { createPngEncoder } from '../../src/export/encode/png.ts';
import { outputFolder } from './engine.ts';
import { checkFieldData, type FieldData } from './field-data.ts';
import { drawPreview } from '../../src/cli/preview.ts';

export type PreviewStyle = 'grey' | 'hillshade' | '3d' | 'color' | 'sheet';

export interface PreviewOptions {
  readonly style?: PreviewStyle;                              // default: 'sheet' for a field, 'color' for a colour
  readonly range?: readonly [number, number] | 'auto';        // 'grey': the values drawn black and white. Default [0, 1]; 'auto' is [min, max]
  readonly height?: FieldData;                                // the terrain to shade when `f` is a mask or a colour, which is drawn over it
  readonly terrainSize?: number;                              // metres; default 4096
  readonly heightRange?: number;                              // metres; default 1024
  readonly crop?: readonly [x: number, y: number, size: number];
}

const NAME = /^[a-z0-9][a-z0-9/_.-]*$/;

/** Writes <OROGEN_TEST_OUTPUT>/<name>.png and returns its absolute path. `name` matches /^[a-z0-9][a-z0-9/_.-]*$/. */
export function writePreview(name: string, f: FieldData, opts: PreviewOptions = {}): Promise<string> {
  // The pattern admits dots and slashes; a segment made of dots alone would leave the output folder.
  if (typeof name !== 'string' || !NAME.test(name) || name.split('/').some((segment) => segment === '' || /^\.+$/.test(segment))) {
    return Promise.reject(new TypeError(`The name of a preview matches /^[a-z0-9][a-z0-9/_.-]*$/ and has no empty or dotted segment: ${JSON.stringify(name)}`));
  }
  return savePicture(name, f, opts);
}

/**
 * writePreview for a name the harness makes itself: `nodes/<category>/<name>/<output>` keeps the output's own
 * spelling, and a port name may hold capitals (engine.md 4.2), which the pattern of writePreview does not admit.
 */
export async function savePicture(name: string, f: FieldData, opts: PreviewOptions = {}): Promise<string> {
  checkFieldData(f, 'The field to draw');
  if (opts.height) checkFieldData(opts.height, 'The terrain to shade');
  const picture = drawPreview(f, opts);

  // A picture is a few megabytes at most: the encoder writes into memory, and the file appears whole, by a rename.
  const chunks: Uint8Array[] = [];
  const memory: FileWriter = {
    async write(chunk) { chunks.push(chunk.slice()); },
    async close() { return { bytes: chunks.reduce((sum, chunk) => sum + chunk.length, 0) }; },
    async abort() { chunks.length = 0; },
  };
  const encoder = createPngEncoder(memory, { width: picture.width, height: picture.height, channels: 3, bits: 8 });
  await encoder.write(picture.rgb);
  await encoder.end();

  const file = path.join(outputFolder(), ...`${name}.png`.split('/'));
  const partial = `${file}.${process.pid}.partial`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(partial, Buffer.concat(chunks));
    await fs.rename(partial, file);
  } catch (thrown) {
    await fs.rm(partial, { force: true });
    throw thrown;
  }
  return file;
}
