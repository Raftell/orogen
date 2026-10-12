// `orogen gallery` (testing.md 8.6): every node of the registry that has outputs, rendered as `render <type>`
// renders it, and gallery/index.html, the page a reviewer reads.

import fs from 'node:fs';
import path from 'node:path';

import { nodes } from '../core/nodes/index.ts';
import { createRegistry } from '../core/runtime.ts';
import { NodeFileSink, NodeFileSource } from '../platform/node/files.ts';
import type { GalleryCommand } from './args.ts';
import { typeDocument } from './document.ts';
import { countsAsFailure, galleryPage, mib, ms, type GalleryEntry, type GalleryInfo } from './gallery-page.ts';
import { renderPlan } from './render.ts';

/** A conformance report is a few kilobytes; a larger file under that name is not shown. */
const CONFORMANCE_MAX_BYTES = 1 << 20;

function readConformance(out: string, type: string): string | null {
  const file = path.join(out, 'conformance', ...`${type}.json`.split('/'));
  try {
    if (fs.statSync(file).size > CONFORMANCE_MAX_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** `orogen gallery`. Resolves with the exit code. */
export async function gallery(command: GalleryCommand, signal: AbortSignal): Promise<number> {
  const registry = createRegistry(nodes);
  const defs = registry.list().filter((def) => def.outputs.length > 0 && (command.category === null || def.category === command.category));
  const sink = NodeFileSink(command.out);
  const entries: GalleryEntry[] = [];
  let device: GalleryInfo['device'] = null;
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
        const result = await renderPlan(cli, sink, typeDocument(registry, def.type), { res: command.res, crop: null, signal });
        if (result.status === 'aborted' || result.status === 'device-lost') {
          stopped = result.status;
          break;
        }
        entries.push({ def, result, conformance: readConformance(command.out, def.type) });
        const outcome = result.status === 'ok' ? `${ms(result.wallMs)}, peak ${mib(result.peakBytes)}` : `failed: ${result.errors[0]?.message ?? result.status}`;
        process.stderr.write(`orogen gallery: ${i + 1}/${defs.length} ${def.type}: ${outcome}\n`);
      }
    } finally {
      await cli.close();
    }
  } else {
    process.stderr.write(`orogen gallery: the registry has no node with outputs${command.category !== null ? ` in the category ${command.category}` : ''}\n`);
  }

  // A page that lacks nodes would be read as the whole gallery: none is written for a run that did not finish.
  if (stopped === 'aborted') {
    process.stderr.write('orogen gallery: cancelled; no page was written\n');
    return 130;
  }
  if (stopped === 'device-lost') {
    process.stderr.write('orogen gallery: the GPU device was lost; no page was written\n');
    return 3;
  }

  await sink.write('gallery/index.html', galleryPage({ res: command.res, category: command.category, device }, entries));
  process.stdout.write(`${path.join(command.out, 'gallery', 'index.html')}\n`);
  const failures = entries.filter(countsAsFailure);
  if (failures.length > 0) process.stderr.write(`orogen gallery: ${failures.length} of ${entries.length} nodes failed: ${failures.map((entry) => entry.def.type).join(', ')}\n`);
  return failures.length > 0 ? 1 : 0;
}
