import type { NodeDef, ParamValue, PortDef } from '../../src/core/api.ts';
import { DeviceLostError, type NodeError, type ProjectSettings } from '../../src/core/runtime.ts';
import { useNodes, type Slices, type TestEngine } from './engine.ts';
import { evaluate, type EvalReport, type SliceListener } from './evaluate.ts';
import { checkFieldData, type FieldData } from './field-data.ts';
import { fixtureKind, fixtures, isFixtureName, type FixtureName } from './fixtures.ts';
import { buildSpec, type GraphSpec } from './graph.ts';

export type { EvalReport, NodeReport } from './evaluate.ts';

export interface RenderOptions {
  readonly res?: number;                                                      // default 257
  readonly params?: Readonly<Record<string, ParamValue>>;
  readonly inputs?: Readonly<Record<string, FieldData | FixtureName | null>>;
  readonly mask?: FieldData | FixtureName;                                    // maskable nodes only
  readonly wants?: readonly string[];                                         // default: every output
  readonly settings?: Partial<ProjectSettings>;                               // merged over TEST_SETTINGS
  readonly signal?: AbortSignal;
  readonly slices?: Slices;                                                   // default 'auto'
  readonly fieldBudgetBytes?: number;                                         // default: the engine's budget is left alone
  readonly onSlice?: SliceListener;
}

/** Its message is the message of the first NodeError. */
export class NodeFailure extends Error {
  override name = 'NodeFailure';
  readonly error: NodeError;
  readonly report: EvalReport;

  constructor(error: NodeError, report: EvalReport) {
    super(error.message);
    this.error = error;
    this.report = report;
  }
}

const HEIGHT_FIXTURES: readonly FixtureName[] = ['terrain', 'cone', 'rampX', 'basin'];
const COLOR_FIXTURES: readonly FixtureName[] = ['color', 'color2', 'color3', 'color4'];

/**
 * The default fixture of every declared input (testing.md 3.1). `variant` is what an input of type `any` is
 * given. The inputs that take a field which is no mask are counted together and each gets the next height
 * fixture, and the inputs that take a colour the next colour fixture: a node with two of either is never
 * checked on one field met with itself.
 */
export function defaultFixtures(def: NodeDef, variant: 'field' | 'color' = 'field'): Record<string, FixtureName> {
  const out: Record<string, FixtureName> = {};
  let heights = 0, colors = 0;
  for (const port of def.inputs) {
    if (port.type === 'color' || (port.type === 'any' && variant === 'color')) out[port.name] = COLOR_FIXTURES[colors++ % COLOR_FIXTURES.length]!;
    else if (port.type === 'field' && port.role === 'mask') out[port.name] = 'mask';
    else out[port.name] = HEIGHT_FIXTURES[heights++ % HEIGHT_FIXTURES.length]!;
  }
  return out;
}

const accepts = (port: PortDef, kind: 'field' | 'color'): boolean => port.type === 'any' || port.type === kind;

/** The node as a spec: the node `node`, and one source per connected input. Rejects what the options get wrong, before anything runs. */
async function specOf(def: NodeDef, opts: RenderOptions, res: number): Promise<GraphSpec> {
  const inputs = opts.inputs ?? {};
  for (const name of Object.keys(inputs)) {
    if (!def.inputs.some((port) => port.name === name)) throw new TypeError(`${def.type} has no input "${name}"`);
  }
  if (opts.mask !== undefined && !def.maskable) throw new TypeError(`${def.type} is not maskable: the option \`mask\` connects the mask the evaluator adds to a maskable node`);

  const defaults = defaultFixtures(def);
  const sources: Record<string, FieldData> = {};
  const wiring: Record<string, string> = {};
  const feed = async (id: string, port: PortDef, given: FieldData | FixtureName, what: string): Promise<void> => {
    let data: FieldData;
    if (isFixtureName(given)) {
      if (!accepts(port, fixtureKind(given))) throw new TypeError(`${what} of ${def.type} takes a ${String(port.type)}; the fixture "${given}" is a ${fixtureKind(given)}`);
      data = await fixtures.byName(given, res);
    } else {
      if (typeof given === 'string') throw new TypeError(`${what} of ${def.type}: "${given}" is not a fixture`);
      checkFieldData(given, what);
      if (!accepts(port, given.kind)) throw new TypeError(`${what} of ${def.type} takes a ${String(port.type)}; the data is a ${given.kind}`);
      if (given.width !== res || given.height !== res) throw new RangeError(`${what} of ${def.type} is ${given.width} x ${given.height}; the evaluation is at ${res} x ${res}`);
      data = given;
    }
    sources[id] = data;
    wiring[port.name] = `${id}.out`;
  };
  for (const [i, port] of def.inputs.entries()) {
    const listed = Object.hasOwn(inputs, port.name) ? inputs[port.name] : undefined;
    const given = listed === undefined ? defaults[port.name]! : listed;
    if (given === null) continue;
    await feed(`src${i}`, port, given, `The input "${port.name}"`);
  }
  if (opts.mask !== undefined) await feed('srcmask', { name: 'mask', type: 'field', role: 'mask', optional: true }, opts.mask, 'The mask');

  return {
    ...(opts.settings ? { settings: opts.settings } : {}),
    sources,
    nodes: { node: { type: def.type, ...(opts.params ? { params: opts.params } : {}), inputs: wiring } },
  };
}

export interface Traced {
  readonly outputs: Readonly<Record<string, FieldData>>;
  readonly report: EvalReport;                 // the node under test has the id 'node'
}

/** traceNode, with the engine the evaluation ran on. */
export async function traceWithEngine(def: NodeDef, opts: RenderOptions = {}): Promise<Traced & { readonly engine: TestEngine }> {
  useNodes([def]);
  const res = opts.res ?? 257;
  const wants = [...new Set(opts.wants ?? def.outputs.map((port) => port.name))];
  for (const name of wants) {
    if (!def.outputs.some((port) => port.name === name)) throw new TypeError(`${def.type} has no output "${name}"`);
  }
  const graph = buildSpec(await specOf(def, opts, res));
  try {
    const { result, errors, fields, report, engine } = await evaluate({
      doc: graph.doc, ids: graph.ids,
      // A node without a wanted output is run for itself.
      targets: wants.length > 0 ? wants.map((name) => `node.${name}`) : ['node'],
      resolution: res, mode: 'build', outputs: 'needed', slices: opts.slices ?? 'auto',
      cache: 'empty-leftovers', requireEmptyCache: true,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.fieldBudgetBytes !== undefined ? { fieldBudgetBytes: opts.fieldBudgetBytes } : {}),
      ...(opts.onSlice ? { onSlice: opts.onSlice } : {}),
    });
    if (result.status === 'device-lost') throw new DeviceLostError('The GPU device was lost during the evaluation');
    if (result.status === 'aborted') throw opts.signal?.reason ?? new DOMException('The evaluation was aborted', 'AbortError');
    if (result.status === 'errors') {
      throw new NodeFailure(errors[0] ?? { nodeId: 'node', nodeType: def.type, kind: 'internal', message: 'The evaluation ended with errors and named none' }, report);
    }
    const outputs: Record<string, FieldData> = {};
    for (const name of wants) {
      const field = fields[`node.${name}`];
      if (!field) throw new Error(`${def.type}: the evaluation ended with status "ok" and delivered no field for the output "${name}"`);
      outputs[name] = field;
    }
    return { outputs, report, engine };
  } finally {
    for (const source of graph.sources.values()) source.handle.release();
  }
}

export async function traceNode(def: NodeDef, opts?: RenderOptions): Promise<Traced> {
  const { outputs, report } = await traceWithEngine(def, opts);
  return { outputs, report };
}

export async function renderNode(def: NodeDef, opts?: RenderOptions): Promise<Readonly<Record<string, FieldData>>> {
  return (await traceWithEngine(def, opts)).outputs;
}
