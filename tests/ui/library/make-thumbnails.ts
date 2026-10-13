// Draws the pictures of the example projects, examples/<name>.png, which the Examples tab of the library shows.
// Not a test file. Run it when an example, or a node an example uses, has changed what the example looks like:
//
//   tools/guard --mem=4G node tests/ui/library/make-thumbnails.ts [name...]
//
// A picture is the command-line program's 3D picture (`orogen render`, src/cli/preview.ts) of what the project
// shows when it opens: the terrain of `ui.view.height` at the preview resolution, with the color map of
// `ui.view.overlay` over it where the project has one, at half the size of that picture: 384 x 256.
// `orogen render <project> --node <id>` draws one node, with the terrain of that node's own input under a
// color; three examples show a color that is mixed from two color maps and has no terrain input, so the
// pictures are drawn here from the view itself.

import fs from 'node:fs';
import path from 'node:path';

import { drawPreview, type Picture } from '../../../src/cli/preview.ts';
import { writePicture } from '../../../src/cli/pictures.ts';
import { nodes } from '../../../src/core/nodes/index.ts';
import { createRegistry, parseDoc, previewResolution, type PortRef } from '../../../src/core/runtime.ts';
import { NodeFileSink } from '../../../src/platform/node/files.ts';
import { parseExampleIndex } from '../../../src/app/panels/library/examples.ts';
import { renderGraph, useNodes } from '../../helpers/index.ts';

const FOLDER = path.resolve(import.meta.dirname, '../../../examples');
/** The size of a picture beside its project: half the 768 x 512 of the program's 3D picture. */
const THUMBNAIL = { width: 384, height: 256 } as const;

/** A picture at half its size: every pixel the mean of four. */
function halved(picture: Picture): Picture {
  const width = picture.width >> 1, height = picture.height >> 1;
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) {
        const at = (2 * y * picture.width + 2 * x) * 3 + c;
        rgb[(y * width + x) * 3 + c] = Math.round((picture.rgb[at]! + picture.rgb[at + 3]! + picture.rgb[at + picture.width * 3]! + picture.rgb[at + picture.width * 3 + 3]!) / 4);
      }
    }
  }
  return { width, height, rgb };
}

const registry = createRegistry(nodes);
useNodes(nodes);
const text = (ref: PortRef): string => `${ref.node}.${ref.port}`;

const index = parseExampleIndex(fs.readFileSync(path.join(FOLDER, 'index.json'), 'utf8'));
const asked = process.argv.slice(2);
const unknown = asked.filter((name) => !index.some((example) => example.id === name));
if (unknown.length > 0) throw new Error(`examples/index.json lists no example "${unknown.join('", "')}": it lists ${index.map((example) => example.id).join(', ')}`);

const sink = NodeFileSink(FOLDER);
for (const example of index) {
  if (asked.length > 0 && !asked.includes(example.id)) continue;
  const file = path.join(FOLDER, example.file);
  const { doc, problems } = parseDoc(fs.readFileSync(file, 'utf8'), registry);
  if (problems.length > 0) throw new Error(`${example.file}: ${problems.map((problem) => problem.message).join('; ')}`);
  const view = doc.ui.view;
  if (!view?.height) throw new Error(`${example.file} shows no terrain: its picture is that of ui.view.height`);
  const height = text(view.height);
  const overlay = view.overlay ? text(view.overlay.ref) : null;
  const res = previewResolution(doc.settings);
  const started = performance.now();
  const { fields, report } = await renderGraph(doc, overlay === null ? [height] : [height, overlay], { res });
  if (report.status !== 'ok') throw new Error(`${example.file} did not evaluate: ${report.status}`);
  const scale = { terrainSize: doc.settings.terrainSize, heightRange: doc.settings.heightRange };
  const picture = overlay === null
    ? drawPreview(fields[height]!, { style: '3d', ...scale })
    : drawPreview(fields[overlay]!, { style: '3d', height: fields[height]!, ...scale });
  const small = halved(picture);
  if (small.width !== THUMBNAIL.width || small.height !== THUMBNAIL.height) throw new Error(`The 3D picture is ${picture.width} x ${picture.height}: half of it is not ${THUMBNAIL.width} x ${THUMBNAIL.height}`);
  fs.rmSync(path.join(FOLDER, example.image), { force: true });
  await writePicture(sink, example.image, small);
  console.log(`examples/${example.image}: ${example.title} at ${res}, ${((performance.now() - started) / 1000).toFixed(1)} s`);
}
// The harness keeps its engine for the tests of a file; a script says when it is done.
process.exit(0);
