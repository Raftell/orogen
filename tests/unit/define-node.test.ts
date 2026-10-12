// defineNode: every check of engine.md 4.6 and its message, and createRegistry (runtime.md 5.1).
// The definitions are deliberately wrong in ways the types reject, so they are built untyped.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRegistry, defineNode, NodeDefError, param, type AnyCpuTask, type NodeDef, type WgslLib } from '../../src/core/api.ts';
import { canBypass, inputsOf, MASK_PORT } from '../../src/core/graph/ports.ts';
import { kernel } from './graph-fixtures.ts';

type Loose = Record<string, unknown>;
const define = defineNode as unknown as (def: Loose) => NodeDef;

const base = (over: Loose = {}): Loose => ({
  type: 'ref/sample',
  title: 'Sample (Reference)',
  category: 'ref',
  description: 'Generates a sample.',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [],
  kernels: [],
  evaluate() {},
  ...over,
});

/** The message after the prefix `node "<type>": `. */
function rejected(over: Loose, problem: string, type = 'ref/sample'): void {
  assert.throws(() => define(base(over)), (error: unknown) => {
    assert.ok(error instanceof NodeDefError, `expected a NodeDefError, got ${String(error)}`);
    assert.equal(error.name, 'NodeDefError');
    assert.equal(error.message, `node "${type}": ${problem}`);
    return true;
  });
}
const float = (over: Loose = {}): Loose => ({ kind: 'float', name: 'reach', unit: 'length', help: 'How far.', default: 0.5, min: 0, max: 1, ...over });
const withParam = (p: Loose, more: readonly Loose[] = []): Loose => ({ params: [p, ...more] });

test('a valid definition is returned with its members, frozen', () => {
  const evaluate = (): void => {};
  const def = define(base({
    inputs: [{ name: 'in', type: 'any' }, { name: 'guide', type: 'field', role: 'data', optional: true }],
    outputs: [{ name: 'out', type: { sameAs: 'in' } }, { name: 'flow', type: 'field', role: 'data' }, { name: 'color', type: 'color' }],
    params: [
      param.seed(), param.size(), param.size({ name: 'warpSize' }), param.slope('talus'), param.octaves(),
      { kind: 'enum', name: 'mode', help: 'A choice.', default: 'a', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
      { kind: 'bool', name: 'invert', help: 'Inverts.', default: false, visibleWhen: { param: 'mode', equals: 'b' } },
      { kind: 'vec2', name: 'offset', unit: 'length', help: 'A shift.', default: [0, 0], min: -1, max: 1 },
      { kind: 'color', name: 'tint', help: 'A colour.', default: [1, 0.5, 0] },
      { kind: 'curve', name: 'profile', help: 'A curve.', default: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
      { kind: 'gradient', name: 'ramp', help: 'A gradient.', default: [{ t: 0, color: [0, 0, 0] }, { t: 0, color: [1, 0, 0] }, { t: 1, color: [1, 1, 1] }] },
      { kind: 'file', name: 'file', help: 'A file.', default: '', filters: ['png', 'r16'] },
      { kind: 'text', name: 'label', help: 'A text.', default: 'Layer' },
    ],
    kernels: [kernel('ref/sample', 'fn compute(px: vec2i, uv: vec2f) -> f32 { return f32(seedFor(0u)); }')],
    maskable: true,
    uses: ['seaLevel'],
    version: 3,
    migrate: (p: Loose) => p,
    evaluate,
  }));
  assert.equal(def.type, 'ref/sample');
  assert.equal(def.evaluate, evaluate);
  assert.equal(def.params.length, 13);
  assert.equal(def.version, 3);
  assert.ok(Object.isFrozen(def));
});

test('the members a definition omits stay absent', () => {
  const def = define(base());
  for (const member of ['keywords', 'cpuTasks', 'maskable', 'resolutionDependent', 'uses', 'version', 'migrate', 'externalKey', 'export']) {
    assert.equal(member in def, false, member);
  }
});

test('1: the type has the pattern <category>/<name> with its category as prefix', () => {
  rejected({ type: 'Ref/Sample' }, 'invalid node type; it is <category>/<name> with a lower-case name of letters, digits and hyphens', 'Ref/Sample');
  rejected({ type: 'sample' }, 'invalid node type; it is <category>/<name> with a lower-case name of letters, digits and hyphens', 'sample');
  rejected({ type: 'ref/2d' }, 'invalid node type; it is <category>/<name> with a lower-case name of letters, digits and hyphens', 'ref/2d');
  rejected({ type: 'ref/a_b' }, 'invalid node type; it is <category>/<name> with a lower-case name of letters, digits and hyphens', 'ref/a_b');
  rejected({ type: 'filter/sample' }, 'the type must begin with its category, "ref/"', 'filter/sample');
  rejected({ type: 'tools/sample', category: 'tools' }, 'unknown category "tools"', 'tools/sample');
  assert.equal(define(base({ type: 'simulate/thermal-erosion2', category: 'simulate' })).type, 'simulate/thermal-erosion2');
});

test('1: port and param names have their patterns and are unique', () => {
  rejected({ inputs: [{ name: 'In', type: 'field' }] }, 'input name "In" must match [a-z][A-Za-z0-9]{0,23}');
  rejected({ outputs: [{ name: 'out', type: 'field' }, { name: 'wear_map', type: 'field' }] }, 'output name "wear_map" must match [a-z][A-Za-z0-9]{0,23}');
  rejected({ outputs: [{ name: 'out', type: 'field' }, { name: 'a'.repeat(25), type: 'field' }] }, `output name "${'a'.repeat(25)}" must match [a-z][A-Za-z0-9]{0,23}`);
  rejected(withParam(float({ name: 'Reach' })), 'param name "Reach" must match [a-z][A-Za-z0-9]*');
  rejected(withParam(float({ name: 'talus-angle' })), 'param name "talus-angle" must match [a-z][A-Za-z0-9]*');
  rejected({ inputs: [{ name: 'in', type: 'field' }, { name: 'in', type: 'field' }] }, 'input "in" is declared twice');
  rejected({ outputs: [{ name: 'out', type: 'field' }, { name: 'out', type: 'color' }] }, 'output "out" is declared twice');
  rejected(withParam(float(), [float()]), 'param "reach" is declared twice');
  // An input and an output may share a name.
  assert.ok(define(base({ inputs: [{ name: 'in', type: 'field' }, { name: 'flow', type: 'field' }], outputs: [{ name: 'out', type: 'field' }, { name: 'flow', type: 'field' }] })));
});

test('2: roles, optional, any and sameAs', () => {
  rejected({ inputs: [{ name: 'in', type: 'color', role: 'mask' }] }, 'input "in": a role is allowed only on a port of type "field"');
  rejected({ outputs: [{ name: 'out', type: 'color', role: 'data' }] }, 'output "out": a role is allowed only on a port of type "field"');
  rejected({ inputs: [{ name: 'in', type: 'any' }], outputs: [{ name: 'out', type: { sameAs: 'in' }, role: 'mask' }] }, 'output "out": a role is allowed only on a port of type "field"');
  rejected({ inputs: [{ name: 'in', type: 'field', role: 'weight' }] }, 'input "in": unknown role "weight"');
  rejected({ outputs: [{ name: 'out', type: 'field', optional: true }] }, 'output "out": optional is allowed only on inputs');
  rejected({ inputs: [{ name: 'in', type: 'field', optional: true }, { name: 'guide', type: 'field' }] }, 'input "guide": a required input cannot follow an optional one');
  rejected({ outputs: [{ name: 'out', type: 'any' }] }, 'output "out": type "any" is allowed only on inputs');
  rejected({ inputs: [{ name: 'in', type: { sameAs: 'in' } }] }, 'input "in": sameAs is allowed only on outputs');
  rejected({ inputs: [{ name: 'in', type: 'vec2' }] }, 'input "in": unknown port type "vec2"');
  rejected({ outputs: [{ name: 'out', type: 'half' }] }, 'output "out": unknown port type "half"');
  rejected({ outputs: [{ name: 'out', type: { sameAs: 'src' } }] }, 'output "out": sameAs names "src", which is not a required input of type "any"');
  rejected({ outputs: [{ name: 'out', type: { sameAs: 'in' } }] }, 'output "out": sameAs names "in", which is not a required input of type "any"');
  rejected(
    { inputs: [{ name: 'in', type: 'field' }, { name: 'other', type: 'any', optional: true }], outputs: [{ name: 'out', type: { sameAs: 'other' } }] },
    'output "out": sameAs names "other", which is not a required input of type "any"',
  );
});

test('2: the conventions for in, a, out and mask', () => {
  rejected({ outputs: [{ name: 'result', type: 'field' }] }, 'the first output must be named "out", not "result"');
  rejected({ inputs: [{ name: 'src', type: 'field' }] }, 'the first input must be named "in" or "a", not "src"');
  rejected({ inputs: [{ name: 'mask', type: 'field', role: 'mask', optional: true }] }, 'the first input must be named "in" or "a", not "mask"');
  const mask = 'input "mask" must be an optional field with role "mask"';
  rejected({ inputs: [{ name: 'in', type: 'field' }, { name: 'mask', type: 'field', role: 'mask' }] }, mask);
  rejected({ inputs: [{ name: 'in', type: 'field' }, { name: 'mask', type: 'field', optional: true }] }, mask);
  rejected({ inputs: [{ name: 'in', type: 'field' }, { name: 'mask', type: 'color', optional: true }] }, mask);
  rejected({ inputs: [{ name: 'in', type: 'field' }, { name: 'mask', type: 'field', role: 'data', optional: true }] }, mask);
  assert.ok(define(base({ inputs: [{ name: 'a', type: 'field' }, { name: 'b', type: 'field' }, { name: 'mask', type: 'field', role: 'mask', optional: true }] })));
  assert.ok(define(base({ inputs: [], outputs: [] })));
});

test('3: ranges and defaults of float, int and vec2', () => {
  rejected(withParam(float({ default: 2 })), 'param "reach": default 2 is outside 0..1');
  rejected(withParam(float({ default: 2, soft: true })), 'param "reach": default 2 is outside 0..1');
  rejected(withParam(float({ min: 1, max: 1, default: 1 })), 'param "reach": min 1 must be below max 1');
  rejected(withParam(float({ min: 2, max: 1 })), 'param "reach": min 2 must be below max 1');
  rejected(withParam(float({ scale: 'log' })), 'param "reach": log scale needs min > 0; min is 0');
  rejected(withParam(float({ scale: 'log', min: -1 })), 'param "reach": log scale needs min > 0; min is -1');
  rejected(withParam(float({ unit: undefined })), 'param "reach": a float needs a unit');
  rejected(withParam(float({ unit: 'metres' })), 'param "reach": unknown unit "metres"');
  rejected(withParam(float({ step: 0 })), 'param "reach": step 0 must be above 0');
  rejected(withParam(float({ max: Infinity })), 'param "reach": min and max must be finite numbers');
  assert.ok(define(base(withParam(float({ scale: 'log', min: 0.001, step: 0.01 })))));

  const int = (over: Loose): Loose => ({ kind: 'int', name: 'count', help: 'A count.', default: 4, min: 1, max: 16, ...over });
  rejected(withParam(int({ default: 0 })), 'param "count": default 0 is outside 1..16');
  rejected(withParam(int({ default: 2.5 })), 'param "count": min, max and default of an int must be integers');
  rejected(withParam(int({ min: 0.5 })), 'param "count": min, max and default of an int must be integers');
  rejected(withParam(int({ min: 16 })), 'param "count": min 16 must be below max 16');

  const vec2 = (over: Loose): Loose => ({ kind: 'vec2', name: 'offset', unit: 'length', help: 'A shift.', default: [0, 0], min: -1, max: 1, ...over });
  rejected(withParam(vec2({ default: [0, 2] })), 'param "offset": default [0,2] is outside -1..1');
  rejected(withParam(vec2({ default: [0] })), 'param "offset": default [0] is outside -1..1');
  rejected(withParam(vec2({ unit: 'angle' })), 'param "offset": unknown unit "angle" for a vec2');
  rejected(withParam(vec2({ min: 1 })), 'param "offset": min 1 must be below max 1');
});

test('3: enum options and default', () => {
  const options = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }];
  const enumParam = (over: Loose): Loose => ({ kind: 'enum', name: 'mode', help: 'A choice.', default: 'a', options, ...over });
  rejected(withParam(enumParam({ default: 'c' })), 'param "mode": default "c" is not among the options');
  rejected(withParam(enumParam({ options: [options[0]] })), 'param "mode": an enum needs at least two options');
  rejected(withParam(enumParam({ options: [options[0], options[0]] })), 'param "mode": option value "a" is listed twice');
  rejected(withParam(enumParam({ options: [options[0], { value: 'b' }] })), 'param "mode": an option needs a value and a label');
});

test('3: help, the seed and the rejected synonyms', () => {
  rejected(withParam(float({ help: '' })), 'param "reach": help is empty');
  rejected(withParam(float({ help: '   ' })), 'param "reach": help is empty');
  rejected(withParam(float({ help: undefined })), 'param "reach": help is empty');
  rejected({ params: [param.seed(), { ...param.seed(), name: 'seed2' }] }, 'a node has at most one seed param');
  rejected(withParam({ ...param.seed(), name: 'variation' }), 'param "variation": a seed param must be named "seed"');
  rejected(withParam({ kind: 'int', name: 'seed', help: 'A seed.', default: 0, min: 0, max: 9 }), 'param "seed": the name "seed" is reserved for the param of kind "seed"');
  rejected(withParam({ ...param.seed(), default: -1 }), 'param "seed": default -1 is not an integer in 0..4294967295');
  const synonyms: Record<string, string> = {
    scale: 'size', frequency: 'size', amount: 'strength', intensity: 'strength', opacity: 'strength', blur: 'radius', rotation: 'angle', rotate: 'angle',
  };
  for (const [name, use] of Object.entries(synonyms)) {
    rejected(withParam(float({ name })), `param "${name}": the name "${name}" is not allowed; use "${use}"`);
  }
  assert.ok(define(base(withParam(float({ name: 'scaleBias' })))));
});

test('3: visibleWhen names another bool, enum or int param and a value it can have', () => {
  const mode = { kind: 'enum', name: 'mode', help: 'A choice.', default: 'a', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] };
  const flag = { kind: 'bool', name: 'invert', help: 'Inverts.', default: false };
  const count = { kind: 'int', name: 'count', help: 'A count.', default: 1, min: 0, max: 4 };
  const other = 'which is not another bool, enum or int param of the node';
  rejected(withParam(float({ visibleWhen: { param: 'mode', equals: 'a' } })), `param "reach": visibleWhen names "mode", ${other}`);
  rejected(withParam(float({ visibleWhen: { param: 'reach', equals: 1 } })), `param "reach": visibleWhen names "reach", ${other}`);
  rejected(withParam(float({ visibleWhen: { param: 'depth', equals: 1 } }), [float({ name: 'depth' })]), `param "reach": visibleWhen names "depth", ${other}`);
  rejected(withParam({ ...flag, visibleWhen: { param: 'invert', equals: true } }), `param "invert": visibleWhen names "invert", ${other}`);
  rejected(withParam(float({ visibleWhen: { param: 'mode', equals: 'c' } }), [mode]), 'param "reach": visibleWhen compares "mode" with "c", a value it never has');
  rejected(withParam(float({ visibleWhen: { param: 'invert', equals: 'yes' } }), [flag]), 'param "reach": visibleWhen compares "invert" with "yes", a value it never has');
  rejected(withParam(float({ visibleWhen: { param: 'count', equals: 1.5 } }), [count]), 'param "reach": visibleWhen compares "count" with 1.5, a value it never has');
  assert.ok(define(base({
    params: [
      float({ visibleWhen: { param: 'mode', equals: 'b' } }), mode, flag, count,
      float({ name: 'depth', visibleWhen: { param: 'invert', equals: true } }),
      float({ name: 'width', visibleWhen: { param: 'count', equals: 2 } }),
    ],
  })));
});

test('3: defaults of the other kinds obey the table of 4.3', () => {
  rejected(withParam({ kind: 'bool', name: 'invert', help: 'Inverts.', default: 0 }), 'param "invert": the default of a bool must be true or false');
  rejected(withParam({ kind: 'color', name: 'tint', help: 'A colour.', default: [1, 1, 2] }), 'param "tint": default [1,1,2] is not three numbers in 0..1');
  const curve = (points: unknown): Loose => withParam({ kind: 'curve', name: 'profile', help: 'A curve.', default: points });
  rejected(curve([{ x: 0, y: 0 }]), 'param "profile": the default of a curve needs at least 2 points');
  rejected(curve([{ x: 0, y: 0 }, { x: 1, y: 2 }]), 'param "profile": the default of a curve has x and y in 0..1');
  rejected(curve([{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 0.5, y: 1 }]), 'param "profile": the default of a curve has strictly increasing x');
  const gradient = (stops: unknown): Loose => withParam({ kind: 'gradient', name: 'ramp', help: 'A gradient.', default: stops });
  rejected(gradient([{ t: 0, color: [0, 0, 0] }]), 'param "ramp": the default of a gradient needs at least 2 stops');
  rejected(gradient([{ t: 0, color: [0, 0, 0] }, { t: 1, color: [1, 1] }]), 'param "ramp": the default of a gradient has t and colours in 0..1');
  rejected(gradient([{ t: 0.5, color: [0, 0, 0] }, { t: 0, color: [1, 1, 1] }]), 'param "ramp": the default of a gradient has non-decreasing t');
  const file = (over: Loose): Loose => withParam({ kind: 'file', name: 'file', help: 'A file.', default: '', filters: ['png'], ...over });
  rejected(file({ default: 'a.png' }), 'param "file": the default of a file param is \'\'');
  rejected(file({ filters: ['.png'] }), 'param "file": filters are lower-case extensions without the dot');
  const text = (over: Loose): Loose => withParam({ kind: 'text', name: 'label', help: 'A text.', default: 'Layer', ...over });
  rejected(text({ maxLength: 3 }), 'param "label": the default is longer than 3 characters');
  rejected(text({ default: 'x'.repeat(257) }), 'param "label": the default is longer than 256 characters');
  rejected(text({ maxLength: 0 }), 'param "label": maxLength 0 must be an integer above 0');
  rejected(withParam({ kind: 'slider', name: 'reach', help: 'How far.', default: 0 }), 'param "reach": unknown kind "slider"');
});

test('4: maskable needs inputs[0] and outputs[0] of one type and no input named mask', () => {
  const same = 'maskable needs inputs[0] and outputs[0] of the same type';
  rejected({ maskable: true, inputs: [] }, same);
  rejected({ maskable: true, outputs: [] }, same);
  rejected({ maskable: true, outputs: [{ name: 'out', type: 'color' }] }, same);
  rejected({ maskable: true, inputs: [{ name: 'in', type: 'any' }] }, same);
  rejected(
    { maskable: true, inputs: [{ name: 'in', type: 'field' }, { name: 'other', type: 'any' }], outputs: [{ name: 'out', type: { sameAs: 'other' } }] },
    same,
  );
  rejected(
    { maskable: true, inputs: [{ name: 'in', type: 'field' }, { name: 'mask', type: 'field', role: 'mask', optional: true }] },
    'maskable is set but the node declares its own input "mask"',
  );
  assert.ok(define(base({ maskable: true })));
  assert.ok(define(base({ maskable: true, inputs: [{ name: 'in', type: 'color' }], outputs: [{ name: 'out', type: 'color' }] })));
  assert.ok(define(base({ maskable: true, inputs: [{ name: 'in', type: 'any' }], outputs: [{ name: 'out', type: { sameAs: 'in' } }] })));
  assert.ok(define(base({ maskable: false, inputs: [] })));
});

test('5: a kernel or task is listed once', () => {
  const k = kernel('ref/sample.pass', 'fn compute(px: vec2i, uv: vec2f) -> f32 { return 0.0; }');
  const task: AnyCpuTask = { name: 'ref/sample.task', run: () => 0 };
  rejected({ kernels: [k, k] }, 'kernel "ref/sample.pass" is listed twice');
  rejected({ cpuTasks: [task, task] }, 'CPU task "ref/sample.task" is listed twice');
  assert.ok(define(base({ kernels: [k], cpuTasks: [task] })));
});

test('6: a kernel that reads the seed needs the seed param', () => {
  const why = 'reads the seed (frame.seed or seedFor) but the node has no seed param; add param.seed()';
  const plain = 'fn compute(px: vec2i, uv: vec2f) -> f32 { return uv.x; }';
  const lib = (name: string, code: string, deps: readonly WgslLib[] = []): WgslLib => ({ name, code, deps });
  const seeded = lib('refSeeded', 'fn refSeeded_value() -> u32 { return frame.seed; }');

  rejected({ kernels: [kernel('ref/sample.a', 'fn compute(px: vec2i, uv: vec2f) -> f32 { return f32(seedFor(1u)); }')] }, `kernel "ref/sample.a" ${why}`);
  rejected({ kernels: [kernel('ref/sample.b', 'fn compute(px: vec2i, uv: vec2f) -> f32 { return f32(frame.seed); }')] }, `kernel "ref/sample.b" ${why}`);
  rejected({ kernels: [kernel('ref/sample.ok', plain), kernel('ref/sample.c', plain, [seeded])] }, `kernel "ref/sample.c" ${why}`);
  rejected({ kernels: [kernel('ref/sample.d', plain, [lib('refOuter', '', [lib('refMiddle', '', [seeded])])])] }, `kernel "ref/sample.d" ${why}`);

  assert.ok(define(base({ kernels: [kernel('ref/sample.e', plain, [lib('refPlain', 'fn refPlain_one() -> f32 { return 1.0; }')])] })));
  assert.ok(define(base({ params: [param.seed()], kernels: [kernel('ref/sample.f', plain, [seeded])] })));
});

test('7: version and migrate, and the settings a node uses', () => {
  rejected({ version: 2 }, 'version 2 needs a migrate function');
  rejected({ version: 0 }, 'version 0 must be an integer of at least 1');
  rejected({ version: 1.5, migrate: (p: Loose) => p }, 'version 1.5 must be an integer of at least 1');
  rejected({ uses: ['seaLevel', 'snowLine'] }, 'uses names an unknown setting "snowLine"');
  assert.ok(define(base({ version: 1 })));
  assert.ok(define(base({ version: 2, migrate: (p: Loose) => p, uses: ['seaLevel'] })));
});

test('the checks run in the order of the list: the first broken rule is reported', () => {
  rejected(
    { inputs: [{ name: 'src', type: 'field' }], params: [float({ default: 9 })], maskable: true, outputs: [], version: 2 },
    'the first input must be named "in" or "a", not "src"',
  );
  rejected({ params: [float({ default: 9 })], maskable: true, outputs: [], version: 2 }, 'param "reach": default 9 is outside 0..1');
  rejected({ maskable: true, outputs: [], version: 2 }, 'maskable needs inputs[0] and outputs[0] of the same type');
});

test('ports: the mask a maskable node gains, and what can be bypassed', () => {
  const plain = define(base());
  const masked = define(base({ maskable: true }));
  assert.equal(inputsOf(plain), plain.inputs);
  assert.deepEqual(inputsOf(masked), [{ name: 'in', type: 'field' }, { name: 'mask', type: 'field', role: 'mask', optional: true }]);
  assert.equal(inputsOf(masked)[1], MASK_PORT);

  assert.equal(canBypass(plain), true);
  assert.equal(canBypass(define(base({ inputs: [{ name: 'in', type: 'any' }], outputs: [{ name: 'out', type: { sameAs: 'in' } }] }))), true);
  assert.equal(canBypass(define(base({ outputs: [{ name: 'out', type: 'color' }] }))), false);
  assert.equal(canBypass(define(base({ inputs: [] }))), false);
  assert.equal(canBypass(define(base({ outputs: [] }))), false);
  assert.equal(canBypass(define(base({ inputs: [{ name: 'in', type: 'any' }] }))), false);
});

test('createRegistry: get by type, list in the order given, one definition per type', () => {
  const a = define(base({ type: 'ref/zeta' }));
  const b = define(base({ type: 'ref/alpha' }));
  const registry = createRegistry([a, b]);
  assert.equal(registry.get('ref/zeta'), a);
  assert.equal(registry.get('ref/alpha'), b);
  assert.equal(registry.get('ref/missing'), undefined);
  assert.equal(registry.get('constructor'), undefined);
  assert.deepEqual(registry.list(), [a, b]);
  assert.equal(registry.list(), registry.list());
  assert.deepEqual(createRegistry([]).list(), []);

  const twin = define(base({ type: 'ref/zeta', title: 'Twin (Reference)' }));
  for (const defs of [[a, b, twin], [a, a]]) {
    assert.throws(() => createRegistry(defs), (error: unknown) => {
      assert.ok(error instanceof NodeDefError);
      assert.equal(error.message, 'node "ref/zeta": the list holds two definitions of this type');
      return true;
    });
  }
});

test('a registry does not change when the list it was made from does', () => {
  const list = [define(base({ type: 'ref/one' }))];
  const registry = createRegistry(list);
  list.push(define(base({ type: 'ref/two' })));
  assert.equal(registry.list().length, 1);
  assert.equal(registry.get('ref/two'), undefined);
});

// Last in this file: sealing cannot be undone, and every test above defines nodes.
test('after createEngine has sealed the definitions, defineNode throws', async () => {
  const { sealDefinitions } = await import('../../src/core/gpu/seal.ts');
  sealDefinitions();
  assert.throws(() => define(base()), /defineNode\(\) was called after createEngine\(\)/);
});
