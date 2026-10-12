import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test, type TestContext } from 'node:test';

import type { NodeDef, ParamDef, ParamValue } from '../../src/core/api.ts';
import { lintNode } from '../../src/core/graph/lint.ts';
import type { GpuContext, ProjectSettings } from '../../src/core/runtime.ts';
import { getEngine, outputFolder, TEST_SETTINGS, TESTS_FOLDER, useNodes, type Slices } from './engine.ts';
import type { SliceListener } from './evaluate.ts';
import type { FieldData } from './field-data.ts';
import { fixtureKind, fixtures, isFixtureName, type FixtureName } from './fixtures.ts';
import { compareLadder } from './ladder.ts';
import { expectNoLeaks } from './leaks.ts';
import { savePicture } from './preview.ts';
import { defaultFixtures, traceWithEngine, type Traced } from './render.ts';
import { diff, expectClose, expectFinite, expectIdentical, expectMask, fail, show, stats } from './stats.ts';

export type SkippableCheck = 'generator-range' | 'resolution' | 'seed' | 'alpha' | 'budget';

export interface ConformanceOptions {
  /** Merged over the node's defaults in every check. For a node whose defaults cannot run: an import node's file. */
  readonly params?: Readonly<Record<string, ParamValue>>;
  /** Replaces the default fixture of an input. A FixtureName other than 'fbm' and 'impulse'. */
  readonly inputs?: Readonly<Record<string, FixtureName>>;
  readonly settings?: Partial<ProjectSettings>;
  /** Replaces the default tolerance of the `resolution` check. 0 < value <= 0.5. */
  readonly resolutionTol?: { readonly value: number; readonly reason: string };
  /** Checks not run, each with the reason. */
  readonly skip?: Partial<Record<SkippableCheck, string>>;
}

type Check =
  | 'meta' | 'finite' | 'mask-range' | 'alpha' | 'generator-range' | 'deterministic' | 'deterministic-large' | 'resolution'
  | 'params' | 'optional-unbound' | 'short-ladder' | 'mask-neutral' | 'seed' | 'wants' | 'budget' | 'abort' | 'slicing' | 'leaks';
type Variant = 'field' | 'color';

// The order of the cases: every 'auto' evaluation first, then the 'small' ones, then the 'one' run, so that a
// file switches engines twice (testing.md 3.2).
const CHECKS: readonly Check[] = [
  'meta', 'finite', 'mask-range', 'alpha', 'generator-range', 'deterministic', 'deterministic-large', 'resolution',
  'params', 'optional-unbound', 'short-ladder', 'mask-neutral', 'seed', 'wants', 'budget', 'abort', 'slicing', 'leaks',
];
const SKIPPABLE: readonly SkippableCheck[] = ['generator-range', 'resolution', 'seed', 'alpha', 'budget'];
const OPTION_NAMES: readonly string[] = ['params', 'inputs', 'settings', 'resolutionTol', 'skip'];
const REASON_MIN = 20;
const BUDGET_BYTES = 3_500_000_000;
const BUILD_RES = 8129;

type Result = 'passed' | 'failed' | 'skipped' | 'not-applicable' | 'not-run';
interface CheckRecord { result: Result; reason?: string; message?: string }

/** What the suite writes as conformance/<category>/<name>.json (testing.md 3.6 rule 2). */
interface Report {
  readonly type: string;
  readonly adapter: { readonly vendor: string; readonly architecture: string; readonly device: string; readonly description: string; readonly software: boolean } | null;
  readonly profile: string | null;
  readonly compactFormats: boolean | null;
  readonly checks: Readonly<Record<string, CheckRecord>>;
  readonly optOuts: readonly { readonly check: string; readonly kind: 'skip' | 'tolerance'; readonly value?: number; readonly reason: string }[];
  readonly resolutionDependent: boolean;
  readonly budget: { readonly peakBytes129: number; readonly peakBytes257: number; readonly estimateBytes: number; readonly limitBytes: number; readonly asserted: boolean } | null;
  /**
   * The `params` of the conformance call, for whoever renders the node the way the suite ran it (`verify`, 5.3):
   * a node whose defaults cannot run, such as one that reads a file, is rendered with these. A file is given as
   * an absolute path, because the suite reads files from tests/ and a command line from where it is started.
   */
  readonly params: Readonly<Record<string, ParamValue>>;
}

const registered = new Set<string>();

function describeValue(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function checkReason(reason: unknown, what: string): void {
  if (typeof reason !== 'string' || reason.trim().length < REASON_MIN) {
    throw new TypeError(`${what} needs a reason of at least ${REASON_MIN} characters that a reviewer can check (testing.md 3.6)`);
  }
}

/** The values of the `params` check for one parameter (testing.md 3.3). `current` is the value of the reference runs. */
function valuesTried(param: ParamDef, current: ParamValue): ParamValue[] {
  switch (param.kind) {
    case 'float': {
      const span = param.max - param.min;
      return param.soft ? [param.min, param.max, param.min - span, param.max + span, 0] : [param.min, param.max];
    }
    case 'int': return [param.min, param.max];
    case 'vec2': {
      const span = param.max - param.min;
      const both = (v: number): ParamValue => [v, v];
      return param.soft ? [both(param.min), both(param.max), both(param.min - span), both(param.max + span)] : [both(param.min), both(param.max)];
    }
    case 'bool': return [!current];
    case 'enum': return param.options.map((option) => option.value).filter((value) => value !== current);
    case 'color': return [[0, 0, 0], [1, 1, 1]];
    case 'curve': return [[{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }], [{ x: 0, y: 1 }, { x: 1, y: 0 }]];
    case 'gradient': return [[{ t: 0.5, color: [0, 0, 0] }, { t: 0.5, color: [1, 1, 1] }]];
    default: return [];      // seed, file, text: not varied
  }
}

/** export-unreal.md 2.3: the rules an export node keeps. Its module belongs to the export stage, so it is found when the check runs. */
async function exportViolations(def: NodeDef): Promise<string[]> {
  const module: unknown = await import(new URL('../../src/export/plan.ts', import.meta.url).href).catch((thrown: unknown) => {
    if ((thrown as { code?: unknown } | null)?.code !== 'ERR_MODULE_NOT_FOUND') throw thrown;
    return null;
  });
  const check = (module as { checkExportNode?: unknown } | null)?.checkExportNode;
  if (typeof check !== 'function') {
    fail(`${def.type} is an export node: its meta check calls checkExportNode of src/export/plan.ts (export-unreal.md 2.3), which belongs to the export stage and does not exist yet`);
  }
  return (check as (def: NodeDef) => string[])(def);
}

export function conformance(def: NodeDef, opts: ConformanceOptions = {}): void {
  if (typeof def?.type !== 'string' || typeof def.evaluate !== 'function') throw new TypeError('conformance takes a NodeDef: the default export of the node file');
  if (typeof opts !== 'object' || opts === null) throw new TypeError(`conformance(${def.type}): the options are an object`);
  const where = `conformance(${def.type})`;
  for (const name of Object.keys(opts)) {
    if (!OPTION_NAMES.includes(name)) throw new TypeError(`${where}: "${name}" is not an option; the options are ${OPTION_NAMES.join(', ')}`);
  }
  if (registered.has(def.type)) throw new Error(`${where} was already called in this file; a node's test file calls it once`);

  // ---- what the node is ------------------------------------------------------------------------------------------
  const isExport = def.export !== undefined;
  const variants: readonly Variant[] = def.inputs.some((port) => port.type === 'any') ? ['field', 'color'] : ['field'];
  const primary = def.outputs[0];
  /**
   * A generator (engine.md 1.7, testing.md 3.2): no required input, a primary output that is a field of role
   * `height`, and no `file` parameter. A mask or a colour made from nothing has no height range to keep, and a
   * node that reads a file returns what the file holds.
   */
  const generator = def.inputs.every((port) => port.optional) && primary !== undefined && primary.type === 'field'
    && (primary.role ?? 'height') === 'height' && !def.params.some((param) => param.kind === 'file');
  const hasSeed = def.params.some((param) => param.kind === 'seed');
  const kindOf = (output: NodeDef['outputs'][number], variant: Variant): Variant => (output.type === 'color' ? 'color' : output.type === 'field' ? 'field' : variant);
  const isMask = (output: NodeDef['outputs'][number]): boolean => output.type === 'field' && output.role === 'mask';
  const applies: Readonly<Record<Check, boolean>> = {
    meta: true,
    finite: !isExport,
    'mask-range': !isExport && def.outputs.some(isMask),
    alpha: !isExport && variants.some((variant) => def.outputs.some((output) => kindOf(output, variant) === 'color')),
    'generator-range': !isExport && generator,
    deterministic: !isExport,
    'deterministic-large': !isExport && def.kernels.some((kernel) => Object.keys(kernel.def.unsafeReadWrite ?? {}).length > 0),
    resolution: !isExport && !def.resolutionDependent,
    params: !isExport,
    'optional-unbound': !isExport && def.inputs.some((port) => port.optional),
    'short-ladder': !isExport,
    'mask-neutral': !isExport && def.inputs.some((port) => port.name === 'mask'),
    seed: !isExport && hasSeed,
    wants: !isExport && def.outputs.length >= 2,
    budget: !isExport,
    abort: !isExport,
    slicing: !isExport,
    leaks: !isExport,
  };

  // ---- the options, checked at registration (testing.md 3.6 rule 1) ----------------------------------------------
  for (const name of Object.keys(opts.params ?? {})) {
    if (!def.params.some((param) => param.name === name)) throw new TypeError(`${where}: the node has no parameter "${name}"`);
  }
  for (const [name, fixture] of Object.entries(opts.inputs ?? {})) {
    const port = def.inputs.find((input) => input.name === name);
    if (!port) throw new TypeError(`${where}: the node has no input "${name}"`);
    if (!isFixtureName(fixture) || fixture === 'fbm' || fixture === 'impulse') {
      throw new TypeError(`${where}: the input "${name}" takes a fixture name other than "fbm" and "impulse", not ${describeValue(fixture)}`);
    }
    // An input of type `any` is given a field here; its colour variant always takes the fixture "color".
    const wanted = port.type === 'color' ? 'color' : 'field';
    if (fixtureKind(fixture) !== wanted) throw new TypeError(`${where}: the input "${name}" takes a ${wanted}; the fixture "${fixture}" is a ${fixtureKind(fixture)}`);
  }
  const skip = opts.skip ?? {};
  for (const [name, reason] of Object.entries(skip)) {
    if (!(SKIPPABLE as readonly string[]).includes(name)) {
      throw new TypeError(`${where}: the check "${name}" cannot be skipped; only ${SKIPPABLE.join(', ')} can. A node that cannot pass another check is wrong`);
    }
    checkReason(reason, `${where}: skip["${name}"]`);
    if (!applies[name as Check]) throw new TypeError(`${where}: skip["${name}"] names a check that does not apply to this node`);
  }
  if (opts.resolutionTol !== undefined) {
    const { value, reason } = opts.resolutionTol;
    if (typeof value !== 'number' || !(value > 0 && value <= 0.5)) {
      throw new RangeError(`${where}: resolutionTol.value is ${describeValue(value)}; it is above 0 and at most 0.5 (two unrelated fields compare at about 1.4)`);
    }
    checkReason(reason, `${where}: resolutionTol`);
    if (def.resolutionDependent) throw new TypeError(`${where}: resolutionTol on a resolutionDependent node, which the resolution check leaves out`);
    if (generator) throw new TypeError(`${where}: resolutionTol on a generator: a generator agrees at shared vertices within 1e-6, and no tolerance replaces that`);
    if (skip.resolution !== undefined) throw new TypeError(`${where}: resolutionTol and skip["resolution"] are both declared`);
  }
  const settings: ProjectSettings = { ...TEST_SETTINGS, ...opts.settings };
  const tolerance = opts.resolutionTol?.value ?? 0.01;

  registered.add(def.type);
  useNodes([def]);

  // ---- the runs --------------------------------------------------------------------------------------------------
  const inputsOf = (variant: Variant): Record<string, FixtureName> => {
    const inputs = defaultFixtures(def, variant);
    for (const [name, fixture] of Object.entries(opts.inputs ?? {})) {
      if (variant === 'field' || def.inputs.find((port) => port.name === name)?.type !== 'any') inputs[name] = fixture;
    }
    return inputs;
  };
  const baseParams: Record<string, ParamValue> = {};
  for (const param of def.params) baseParams[param.name] = opts.params?.[param.name] ?? param.default;

  interface RunOptions {
    readonly res: number;
    readonly variant?: Variant;
    readonly params?: Readonly<Record<string, ParamValue>>;
    /** Replaces single inputs of the variant's set; null leaves one unconnected. */
    readonly inputs?: Readonly<Record<string, FixtureName | null>>;
    readonly wants?: readonly string[];
    readonly slices?: Slices;
    readonly signal?: AbortSignal;
    readonly onSlice?: SliceListener;
    /** What the run is, for the message of a failure. */
    readonly label: string;
  }
  let runs = 0;
  let gpu: GpuContext | null = null;
  const leaked: string[] = [];
  let current: Check = 'meta';

  /** traceNode without the assertions: for the run that is expected to reject. */
  async function trace(o: RunOptions): Promise<Traced> {
    runs++;
    try {
      const traced = await traceWithEngine(def, {
        res: o.res, settings,
        params: { ...opts.params, ...o.params },
        inputs: { ...inputsOf(o.variant ?? 'field'), ...o.inputs },
        ...(o.wants ? { wants: o.wants } : {}),
        ...(o.slices ? { slices: o.slices } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
        ...(o.onSlice ? { onSlice: o.onSlice } : {}),
      });
      gpu = traced.engine.gpu;
      return traced;
    } catch (thrown) {
      if (thrown instanceof Error && thrown.message.startsWith('Leaked textures') && !leaked.includes(current)) leaked.push(current);
      throw thrown;
    }
  }

  /** One evaluation that passes the basic assertions: status 'ok', every output finite, every mask output within 0..1. */
  async function run(o: RunOptions): Promise<Traced> {
    let traced: Traced;
    try {
      traced = await trace(o);
    } catch (thrown) {
      if (!(thrown instanceof Error) || thrown.name === 'AbortError') throw thrown;
      const kind = (thrown as { error?: { kind?: unknown } }).error?.kind;
      fail(`${o.label}: ${typeof kind === 'string' ? `the node failed (${kind}): ` : ''}${thrown.message}`);
    }
    for (const output of def.outputs) {
      const field = traced.outputs[output.name];
      if (!field) continue;
      try {
        expectFinite(field);
        if (isMask(output)) expectMask(field);
      } catch (thrown) {
        fail(`${o.label}: output "${output.name}": ${(thrown as Error).message}`);
      }
    }
    return traced;
  }

  const references = new Map<string, Promise<Traced>>();
  /** R257 and R129: defaults, every input connected, every output wanted (3.1). Made once per variant, by whichever check asks first. */
  function reference(res: 129 | 257, variant: Variant = 'field'): Promise<Traced> {
    const key = `${res} ${variant}`;
    let made = references.get(key);
    if (!made) references.set(key, made = run({ res, variant, label: `R${res}${variant === 'color' ? ' (colour variant)' : ''}` }));
    return made;
  }
  const named = (variant: Variant, text: string): string => (variants.length > 1 ? `${text} (${variant} variant)` : text);
  const identical = (a: FieldData, b: FieldData, what: string): void => {
    try {
      expectIdentical(a, b);
    } catch (thrown) {
      fail(`${what}: ${(thrown as Error).message}`);
    }
  };

  // ---- the checks ------------------------------------------------------------------------------------------------
  let budget: Report['budget'] = null;
  const bodies: Readonly<Record<Check, (t: TestContext) => Promise<void>>> = {
    async meta() {
      const problems = lintNode(def).map((problem) => problem.message);
      if (isExport) problems.push(...(await exportViolations(def)).map((violation) => `export ${def.type}: ${violation}`));
      if (problems.length > 0) fail(`The node breaks ${problems.length === 1 ? 'a rule' : `${problems.length} rules`} of testing.md section 4:\n${problems.slice(0, 20).join('\n')}`);
    },

    async finite() {
      for (const variant of variants) {
        const { outputs } = await reference(257, variant);
        // The terrain a mask or a data output is drawn over: the node's first height input, an `any` input given a field included.
        const heightPort = def.inputs.find((port) => (port.type === 'field' && (port.role ?? 'height') === 'height') || (port.type === 'any' && variant === 'field'));
        const heightName = heightPort ? inputsOf(variant)[heightPort.name] : undefined;
        const terrain = heightName ? await fixtures.byName(heightName, 257) : undefined;
        for (const output of def.outputs) {
          const field = outputs[output.name]!;
          const name = `nodes/${def.type}/${output.name}${variant === 'color' ? '-color' : ''}`;
          const scale = { terrainSize: settings.terrainSize, heightRange: settings.heightRange };
          if (field.kind === 'color') await savePicture(name, field, { style: 'color' });
          else if (output.role === 'mask' || output.role === 'data') {
            await savePicture(name, field, { style: 'sheet', ...scale, ...(output.role === 'data' ? { range: 'auto' as const } : {}), ...(terrain ? { height: terrain } : {}) });
          } else await savePicture(name, field, { style: 'sheet', ...scale });
        }
      }
    },

    async 'mask-range'() {
      for (const variant of variants) {
        const { outputs } = await reference(257, variant);
        for (const output of def.outputs.filter(isMask)) {
          try {
            expectMask(outputs[output.name]!);
          } catch (thrown) {
            fail(named(variant, `output "${output.name}": ${(thrown as Error).message}`));
          }
        }
      }
    },

    async alpha() {
      for (const variant of variants) {
        const { outputs } = await reference(257, variant);
        for (const output of def.outputs) {
          const field = outputs[output.name]!;
          if (field.kind !== 'color') continue;
          let first = -1, count = 0;
          for (let i = 0; i < field.width * field.height; i++) {
            if (field.data[i * 4 + 3] === 1) continue;
            if (count++ === 0) first = i;
          }
          if (count > 0) {
            fail(named(variant, `output "${output.name}": alpha is not 1 on ${count} of ${field.width * field.height} texels; the first is ${show(field.data[first * 4 + 3]!)} at (${first % field.width}, ${Math.floor(first / field.width)})`));
          }
        }
      }
    },

    async 'generator-range'() {
      const seeds = hasSeed ? [0, 1, 2] : [null];
      for (const seed of seeds) {
        const label = seed === null ? 'at 257' : `at 257 with the node seed ${seed}`;
        const { outputs } = await run({ res: 257, ...(seed !== null ? { params: { seed } } : {}), label });
        const s = stats(outputs[primary!.name]!);
        const out = `output "${primary!.name}" ${label}`;
        if (!(s.min >= -0.05)) fail(`${out}: min ${show(s.min)} is below -0.05`);
        if (!(s.max <= 1.05)) fail(`${out}: max ${show(s.max)} is above 1.05`);
        if (!(s.max - s.min >= 0.5)) fail(`${out}: the span max - min is ${show(s.max - s.min)}, below 0.5`);
        if (!(s.mean >= 0.25 && s.mean <= 0.75)) fail(`${out}: mean ${show(s.mean)} is outside [0.25, 0.75]`);
      }
    },

    async deterministic() {
      for (const variant of variants) {
        // After the trim the first run receives new, zero-filled textures and the second recycled ones holding −1e30.
        await (await getEngine('auto')).engine.trim();
        const first = await run({ res: 257, variant, label: named(variant, 'the first run at 257, on a fresh pool') });
        const second = await run({ res: 257, variant, label: named(variant, 'the second run at 257, on a used pool') });
        for (const output of def.outputs) {
          identical(second.outputs[output.name]!, first.outputs[output.name]!, named(variant, `output "${output.name}", the second run at 257 against the first (the first runs on new textures, the second on recycled ones)`));
        }
      }
    },

    async 'deterministic-large'(t) {
      const { gpu: device } = await getEngine('auto');
      if (device.caps.software) {
        t.skip(`a data race in a read_write texture shows on parallel hardware and large fields only; "${device.caps.adapter.description || device.caps.adapter.device}" is a software adapter`);
        return;
      }
      const first = await run({ res: 2049, label: 'the first run at 2049' });
      const second = await run({ res: 2049, label: 'the second run at 2049' });
      for (const output of def.outputs) identical(second.outputs[output.name]!, first.outputs[output.name]!, `output "${output.name}", two runs at 2049`);
    },

    async resolution() {
      for (const variant of variants) {
        const coarse = await reference(257, variant);
        const fine = await run({ res: 513, variant, label: named(variant, 'at 513') });
        for (const output of def.outputs) {
          const d = compareLadder(coarse.outputs[output.name]!, fine.outputs[output.name]!);
          const what = named(variant, `output "${output.name}", 513 against 257 at shared vertices`);
          if (generator) {
            if (!(d.max <= 1e-6)) fail(`${what}: max difference ${show(d.max)}; a generator is a function of uv, allowed 1e-6`);
          } else {
            const allowed = Math.max(tolerance * d.std, 1e-6);
            if (!(d.rms <= allowed)) {
              fail(`${what}: rms difference ${show(d.rms)} is ${show(d.rel)} of the standard deviation ${show(d.std)}; allowed ${show(tolerance)} of it (${show(allowed)})`);
            }
          }
        }
      }
    },

    async params() {
      const key = (params: Readonly<Record<string, ParamValue>>): string => JSON.stringify(def.params.map((param) => params[param.name]));
      const done = new Set<string>();
      const tried = async (changes: Readonly<Record<string, ParamValue>>): Promise<void> => {
        const id = key({ ...baseParams, ...changes });
        if (done.has(id)) return;
        done.add(id);
        // The values of the reference run are R129 itself.
        if (id === key(baseParams)) await reference(129);
        else await run({ res: 129, params: changes, label: `at 129 with ${describeValue(changes)}` });
      };
      for (const param of def.params) {
        for (const value of valuesTried(param, baseParams[param.name]!)) await tried({ [param.name]: value });
      }
      // Every float, int and vec2 parameter at its min together, and at its max together (3.3).
      for (const end of ['min', 'max'] as const) {
        const together: Record<string, ParamValue> = {};
        for (const param of def.params) {
          if (param.kind === 'float' || param.kind === 'int') together[param.name] = param[end];
          else if (param.kind === 'vec2') together[param.name] = [param[end], param[end]];
        }
        if (Object.keys(together).length > 0) await tried(together);
      }
    },

    async 'optional-unbound'() {
      const unbound: Record<string, null> = {};
      for (const port of def.inputs) if (port.optional) unbound[port.name] = null;
      await run({ res: 129, inputs: unbound, label: `at 129 with the optional inputs ${Object.keys(unbound).join(', ')} unconnected` });
    },

    async 'short-ladder'() {
      for (const variant of variants) await run({ res: 33, variant, label: named(variant, 'at 33, where ctx.ladder is [33]') });
    },

    async 'mask-neutral'() {
      const unconnected = await run({ res: 129, inputs: { mask: null }, label: 'at 129 with `mask` unconnected' });
      const ones = await run({ res: 129, inputs: { mask: 'one' }, label: 'at 129 with `mask` given ones' });
      for (const output of def.outputs) {
        try {
          expectClose(unconnected.outputs[output.name]!, ones.outputs[output.name]!, { max: 1e-6 });
        } catch (thrown) {
          fail(`output "${output.name}", \`mask\` unconnected against a mask of ones: ${(thrown as Error).message}`);
        }
      }
    },

    async seed() {
      const base = await reference(129);
      const raised = (Number(baseParams.seed) + 1) % 2 ** 32;
      const other = await run({ res: 129, params: { seed: raised }, label: `at 129 with the node seed ${raised}` });
      const shares = def.outputs.map((output) => {
        const a = base.outputs[output.name]!, b = other.outputs[output.name]!;
        return { name: output.name, share: diff(a, b).differing / a.data.length };
      });
      if (!shares.some((s) => s.share > 0.01)) {
        fail(`with the node seed raised from ${String(baseParams.seed)} to ${raised} no output differs in more than 1 % of its values (${shares.map((s) => `"${s.name}": ${show(100 * s.share)} %`).join(', ')})`);
      }
    },

    async wants() {
      const all = await reference(129);
      for (const output of def.outputs) {
        const alone = await run({ res: 129, wants: [output.name], label: `at 129 wanting "${output.name}" alone` });
        identical(alone.outputs[output.name]!, all.outputs[output.name]!, `output "${output.name}" wanted alone against wanted with the others`);
      }
    },

    async budget(t) {
      const peakBytes129 = (await reference(129)).report.nodes.node?.peakBytes ?? 0;
      const peakBytes257 = (await reference(257)).report.nodes.node?.peakBytes ?? 0;
      // The two-point fit separates memory that grows with the resolution from memory that does not (3.5).
      const estimateBytes = peakBytes129 + ((peakBytes257 - peakBytes129) * (BUILD_RES ** 2 - 129 ** 2)) / (257 ** 2 - 129 ** 2);
      const asserted = (await getEngine('auto')).gpu.caps.compactFormats;
      budget = { peakBytes129, peakBytes257, estimateBytes, limitBytes: BUDGET_BYTES, asserted };
      const line = `budget: ${(estimateBytes / 1e9).toFixed(2)} GB at ${BUILD_RES}`;
      t.diagnostic(line);
      if (!asserted) {
        t.skip(`${line}; not asserted: this device has no compact formats and counts half, half2 and mask8 at up to four times their size. The profile max on a hardware adapter asserts it`);
        return;
      }
      if (!(estimateBytes <= BUDGET_BYTES)) {
        fail(`${line}: the node's peak memory, ${peakBytes129} bytes at 129 and ${peakBytes257} at 257, extrapolates to ${Math.round(estimateBytes)} bytes; allowed ${BUDGET_BYTES}`);
      }
    },

    async abort(t) {
      const base = await reference(129);
      const controller = new AbortController();
      const outcome = await trace({
        res: 129, slices: 'small', signal: controller.signal, label: 'the aborted run at 129',
        // The first slice that completes while the node runs.
        onSlice: (slice) => {
          if (slice.nodeId === 'node') controller.abort();
        },
      }).then(() => ({ thrown: null, rejected: false }), (thrown: unknown) => ({ thrown, rejected: true }));
      if (!controller.signal.aborted) {
        if (outcome.rejected) throw outcome.thrown;
        t.skip('the node completes without a slice: there is nothing to abort');
        return;
      }
      if (!outcome.rejected) fail('the run was aborted at the first slice of the node and resolved; it rejects with the abort reason');
      if (outcome.thrown !== controller.signal.reason) {
        fail(`the aborted run rejected with ${outcome.thrown instanceof Error ? `${outcome.thrown.name}: ${outcome.thrown.message}` : describeValue(outcome.thrown)}, not with the abort reason`);
      }
      const again = await run({ res: 129, slices: 'small', label: 'the run at 129 after the aborted one' });
      for (const output of def.outputs) identical(again.outputs[output.name]!, base.outputs[output.name]!, `output "${output.name}", the run after the aborted one against R129`);
    },

    async slicing() {
      const bases = new Map<Variant, Traced>();
      for (const variant of variants) bases.set(variant, await reference(129, variant));
      for (const slices of ['small', 'one'] as const) {
        for (const variant of variants) {
          const sliced = await run({ res: 129, variant, slices, label: named(variant, `at 129 with slices "${slices}"`) });
          for (const output of def.outputs) {
            identical(sliced.outputs[output.name]!, bases.get(variant)!.outputs[output.name]!, named(variant, `output "${output.name}" with slices "${slices}" against R129`));
          }
        }
      }
    },

    async leaks() {
      // Every evaluation above ended with expectNoLeaks(), and a leak failed the check that ran it.
      if (leaked.length > 0) fail(`textures leaked in the check${leaked.length > 1 ? 's' : ''} ${leaked.join(', ')}`);
      await expectNoLeaks();
    },
  };

  // ---- registration ------------------------------------------------------------------------------------------------
  const records: Record<string, CheckRecord> = {};
  for (const check of CHECKS) records[check] = { result: applies[check] ? 'not-run' : 'not-applicable' };

  function writeReport(): void {
    const caps = gpu?.caps ?? null;
    const optOuts: Report['optOuts'][number][] = Object.entries(skip).map(([check, reason]) => ({ check, kind: 'skip' as const, reason: reason! }));
    if (opts.resolutionTol) optOuts.push({ check: 'resolution', kind: 'tolerance', value: opts.resolutionTol.value, reason: opts.resolutionTol.reason });
    const report: Report = {
      type: def.type,
      adapter: caps ? { vendor: caps.adapter.vendor, architecture: caps.adapter.architecture, device: caps.adapter.device, description: caps.adapter.description, software: caps.software } : null,
      profile: gpu?.profile ?? null,
      compactFormats: caps?.compactFormats ?? null,
      checks: records, optOuts,
      resolutionDependent: def.resolutionDependent === true,
      budget,
      params: Object.fromEntries(Object.entries(opts.params ?? {}).map(([name, value]) => {
        const isFile = def.params.some((param) => param.name === name && param.kind === 'file');
        return [name, isFile && typeof value === 'string' && value !== '' ? path.resolve(TESTS_FOLDER, value) : value];
      })),
    };
    const file = path.join(outputFolder(), 'conformance', ...`${def.type}.json`.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  }

  describe(`${def.type} conformance`, () => {
    for (const check of CHECKS) {
      if (!applies[check]) continue;
      const name = `${def.type} / ${check}`;
      const reason = skip[check as SkippableCheck];
      if (reason !== undefined) {
        records[check] = { result: 'skipped', reason };
        test(name, { skip: reason }, () => {});
        continue;
      }
      test(name, async (t) => {
        current = check;
        const record: CheckRecord = { result: 'passed' };
        records[check] = record;
        // t.skip() marks the case and lets the function go on: the record follows it.
        const skipCase = t.skip.bind(t);
        t.skip = (message?: string) => {
          record.result = 'skipped';
          if (message !== undefined) record.reason = message;
          skipCase(message);
        };
        try {
          await bodies[check](t);
        } catch (thrown) {
          record.result = 'failed';
          record.message = thrown instanceof Error ? thrown.message : String(thrown);
          throw thrown;
        }
      });
    }
    // Written whatever the cases did: the gallery shows it, and the reviewer approves each opt-out (3.6 rule 2).
    after(writeReport);
  });
}
