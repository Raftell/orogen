// The panel's model without a window: the output folder of each project, when a build asks for one, what the
// model keeps of a build from its events, and the manifest and the report it reads through the bridge. The
// stores are the application's own; the engine and the bridge are stand-ins that record what they are asked.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { disconnect, moveNodes, setNodeFlags, setParam, setSettings, type BuildPlan, type BuildResult, type GraphDoc } from '../../../../src/core/runtime.ts';
import { buildSignature, createBuildModel, type PanelStorage } from '../../../../src/app/panels/build/model/store.ts';
import { docOf, FULL, plan, ready, REGISTRY, resultOf, SOURCES, turn, createPage, type Page } from './_docs.ts';

const OUT = '/home/ada/Builds/Ridge';
const MANIFEST = JSON.stringify({
  schema: 'orogen.unreal.landscape/1', status: 'complete', generator: { name: 'Orogen', version: '0.1.0' }, targetEngine: '5.8', project: { seed: 7 },
  terrain: { sizeM: 2000, heightRangeM: 500, seaLevel: 0 }, resolution: { x: 1009, y: 1009 }, landscape: null, textures: [], images: [], splines: null,
  files: [{ path: 'Heights.exr', bytes: 10 }],
});
const REPORT = JSON.stringify({
  schema: 'orogen.build-report/1', status: 'ok', durationMs: 540, resolution: 1009, problems: [], targets: [], weightsMs: null, commitMs: 90, files: [],
});

/** The events of a build as the session sends them, around a result. */
function runBuild(page: Page, requestId: number, result: BuildResult, outDir = OUT): void {
  page.emit({ type: 'request-start', requestId, revision: 1, purpose: 'build' });
  page.emit({ type: 'build-start', requestId, resolution: 1009, outDir });
  page.now += 500;
  page.emit({ type: 'build-result', requestId, result: { ...result, requestId } });
  page.emit({ type: 'build-end', requestId, status: result.status });
}

test('a build asks for the output folder when none is chosen, keeps it, and does not ask again', async () => {
  const page = createPage();
  ready(page);
  assert.equal(page.model.folder(), null);

  // The dialog is cancelled: no folder, no build.
  await page.model.start();
  assert.deepEqual([page.built.length, page.model.folder()], [0, null]);

  page.folders.push(OUT);
  const first = page.model.start();
  await turn();
  assert.deepEqual(page.built.map((build) => build.outDir), [OUT]);
  assert.equal(page.built[0]!.doc, page.ctx.doc.getState().doc, 'the build gets the document as it is');
  assert.equal(page.model.folder(), OUT);
  // While it runs a second start does nothing: neither a dialog nor a build.
  page.emit({ type: 'build-start', requestId: 3, resolution: 1009, outDir: OUT });
  page.folders.push('/elsewhere');
  await page.model.start();
  assert.equal(page.built.length, 1);
  page.emit({ type: 'build-end', requestId: 3, status: 'ok' });
  page.endBuild(resultOf('ok'));
  await first;

  // The next build goes to the folder that was chosen; the dialog's answer is still waiting.
  const second = page.model.start();
  await turn();
  assert.deepEqual(page.built.map((build) => build.outDir), [OUT, OUT]);
  assert.deepEqual(page.folders, ['/elsewhere']);
  page.endBuild(resultOf('ok'));
  await second;
});

test('a build does not start before the device is ready', async () => {
  const page = createPage();
  page.folders.push(OUT);
  await page.model.start();
  assert.equal(page.built.length, 0);
  assert.deepEqual(page.folders, [OUT], 'and asks nothing');
});

test('a folder the build is certain to refuse is asked about again; the answer is taken as it is', async () => {
  const page = createPage(docOf(FULL), '/home/ada/Terrain/ridge.orogen');
  ready(page);
  page.model.setFolder('/home/ada/Terrain');
  page.folders.push(OUT);
  const started = page.model.start();
  await turn();
  assert.deepEqual(page.built.map((build) => build.outDir), [OUT]);
  assert.equal(page.model.folder(), OUT);
  page.endBuild(resultOf('ok'));
  await started;

  // Whoever chooses the project's folder again gets the pipeline's refusal, not silence: the build is started.
  page.model.setFolder('/home/ada/Terrain');
  page.folders.push('/home/ada/Terrain');
  const insisted = page.model.start();
  await turn();
  assert.deepEqual(page.built.map((build) => build.outDir), [OUT, '/home/ada/Terrain']);
  page.endBuild(resultOf('errors'));
  await insisted;
});

test('every project has its own folder: it goes with the project when it is saved, and another project starts without one', () => {
  const page = createPage();
  page.model.setFolder(OUT);
  assert.equal(page.model.folder(), OUT);

  // Saved under a name: the same project, the same folder.
  page.ctx.doc.getState().markSaved('/home/ada/Terrain/ridge.orogen');
  assert.equal(page.model.folder(), OUT);
  assert.deepEqual(page.model.state.getState().folders, { '/home/ada/Terrain/ridge.orogen': OUT });
  // Saved under another name: both files are the project that builds there.
  page.ctx.doc.getState().markSaved('/home/ada/Terrain/ridge-2.orogen');
  assert.equal(page.model.folder(), OUT);

  // Another project is opened: it has no folder, and the count of projects goes up.
  const before = page.model.state.getState().project;
  page.ctx.doc.getState().load(docOf(SOURCES), '/home/ada/Other/dunes.orogen');
  assert.equal(page.model.folder(), null);
  assert.equal(page.model.state.getState().project, before + 1);
  page.model.setFolder('/home/ada/Builds/Dunes');
  // Back to the first: its folder is remembered.
  page.ctx.doc.getState().load(docOf(FULL), '/home/ada/Terrain/ridge.orogen');
  assert.equal(page.model.folder(), OUT);

  // A project without a file: its folder is not the next new project's.
  page.ctx.doc.getState().load(docOf(FULL), null);
  page.model.setFolder('/home/ada/Builds/Untitled');
  page.ctx.doc.getState().load(docOf(SOURCES), null);
  assert.equal(page.model.folder(), null);

  // Changes that are no other project keep the folder and the count: a view, a resolution, an edit and its undo.
  page.model.setFolder(OUT);
  const count = page.model.state.getState().project;
  page.ctx.doc.getState().transact('View', (draft) => { draft.ui.view = { height: { node: 'land', port: 'out' } }; }, { undoable: false });
  page.model.setResolution(2017);
  page.ctx.doc.getState().transact('Octaves', (draft) => setParam(draft, REGISTRY, 'land', 'octaves', 3));
  page.ctx.doc.getState().undo();
  assert.deepEqual([page.model.folder(), page.model.state.getState().project], [OUT, count]);
  page.model.setFolder(null);
  assert.equal(page.model.folder(), null);
});

test('the build resolution is changed as the settings ask: validated, and no undo step', () => {
  const page = createPage();
  const doc = () => page.ctx.doc.getState();
  page.model.setResolution(4033);
  assert.equal(doc().doc.settings.buildResolution, 4033);
  assert.deepEqual([doc().past.length, doc().unsaved], [0, true], 'runtime.md 8.5 rule 5');
  const revision = doc().revision;
  page.model.setResolution(4033);
  assert.equal(doc().revision, revision, 'the same resolution is no change');
  // A level the new resolution does not have is lowered with it (4.2).
  page.model.setResolution(1009);
  assert.equal(doc().doc.settings.buildResolution, 1009);
  page.model.setResolution(Number.NaN);
  assert.equal(doc().doc.settings.buildResolution, 1009);
});

test('what the model keeps of a build: its log, of which project and which state of it, and its files', async () => {
  const page = createPage();
  ready(page);
  page.model.setFolder(OUT);
  page.files.set(`${OUT}/Export.orogen.json`, MANIFEST);
  page.files.set(`${OUT}/Export.report.json`, REPORT);

  const started = page.model.start();
  await turn();
  const signature = buildSignature(page.ctx.doc.getState().doc);
  runBuild(page, 5, resultOf('ok', { outDir: OUT, manifest: 'Export.orogen.json', report: 'Export.report.json', files: [{ path: 'Heights.exr', bytes: 10 }] }));
  page.endBuild(resultOf('ok'));
  await started;
  await turn();

  const held = page.model.state.getState();
  assert.deepEqual([held.log!.requestId, held.log!.outDir, held.log!.status, held.log!.endedAt! - held.log!.startedAt], [5, OUT, 'ok', 500]);
  assert.deepEqual(held.built, { requestId: 5, project: held.project, signature });
  assert.deepEqual([held.files!.requestId, held.files!.folder, held.files!.manifestPath, held.files!.reportPath, held.files!.reading], [5, OUT, `${OUT}/Export.orogen.json`, `${OUT}/Export.report.json`, false]);
  assert.ok(held.files!.manifest?.ok && held.files!.manifest.value.resolution.x === 1009);
  assert.ok(held.files!.report?.ok && held.files!.report.value.durationMs === 540);

  // What there is to show in the file manager: the manifest of the build.
  assert.equal(page.model.revealTarget(), `${OUT}/Export.orogen.json`);
  page.model.reveal();
  assert.deepEqual(page.revealed, [`${OUT}/Export.orogen.json`]);

  // The next build starts with nothing of the last.
  page.emit({ type: 'build-start', requestId: 6, resolution: 1009, outDir: OUT });
  assert.deepEqual([page.model.state.getState().files, page.model.state.getState().log!.requestId], [null, 6]);
});

test('a build that fails leaves its report beside the output folder; a file that cannot be read is said, not thrown', async () => {
  const page = createPage();
  ready(page);
  const staging = `${OUT}.partial`;
  page.files.set(`${staging}/Ridge.report.json`, '{ "schema": "orogen.build-report/1"');
  runBuild(page, 8, resultOf('errors', { outDir: staging, report: 'Ridge.report.json', problems: [{ severity: 'error', code: 'E_NODE_FAILED', message: 'Rock Layer: Boom.', nodeId: 'outrock' }] }));
  await turn();
  const { files } = page.model.state.getState();
  assert.deepEqual([files!.manifestPath, files!.manifest, files!.reportPath], [null, null, `${staging}/Ridge.report.json`]);
  assert.deepEqual(files!.report, { ok: false, reason: 'The build report is not JSON' });
  assert.equal(page.model.revealTarget(), `${staging}/Ridge.report.json`);
  // The node the problem names can be selected, and is.
  assert.equal(page.model.problemNode(), 'outrock');
  page.model.selectNode('outrock');
  assert.deepEqual(page.ctx.ui.getState().selection, ['outrock']);
  page.model.selectNode('no-such-node');
  assert.deepEqual(page.ctx.ui.getState().selection, ['outrock']);

  // A manifest that is not on disk: the reason is the bridge's.
  runBuild(page, 9, resultOf('ok', { outDir: OUT, manifest: 'Gone.orogen.json' }));
  await turn();
  assert.deepEqual(page.model.state.getState().files!.manifest, { ok: false, reason: `ENOENT: no such file or directory, open '${OUT}/Gone.orogen.json'` });

  // A folder that was refused wrote nothing: there is nothing to read and nothing to show.
  runBuild(page, 10, resultOf('errors', { problems: [{ severity: 'error', code: 'E_OUT_DIR', message: 'Cannot build into this folder.' }] }));
  await turn();
  assert.deepEqual([page.model.state.getState().files!.reading, page.model.revealTarget(), page.model.problemNode()], [false, null, null]);
});

test('a build is known as another project\'s once another project is open, and as an older state once the project builds to something else', async () => {
  const page = createPage();
  ready(page);
  page.model.setFolder(OUT);
  const started = page.model.start();
  await turn();
  runBuild(page, 3, resultOf('ok', { outDir: OUT }));
  page.endBuild(resultOf('ok'));
  await started;
  const built = page.model.state.getState().built!;
  const now = (): string => buildSignature(page.ctx.doc.getState().doc);
  assert.equal(built.signature, now());

  // What a build does not read leaves the build the project's: the view (which selecting a node changes), where a node stands, what it is called.
  page.model.selectNode('land');
  assert.deepEqual(page.ctx.doc.getState().doc.ui.view, { height: { node: 'land', port: 'out' } }, 'selecting a node shows it');
  page.ctx.doc.getState().transact('Move', (draft) => moveNodes(draft, ['land'], { x: 40, y: 80 }));
  page.ctx.doc.getState().transact('Rename', (draft) => setNodeFlags(draft, 'land', { title: 'Massif' }));
  assert.equal(built.signature, now());

  // What it reads does not: a parameter, a wire, the bypass of a node, a setting.
  const changes: readonly (readonly [string, () => void])[] = [
    ['a parameter', () => page.ctx.doc.getState().transact('Octaves', (draft) => setParam(draft, REGISTRY, 'land', 'octaves', 2))],
    ['a wire', () => page.ctx.doc.getState().transact('Disconnect', (draft) => disconnect(draft, ['e-outnormal']))],
    ['a bypass', () => page.ctx.doc.getState().transact('Bypass', (draft) => setNodeFlags(draft, 'steep', { bypass: true }))],
    ['the resolution', () => page.model.setResolution(2017)],
    ['the sea level', () => page.ctx.doc.getState().transact('Sea', (draft) => setSettings(draft, { seaLevel: 0.2 }))],
  ];
  for (const [what, change] of changes) {
    const before = now();
    change();
    assert.notEqual(now(), before, what);
  }
  assert.notEqual(now(), built.signature);
  assert.equal(page.model.state.getState().built, built, 'what was built stays what it was');
  // Undone, the project is the one that was built again.
  for (let i = 0; i < 4; i++) page.ctx.doc.getState().undo();
  page.model.setResolution(1009);
  assert.equal(now(), built.signature);

  // Another project: the count differs from the build's.
  page.ctx.doc.getState().load(docOf(SOURCES), null);
  assert.notEqual(page.model.state.getState().project, built.project);
});

test('the signature of a document is written anew for the node that changed, and for no other', () => {
  const page = createPage();
  const state = (): GraphDoc => page.ctx.doc.getState().doc;
  // The same members are the same text, and the text is what was written for the whole document at once.
  const first = buildSignature(state());
  const nodes = Object.keys(state().nodes).sort().map((id) => [id, state().nodes[id]!.type, state().nodes[id]!.version, state().nodes[id]!.params, state().nodes[id]!.bypass === true]);
  const edges = Object.keys(state().edges).sort().map((id) => [state().edges[id]!.from.node, state().edges[id]!.from.port, state().edges[id]!.to.node, state().edges[id]!.to.port]);
  assert.equal(first, JSON.stringify([state().settings, nodes, edges]));

  // An edit and its undo: another text, then the first again, though the edited node is not the object it was.
  const before = state().nodes;
  page.ctx.doc.getState().transact('Octaves', (draft) => setParam(draft, REGISTRY, 'land', 'octaves', 2));
  assert.notEqual(buildSignature(state()), first);
  assert.equal(state().nodes.steep, before.steep, 'a transaction leaves the other nodes the objects they were (8.5)');
  page.ctx.doc.getState().undo();
  assert.notEqual(state().nodes, before);
  assert.equal(buildSignature(state()), first);

  // What is written of a node is written once: an edit of one node of three hundred reads the parameters of one.
  let read = 0;
  const watched = (params: Record<string, unknown>): Record<string, unknown> => new Proxy(params, { ownKeys(target) { read++; return Reflect.ownKeys(target); } });
  const node = (id: string, params: Record<string, unknown>): GraphDoc['nodes'][string] => ({ id, type: 'ref/fbm', version: 1, position: { x: 0, y: 0 }, params: watched(params) });
  const many: Record<string, GraphDoc['nodes'][string]> = {};
  for (let i = 0; i < 300; i++) many[`n${i}`] = node(`n${i}`, { octaves: i });
  const rest = { settings: state().settings, edges: state().edges };
  const whole = buildSignature({ ...rest, nodes: many });
  assert.equal(read, 300);
  const edited = buildSignature({ ...rest, nodes: { ...many, n7: node('n7', { octaves: 99 }) } });
  assert.equal(read, 301, 'one node was edited, one node is written');
  assert.notEqual(edited, whole);
  // A node that is moved or renamed is a new object with the parameters it had: it is written again, and says the same.
  assert.equal(buildSignature({ ...rest, nodes: { ...many, n7: { ...many.n7!, position: { x: 5, y: 5 }, title: 'Moved' } } }), whole);
  assert.equal(read, 302);
});

test('a build of another project is not shown, revealed or selected from as this project\'s', async () => {
  const page = createPage();
  ready(page);
  page.model.setFolder(OUT);
  page.files.set(`${OUT}/Export.orogen.json`, MANIFEST);
  const started = page.model.start();
  await turn();
  runBuild(page, 3, resultOf('ok', {
    outDir: OUT, manifest: 'Export.orogen.json', problems: [{ severity: 'warning', code: 'W_LAYER_EMPTY', message: 'Rock Layer: empty.', nodeId: 'outrock' }],
  }));
  page.endBuild(resultOf('ok'));
  await started;
  await turn();
  assert.deepEqual([page.model.scope().mine, page.model.scope().changed], [true, false]);
  assert.equal(page.model.revealTarget(), `${OUT}/Export.orogen.json`);
  assert.equal(page.model.problemNode(), 'outrock');
  assert.equal(page.model.importSource()!.folder, OUT);

  // The project changes: the build is still its own, of an earlier state; what it wrote is still there to show.
  page.ctx.doc.getState().transact('Octaves', (draft) => setParam(draft, REGISTRY, 'land', 'octaves', 2));
  assert.deepEqual([page.model.scope().mine, page.model.scope().changed], [true, true]);
  assert.equal(page.model.revealTarget(), `${OUT}/Export.orogen.json`);

  // Another project is opened, one that happens to hold a node of the same id: nothing of the build is its.
  page.ctx.doc.getState().load(docOf(FULL), '/home/ada/Other/dunes.orogen');
  assert.deepEqual([page.model.scope().mine, page.model.scope().changed], [false, false]);
  assert.deepEqual([page.model.revealTarget(), page.model.problemNode(), page.model.importSource()], [null, null, null]);
  page.model.reveal();
  assert.deepEqual(page.revealed, [], 'the folder of another project\'s build is not opened from this one');

  // The node of a problem is selected from what the panel shows: without a build of its own, what the project's document says.
  page.ctx.doc.getState().load(docOf({ ...FULL, outloose: { type: 'io/export-normal', params: { name: 'Loose' } } }), null);
  assert.equal(page.model.problemNode(), 'outloose');
});

test('the output folder of a project and the folded sections outlive the application; a project without a file is not remembered', () => {
  const held = new Map<string, string>();
  const storage: PanelStorage = { getItem: (key) => held.get(key) ?? null, setItem: (key, value) => void held.set(key, value) };
  const ridge = '/home/ada/Terrain/ridge.orogen';

  const first = createPage(docOf(FULL), ridge, { storage });
  assert.equal(first.model.folder(), null);
  assert.equal(held.size, 0, 'nothing is written before something is chosen');
  first.model.setFolder(OUT);
  first.model.setFolded('settings', true);
  first.model.setFolded('plan', true);
  first.model.setFolded('plan', false);
  // A project without a file has its folder for the session alone.
  first.ctx.doc.getState().load(docOf(SOURCES), null);
  first.model.setFolder('/home/ada/Builds/Untitled');
  assert.deepEqual(JSON.parse(held.get('orogen.build/1')!), { folders: { [ridge]: OUT }, folded: ['settings'] });
  first.model.dispose();

  // The application is started again: the project builds where it built, and what was folded is folded.
  const second = createPage(docOf(FULL), ridge, { storage });
  assert.equal(second.model.folder(), OUT);
  assert.deepEqual(second.model.state.getState().folded, ['settings']);
  const other = createPage(docOf(FULL), '/home/ada/Other/dunes.orogen', { storage });
  assert.equal(other.model.folder(), null, 'another project has no folder');
  assert.equal(createPage(docOf(FULL), null, { storage }).model.folder(), null, 'nor has a project without a file');

  // A folder that is taken back is forgotten.
  second.model.setFolder(null);
  assert.deepEqual(JSON.parse(held.get('orogen.build/1')!).folders, {});

  // What the storage holds is read as far as it is of the kind expected, and a storage that fails is done without.
  for (const text of ['not json', '[]', '{"folders": 3, "folded": "x"}', `{"folders": {"": "/a", "${ridge}": 7, "/p.orogen": ""}, "folded": [1, null]}`]) {
    held.set('orogen.build/1', text);
    const page = createPage(docOf(FULL), ridge, { storage });
    assert.deepEqual([page.model.state.getState().folders, page.model.state.getState().folded], [{}, []], text);
  }
  const failing: PanelStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); } };
  const page = createPage(docOf(FULL), ridge, { storage: failing });
  page.model.setFolder(OUT);
  assert.equal(page.model.folder(), OUT);

  // Sixty-four projects are remembered, the last that were given a folder.
  held.clear();
  const many = createPage(docOf(FULL), null, { storage });
  for (let i = 0; i < 70; i++) {
    many.ctx.doc.getState().load(docOf(FULL), `/p/${i}.orogen`);
    many.model.setFolder(`/b/${i}`);
  }
  many.ctx.doc.getState().load(docOf(FULL), '/p/10.orogen');
  many.model.setFolder('/b/ten');
  const kept = Object.keys(JSON.parse(held.get('orogen.build/1')!).folders as Record<string, string>);
  assert.deepEqual([kept.length, kept[0], kept.at(-1)], [64, '/p/6.orogen', '/p/10.orogen']);
});

test('a session that plans without building is asked for the plan of the project as it stands; one that does not is asked nothing', async () => {
  // Today's session has no such method: nothing is scheduled, and the draft stays empty.
  const plain = createPage();
  ready(plain);
  plain.ctx.doc.getState().transact('Octaves', (draft) => setParam(draft, REGISTRY, 'land', 'octaves', 2));
  await turn();
  assert.equal(plain.model.state.getState().draft, null);

  // A session with the method `plan`, as the pipeline's own planBuild would answer it.
  const asked: GraphDoc[] = [];
  const due: (() => void)[] = [];
  let cancelled = 0;
  const page = createPage(docOf(FULL), null, {
    planner: (doc) => { asked.push(doc); return plan(doc); },
    defer: (run) => { due.push(run); return () => { cancelled++; due.splice(due.indexOf(run), 1); }; },
  });
  ready(page);
  const run = async (): Promise<void> => { for (const one of due.splice(0)) one(); await turn(); };
  const draft = (): BuildPlan | null => page.model.state.getState().draft?.plan ?? null;

  // The project as it was opened.
  assert.equal(due.length, 1);
  await run();
  assert.equal(asked.length, 1);
  assert.deepEqual([draft()!.ok, draft()!.files.length], [true, plan(docOf(FULL)).files.length]);
  assert.equal(page.model.state.getState().draft!.signature, buildSignature(page.ctx.doc.getState().doc));

  // A drag of thirty steps asks once, when it has come to rest, for the document as it stands then.
  for (let i = 1; i <= 30; i++) page.ctx.doc.getState().transact('Layer', (draft) => setParam(draft, REGISTRY, 'outrock', 'layer', `Rock${i}`), { mergeKey: 'param:outrock:layer' });
  assert.deepEqual([due.length, cancelled], [1, 29]);
  await run();
  assert.equal(asked.length, 2);
  assert.equal(asked[1], page.ctx.doc.getState().doc);
  assert.ok(draft()!.files.some((file) => file.path === 'LayerRock.png'));

  // What a build does not read asks for no plan: where a node stands, what it is called, what the view shows.
  page.ctx.doc.getState().transact('Move', (draft) => moveNodes(draft, ['land'], { x: 40, y: 80 }));
  await run();
  assert.equal(asked.length, 2);

  // A plan with an error is a plan: here two layers that would write one file, which only a plan can know.
  page.ctx.doc.getState().load(docOf({ ...FULL, outrock2: { type: 'io/export-layer', params: { layer: 'Rock2' }, in: 'steep.out' }, outrock3: { type: 'io/export-layer', params: { layer: 'Rock3' }, in: 'steep.out' } }), null);
  assert.equal(page.model.state.getState().draft, null, 'the plan of another project is not this project\'s');
  await run();
  assert.deepEqual([draft()!.ok, draft()!.problems.some((problem) => problem.code === 'E_FILE_COLLISION')], [false, true]);

  // A plan that arrives for a document that has changed meanwhile is dropped: the newer one is on its way.
  let release!: (value: BuildPlan) => void;
  const slow = createPage(docOf(FULL), null, {
    planner: () => new Promise<BuildPlan>((resolve) => { release = resolve; }),
    defer: (run) => { due.push(run); return () => { due.splice(due.indexOf(run), 1); }; },
  });
  ready(slow);
  await run();
  slow.ctx.doc.getState().transact('Octaves', (draft) => setParam(draft, REGISTRY, 'land', 'octaves', 2));
  release(plan(docOf(FULL)));
  await turn();
  assert.equal(slow.model.state.getState().draft, null);

  // While a build runs nothing is planned beside it; when it has ended, the project is planned again if it changed.
  const building = createPage(docOf(FULL), null, { planner: (doc) => { asked.push(doc); return plan(doc); }, defer: (run) => { due.push(run); return () => { due.splice(due.indexOf(run), 1); }; } });
  ready(building);
  await run();
  const count = asked.length;
  building.emit({ type: 'build-start', requestId: 2, resolution: 1009, outDir: OUT });
  building.ctx.doc.getState().transact('Octaves', (draft) => setParam(draft, REGISTRY, 'land', 'octaves', 2));
  await run();
  assert.equal(asked.length, count);
  building.emit({ type: 'build-end', requestId: 2, status: 'aborted' });
  await run();
  assert.equal(asked.length, count + 1);

  // A session that rejects is done without, and a model that is disposed asks no more.
  const refusing = createPage(docOf(FULL), null, { planner: () => { throw new Error('The engine is busy'); }, defer: (run) => { due.push(run); return () => {}; } });
  await run();
  assert.equal(refusing.model.state.getState().draft, null);
  refusing.ctx.doc.getState().transact('Octaves', (draft) => setParam(draft, REGISTRY, 'land', 'octaves', 2));
  refusing.model.dispose();
  await run();
  assert.equal(refusing.model.state.getState().draft, null);
});

test('a build that somebody else started is recorded with the project as it is then', () => {
  const page = createPage();
  ready(page);
  page.emit({ type: 'build-start', requestId: 2, resolution: 1009, outDir: '/elsewhere' });
  const { built, log, project } = page.model.state.getState();
  assert.deepEqual(built, { requestId: 2, project, signature: buildSignature(page.ctx.doc.getState().doc) });
  assert.equal(log!.outDir, '/elsewhere');
});

test('the problems of a running build are the plan\'s and those found since; cancelling asks the engine', () => {
  const page = createPage();
  ready(page);
  const broken = plan(docOf({ ...SOURCES, outland: { type: 'io/export-landscape', params: { regionComponents: 4 }, in: 'land.out' } }));
  page.ctx.doc.getState().load(docOf({ ...SOURCES, outland: { type: 'io/export-landscape', params: { regionComponents: 4 }, in: 'land.out' } }), null);
  page.emit({ type: 'build-start', requestId: 4, resolution: 1009, outDir: OUT });
  page.emit({ type: 'build-plan', requestId: 4, plan: broken });
  assert.equal(page.model.problemNode(), 'outland', 'the warning of the plan names the landscape node');
  page.model.cancel();
  assert.equal(page.cancelled, 1);
});

test('the model begins with what engineStore already knows: a build that has ended, and what the shown nodes held', async () => {
  const page = createPage();
  ready(page);
  // Before a second model listens: an evaluation is shown, and a build has ended.
  page.emit({ type: 'request-start', requestId: 1, revision: 1, purpose: 'view' });
  page.emit({ type: 'eval-start', requestId: 1, resolution: 505, mode: 'preview', plan: [{ nodeId: 'land', state: 'run' }], outputPeakBytes: null });
  page.emit({ type: 'node-start', requestId: 1, nodeId: 'land' });
  page.emit({ type: 'node-done', requestId: 1, nodeId: 'land', cached: false, wallMs: 5, gpuMs: null, peakBytes: 4e6 });
  page.emit({ type: 'eval-end', requestId: 1, status: 'ok', wallMs: 5 });
  page.emit({ type: 'view-updated', requestId: 1, revision: 1, resolution: 505, draft: false, height: true, overlay: false });
  // The model that listened from the start measured it as it happened.
  assert.deepEqual(page.model.state.getState().measurements.peaks, { land: { bytes: 4e6, resolution: 505 } });

  const late = createBuildModel(page.ctx);
  assert.deepEqual(late.state.getState().measurements.peaks, { land: { bytes: 4e6, resolution: 505 } }, 'and one that begins later takes it from engineStore');
  late.dispose();

  page.files.set(`${OUT}/Export.orogen.json`, MANIFEST);
  runBuild(page, 2, resultOf('ok', { outDir: OUT, manifest: 'Export.orogen.json' }));
  const later = createBuildModel(page.ctx);
  await turn();
  assert.ok(later.state.getState().files?.manifest?.ok, 'the files of a build that ended before it listened are read');
  assert.equal(later.state.getState().log, null, 'its log is not: nobody heard its events');
  // After dispose nothing reaches the model.
  later.dispose();
  page.emit({ type: 'build-start', requestId: 3, resolution: 1009, outDir: OUT });
  assert.equal(later.state.getState().log, null);
});
