// What the hidden-window tests of the platform share. Not a test file.
//
// Every test here drives the application through `orogenTest.ctx` (testing.md 2.9) and loads its own documents:
// what the page shows by itself at start-up is the shell's business.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { nodes } from '../../../src/core/nodes/index.ts';
import type { FieldStats } from '../../../src/core/api.ts';
import { createRegistry, type GpuCaps, type GpuProfile, type GraphDoc, type PortRef } from '../../../src/core/runtime.ts';
import { launchApp, makeDoc, useNodes, type AppDriver } from '../../helpers/index.ts';

useNodes(nodes);

export const ROOT = path.resolve(import.meta.dirname, '../../..');
/** Where these tests write: <OROGEN_TEST_OUTPUT>/platform. Captures go to <OROGEN_TEST_OUTPUT>/ui/platform (AppDriver.capture). */
export const OUTPUT = path.resolve(process.env.OROGEN_TEST_OUTPUT || path.join(ROOT, 'test-output'), 'platform');
export const REGISTRY = createRegistry(nodes);
/** Backstop for one preview evaluation of a small document. */
export const EVALUATION_BACKSTOP_MS = 60_000;

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `body` on a launched application and closes it. close() rejects for any error the application reported
 * (testing.md 8.5 rule 3); when the body has failed already, its failure is the one to read.
 */
export async function withApp(
  opts: { readonly open?: string; readonly profile?: GpuProfile; readonly gpu?: 'hardware' | 'software' },
  body: (app: AppDriver) => Promise<void>,
): Promise<void> {
  const app = await launchApp(opts);
  try {
    await body(app);
  } catch (thrown) {
    await app.close().catch(() => {});
    throw thrown;
  }
  await app.close();
}

/** Waits until the engine worker has a device, or fails with what it reported instead. */
export async function ready(app: AppDriver): Promise<GpuCaps> {
  await app.waitFor(`['ready', 'failed'].includes(orogenTest.ctx.engineState.getState().device.state)`, 60_000);
  const device = await app.eval<{ state: string; caps: GpuCaps | null; message: string | null }>(`orogenTest.ctx.engineState.getState().device`);
  assert.equal(device.state, 'ready', `the engine did not start: ${device.message}`);
  return device.caps!;
}

/** One generate/mountain-range node, bound to the view: the smallest document that shows terrain. */
export function mountainDoc(): { readonly doc: GraphDoc; readonly height: PortRef } {
  const doc = makeDoc({ settings: { buildResolution: 1009, previewLevel: 1 }, nodes: { range: { type: 'generate/mountain-range' } } });
  const height = { node: Object.keys(doc.nodes)[0]!, port: 'out' };
  return { doc: { ...doc, ui: { ...doc.ui, view: { height } } }, height };
}

/**
 * The revision the engine was last sent, which is the one it reports back as shown: `engineRevision` of docStore
 * (runtime.md 8.5). A page whose store has no such member sends every revision.
 */
export function sentRevision(app: AppDriver): Promise<number> {
  return app.eval<number>(`(() => { const state = orogenTest.ctx.doc.getState(); return state.engineRevision ?? state.revision; })()`);
}

/** Loads a document as the application's project and waits until its view is shown. Returns the revision shown. */
export async function show(app: AppDriver, doc: GraphDoc, file: string | null = null): Promise<number> {
  await app.eval(`orogenTest.ctx.doc.getState().load(${JSON.stringify(doc)}, ${JSON.stringify(file)})`);
  const revision = await sentRevision(app);
  await shown(app, revision);
  return revision;
}

/** Waits until the view of `revision` is shown and nothing runs. */
export async function shown(app: AppDriver, revision: number): Promise<void> {
  await app.waitFor(`(() => {
    const state = orogenTest.ctx.engineState.getState();
    return state.evaluation === null && state.view !== null && state.view.revision >= ${revision};
  })()`, EVALUATION_BACKSTOP_MS);
}

export function inspect(app: AppDriver, ref: PortRef): Promise<FieldStats | null> {
  return app.eval<FieldStats | null>(`orogenTest.ctx.engine.inspect(${JSON.stringify(ref)})`);
}

/** How far up a process's ancestors are followed: this process starts Electron, which starts its GPU process. */
const ANCESTORS_MAX = 8;

function parentOf(pid: number): number {
  try {
    // "pid (name) state ppid ...": the name may hold spaces and brackets, so the fields are counted from the last bracket.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  } catch {
    return 0;
  }
}

/**
 * The GPU processes among the descendants of this process: those of the applications this test launched, and of
 * no other. Found through /proc, so on Linux only.
 */
export function gpuProcesses(): number[] {
  const found: number[] = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let command: string;
    try {
      command = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8');
    } catch {
      continue;
    }
    // Chromium's child processes rewrite their command line: its arguments are divided by spaces or by NUL.
    if (!/(^|[\0 ])--type=gpu-process([\0 ]|$)/.test(command)) continue;
    let pid = Number(name);
    for (let depth = 0; depth < ANCESTORS_MAX && pid > 1; depth++) {
      pid = parentOf(pid);
      if (pid === process.pid) {
        found.push(Number(name));
        break;
      }
    }
  }
  return found;
}
