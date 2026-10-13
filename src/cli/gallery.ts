// `orogen gallery` (testing.md 8.6): every node of the registry that has outputs, rendered as `render <type>`
// renders it, a page per category, and gallery/index.html, which links the pages of every category drawn into
// the output folder by this run and by earlier ones.

import fs from 'node:fs';
import path from 'node:path';

import { nodes } from '../core/nodes/index.ts';
import { createRegistry } from '../core/runtime.ts';
import { NodeFileSink, NodeFileSource } from '../platform/node/files.ts';
import { CATEGORIES, UsageError, type GalleryCommand, type ParamArg } from './args.ts';
import { hasConnectedVariant, typeDocument, type RenderPlan } from './document.ts';
import {
  countsAsFailure, galleryIndex, galleryPage, gallerySummary, mib, ms, needsFile, readGallerySummary,
  type GalleryEntry, type GalleryInfo, type GallerySummary,
} from './gallery-page.ts';
import { renderPlan } from './render.ts';
import type { RenderResult } from './result.ts';

/** A conformance report is a few kilobytes; a larger file under that name is not shown. */
const CONFORMANCE_MAX_BYTES = 1 << 20;
/** A category page is a few hundred kilobytes; a larger file under that name is not one. */
const PAGE_MAX_BYTES = 16 << 20;

/** The summary of the page an earlier run left for `category`; null when the folder holds none. */
function earlierPage(out: string, category: string): GallerySummary | null {
  const file = path.join(out, 'gallery', `${category}.html`);
  try {
    if (fs.statSync(file).size > PAGE_MAX_BYTES) return null;
    const summary = readGallerySummary(fs.readFileSync(file, 'utf8'));
    return summary?.category === category ? summary : null;
  } catch {
    return null;
  }
}

function readConformance(out: string, type: string): string | null {
  const file = path.join(out, 'conformance', ...`${type}.json`.split('/'));
  try {
    if (fs.statSync(file).size > CONFORMANCE_MAX_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The `params` of a node's conformance call, from its report (testing.md 3.6 rule 2); none when the report is
 * absent, is no such report or names none. A file is an absolute path there.
 */
export function conformanceParams(report: string | null): ParamArg[] {
  if (report === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(report);
  } catch {
    return [];
  }
  const params = typeof value === 'object' && value !== null && 'params' in value ? value.params : null;
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return [];
  return Object.entries(params).map(([name, held]) => ({ name, value: held as ParamArg['value'] }));
}

/** A parameter value as the page says it: a path under the working directory from there, anything else as JSON. */
function shown(value: unknown): string {
  if (typeof value !== 'string') return JSON.stringify(value);
  if (!path.isAbsolute(value)) return value;
  const relative = path.relative(process.cwd(), value);
  return relative.startsWith('..') ? value : relative.split(path.sep).join('/');
}

/** `orogen gallery`. Resolves with the exit code. */
export async function gallery(command: GalleryCommand, signal: AbortSignal): Promise<number> {
  const registry = createRegistry(nodes);
  const defs = registry.list().filter((def) => def.outputs.length > 0 && (command.category === null || def.category === command.category));
  const sink = NodeFileSink(command.out);
  const entries: GalleryEntry[] = [];
  let device: GalleryInfo['device'] | null = null;
  let stopped: 'aborted' | 'device-lost' | null = null;

  if (defs.length > 0) {
    const { openEngine } = await import('./engine.ts');
    const cli = await openEngine({ device: command.device, budgetBytes: command.budgetBytes, registry, files: NodeFileSource(process.cwd()) });
    try {
      const { caps } = cli.gpu;
      device = { adapter: caps.adapter.description || caps.adapter.device, software: caps.software, profile: cli.gpu.profile };
      for (const [i, def] of defs.entries()) {
        if (signal.aborted) {
          stopped = 'aborted';
          break;
        }
        const drawn = { res: command.res, crop: null, signal, inputs: true };
        const conformance = readConformance(command.out, def.type);
        // A node that reads a file is drawn the way the suite ran it: at its defaults it selects no file. Parameters
        // the node no longer takes as the report holds them are left out, and the node is drawn at its defaults.
        let given = needsFile(def) ? conformanceParams(conformance) : [];
        const planned = (connected: boolean): RenderPlan => typeDocument(registry, def.type, { params: given, connected });
        let plan: RenderPlan;
        try {
          plan = planned(false);
        } catch (thrown) {
          if (!(thrown instanceof UsageError) || given.length === 0) throw thrown;
          process.stderr.write(`orogen gallery: ${def.type}: the parameters of its conformance report are not its own any more (${thrown.message}); it is drawn at its defaults\n`);
          given = [];
          plan = planned(false);
        }
        const result = await renderPlan(cli, sink, plan, drawn);
        // The second variant, with the optional inputs and the mask connected: what they do to the node.
        let connected: RenderResult | null = null;
        if (result.status === 'ok' && hasConnectedVariant(def) && !signal.aborted) {
          connected = await renderPlan(cli, sink, planned(true), drawn);
        }
        const ended = connected?.status === 'aborted' || connected?.status === 'device-lost' ? connected.status : result.status;
        if (ended === 'aborted' || ended === 'device-lost') {
          stopped = ended;
          break;
        }
        entries.push({ def, result, connected, conformance, given: given.map((param) => ({ name: param.name, value: shown(param.value) })) });
        const failed = result.status !== 'ok' ? result : connected && connected.status !== 'ok' ? connected : null;
        const outcome = failed ? `failed${failed === connected ? ' with its optional inputs connected' : ''}: ${failed.errors[0]?.message ?? failed.status}` : `${ms(result.wallMs)}, peak ${mib(result.peakBytes)}`;
        process.stderr.write(`orogen gallery: ${i + 1}/${defs.length} ${def.type}: ${outcome}\n`);
      }
    } finally {
      await cli.close();
    }
  } else {
    process.stderr.write(`orogen gallery: the registry has no node with outputs${command.category !== null ? ` in the category ${command.category}` : ''}\n`);
  }

  // A page that lacks nodes would be read as its whole category: none is written for a run that did not finish.
  if (stopped === 'aborted') {
    process.stderr.write('orogen gallery: cancelled; no page was written\n');
    return 130;
  }
  if (stopped === 'device-lost') {
    process.stderr.write('orogen gallery: the GPU device was lost; no page was written\n');
    return 3;
  }

  // One page per category drawn, and the index of every category the folder holds a page of: those of this
  // run, and those an earlier run left, which stay as they are.
  const drawn = new Map<string, GallerySummary>();
  for (const category of CATEGORIES) {
    const own = entries.filter((entry) => entry.def.category === category);
    if (own.length === 0 || device === null) continue;
    const info: GalleryInfo = { res: command.res, category, device };
    await sink.write(`gallery/${category}.html`, galleryPage(info, own));
    drawn.set(category, gallerySummary(info, own));
  }
  const pages = CATEGORIES.flatMap((category) => drawn.get(category) ?? earlierPage(command.out, category) ?? []);
  await sink.write('gallery/index.html', galleryIndex(pages));
  // The page to open: that of the one category asked for, else the index.
  const opened = command.category !== null && drawn.has(command.category) ? `${command.category}.html` : 'index.html';
  process.stdout.write(`${path.join(command.out, 'gallery', opened)}\n`);
  const failures = entries.filter(countsAsFailure);
  if (failures.length > 0) process.stderr.write(`orogen gallery: ${failures.length} of ${entries.length} nodes failed: ${failures.map((entry) => entry.def.type).join(', ')}\n`);
  return failures.length > 0 ? 1 : 0;
}
