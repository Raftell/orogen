// What the hidden-window tests of the build panel share. Not a test file.
//
// A test builds real projects into folders of its own under <OROGEN_TEST_OUTPUT>/build-panel, and looks at what
// the panel shows and at what is on disk. Input is synthesised in the page with the shell's `shellTest`
// (tests/ui/shell/rig.ts); the folder dialog is answered through `orogenTest.shell.answers` (testing.md 2.9).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { nodes } from '../../../src/core/nodes/index.ts';
import {
  addNode, connect, createRegistry, newDoc, serializeDoc, setNodeFlags, setParam, setSettings, setView,
  type BuildResult, type DocDraft, type GraphDoc, type ProjectSettings,
} from '../../../src/core/runtime.ts';
import type { AppDriver } from '../../helpers/index.ts';
import { docked, EVALUATION_BACKSTOP_MS, install, PAGE_BACKSTOP_MS, quote, ready, ROOT, settled, sleep } from '../shell/rig.ts';
import { launchApp } from '../../helpers/index.ts';

export { appears, exists, key, press, quote, run, vanishes } from '../shell/rig.ts';

export const REGISTRY = createRegistry(nodes);
/** Files these tests write. Captures go to <OROGEN_TEST_OUTPUT>/ui/build (AppDriver.capture). */
export const OUTPUT = path.resolve(process.env.OROGEN_TEST_OUTPUT || path.join(ROOT, 'test-output'), 'build-panel');
/** A build of a small project, with the preview that follows it. */
export const BUILD_BACKSTOP_MS = 120_000;

/** An empty folder of this name for one test: what was left of an earlier run is removed. */
export function scratch(name: string): string {
  const folder = path.join(OUTPUT, name);
  // Nothing but a folder of these tests is ever removed.
  assert.ok(folder.startsWith(OUTPUT + path.sep) && !name.includes('..'), folder);
  for (const stale of [folder, `${folder}.partial`, `${folder}.previous`]) fs.rmSync(stale, { recursive: true, force: true });
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

export const SETTINGS: ProjectSettings = { terrainSize: 2000, heightRange: 500, seed: 7, buildResolution: 1009, previewLevel: 1, seaLevel: 0 };

export interface ProjectIds { range: string; steep: string; landscape: string; rock: string; normal: string }

/**
 * A small project made with the commands of runtime.md 4.6: a mountain range, a mask of its steep ground, and
 * three exports of them: the landscape, one weight-blended layer and a normal texture.
 */
export function ridge(settings: Partial<ProjectSettings> = {}, change?: (draft: DocDraft, ids: ProjectIds) => void): { doc: GraphDoc; ids: ProjectIds } {
  const draft = structuredClone(newDoc()) as DocDraft;
  setSettings(draft, { ...SETTINGS, ...settings });
  const ids = {} as ProjectIds;
  ids.range = addNode(draft, REGISTRY, 'generate/mountain-range', { x: 0, y: 0 });
  ids.steep = addNode(draft, REGISTRY, 'select/slope', { x: 260, y: 140 });
  ids.landscape = addNode(draft, REGISTRY, 'io/export-landscape', { x: 520, y: 0 });
  ids.rock = addNode(draft, REGISTRY, 'io/export-layer', { x: 520, y: 140 });
  ids.normal = addNode(draft, REGISTRY, 'io/export-normal', { x: 520, y: 280 });
  setParam(draft, REGISTRY, ids.steep, 'slopeMin', 30);
  setParam(draft, REGISTRY, ids.steep, 'slopeMax', 90);
  setParam(draft, REGISTRY, ids.landscape, 'name', 'Ridge');
  setParam(draft, REGISTRY, ids.rock, 'layer', 'Rock');
  connect(draft, REGISTRY, { node: ids.range, port: 'out' }, { node: ids.steep, port: 'in' });
  connect(draft, REGISTRY, { node: ids.range, port: 'out' }, { node: ids.landscape, port: 'in' });
  connect(draft, REGISTRY, { node: ids.steep, port: 'out' }, { node: ids.rock, port: 'in' });
  connect(draft, REGISTRY, { node: ids.range, port: 'out' }, { node: ids.normal, port: 'in' });
  setView(draft, { height: { node: ids.range, port: 'out' } });
  change?.(draft, ids);
  return { doc: draft as GraphDoc, ids };
}

/**
 * The ridge with more to write, so that a build at 4033 lasts some seconds: a second weight-blended layer, an
 * independent one, a mask texture and two images. Eight targets and fifteen files.
 */
export function longRidge(settings: Partial<ProjectSettings> = {}): { doc: GraphDoc; ids: ProjectIds } {
  return ridge(settings, (draft, ids) => {
    const scree = addNode(draft, REGISTRY, 'select/slope', { x: 260, y: 420 });
    setParam(draft, REGISTRY, scree, 'slopeMin', 12);
    setParam(draft, REGISTRY, scree, 'slopeMax', 30);
    connect(draft, REGISTRY, { node: ids.range, port: 'out' }, { node: scree, port: 'in' });
    const add = (type: string, from: string, params: Readonly<Record<string, unknown>>, y: number): void => {
      const id = addNode(draft, REGISTRY, type, { x: 520, y });
      for (const [name, value] of Object.entries(params)) setParam(draft, REGISTRY, id, name, value);
      connect(draft, REGISTRY, { node: from, port: 'out' }, { node: id, port: 'in' });
    };
    add('io/export-layer', scree, { layer: 'Scree' }, 420);
    add('io/export-layer', ids.steep, { layer: 'Steep', weightBlended: false }, 560);
    add('io/export-mask', scree, { name: 'Scree', bits: '16' }, 700);
    add('io/export-field', ids.range, { name: 'Heights' }, 840);
    add('io/export-field', ids.range, { name: 'Relief', format: 'png16', rangeMode: 'measured' }, 980);
  });
}

/** The names of `crowded`: as long as their parameters take, and a title no row has room for. */
export const LONG = {
  landscape: 'TheGreatNorthernRangeOfTheUpperValleyWithItsThreeGlaciersAndLake',
  layer: 'AVeryLongLayerNameThatGoesOnAndOnUntilItReachesTheLimitOfSixtyT',
  normal: 'NormalsOfTheGreatNorthernRangeOfTheUpperValleyWithItsThreeGlacie',
  title: 'The landscape of the great northern range, final export for the autumn milestone (do not switch off)',
} as const;

export interface CrowdedIds { range: string; last: string; landscape: string; layers: string[]; slopes: string[]; normal: string; image: string; off: string; loose: string }

/**
 * A project as large as projects get: 294 nodes. A chain of 260 inverts behind a mountain range (an even number,
 * so the terrain is the range's), fourteen slope masks each with a Landscape Layer, a landscape, a normal texture
 * and an image, with names as long as the parameters take; and two exports no build writes for: a mask texture
 * that is switched off, and a color texture with nothing connected, which stops a build at its plan.
 */
export function crowded(settings: Partial<ProjectSettings> = {}, change?: (draft: DocDraft, ids: CrowdedIds) => void): { doc: GraphDoc; ids: CrowdedIds } {
  const draft = structuredClone(newDoc()) as DocDraft;
  setSettings(draft, { terrainSize: 8000, heightRange: 3000, seed: 3, buildResolution: 241, previewLevel: 1, seaLevel: 0.1, ...settings });
  const ids = { layers: [], slopes: [] } as unknown as CrowdedIds;
  ids.range = addNode(draft, REGISTRY, 'generate/mountain-range', { x: 0, y: 0 });
  let last = ids.range;
  for (let i = 0; i < 260; i++) {
    const id = addNode(draft, REGISTRY, 'adjust/invert', { x: 200 + (i % 20) * 180, y: Math.floor(i / 20) * 160 });
    connect(draft, REGISTRY, { node: last, port: 'out' }, { node: id, port: 'in' });
    last = id;
  }
  ids.last = last;
  ids.landscape = addNode(draft, REGISTRY, 'io/export-landscape', { x: 4200, y: 0 });
  setParam(draft, REGISTRY, ids.landscape, 'name', LONG.landscape);
  setNodeFlags(draft, ids.landscape, { title: LONG.title });
  connect(draft, REGISTRY, { node: last, port: 'out' }, { node: ids.landscape, port: 'in' });
  const names = ['Rock', 'Scree', 'Grass', 'Forest', 'Snow', 'Sand', 'Mud', 'Gravel', 'Moss', 'Ice', 'Dirt', 'Cliff', LONG.layer, 'Wet'];
  names.forEach((name, i) => {
    const slope = addNode(draft, REGISTRY, 'select/slope', { x: 4000, y: 200 + i * 160 });
    setParam(draft, REGISTRY, slope, 'slopeMin', i * 5);
    setParam(draft, REGISTRY, slope, 'slopeMax', i * 5 + 10);
    connect(draft, REGISTRY, { node: last, port: 'out' }, { node: slope, port: 'in' });
    const layer = addNode(draft, REGISTRY, 'io/export-layer', { x: 4200, y: 200 + i * 160 });
    setParam(draft, REGISTRY, layer, 'layer', name);
    if (name === 'Wet') setParam(draft, REGISTRY, layer, 'weightBlended', false);
    connect(draft, REGISTRY, { node: slope, port: 'out' }, { node: layer, port: 'in' });
    ids.layers.push(layer);
    ids.slopes.push(slope);
  });
  ids.normal = addNode(draft, REGISTRY, 'io/export-normal', { x: 4200, y: 2600 });
  setParam(draft, REGISTRY, ids.normal, 'name', LONG.normal);
  connect(draft, REGISTRY, { node: last, port: 'out' }, { node: ids.normal, port: 'in' });
  ids.image = addNode(draft, REGISTRY, 'io/export-field', { x: 4200, y: 2800 });
  setParam(draft, REGISTRY, ids.image, 'name', 'Heights');
  setParam(draft, REGISTRY, ids.image, 'format', 'tiff32');
  connect(draft, REGISTRY, { node: last, port: 'out' }, { node: ids.image, port: 'in' });
  ids.off = addNode(draft, REGISTRY, 'io/export-mask', { x: 4200, y: 3000 });
  setParam(draft, REGISTRY, ids.off, 'enabled', false);
  ids.loose = addNode(draft, REGISTRY, 'io/export-color', { x: 4200, y: 3200 });
  setView(draft, { height: { node: ids.range, port: 'out' } });
  change?.(draft, ids);
  return { doc: draft as GraphDoc, ids };
}

/** Writes a project file into `folder` and returns its path. */
export function writeProject(folder: string, name: string, doc: GraphDoc): string {
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${name}.orogen`);
  fs.writeFileSync(file, serializeDoc(doc));
  return file;
}

/** Runs `body` on an application that has opened `project` and shows the build panel, and closes it. close() rejects for any error the application reported. */
export async function withBuildPanel(project: string | undefined, body: (app: AppDriver) => Promise<void>): Promise<void> {
  const app = await launchApp({ profile: 'core', ...(project === undefined ? {} : { open: project }) });
  try {
    await install(app);
    await ready(app);
    await docked(app);
    if (project !== undefined) await app.waitFor(`orogenTest.ctx.doc.getState().path === ${quote(project)}`, PAGE_BACKSTOP_MS);
    await settled(app);
    await showPanel(app);
    await body(app);
  } catch (thrown) {
    await app.close().catch(() => {});
    throw thrown;
  }
  await app.close();
}

/** Brings the Build tab to the front, as a press on it does. */
export async function showPanel(app: AppDriver): Promise<void> {
  await app.eval(`void shellTest.press([...document.querySelectorAll('.dv-tab')].find((tab) => tab.textContent === 'Build'))`);
  await app.waitFor(`document.querySelector('[data-panel="build"] [data-build="panel"]') !== null`, PAGE_BACKSTOP_MS);
}

export const text = (app: AppDriver, selector: string): Promise<string | null> =>
  app.eval<string | null>(`document.querySelector(${quote(selector)})?.textContent ?? null`);
export const texts = (app: AppDriver, selector: string): Promise<string[]> =>
  app.eval<string[]>(`[...document.querySelectorAll(${quote(selector)})].map((element) => element.textContent)`);
export const attr = (app: AppDriver, selector: string, name: string): Promise<string | null> =>
  app.eval<string | null>(`document.querySelector(${quote(selector)})?.getAttribute(${quote(name)}) ?? null`);

/** Chooses the output folder through the panel's command, with the folder dialog answered. */
export async function chooseFolder(app: AppDriver, folder: string): Promise<void> {
  await app.eval(`void (orogenTest.shell.answers.chooseFolder.push(${quote(folder)}), orogenTest.ctx.run('build.chooseFolder'))`);
  await app.waitFor(`document.querySelector('[data-build="folder"]')?.textContent === ${quote(folder)}`, PAGE_BACKSTOP_MS);
}

export interface BuildState {
  readonly requestId: number | null;
  readonly running: boolean;
  readonly lastStatus: string | null;
  readonly result: BuildResult | null;
}
export const buildState = (app: AppDriver): Promise<BuildState> => app.eval<BuildState>(`(() => {
  const { requestId, running, lastStatus, result } = orogenTest.ctx.engineState.getState().build;
  return { requestId, running, lastStatus, result };
})()`);

/** Waits until a build newer than `after` has ended and the panel has read what it wrote. */
export async function built(app: AppDriver, after: number | null): Promise<BuildResult> {
  await app.waitFor(`(() => {
    const build = orogenTest.ctx.engineState.getState().build;
    return !build.running && build.result !== null && build.requestId !== ${after === null ? 'null' : after};
  })()`, BUILD_BACKSTOP_MS);
  await app.waitFor(`!document.querySelector('[data-build="status"]').hasAttribute('data-running')`, PAGE_BACKSTOP_MS);
  return (await buildState(app)).result!;
}

/** Starts a build with the panel's button and waits for its end. */
export async function build(app: AppDriver): Promise<BuildResult> {
  const before = (await buildState(app)).requestId;
  await app.eval(`void shellTest.press('[data-panel="build"] [data-command="build.start"]')`);
  return built(app, before);
}

/**
 * A capture of the window for a person (testing.md 8.5 rule 1), under ui/build/. A window that was never shown
 * draws about once a second: the picture is taken two page frames and a second after what the test did.
 */
export async function capture(app: AppDriver, name: string): Promise<string> {
  await app.eval(`new Promise((resolve) => {
    const done = () => resolve(true);
    setTimeout(done, 5000);
    requestAnimationFrame(() => requestAnimationFrame(done));
  })`);
  await sleep(1200);
  return app.capture(`build/${name}`);
}

/** Dismisses the shell's notices, which lie over the side column: the panel says what they say. */
export const dismissNotices = (app: AppDriver): Promise<void> =>
  app.eval<void>(`void [...document.querySelectorAll('[data-ui="notice"] [aria-label="Dismiss"]')].forEach((button) => shellTest.press(button))`);

/** Brings another panel's tab to the front. */
export const showTab = (app: AppDriver, title: string): Promise<void> =>
  app.eval<void>(`void shellTest.press([...document.querySelectorAll('.dv-tab')].find((tab) => tab.textContent === ${quote(title)}))`);

/** Scrolls the panel so that a part of it is in the picture. */
export const scrollTo = (app: AppDriver, selector: string): Promise<void> =>
  app.eval<void>(`void document.querySelector(${quote(selector)})?.scrollIntoView({ block: 'start' })`);

/** Stores a value of a parameter of a node, in one transaction: one undo step. */
export const setParamIn = (app: AppDriver, nodeId: string, name: string, value: unknown): Promise<void> =>
  app.eval<void>(`void orogenTest.ctx.doc.getState().transact('Parameter', (draft) => { draft.nodes[${quote(nodeId)}].params[${quote(name)}] = ${JSON.stringify(value)}; })`);

/**
 * Makes the column that holds the build panel `width` pixels wide, as dragging its edge does: the dock's layout
 * with other sizes, restored through the dock.
 */
export async function sideWidth(app: AppDriver, width: number): Promise<void> {
  const restored = await app.eval<string>(`(() => {
    const layout = JSON.parse(JSON.stringify(orogenTest.shell.layout()));
    const columns = layout.dock.grid.root.data;
    const side = columns.find((column) => column.type === 'leaf' && column.data.views.includes('build'));
    const others = columns.filter((column) => column !== side);
    const total = columns.reduce((sum, column) => sum + column.size, 0);
    const before = others.reduce((sum, column) => sum + column.size, 0);
    for (const column of others) column.size = Math.round(column.size * (total - ${width}) / before);
    side.size = ${width};
    return orogenTest.shell.dock.restore(layout);
  })()`);
  assert.equal(restored, 'restored');
  await app.waitFor(`Math.abs(document.querySelector('[data-build="panel"]').getBoundingClientRect().width - ${width}) <= 4`, PAGE_BACKSTOP_MS);
}

export interface Fit {
  /** The width of the panel. */
  readonly width: number;
  /** What reaches beyond the right edge of the panel, or is cut by it without saying so: a box, or a line of text. Empty when everything fits. */
  readonly spills: readonly string[];
}

/**
 * Whether everything in the panel is inside it. A text that is cut on purpose ends in an ellipsis inside a box
 * that fits; what is asked for here is what nobody cut: a box wider than the panel, or text that runs out of it.
 */
export const fit = (app: AppDriver): Promise<Fit> => app.eval<Fit>(`(() => {
  const panel = document.querySelector('[data-build="panel"]');
  const edge = panel.getBoundingClientRect().right + 1;
  const name = (element) => (element.getAttribute('data-build') || element.getAttribute('data-build-row') || element.className || element.tagName).toString().slice(0, 40) + ': ' + element.textContent.slice(0, 40);
  // The cut of an ellipsis is its box's own: what lies in such a box is not asked about, the box itself is.
  const cuts = (element) => {
    for (let at = element; at && at !== panel; at = at.parentElement) {
      const style = getComputedStyle(at);
      if (style.textOverflow === 'ellipsis' && style.overflowX !== 'visible') return true;
    }
    return false;
  };
  const spills = [];
  for (const element of panel.querySelectorAll('*')) {
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && rect.right > edge && !cuts(element.parentElement)) spills.push('box ' + name(element));
  }
  const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent.trim() === '' || cuts(node.parentElement)) continue;
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (rect.width > 0 && rect.right > edge) spills.push('text ' + name(node.parentElement));
  }
  const scroll = panel.querySelector('[data-build="scroll"]');
  if (scroll.scrollWidth > scroll.clientWidth + 1) spills.push('the panel scrolls sideways by ' + (scroll.scrollWidth - scroll.clientWidth));
  return { width: Math.round(panel.getBoundingClientRect().width), spills: [...new Set(spills)] };
})()`);

/** The elements matching `selector` whose text is cut by an ellipsis: their texts. */
export const cut = (app: AppDriver, selector: string): Promise<string[]> =>
  app.eval<string[]>(`[...document.querySelectorAll(${quote(selector)})].filter((element) => element.scrollWidth > element.clientWidth + 1).map((element) => element.textContent)`);

export { EVALUATION_BACKSTOP_MS, PAGE_BACKSTOP_MS, settled, sleep };
