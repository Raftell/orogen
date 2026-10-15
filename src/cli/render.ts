// `orogen render` (testing.md 8.6): one node, evaluated as a build would evaluate it, and a picture of every
// output. renderPlan is also what `gallery` runs for each node.

import fs from 'node:fs';
import path from 'node:path';

import { nodes } from '../core/nodes/index.ts';
import {
  createRegistry, outputKind, previewResolution,
  type AnyFieldHandle, type EvalTarget, type EvaluateResult, type FileSink, type FileSource,
} from '../core/runtime.ts';
import { NodeFileSink, NodeFileSource } from '../platform/node/files.ts';
import { UsageError, type RenderCommand } from './args.ts';
import { projectDocument, typeDocument, type RenderPlan } from './document.ts';
import type { CliEngine, RunLog } from './engine.ts';
import { inputPicture, picturesOf, viewIsLit, writePicture } from './pictures.ts';
import type { Raster } from './preview.ts';
import { describeError, exitCodeOf, HARD_CEILING_MS, overran, type RenderResult, type WrittenInput, type WrittenPicture } from './result.ts';

/** The file name of the picture of what the input `port` was given: no output is named so, since a port name has no hyphen. */
const inputFile = (port: string): string => `input-${port}`;

/**
 * Evaluates the plan's node at `res` in build mode with every output as a target, and writes the pictures of
 * each output as soon as it is delivered: `nodes/<category>/<name>/<output>-<res>[-connected][-3d|-crop].png` in
 * the sink, with `-connected` for the connected variant of a node type. With `inputs`, a node type with two or
 * more connected inputs also gets a picture of what each was given, `input-<port>-<res>[-connected].png`.
 * Resolves whatever the status; rejects when a picture cannot be written, and for a malformed plan.
 */
export async function renderPlan(
  cli: CliEngine, sink: FileSink, plan: RenderPlan,
  opts: { readonly res: number; readonly crop: number | null; readonly signal: AbortSignal; readonly inputs?: boolean },
): Promise<RenderResult> {
  const { engine } = cli;
  const { doc, nodeId } = plan;
  const outputs = plan.def?.outputs ?? [];
  const scale = { terrainSize: doc.settings.terrainSize, heightRange: doc.settings.heightRange };

  const targets: EvalTarget[] = [];
  if (plan.terrain) {
    // The node reads its height input as a field; a colour connected there is converted for it, and for the picture.
    targets.push(outputKind(doc, engine.registry, plan.terrain) === 'color' ? { ref: plan.terrain, as: 'field' } : { ref: plan.terrain });
  }
  // What the node was given, where that is more than the one terrain every reader of the page knows.
  const shown = opts.inputs && plan.inputs.length >= 2 ? plan.inputs : [];
  const firstInput = targets.length;
  for (const input of shown) targets.push({ ref: input.from });
  const first = targets.length;
  if (outputs.length === 0) targets.push({ node: nodeId });
  for (const port of outputs) targets.push({ ref: { node: nodeId, port: port.name } });
  const variant = plan.connected ? '-connected' : '';
  const primaryIsHeight = outputs[0] !== undefined && outputs[0].type === 'field' && (outputs[0].role ?? 'height') === 'height';

  const read = async (handle: AnyFieldHandle): Promise<Raster> => ({
    kind: handle.kind, width: handle.width, height: handle.height, channels: handle.kind === 'color' ? 4 : 1, data: await engine.read(handle),
  });

  const measured = { wallMs: 0, gpuMs: null as number | null, peakBytes: 0 };
  const files: string[] = [];
  const pictures: Record<string, WrittenPicture> = {};
  const views: Record<string, WrittenPicture> = {};
  const given: WrittenInput[] = [];
  let terrain: Raster | null = null;

  const stop = cli.record();
  let result: EvaluateResult;
  let log: RunLog;
  try {
    result = await engine.evaluate(doc, targets, {
      resolution: opts.res, mode: 'build', requestId: cli.nextRequestId(), signal: opts.signal,
      onEvent(event) {
        if (event.type === 'node-done' && event.nodeId === nodeId) {
          measured.wallMs = event.wallMs;
          measured.gpuMs = event.gpuMs;
          measured.peakBytes = event.peakBytes;
        }
      },
      // Staged delivery: in a build a target's memory is held only while it is drawn (runtime.md 5.2).
      async onTarget(index, handle) {
        if (!handle) return;
        const field = await read(handle);
        if (index < firstInput) {
          // A terrain is a field. An upstream output whose kind the document does not determine may arrive as a colour: no terrain then.
          terrain = field.kind === 'field' ? field : null;
          return;
        }
        if (index < first) {
          const input = shown[index - firstInput]!;
          const file = `nodes/${plan.type}/${inputFile(input.port)}-${opts.res}${variant}.png`;
          const picture = inputPicture(input.kind, field, scale);
          await writePicture(sink, file, picture);
          files.push(file);
          given.push({ port: input.port, kind: input.kind, file, width: picture.width, height: picture.height });
          return;
        }
        const port = outputs[index - first]!;
        // The node's own terrain: its other outputs are drawn over the height it made, not over the one it was given.
        if (index === first && primaryIsHeight && field.kind === 'field' && outputs.length > 1) terrain = field;
        for (const { suffix, draw, tone } of picturesOf(port, field, terrain, scale, opts.crop, viewIsLit(plan.type))) {
          const file = `nodes/${plan.type}/${port.name}-${opts.res}${variant}${suffix}.png`;
          const picture = draw();
          await writePicture(sink, file, picture);
          files.push(file);
          const written: WrittenPicture = { file, width: picture.width, height: picture.height, ...(tone ? { tone } : {}) };
          if (suffix === '') pictures[port.name] = written;
          if (suffix === '-3d') views[port.name] = written;
        }
      },
    });
  } finally {
    log = stop();
  }

  return {
    type: plan.type, res: opts.res, status: result.status, errors: result.errors,
    ...measured,
    longestSliceMs: log.longestSliceMs, longestSliceKernels: log.longestSliceKernels, engineErrors: log.engineErrors,
    files, pictures, views, inputs: given,
  };
}

const rounded = (ms: number): number => Math.round(ms * 1000) / 1000;

/** `orogen render`. Resolves with the exit code; a usage error is thrown as UsageError before a device is opened. */
export async function render(command: RenderCommand, signal: AbortSignal): Promise<number> {
  const registry = createRegistry(nodes);
  let plan: RenderPlan;
  let source: FileSource;
  if (command.source.kind === 'type') {
    plan = typeDocument(registry, command.source.type, { params: command.params, maxParams: command.maxParams, seed: command.seed, connected: command.connected });
    // A relative `file` parameter given with --param is taken from the working directory.
    source = NodeFileSource(process.cwd());
  } else {
    const { file, node } = command.source;
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (thrown) {
      throw new UsageError(`Cannot read the project file ${file}: ${thrown instanceof Error ? thrown.message : String(thrown)}`, 'render');
    }
    plan = projectDocument(registry, text, node, file);
    source = NodeFileSource(path.dirname(file));
  }
  const res = command.res ?? previewResolution(plan.doc.settings);
  if (command.crop !== null && command.crop > res) throw new UsageError(`--crop ${command.crop} is larger than the resolution ${res}`, 'render');
  for (const warning of plan.warnings) process.stderr.write(`orogen render: warning: ${warning}\n`);

  // Loaded here and not at the top: the arguments are checked before the GPU package is touched.
  const { openEngine } = await import('./engine.ts');
  const cli = await openEngine({ device: command.device, budgetBytes: command.budgetBytes, registry, files: source });
  let result: RenderResult;
  try {
    process.stderr.write(`orogen render: ${cli.budgetLine}\n`);
    result = await renderPlan(cli, NodeFileSink(command.out), plan, { res, crop: command.crop, signal });
  } finally {
    await cli.close();
  }

  for (const error of result.errors) process.stderr.write(`orogen render: ${describeError(error, command.source.kind === 'project')}\n`);
  if (result.status === 'device-lost') process.stderr.write('orogen render: the GPU device was lost during the evaluation\n');
  if (result.status === 'aborted') process.stderr.write('orogen render: cancelled\n');
  if (overran(result)) {
    if (result.longestSliceMs > HARD_CEILING_MS) {
      process.stderr.write(`orogen render: a slice took ${result.longestSliceMs.toFixed(0)} ms, above the hard ceiling of ${HARD_CEILING_MS} ms (runtime.md 3.5)\n`);
    }
    for (const message of result.engineErrors) process.stderr.write(`orogen render: a GPU error outside every error scope: ${message}\n`);
    process.stderr.write(`orogen render: kernels of the longest slice: ${result.longestSliceKernels.join(', ') || 'none'}\n`);
  }

  // One line, whatever the outcome of the evaluation: what was measured and which pictures exist.
  process.stdout.write(`${JSON.stringify({
    type: result.type, res: result.res,
    wallMs: rounded(result.wallMs), gpuMs: result.gpuMs === null ? null : rounded(result.gpuMs),
    longestSliceMs: rounded(result.longestSliceMs), peakBytes: result.peakBytes,
    files: result.files.map((file) => path.join(command.out, ...file.split('/'))),
  })}\n`);
  return exitCodeOf(result);
}
