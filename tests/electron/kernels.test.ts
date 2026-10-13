// The kernel test in Electron (testing.md 8.4). The Dawn inside Electron is not the one the GPU layer runs on,
// so this is the only test that sees the application's own WGSL compiler: once per profile the whole product is
// evaluated inside the built application, a project is built from its engine worker, and, on a hardware
// adapter, a sample of results is compared with the same document evaluated in this process.
//
// Sizes: previews of 129 x 129 and one build at 1009; no list that grows with a resolution reaches an assertion.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { FieldStats, NodeDef } from '../../src/core/api.ts';
import { nodes } from '../../src/core/nodes/index.ts';
import { serializeDoc, type BuildResult, type GpuCaps, type GpuProfile, type GraphDoc, type NodeError } from '../../src/core/runtime.ts';
import { getEngine, launchApp, makeDoc, registryDoc, renderGraph, stats, useNodes, type AppDriver } from '../helpers/index.ts';

useNodes(nodes);

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUTPUT = path.resolve(process.env.OROGEN_TEST_OUTPUT || path.join(ROOT, 'test-output'), 'electron');
/** engine.md 3.12: the language features author code may use. */
const LANGUAGE_FEATURES = ['readonly_and_readwrite_storage_textures', 'packed_4x8_integer_dot_product', 'unrestricted_pointer_parameters', 'pointer_composite_access'];
/** A failure of one of these kinds is a failure of the runtime, never of a node's input (testing.md 8.4 step 3). */
const RUNTIME_ERRORS = ['shader-compile', 'binding', 'validation', 'internal'];
/** Backstop for the evaluation of the whole registry; a software adapter takes minutes where a GPU takes seconds. */
const EVALUATION_BACKSTOP_MS = 240_000;
const SOFTWARE = process.env.OROGEN_ELECTRON_GPU === 'software';

/**
 * Nodes whose first output is compared with this process's Dawn: one or two of each category that has field
 * outputs, each a short chain of float32 arithmetic. A simulation is not among them: over its iterations the
 * last bit of two compilers grows into a different terrain, which says nothing about either.
 */
const SAMPLE = [
  'generate/eroded-noise', 'generate/mountain-range', 'generate/fractal-noise', 'adjust/levels', 'adjust/curve',
  'filter/blur', 'filter/sharpen', 'select/slope', 'select/height', 'surface/strata', 'ref/fbm', 'ref/slope-mask',
];
/** testing.md 3.4: values computed on two adapters or two compilers are never bit-compared; the tolerance is absolute. */
const TOLERANCE = 1e-5;

interface NodeState { readonly state: string; readonly error: NodeError | null; readonly upstream: string | null }

const hasFile = (def: NodeDef): boolean => def.params.some((param) => param.kind === 'file');
const byType = new Map(nodes.map((def) => [def.type, def]));

/** The registry document of testing.md 8.4 step 2: build resolution 513, preview level 2, so previews of 129. */
function registryProject(): GraphDoc {
  const doc = registryDoc(nodes);
  return { ...doc, settings: { ...doc.settings, buildResolution: 513, previewLevel: 2 } };
}

/**
 * Acceptance graph 05 (testing.md 10.2) and, beside it, every node the registry document cannot run: the nodes
 * with a file, here with one, and every export node. Its file parameters are absolute, since the project file
 * is written to the output folder.
 */
function buildProject(): GraphDoc {
  const heights = path.join(ROOT, 'tests/graphs/assets/heights-253.png');
  const doc = makeDoc({
    settings: { buildResolution: 1009, previewLevel: 1 },
    nodes: {
      image: { type: 'ref/image', params: { file: heights } },
      fbm: { type: 'ref/fbm', params: { size: 0.1, octaves: 4 } },
      land: { type: 'ref/combine', params: { mode: 'add', strength: 0.1 }, inputs: { a: 'image.out', b: 'fbm.out' } },
      rock: { type: 'ref/slope-mask', inputs: { in: 'land.out' } },
      paint: { type: 'ref/colorize', inputs: { in: 'land.out' } },
      outland: { type: 'io/export-landscape', params: { dither: false }, inputs: { in: 'land.out' } },
      outrock: { type: 'io/export-layer', params: { layer: 'Rock' }, inputs: { in: 'rock.out' } },
      outpaint: { type: 'io/export-color', inputs: { in: 'paint.out' } },
      imported: { type: 'io/import-field', params: { file: path.join(ROOT, 'tests/nodes/io/assets/terrain-193.png') } },
      tint: { type: 'io/import-color', params: { file: path.join(ROOT, 'tests/nodes/io/assets/colors-129.png') } },
      outimported: { type: 'io/export-field', params: { name: 'Imported' }, inputs: { in: 'imported.out' } },
      outtint: { type: 'io/export-color', params: { name: 'Tint' }, inputs: { in: 'tint.out' } },
      outnormal: { type: 'io/export-normal', inputs: { in: 'land.out' } },
      outmask: { type: 'io/export-mask', inputs: { in: 'rock.out' } },
    },
  });
  const land = Object.values(doc.nodes).find((node) => node.type === 'ref/combine')!;
  return { ...doc, ui: { ...doc.ui, view: { height: { node: land.id, port: 'out' } } } };
}

/**
 * Runs `body` on a launched application and closes it. close() rejects for any error the application reported;
 * when the body has failed already, its failure is the one to read.
 */
async function withApp(opts: { readonly profile: GpuProfile; readonly open?: string }, body: (app: AppDriver) => Promise<void>): Promise<void> {
  const app = await launchApp(opts);
  try {
    await body(app);
  } catch (thrown) {
    await app.close().catch(() => {});
    throw thrown;
  }
  await app.close();
}

/**
 * Detaches the viewport and waits until the engine worker has a device, or fails with what it reported instead.
 * This test looks at no pixel, and under a virtual display the first frame drawn to a WebGPU canvas costs the
 * device (runtime.md 7.5 rule 9): a frame drawn before this call may still do so, once. What a test then waits
 * for is therefore a result the GPU delivered after the call, which the lost device of that frame cannot deliver.
 */
async function started(app: AppDriver): Promise<GpuCaps> {
  await app.eval(`orogenTest.ctx.engine.viewport.detach()`);
  await app.waitFor(`['ready', 'failed'].includes(orogenTest.ctx.engineState.getState().device.state)`, 60_000);
  const device = await app.eval<{ state: string; caps: GpuCaps | null; message: string | null }>(`orogenTest.ctx.engineState.getState().device`);
  assert.equal(device.state, 'ready', `the engine did not start: ${device.message}`);
  return device.caps!;
}

/**
 * Waits until no evaluation runs and every one of the nodes has a final state. When that does not happen the
 * failure says what the engine was doing instead: on a runner this is all there is to go by.
 */
async function evaluated(app: AppDriver, ids: readonly string[]): Promise<void> {
  const list = JSON.stringify(ids);
  try {
    await app.waitFor(`(() => {
      const state = orogenTest.ctx.engineState.getState();
      const final = (id) => state.nodes[id] !== undefined && ['done', 'error', 'skipped'].includes(state.nodes[id].state);
      return state.evaluation === null && ${list}.every(final);
    })()`, EVALUATION_BACKSTOP_MS);
  } catch (thrown) {
    const found = await app.eval<string>(`(() => {
      const state = orogenTest.ctx.engineState.getState();
      const counts = {};
      for (const id of ${list}) { const s = state.nodes[id] ? state.nodes[id].state : 'unreported'; counts[s] = (counts[s] || 0) + 1; }
      return JSON.stringify({ device: state.device.state, message: state.device.message, evaluation: state.evaluation, nodes: counts });
    })()`).catch((failed: Error) => `the state could not be read: ${failed.message}`);
    throw new Error(`The registry document was not evaluated within ${EVALUATION_BACKSTOP_MS} ms. Engine state: ${found}`, { cause: thrown });
  }
}

/** The ids that may end without `done`: a node with a file parameter whose file is not selected, and what reads it. */
function excusedIds(doc: GraphDoc): Set<string> {
  const excused = new Set(Object.keys(doc.nodes).filter((id) => { const def = byType.get(doc.nodes[id]!.type); return def !== undefined && hasFile(def); }));
  const queue = [...excused];
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    for (const edge of Object.values(doc.edges)) {
      if (edge.from.node !== id || excused.has(edge.to.node)) continue;
      excused.add(edge.to.node);
      queue.push(edge.to.node);
    }
  }
  return excused;
}

const describeError = (error: NodeError): string =>
  `${error.kind}${error.kernel ? ` in kernel ${error.kernel}` : ''}: ${error.message}${error.detail ? `\n${error.detail}` : ''}${error.wgsl ? `\n${error.wgsl.origin}:${error.wgsl.line}:${error.wgsl.column} ${error.wgsl.message}\n${error.wgsl.excerpt.join('\n')}` : ''}`;

for (const profile of ['core', 'max'] as const satisfies readonly GpuProfile[]) {
  test(`kernels (${profile}): the whole registry evaluates inside the application`, async (t) => {
    await withApp({ profile }, async (app) => {
      // Step 1: reaching `ready` proves that every kernel of the engine itself compiled.
      const caps = await started(app);
      for (const feature of LANGUAGE_FEATURES) assert.ok(caps.wgslLanguageFeatures.includes(feature), `the application's WGSL has the language feature ${feature}`);
      assert.equal(await app.eval<string>(`orogenTest.ctx.platform.gpuProfile`), profile);
      if (profile === 'core') assert.equal(caps.compactFormats, false, 'the core profile has no compact formats');
      else assert.equal(caps.compactFormats, caps.adapterFeatures.includes('texture-formats-tier1'), 'the max profile takes the compact formats the adapter has');
      t.diagnostic(`adapter: ${caps.adapter.vendor} ${caps.adapter.description || caps.adapter.device}${caps.software ? ' (software)' : ''}; features: ${caps.features.join(', ') || 'none'}`);

      // Step 4: the application's bundle holds every node this process sees, and no other.
      const types = new Set(await app.eval<string[]>(`orogenTest.ctx.registry.list().map((def) => def.type)`));
      const missing = nodes.filter((def) => !types.has(def.type)).map((def) => def.type);
      const extra = [...types].filter((type) => !byType.has(type));
      assert.equal(missing.length + extra.length, 0, `the application's registry differs: missing ${missing.join(', ') || 'none'}; unknown here ${extra.join(', ') || 'none'}`);

      // Step 2: one instance of every node, shown through the chain of ref/combine.
      const doc = registryProject();
      const ids = Object.keys(doc.nodes);
      await app.eval(`orogenTest.ctx.doc.getState().load(${JSON.stringify(doc)}, null)`);
      // Every node done is a result the GPU delivered after the document was loaded: a device that is lost on
      // the way is replaced and the document evaluated again (7.8), which this wait sits out.
      await evaluated(app, ids);

      // Step 3: every node is done, except the nodes without their file and the links after them.
      const states = await app.eval<Record<string, NodeState>>(`(() => {
        const nodes = orogenTest.ctx.engineState.getState().nodes;
        return Object.fromEntries(${JSON.stringify(ids)}.map((id) => [id, { state: nodes[id].state, error: nodes[id].error, upstream: nodes[id].upstream }]));
      })()`);
      const excused = excusedIds(doc);
      const problems: string[] = [];
      for (const id of ids) {
        const type = doc.nodes[id]!.type;
        const node = states[id]!;
        if (node.state === 'error' && RUNTIME_ERRORS.includes(node.error!.kind)) problems.push(`${type}: ${describeError(node.error!)}`);
        else if (node.state !== 'done' && !excused.has(id)) {
          problems.push(`${type}: ended ${node.state}${node.error ? ` (${describeError(node.error)})` : ''}${node.upstream ? ` behind ${doc.nodes[node.upstream]?.type ?? node.upstream}` : ''}`);
        }
      }
      assert.equal(problems.length, 0, `${problems.length} problems:\n${problems.slice(0, 25).join('\n')}`);
      t.diagnostic(`${ids.length} nodes of ${nodes.length} types evaluated at 129`);

      // Values: on a hardware adapter, and for the profile this process's own device has. A runner without a
      // GPU has no adapter for this process at all, so its device is asked for only when there is one to compare with.
      const here = SOFTWARE || caps.software ? null : await getEngine();
      if (!here || here.gpu.caps.software || here.gpu.profile !== profile) {
        t.diagnostic(`values are not compared: ${!here || here.gpu.caps.software ? 'a software adapter' : `this process's device has the profile ${here.gpu.profile}`}`);
      } else {
        const sample = SAMPLE.map((type) => {
          const def = byType.get(type);
          const id = ids.find((nodeId) => doc.nodes[nodeId]!.type === type);
          assert.ok(def !== undefined && id !== undefined, `the sample names ${type}, which the registry document does not hold`);
          return { type, id, port: def.outputs[0]!.name };
        });
        // `inspect` reads the shown result, and the registry document shows none: its chain ends behind the nodes
        // without a file. The same nodes with the view on the first of the sample are a cache hit, and are shown.
        const shown: GraphDoc = { ...doc, ui: { ...doc.ui, view: { height: { node: sample[0]!.id, port: sample[0]!.port } } } };
        await app.eval(`orogenTest.ctx.doc.getState().load(${JSON.stringify(shown)}, null)`);
        // The revision the engine was sent, and reports back as shown: `engineRevision` of docStore (runtime.md 8.5).
        const revision = await app.eval<number>(`(() => { const state = orogenTest.ctx.doc.getState(); return state.engineRevision ?? state.revision; })()`);
        await app.waitFor(`(() => {
          const state = orogenTest.ctx.engineState.getState();
          return state.evaluation === null && state.view !== null && state.view.revision === ${revision};
        })()`, EVALUATION_BACKSTOP_MS);
        const { fields } = await renderGraph(doc, sample.map((s) => `${s.id}.${s.port}`), { res: 129, outputs: 'all' });
        const differences: string[] = [];
        for (const { type, id, port } of sample) {
          const there = await app.eval<FieldStats | null>(`orogenTest.ctx.engine.inspect(${JSON.stringify({ node: id, port })})`);
          const field = fields[`${id}.${port}`];
          if (!there || !field) {
            differences.push(`${type}: ${there ? 'this process' : 'the application'} delivered no ${port}`);
            continue;
          }
          const mine = stats(field);
          for (const name of ['min', 'max', 'mean'] as const) {
            if (!(Math.abs(there[name] - mine[name]) <= TOLERANCE)) differences.push(`${type}: ${name} is ${there[name]} in the application and ${mine[name]} here`);
          }
          if (there.nonFinite !== 0) differences.push(`${type}: ${there.nonFinite} values are not finite in the application`);
        }
        assert.equal(differences.length, 0, `${differences.length} differences above ${TOLERANCE}:\n${differences.join('\n')}`);
        t.diagnostic(`${sample.length} nodes agree with this process's device within ${TOLERANCE}`);
      }
    });
  });

  // Step 5: the engine worker reads images, evaluates in build mode and writes files with Electron's own Node.
  test(`kernels (${profile}): a project with files builds from the engine worker`, async (t) => {
    const folder = path.join(OUTPUT, profile);
    fs.mkdirSync(folder, { recursive: true });
    const project = path.join(folder, 'roundtrip.orogen');
    const outDir = path.join(folder, 'build');
    const doc = buildProject();
    fs.writeFileSync(project, serializeDoc(doc));

    await withApp({ profile, open: project }, async (app) => {
      await started(app);
      await app.waitFor(`orogenTest.ctx.doc.getState().path !== null`);
      // Statistics of the shown terrain, computed now: the device is one that outlived whatever was drawn before.
      await app.waitFor(`(async () => {
        const view = orogenTest.ctx.doc.getState().doc.ui.view;
        return orogenTest.ctx.engineState.getState().view !== null && (await orogenTest.ctx.engine.inspect(view.height)) !== null;
      })()`, EVALUATION_BACKSTOP_MS);
      const result = await app.eval<BuildResult>(`orogenTest.ctx.engine.build({ doc: orogenTest.ctx.doc.getState().doc, outDir: ${JSON.stringify(outDir)} })`);
      assert.equal(result.status, 'ok', `the build ended ${result.status}: ${JSON.stringify(result.problems)}`);
      assert.ok(result.manifest !== null && fs.statSync(path.join(outDir, result.manifest)).size > 0, 'the manifest is on disk');
      const absent = result.files.filter((file) => !fs.existsSync(path.join(outDir, file.path)) || fs.statSync(path.join(outDir, file.path)).size !== file.bytes);
      assert.equal(absent.length, 0, `files of the result that are not on disk at their size: ${absent.map((file) => file.path).join(', ')}`);
      t.diagnostic(`${result.files.length} files in ${outDir}`);
      // The preview that follows a build ends too, so that closing aborts nothing.
      await app.waitFor(`orogenTest.ctx.engineState.getState().evaluation === null && !orogenTest.ctx.engineState.getState().build.running`, EVALUATION_BACKSTOP_MS);
    });
  });
}
