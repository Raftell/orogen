// What the inspector shows for a selection (src/app/panels/inspector/model.ts, settings.ts): which nodes it
// edits, how their parameters fall into sections, which are hidden by visibleWhen, which differ from their
// defaults, what several nodes share, and what it says of the engine's report and of the project settings.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { NodeDef, ParamDef } from '../../../../src/core/api.ts';
import { nodes } from '../../../../src/core/nodes/index.ts';
import {
  addNode, canBypass, connect, createRegistry, missingInputs, newDoc, portLabel, setNodeFlags, setParam, type DocDraft, type GraphDoc, type NodeError, type ProjectSettings,
} from '../../../../src/core/runtime.ts';
import type { NodeRuntime } from '../../../../src/app/state/engine-store.ts';
import {
  errorFacts, excerptLines, isChanged, isSteady, isVisible, layoutParams, measuredAt, nodeValues, outputRole, paramLabel, sameValue, SETTLED, sharedValues,
  statusLine, statusSummary, targetOf, visibleSections,
} from '../../../../src/app/panels/inspector/model.ts';
import {
  buildResolutionOptions, formatSpacing, highestPointText, isUndoableSetting, metresPerVertex, previewLevelLabel, previewLevels, previewResolutionText, SETTING_HELP, SETTING_LABELS,
  UNREAL_RESOLUTIONS,
} from '../../../../src/app/panels/inspector/settings.ts';

const REGISTRY = createRegistry(nodes);
const def = (type: string): NodeDef => REGISTRY.get(type)!;
const names = (params: readonly ParamDef[]): string[] => params.map((param) => param.name);

function docWith(build: (draft: DocDraft) => void): GraphDoc {
  const draft = structuredClone(newDoc()) as DocDraft;
  build(draft);
  return draft as GraphDoc;
}

test('nothing selected is the project settings; nodes of one type are edited together; other selections are a summary', () => {
  let noise = '';
  let second = '';
  let blur = '';
  const doc = docWith((draft) => {
    noise = addNode(draft, REGISTRY, 'generate/fractal-noise', { x: 0, y: 0 });
    second = addNode(draft, REGISTRY, 'generate/fractal-noise', { x: 0, y: 100 });
    blur = addNode(draft, REGISTRY, 'filter/blur', { x: 200, y: 0 });
    draft.nodes.old = { id: 'old', type: 'generate/fractal-noise', version: 7, position: { x: 0, y: 0 }, params: {} };
    draft.nodes.gone = { id: 'gone', type: 'generate/no-such-node', version: 1, position: { x: 0, y: 0 }, params: { size: 3 } };
  });
  const target = (selection: readonly string[]) => targetOf(doc.nodes, REGISTRY, selection);

  assert.deepEqual(target([]), { kind: 'settings' });
  assert.deepEqual(target(['deleted-meanwhile']), { kind: 'settings' }, 'an id the document does not hold selects nothing');

  const one = target([noise]);
  assert.ok(one.kind === 'nodes');
  assert.deepEqual([one.def.type, one.ids, one.locked], ['generate/fractal-noise', [noise], null]);

  const two = target([noise, 'deleted-meanwhile', second, noise]);
  assert.ok(two.kind === 'nodes');
  assert.deepEqual([two.ids, two.nodes.length, two.locked], [[noise, second], 2, null]);

  const mixed = target([noise, blur, second]);
  assert.ok(mixed.kind === 'summary');
  assert.deepEqual(mixed.types, [
    { type: 'generate/fractal-noise', title: 'Fractal Noise', category: 'generate', count: 2 },
    { type: 'filter/blur', title: 'Blur', category: 'filter', count: 1 },
  ]);

  // A node saved by another version of its type is shown and not edited: setParam would refuse it (runtime.md 4.5).
  const old = target(['old']);
  assert.ok(old.kind === 'nodes');
  assert.equal(old.locked, 'Saved with version 7 of this node; this build has version 1');
  assert.throws(() => setParam(structuredClone(doc) as DocDraft, REGISTRY, 'old', 'size', 0.5), { message: old.locked! });

  // A type this build does not have is a summary that names it.
  const gone = target(['gone']);
  assert.ok(gone.kind === 'summary');
  assert.deepEqual(gone.types, [{ type: 'generate/no-such-node', title: 'generate/no-such-node', category: null, count: 1 }]);
});

test('what can be bypassed is what the core says can: an input and an output of one kind', () => {
  assert.equal(canBypass(def('filter/blur')), true);
  assert.equal(canBypass(def('generate/fractal-noise')), false, 'a generator has no input to pass on');
  assert.equal(canBypass(def('color/gradient-map')), false, 'a field in and a color out');
});

test('an output that has the kind of its input carries what is connected there: heights stay heights through a blur', () => {
  const ids = { noise: '', blur: '', sharpen: '', slope: '', map: '', blurred: '', loose: '' };
  const doc = docWith((draft) => {
    ids.noise = addNode(draft, REGISTRY, 'generate/fractal-noise', { x: 0, y: 0 });
    ids.blur = addNode(draft, REGISTRY, 'filter/blur', { x: 0, y: 0 });
    ids.sharpen = addNode(draft, REGISTRY, 'filter/sharpen', { x: 0, y: 0 });
    ids.slope = addNode(draft, REGISTRY, 'select/slope', { x: 0, y: 0 });
    ids.map = addNode(draft, REGISTRY, 'color/gradient-map', { x: 0, y: 0 });
    ids.blurred = addNode(draft, REGISTRY, 'filter/blur', { x: 0, y: 0 });
    ids.loose = addNode(draft, REGISTRY, 'filter/blur', { x: 0, y: 0 });
    const wire = (from: string, to: string): void => {
      const id = `${from}-${to}`;
      draft.edges[id] = { id, from: { node: from, port: 'out' }, to: { node: to, port: 'in' } };
    };
    wire(ids.noise, ids.blur);
    wire(ids.blur, ids.sharpen);
    wire(ids.sharpen, ids.slope);
    wire(ids.noise, ids.map);
    wire(ids.map, ids.blurred);
  });
  const role = (node: string, port = 'out') => outputRole(doc, REGISTRY, { node, port });
  assert.equal(role(ids.noise), 'height');
  assert.equal(role(ids.blur), 'height', 'through one node');
  assert.equal(role(ids.sharpen), 'height', 'and through two');
  assert.equal(role(ids.slope), 'mask', 'a mask is no height');
  assert.equal(role(ids.map), null, 'a color has no role');
  assert.equal(role(ids.blurred), null, 'nor has a blurred color');
  assert.equal(role(ids.loose), null, 'nor an output whose input is not connected');
  assert.equal(role('no-such-node'), null);
  assert.equal(role(ids.noise, 'no-such-port'), null);
  // A cycle, which a file edited by hand may hold, ends.
  const cyclic = { nodes: doc.nodes, edges: { ...doc.edges, loop: { id: 'loop', from: { node: ids.loose, port: 'out' }, to: { node: ids.loose, port: 'in' } } } };
  assert.equal(outputRole(cyclic, REGISTRY, { node: ids.loose, port: 'out' }), null);
});

test('a required input that nothing is connected to is read off the document by the evaluator\'s rule, and said by its label; an optional one and a bypassed node lack nothing', () => {
  const ids = { range: '', combine: '', blur: '' };
  const doc = docWith((draft) => {
    ids.range = addNode(draft, REGISTRY, 'generate/mountain-range', { x: 0, y: 0 });
    ids.combine = addNode(draft, REGISTRY, 'adjust/combine', { x: 300, y: 0 });
    ids.blur = addNode(draft, REGISTRY, 'filter/blur', { x: 600, y: 0 });
  });
  const missing = (held: GraphDoc, id: string): string[] => missingInputs(held, REGISTRY, id).map(portLabel);
  assert.deepEqual(missing(doc, ids.range), [], 'a generator has no input');
  assert.deepEqual(missing(doc, ids.combine), ['A', 'B'], 'both required inputs, not the optional mask');
  assert.deepEqual(missing(doc, ids.blur), ['In']);
  const wired = docWith((draft) => {
    Object.assign(draft, structuredClone(doc));
    connect(draft, REGISTRY, { node: ids.range, port: 'out' }, { node: ids.combine, port: 'a' });
    connect(draft, REGISTRY, { node: ids.range, port: 'out' }, { node: ids.blur, port: 'in' });
  });
  assert.deepEqual(missing(wired, ids.combine), ['B']);
  assert.deepEqual(missing(wired, ids.blur), []);
  // A wire from a node that is gone, or from an output its node does not have, connects nothing (runtime.md 4.3 rule 1).
  const dangling = structuredClone(wired) as DocDraft;
  for (const edge of Object.values(dangling.edges)) if (edge.to.node === ids.blur) edge.from = { node: ids.range, port: 'no-such-output' };
  assert.deepEqual(missing(dangling as GraphDoc, ids.blur), ['In']);
  // Bypassed, a node passes its first input on and reads nothing else (5.6): it lacks nothing.
  const bypassed = docWith((draft) => {
    Object.assign(draft, structuredClone(doc));
    setNodeFlags(draft, ids.blur, { bypass: true });
  });
  assert.deepEqual(missing(bypassed, ids.blur), []);
});

test('parameters without a group come first; each group is a section where its first parameter stands', () => {
  const noise = layoutParams(def('generate/fractal-noise').params);
  assert.deepEqual(noise.map((section) => [section.title, names(section.params)]), [
    [null, ['mode', 'size', 'octaves', 'gain', 'lacunarity', 'seed']],
    ['Warp', ['warpStrength', 'warpSize']],
  ]);
  const landscape = layoutParams(def('io/export-landscape').params);
  assert.deepEqual(landscape.map((section) => section.title), [null, 'Layers', 'World Partition']);
  assert.deepEqual(names(landscape[1]!.params), ['baseLayer', 'layerBlend', 'layerFloor', 'layerLimit']);

  // A node whose parameters are all grouped has no loose section, and one without parameters has no section.
  const grouped = [{ ...def('filter/blur').params[0]!, group: 'Shape' }];
  assert.deepEqual(layoutParams(grouped).map((section) => section.title), ['Shape']);
  assert.deepEqual(layoutParams([]), []);
  // Every parameter of the product lies in exactly one section.
  for (const node of nodes) {
    const sections = layoutParams(node.params);
    assert.deepEqual(names(sections.flatMap((section) => section.params)).sort(), names(node.params).sort(), node.type);
    assert.ok(sections.every((section) => section.params.length > 0), node.type);
    assert.equal(sections.filter((section) => section.title === null).length <= 1 && sections.findIndex((section) => section.title === null) <= 0, true, node.type);
  }
});

test('a control is hidden while its visibleWhen does not hold, for one value and for a list of values', () => {
  const combine = def('adjust/combine');
  const smoothness = combine.params.find((param) => param.name === 'smoothness')!;
  assert.deepEqual(smoothness.visibleWhen, { param: 'mode', equals: ['smooth-maximum', 'smooth-minimum'] });
  assert.equal(isVisible(smoothness, { mode: 'mix' }), false);
  assert.equal(isVisible(smoothness, { mode: 'smooth-maximum' }), true);
  assert.equal(isVisible(smoothness, { mode: 'smooth-minimum' }), true);
  assert.equal(isVisible(smoothness, {}), false, 'a missing value holds nothing');
  assert.equal(isVisible(combine.params[0]!, {}), true, 'a parameter without the member is always shown');
  assert.equal(isVisible({ visibleWhen: { param: 'on', equals: true } }, { on: true }), true);
  assert.equal(isVisible({ visibleWhen: { param: 'count', equals: 3 } }, { count: '3' }), false, 'values are compared as they are');

  const landscape = def('io/export-landscape');
  const shown = (values: Record<string, unknown>): string[] => names(visibleSections(landscape.params, [values]).flatMap((section) => section.params));
  assert.ok(shown({ rangeMode: 'measured' }).includes('headroom') && !shown({ rangeMode: 'measured' }).includes('heightMin'));
  assert.ok(!shown({ rangeMode: 'fixed' }).includes('headroom') && shown({ rangeMode: 'fixed' }).includes('heightMax'));
  // Of several nodes a parameter is shown when any of them shows it.
  const both = names(visibleSections(landscape.params, [{ rangeMode: 'measured' }, { rangeMode: 'fixed' }]).flatMap((section) => section.params));
  assert.ok(both.includes('headroom') && both.includes('heightMin'));

  // A section whose parameters are all hidden is not drawn.
  const hidden: ParamDef[] = [
    { kind: 'bool', name: 'detail', help: 'Adds detail.', default: false },
    { kind: 'int', name: 'steps', help: 'More steps are finer.', default: 2, min: 1, max: 8, group: 'Detail', visibleWhen: { param: 'detail', equals: true } },
  ];
  assert.deepEqual(visibleSections(hidden, [{ detail: false }]).map((section) => section.title), [null]);
  assert.deepEqual(visibleSections(hidden, [{ detail: true }]).map((section) => section.title), [null, 'Detail']);
});

test('a value is marked when it is not the default, whatever its kind', () => {
  assert.equal(sameValue(0.25, 0.25), true);
  assert.equal(sameValue([0.5, 0.5], [0.5, 0.5]), true);
  assert.equal(sameValue([0.5, 0.5], [0.5, 0.25]), false);
  assert.equal(sameValue([{ x: 0, y: 0 }, { x: 1, y: 1 }], [{ x: 0, y: 0 }, { x: 1, y: 1 }]), true);
  assert.equal(sameValue([{ x: 0, y: 0 }, { x: 1, y: 1 }], [{ x: 0, y: 0 }, { x: 1, y: 0.9 }]), false);
  assert.equal(sameValue([{ t: 0, color: [0, 0, 0] }], [{ t: 0, color: [0, 0, 0.1] }]), false);
  assert.equal(sameValue('a', 'a') && !sameValue('a', 'b') && !sameValue(1, '1') && !sameValue([1], { 0: 1 }), true);
  assert.equal(sameValue([1, 2], [1, 2, 3]), false);

  // Every parameter of the product is unchanged at its default, and what addNode stores is the default.
  for (const node of nodes) {
    const doc = docWith((draft) => { addNode(draft, REGISTRY, node.type, { x: 0, y: 0 }); });
    const values = nodeValues(node, Object.values(doc.nodes)[0]!);
    for (const param of node.params) assert.equal(isChanged(param, values[param.name]), false, `${node.type}.${param.name}`);
  }
  assert.equal(isChanged(def('adjust/curve').params[0]!, [{ x: 0, y: 0 }, { x: 1, y: 1 }]), true);
});

test('several nodes of one type show the first node\'s values and say which differ', () => {
  let a = '';
  let b = '';
  const doc = docWith((draft) => {
    a = addNode(draft, REGISTRY, 'generate/fractal-noise', { x: 0, y: 0 });
    b = addNode(draft, REGISTRY, 'generate/fractal-noise', { x: 0, y: 100 });
    setParam(draft, REGISTRY, a, 'size', 0.4);
    setParam(draft, REGISTRY, b, 'octaves', 5);
    setParam(draft, REGISTRY, a, 'gain', 0.7);
    setParam(draft, REGISTRY, b, 'gain', 0.7);
    setNodeFlags(draft, b, { title: 'Detail' });
  });
  const noise = def('generate/fractal-noise');
  const shared = sharedValues(noise, [doc.nodes[a]!, doc.nodes[b]!]);
  assert.deepEqual(shared.size, { value: 0.4, mixed: true, changed: true });
  assert.deepEqual(shared.octaves, { value: 8, mixed: true, changed: true }, 'the first node holds the default, the second does not');
  assert.deepEqual(shared.gain, { value: 0.7, mixed: false, changed: true });
  assert.deepEqual(shared.mode, { value: 'fbm', mixed: false, changed: false });
  assert.deepEqual(Object.keys(shared), names(noise.params), 'every declared parameter, in declaration order');

  // What a node does not store reads as the default; what it stores wrongly reads as the evaluator reads it.
  const bare = { ...doc.nodes[a]!, params: { octaves: 99, mode: 'spiky', size: 'wide' } };
  const values = nodeValues(noise, bare);
  assert.deepEqual([values.octaves, values.size, values.gain], [16, 0.25, 0.5]);
  assert.equal(values.mode, 'spiky', 'an enum value this build does not know is shown as it is stored');
  assert.equal(paramLabel({ name: 'warpSize' }), 'WarpSize');
  assert.equal(paramLabel({ name: 'warpSize', label: 'Warp size' }), 'Warp size');
});

const runtime = (patch: Partial<NodeRuntime>): NodeRuntime => ({
  requestId: 1, state: 'idle', cached: false, fraction: 0, label: null, etaMs: null, wallMs: null, peakBytes: null, resolution: null, error: null, upstream: null, ...patch,
});

test('the state of a node is one line: what it is, then the time and the memory of its last run', () => {
  assert.deepEqual(statusLine(undefined), { tone: 'idle', text: 'Not computed', facts: [] });
  assert.deepEqual(statusLine(runtime({}), null, { ...SETTLED, evaluating: true }), { tone: 'idle', text: 'Waiting', facts: [] });
  assert.deepEqual(statusLine(runtime({ state: 'done', wallMs: 145.2, peakBytes: 48 * 2 ** 20 })), { tone: 'ok', text: 'Computed', facts: ['145 ms', '48 MB'] });
  assert.deepEqual(statusLine(runtime({ state: 'done', cached: true, wallMs: 1250, peakBytes: 2 ** 31 })).facts, ['1.25 s', '2.0 GB', 'from cache']);
  assert.deepEqual(statusLine(runtime({ state: 'done', cached: true })).facts, ['from cache'], 'a node that never ran here has no time');
  assert.deepEqual(statusLine(runtime({ state: 'running', fraction: 0.416, label: 'Eroding', etaMs: 12_300 })), { tone: 'running', text: 'Computing 42 %', facts: ['Eroding', '12.3 s left'] });
  assert.deepEqual(statusLine(runtime({ state: 'running', fraction: 7 })).text, 'Computing 100 %');
  assert.deepEqual(statusLine(runtime({ state: 'error' })), { tone: 'error', text: 'Failed', facts: [] });
  assert.equal(statusLine(runtime({ state: 'skipped', upstream: 'n1' }), 'Blur').text, 'Skipped: Blur failed');
  assert.equal(statusLine(runtime({ state: 'skipped' })).text, 'Skipped: a node before it failed');

  assert.equal(statusSummary([runtime({ state: 'done' }), runtime({ state: 'done' }), undefined, runtime({ state: 'error' })]), '2 computed, 1 failed, 1 not computed');
  assert.equal(statusSummary([runtime({ state: 'running' })]), '1 computing');
  assert.equal(statusSummary([]), '');
});

test('a node without a result says why it has none, from what the engine is doing', () => {
  const idle = runtime({});
  // Nothing runs: the evaluation that would have reached the node was stopped (a pause), or shows another node now.
  assert.equal(statusLine(idle).text, 'Not computed', 'a node nothing will compute does not say that it waits');
  assert.equal(statusLine(idle, null, { ...SETTLED, evaluating: true }).text, 'Waiting');
  assert.equal(statusLine(undefined, null, { ...SETTLED, evaluating: true }).text, 'Not computed', 'a node no request has named is not waited for');
  for (const record of [idle, undefined]) {
    assert.equal(statusLine(record, null, { ...SETTLED, building: true }).text, 'Waiting for the build');
    assert.equal(statusLine(record, null, { ...SETTLED, device: 'lost', evaluating: true }).text, 'Waiting for the GPU device');
    assert.equal(statusLine(record, null, { ...SETTLED, device: 'failed' }).text, 'No GPU device');
    assert.equal(statusLine(record, null, { ...SETTLED, device: 'starting' }).text, 'Waiting for the engine');
    assert.equal(statusLine(record, null, { ...SETTLED, device: 'failed' }).tone, 'idle');
  }
  // An export node is run by a build and by no preview: without a record that is its normal state.
  assert.equal(statusLine(undefined, null, { ...SETTLED, exports: true }).text, 'Runs when the project is built');
  assert.equal(statusLine(undefined, null, { ...SETTLED, exports: true, device: 'failed' }).text, 'No GPU device');
  assert.equal(statusLine(runtime({ state: 'done', wallMs: 20, peakBytes: 2 ** 20 }), null, { ...SETTLED, exports: true }).text, 'Computed', 'a build that ran it has reported');
  assert.equal(statusLine(undefined, null, { ...SETTLED, exports: true, building: true }).text, 'Waiting for the build');
  // What the engine did report is said while a build runs and while a lost device comes back, which takes a moment.
  const busy = { ...SETTLED, building: true, device: 'lost' as const };
  assert.equal(statusLine(runtime({ state: 'done' }), null, busy).text, 'Computed');
  assert.equal(statusLine(runtime({ state: 'error' }), null, busy).text, 'Failed');
  assert.equal(statusLine(runtime({ state: 'running', fraction: 0.5 }), null, busy).text, 'Computing 50 %');
  // Without a device there are no results: what the last device computed went with it.
  for (const record of [runtime({ state: 'done', wallMs: 20, peakBytes: 2 ** 20 }), runtime({ state: 'error' }), runtime({ state: 'running' }), runtime({ state: 'skipped' })]) {
    assert.deepEqual(statusLine(record, 'Blur', { ...SETTLED, device: 'failed' }), { tone: 'idle', text: 'No GPU device', facts: [] });
    assert.deepEqual(statusLine(record, 'Blur', { ...SETTLED, device: 'starting' }), { tone: 'idle', text: 'Waiting for the engine', facts: [] });
  }
});

test('with the previews paused a node without a result says "Paused", and one that has a result says what it has', () => {
  const paused = { ...SETTLED, paused: true };
  for (const record of [runtime({}), undefined]) assert.deepEqual(statusLine(record, null, paused), { tone: 'idle', text: 'Paused', facts: [] });
  // What stands in the way before the pause does is said first: without a device a resumed preview computes nothing either.
  assert.equal(statusLine(undefined, null, { ...paused, device: 'failed' }).text, 'No GPU device');
  assert.equal(statusLine(undefined, null, { ...paused, device: 'starting' }).text, 'Waiting for the engine');
  assert.equal(statusLine(runtime({}), null, { ...paused, building: true }).text, 'Waiting for the build');
  // An export node runs in no preview: the pause is not what it waits for.
  assert.equal(statusLine(undefined, null, { ...paused, exports: true }).text, 'Runs when the project is built');
  assert.equal(statusLine(runtime({ state: 'done', wallMs: 20, peakBytes: 2 ** 20 }), null, paused).text, 'Computed');
  assert.equal(statusLine(runtime({ state: 'error' }), null, paused).text, 'Failed');
  assert.equal(statusSummary([runtime({ state: 'done' }), undefined, runtime({})], true), '1 computed, 2 paused');
  assert.equal(statusSummary([runtime({ state: 'done' }), undefined], false), '1 computed, 1 not computed');
});

test('a time measured at another resolution than the view\'s says at which: a node outside the view ran for its thumbnail', () => {
  const thumb = runtime({ state: 'done', wallMs: 3, peakBytes: 2 ** 20, resolution: 253 });
  assert.deepEqual(statusLine(thumb, null, { ...SETTLED, viewResolution: 1009 }).facts, ['3 ms', '1 MB', 'at 253 × 253']);
  assert.deepEqual(statusLine(thumb, null, { ...SETTLED, viewResolution: 253 }).facts, ['3 ms', '1 MB'], 'the view\'s own resolution is the one the status bar names');
  assert.deepEqual(statusLine(thumb, null, { ...SETTLED, viewResolution: null }).facts, ['3 ms', '1 MB', 'at 253 × 253'], 'with nothing shown there is no other place that names it');
  assert.deepEqual(statusLine({ ...thumb, cached: true }, null, { ...SETTLED, viewResolution: 1009 }).facts, ['3 ms', '1 MB', 'at 253 × 253', 'from cache']);
  // A record without figures has nothing to qualify, and one of an engine that names no resolution says none.
  assert.deepEqual(statusLine(runtime({ state: 'done', cached: true, resolution: 253 }), null, { ...SETTLED, viewResolution: 1009 }).facts, ['from cache']);
  assert.deepEqual(statusLine(runtime({ state: 'done', wallMs: 3, peakBytes: 2 ** 20 }), null, { ...SETTLED, viewResolution: 1009 }).facts, ['3 ms', '1 MB']);
  assert.equal(measuredAt({ resolution: 1009 }, 1009), null);
  assert.equal(measuredAt({ resolution: 64 }, 1009), 'at 64 × 64');
});

test('the head takes a finished run, a failure and no record at once; a draft, a wait and a run only when they last', () => {
  assert.equal(isSteady(undefined, false), true);
  assert.equal(isSteady(undefined, true), true);
  assert.equal(isSteady(runtime({ state: 'done' }), false), true);
  assert.equal(isSteady(runtime({ state: 'done' }), true), false, 'the time and the memory of a draft are those of a coarse grid');
  for (const drafting of [false, true]) {
    assert.equal(isSteady(runtime({ state: 'error' }), drafting), true);
    assert.equal(isSteady(runtime({ state: 'skipped' }), drafting), true);
    assert.equal(isSteady(runtime({ state: 'idle' }), drafting), false);
    assert.equal(isSteady(runtime({ state: 'running' }), drafting), false);
  }
});

test('an error is its kind, its kernel and, for a shader, the line with its excerpt', () => {
  const io: NodeError = { nodeId: 'n', nodeType: 'io/import-field', kind: 'io', message: 'File not found: heights.png' };
  assert.deepEqual(errorFacts(io), [{ label: 'Kind', value: 'File' }]);

  const shader: NodeError = {
    nodeId: 'n', nodeType: 'filter/blur', kind: 'shader-compile', message: 'kernel "filter/blur.pass": unresolved value \'radiu\'', kernel: 'filter/blur.pass',
    detail: 'error: unresolved value \'radiu\'\n  at line 43',
    wgsl: { origin: 'code', line: 12, column: 21, length: 5, message: 'unresolved value \'radiu\'', excerpt: ['  let a = 1.0;', '  let b = 2.0;', '  let r = params.radiu;', '  let c = 3.0;', '}'] },
  };
  assert.deepEqual(errorFacts(shader), [
    { label: 'Kind', value: 'Shader error' },
    { label: 'Kernel', value: 'filter/blur.pass' },
    { label: 'Line', value: '12, column 21, in kernel code' },
  ]);
  assert.deepEqual(excerptLines(shader.wgsl!).map((line) => [line.number, line.failing]), [[10, false], [11, false], [12, true], [13, false], [14, false]]);
  assert.equal(excerptLines(shader.wgsl!)[2]!.text, '  let r = params.radiu;');

  // Near the top of its segment the excerpt begins at the first line (runtime.md 5.8).
  const second = { ...shader.wgsl!, line: 2, excerpt: ['fn a() {', '  bad;', '  x;', '}'] };
  assert.deepEqual(excerptLines(second).map((line) => [line.number, line.failing]), [[1, false], [2, true], [3, false], [4, false]]);
  const first = { ...shader.wgsl!, line: 1, excerpt: ['bad;', 'x;', 'y;'] };
  assert.deepEqual(excerptLines(first).map((line) => [line.number, line.failing]), [[1, true], [2, false], [3, false]]);
  assert.equal(errorFacts({ ...shader, wgsl: { ...shader.wgsl!, origin: 'library:noise' } })[2]!.value, '12, column 21, in library noise');
  assert.equal(errorFacts({ ...shader, wgsl: { ...shader.wgsl!, origin: 'generated' } })[2]!.value, '12, column 21, in generated code');
});

// ---- the project settings ----

const settings = (patch: Partial<ProjectSettings>): ProjectSettings => ({ ...newDoc().settings, ...patch });

test('the preview levels of a build resolution are those of the ladder, each with the resolution it gives', () => {
  // The table of engine.md 1.5.
  const table: Readonly<Record<number, number[]>> = {
    8129: [8129, 4065, 2033, 1017, 509, 255, 128],
    4033: [4033, 2017, 1009, 505, 253, 127, 64],
    2017: [2017, 1009, 505, 253, 127, 64],
    1009: [1009, 505, 253, 127, 64],
  };
  for (const [build, resolutions] of Object.entries(table)) {
    const levels = previewLevels(settings({ buildResolution: Number(build) }));
    assert.deepEqual(levels.map((level) => level.resolution), resolutions, `build resolution ${build}`);
    assert.deepEqual(levels.map((level) => level.level), resolutions.map((_, index) => index));
  }
  // A custom resolution has the levels its own arithmetic allows: (B − 1) divisible by 2^k, and at least 33.
  assert.deepEqual(previewLevels(settings({ buildResolution: 2049 })).map((level) => level.resolution), [2049, 1025, 513, 257, 129, 65, 33]);
  assert.deepEqual(previewLevels(settings({ buildResolution: 145 })).map((level) => level.resolution), [145, 73, 37]);
  // The level the project has is always among them, whatever it was set to before.
  assert.equal(previewLevels(settings({ buildResolution: 1009, previewLevel: 4 })).length, 5);

  assert.equal(previewLevelLabel({ level: 0, resolution: 4033 }), 'Full · 4033 × 4033');
  assert.equal(previewLevelLabel({ level: 2, resolution: 1009 }), '1/4 · 1009 × 1009');
  assert.equal(previewLevelLabel({ level: 6, resolution: 64 }), '1/64 · 64 × 64');

  // What the previews are computed at, as the settings say it under the two selects.
  assert.equal(previewResolutionText(settings({ buildResolution: 4033, previewLevel: 2 })), "1009 × 1009, 1/4 of the build's 4033 × 4033");
  assert.equal(previewResolutionText(settings({ buildResolution: 1009, previewLevel: 0 })), '1009 × 1009, the build resolution itself');
  assert.equal(previewResolutionText(settings({ buildResolution: 8129, previewLevel: 3 })), "1017 × 1017, 1/8 of the build's 8129 × 8129");
});

test('the build resolutions offered are Unreal\'s landscape sizes, and the project\'s own when it is another', () => {
  assert.deepEqual(UNREAL_RESOLUTIONS, [1009, 2017, 4033, 8129]);
  assert.deepEqual(buildResolutionOptions(4033), [
    { value: '1009', label: '1009 × 1009' }, { value: '2017', label: '2017 × 2017' }, { value: '4033', label: '4033 × 4033' }, { value: '8129', label: '8129 × 8129' },
  ]);
  assert.deepEqual(buildResolutionOptions(2049)[4], { value: '2049', label: '2049 × 2049 (custom)' });
  assert.equal(metresPerVertex(newDoc().settings), 1, 'the default project is one metre per vertex');
  assert.equal(formatSpacing(metresPerVertex(settings({ terrainSize: 8128, buildResolution: 4033 }))), '2.02 m');
  assert.equal(formatSpacing(0.5), '0.5 m');
});

test('the top of the height range is said in metres, and against the sea on the side it lies on', () => {
  assert.equal(highestPointText({ heightRange: 1008, seaLevel: 0 }), '1008 m at height 1, 1008 m above the sea');
  assert.equal(highestPointText({ heightRange: 2016, seaLevel: 0.125 }), '2016 m at height 1, 1764 m above the sea');
  assert.equal(highestPointText({ heightRange: 1000, seaLevel: -1 }), '1000 m at height 1, 2000 m above the sea', 'no sea: a level below the terrain');
  assert.equal(highestPointText({ heightRange: 1000, seaLevel: 1 }), '1000 m at height 1, 0 m above the sea');
  assert.equal(highestPointText({ heightRange: 1000, seaLevel: 1.5 }), '1000 m at height 1, 500 m below the sea', 'never a negative height above it');
  assert.doesNotMatch(highestPointText({ heightRange: 1, seaLevel: 1e12 }), /-/);
});

test('every setting has a label and a help text as testing.md 6.2 asks, and two are no undo steps', () => {
  const all = Object.keys(newDoc().settings).sort();
  assert.deepEqual(Object.keys(SETTING_LABELS).sort(), all);
  assert.deepEqual(Object.keys(SETTING_HELP).sort(), all);
  for (const name of all as (keyof ProjectSettings)[]) {
    assert.match(SETTING_LABELS[name], /^[A-Z][a-z]+( [a-z]+)*$/, `"${SETTING_LABELS[name]}" is sentence case`);
    assert.ok(SETTING_LABELS[name].length <= 24);
    assert.ok(SETTING_HELP[name].length <= 200 && SETTING_HELP[name].endsWith('.'), `the help of ${name}`);
  }
  assert.deepEqual(all.filter((name) => !isUndoableSetting(name as keyof ProjectSettings)), ['buildResolution', 'previewLevel']);
});
