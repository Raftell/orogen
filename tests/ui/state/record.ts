// Makes the recordings of tests/ui/state/assets/ (testing.md 8.5 rule 5): the EngineEvents a real session sent
// to an EngineClient while a page was edited, viewed and built, as the client's subscribers received them.
// Not a test file. Run once, by hand, when the event stream of the engine has changed:
//
//   tools/guard node tests/ui/state/record.ts
//
// A recording holds the events, the node ids by the names used here, and `marks`: how many events had arrived
// when a step of the script had come to rest, with the revision the engine had been sent by then.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { removeNodes, setNodeFlags, setParam, setView, type EngineEvent } from '../../../src/core/runtime.ts';
import { viewOutput } from '../../../src/app/state/ui-store.ts';
import { applySettings, DRAFT, REGISTRY, SETTINGS, showHeight, startApplication, type Application } from './rig.ts';

/** The thumbnail resolution of these settings (runtime.md 7.3 rule 9): the build resolution itself, whose next level is below 128. */
const THUMBNAIL = SETTINGS.buildResolution;

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets');

interface Mark { readonly events: number; readonly engineRevision: number }

/**
 * Ends a step: when the session has come to rest and, where the step makes thumbnails, when those of the named
 * nodes have arrived from a field of the resolution given. They follow the evaluation that made them.
 */
type MarkStep = (step: string, thumbnails?: { readonly of: readonly string[]; readonly at: number }) => Promise<void>;

async function record(name: string, about: string, script: (app: Application, ids: Record<string, string>, mark: MarkStep) => Promise<void>): Promise<void> {
  const app = await startApplication();
  const ids: Record<string, string> = {};
  const marks: Record<string, Mark> = {};
  try {
    await script(app, ids, async (step, thumbnails) => {
      await app.settled();
      if (thumbnails) {
        await app.thumbnailsOf(thumbnails.of.map((nodeName) => ids[nodeName]!), thumbnails.at);
        await app.settled();
      }
      marks[step] = { events: app.received.length, engineRevision: app.page.doc.getState().engineRevision };
    });
  } finally {
    await app.close();
  }
  // The pixels of a thumbnail are no part of a recording: the stores never see them (runtime.md 8.5).
  const events = app.received.map((event: EngineEvent) => (event.type === 'thumbnail' ? { ...event, rgba: null } : event));
  const lines = events.map((event) => `    ${JSON.stringify(event)}`).join(',\n');
  mkdirSync(ASSETS, { recursive: true });
  writeFileSync(
    path.join(ASSETS, `${name}.json`),
    `{\n  "about": ${JSON.stringify(about)},\n  "ids": ${JSON.stringify(ids)},\n  "marks": ${JSON.stringify(marks)},\n  "events": [\n${lines}\n  ]\n}\n`,
  );
  console.log(`${name}.json: ${events.length} events, marks ${Object.keys(marks).join(', ')}`);
}

await record(
  'editing',
  'A page is edited and viewed: a terrain chain is shown, a branch outside the view gets its thumbnails from idle evaluations, a slider is scrubbed in a gesture, '
  + 'a mask is laid over the terrain, a branch that fails is shown, a node is bypassed and the bypass undone, and the view is cleared.',
  async ({ page, client }, ids, mark) => {
    const doc = () => page.doc.getState();
    await mark('ready');

    applySettings(page);
    ids.land = page.add('ref/fbm', { octaves: 4 });
    ids.soft = page.add('ref/blur', {}, { in: `${ids.land}.out` });
    ids.scree = page.add('ref/talus', {}, { in: `${ids.soft}.out` });
    ids.steep = page.add('ref/slope-mask', { slopeMin: 4, slopeMax: 12 }, { in: `${ids.scree}.out` });
    // Outside the view: evaluated for their thumbnails only.
    ids.paint = page.add('ref/colorize', {}, { in: `${ids.land}.out` });
    // A node that fails, one that reads it, and one whose required input is unconnected.
    ids.broken = page.add('ref/fail', { message: 'Recorded failure' }, { in: `${ids.land}.out` });
    ids.after = page.add('ref/blur', {}, { in: `${ids.broken}.out` });
    ids.lonely = page.add('ref/blur');
    client.requestThumbnails(Object.values(ids));
    // Every node that can be evaluated gets its thumbnail from an idle evaluation, at the thumbnail resolution.
    const pictured = ['land', 'soft', 'scree', 'steep', 'paint'];
    await mark('built', { of: pictured, at: THUMBNAIL });

    showHeight(page, ids.scree!);
    await mark('shown');

    const key = `param:${ids.land}:size`;
    doc().beginGesture(key);
    for (const size of [0.3, 0.35, 0.4, 0.45]) {
      doc().transact('Fbm: Feature size', (draft) => setParam(draft, REGISTRY, ids.land!, 'size', size), { mergeKey: key });
      // A draft per step: the session has shown it before the next step is made.
      await mark(`scrub ${size}`, { of: ['land', 'soft', 'scree'], at: DRAFT });
    }
    doc().endGesture();
    await mark('scrubbed', { of: pictured, at: THUMBNAIL });

    viewOutput({ doc: page.doc, registry: REGISTRY }, { node: ids.steep!, port: 'out' });
    await mark('overlay');

    showHeight(page, ids.after!);
    await mark('failed view');

    showHeight(page, ids.scree!);
    doc().transact('Bypass Blur', (draft) => setNodeFlags(draft, ids.soft!, { bypass: true }));
    await mark('bypassed', { of: pictured, at: THUMBNAIL });
    doc().undo();
    await mark('bypass undone', { of: pictured, at: THUMBNAIL });

    doc().transact('View', (draft) => setView(draft, null), { undoable: false });
    await mark('nothing shown');
  },
);

await record(
  'build',
  'A page is built three times: a build that writes its files, a build that is cancelled while it evaluates, and a build of a document without an export node, '
  + 'whose plan has an error.',
  async ({ page, client, worker }, ids, mark) => {
    const doc = () => page.doc.getState();
    applySettings(page);
    ids.land = page.add('ref/fbm', { octaves: 4 });
    ids.scree = page.add('ref/talus', {}, { in: `${ids.land}.out` });
    ids.rock = page.add('ref/slope-mask', { slopeMin: 10, slopeMax: 20 }, { in: `${ids.scree}.out` });
    ids.outland = page.add('io/export-landscape', { name: 'Recorded', dither: false }, { in: `${ids.scree}.out` });
    ids.outrock = page.add('io/export-layer', { layer: 'Rock' }, { in: `${ids.rock}.out` });
    showHeight(page, ids.scree!);
    await mark('shown');

    const first = await client.build({ doc: doc().doc, outDir: '/out/recorded' });
    if (first.status !== 'ok') throw new Error(`The recorded build ended "${first.status}": ${JSON.stringify(first.problems)}`);
    await mark('built');

    const second = client.build({ doc: doc().doc, outDir: '/out/recorded' });
    // Cancelled once the evaluation has begun, so that the recording holds an evaluation that was aborted.
    const before = worker.emitted.length;
    const started = new Promise<void>((resolve) => {
      const off = client.subscribe((event) => {
        if (event.type !== 'node-start') return;
        off();
        resolve();
      });
    });
    await started;
    client.cancelBuild();
    const cancelled = await second;
    if (cancelled.status !== 'aborted') throw new Error(`The cancelled build ended "${cancelled.status}" (${worker.emitted.length - before} events)`);
    await mark('cancelled');

    doc().transact('Delete exports', (draft) => removeNodes(draft, [ids.outland!, ids.outrock!]));
    const third = await client.build({ doc: doc().doc, outDir: '/out/recorded' });
    if (third.status !== 'errors') throw new Error(`The build without an export node ended "${third.status}"`);
    await mark('nothing to export');
  },
);
