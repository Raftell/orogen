// The six example projects in the application, in a window of 1600 by 1000 that is never shown: each in the 3D
// view as the panel frames a project it opens, with its colour output draped as the project has it, and with
// the default material alone. Not a test of a suite (its name ends in no .test.ts): the pictures are for a
// person to judge beside what a terrain tool shows.
//
//   npm run build
//   OROGEN_TEST_OUTPUT=test-output/<folder> tools/guard --lock --mem=4G --timeout=1800 node --test --test-timeout=900000 tests/ui/viewport/measure/examples.ts
//
// The pictures are <OROGEN_TEST_OUTPUT>/ui/viewport/example-<name>-color.png and -material.png. The viewport is
// given most of the window through the dock: its panel is 420 pixels high in the default layout.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { launchApp } from '../../../helpers/index.ts';
import { attr, capture, prepare, resizeViewport, ROOT, run, settled } from '../rig.ts';

const EVALUATION_MS = 300_000;
const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/index.json'), 'utf8')) as { examples: { file: string; title: string }[] };

for (const example of index.examples) {
  const name = example.file.replace(/\.orogen$/, '');
  test(`the example ${example.title}, as the application shows it`, async (t) => {
    const app = await launchApp({ profile: 'core', open: `examples/${example.file}` });
    try {
      await prepare(app);
      await settled(app, EVALUATION_MS);
      const size = await resizeViewport(app, 1228, 800);
      t.diagnostic(`the canvas is ${Math.round(size.width)} × ${Math.round(size.height)}; the view is ${await app.eval<string>(`JSON.stringify(orogenTest.ctx.doc.getState().doc.ui.view)`)}`);
      assert.equal(await attr(app, 'data-status'), 'shown');
      const draped = await app.eval<boolean>(`orogenTest.ctx.doc.getState().doc.ui.view?.overlay !== undefined`);
      t.diagnostic(await capture(app, `example-${name}-${draped ? 'color' : 'material'}`));
      if (draped) {
        await run(app, 'viewport.removeOverlay');
        await settled(app, EVALUATION_MS);
        t.diagnostic(await capture(app, `example-${name}-material`));
      }
      assert.deepEqual(await app.errors(), []);
    } catch (thrown) {
      await app.close().catch(() => {});
      throw thrown;
    }
    await app.close();
  });
}
