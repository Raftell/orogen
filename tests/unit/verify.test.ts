// What `verify` (testing.md 5.3) decides without starting anything: whose a type error and a failed case of the
// unit layer are. The first two steps cover the whole repository; a node is held to its category's own part of
// them, and what fails elsewhere is reported for its owner.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { UnitCase } from '../tools/unit-report.ts';
import { ownsPath, typeErrors, unitCases, unitOutcome } from '../tools/verify.ts';

const pass = (file: string, name: string): UnitCase => ({ result: 'pass', file, name });
const fail = (file: string, name: string, message = 'failed'): UnitCase => ({ result: 'fail', file, name, message });
const LINT = 'tests/unit/registry.test.ts', CATALOG = 'tests/unit/catalog.test.ts', IMPORTS = 'tests/unit/boundaries.test.ts';
const lintCase = (category: string): string => `${category}: files, index, tests, source and definitions`;
const catalogCase = (category: string): string => `${category}: the registered nodes are those of the catalog, with its titles, ports, parameters and flags`;
/** A unit layer in which everything passes, for these categories. */
const clean = (...categories: readonly string[]): UnitCase[] => [
  ...categories.flatMap((category) => [pass(LINT, lintCase(category)), ...(category === 'ref' ? [] : [pass(CATALOG, catalogCase(category))])]),
  pass(IMPORTS, 'every import of src/ and tests/ obeys the rules'), pass('tests/unit/params.test.ts', 'a float is clamped'),
];

test('a category owns its node folder and its test folder, and nothing beside them', () => {
  for (const file of ['src/core/nodes/filter/blur.ts', 'src/core/nodes/filter/_wgsl.ts', 'tests/nodes/filter/blur.test.ts', 'tests/nodes/filter/unit/kernel.test.ts']) assert.equal(ownsPath('filter', file), true, file);
  for (const file of ['src/core/nodes/filters/x.ts', 'src/core/nodes/select/slope.ts', 'tests/nodes/select/slope.test.ts', 'src/cli/render.ts', 'tests/unit/lint.test.ts', 'src/core/nodes/index.ts']) assert.equal(ownsPath('filter', file), false, file);
});

test('typeErrors reads the lines tsc prints, with the path as the repository writes it', () => {
  const output = [
    '> orogen@0.1.0 check', '> tsc -p tsconfig.core.json && tsc -p tsconfig.json', '',
    'src/platform/electron/main/files.ts(52,85): error TS2694: Namespace \'path\' has no exported member \'PlatformPath\'.',
    'src\\core\\nodes\\filter\\blur.ts(7,3): error TS2322: Type \'string\' is not assignable to type \'number\'.',
    '  The expected type comes from property \'radius\'.',
    'Found 2 errors in 2 files.',
  ].join('\n');
  assert.deepEqual(typeErrors(output), [
    { file: 'src/platform/electron/main/files.ts', text: 'src/platform/electron/main/files.ts(52,85): TS2694: Namespace \'path\' has no exported member \'PlatformPath\'.' },
    { file: 'src/core/nodes/filter/blur.ts', text: 'src/core/nodes/filter/blur.ts(7,3): TS2322: Type \'string\' is not assignable to type \'number\'.' },
  ]);
  assert.deepEqual(typeErrors('no error here\n'), []);
});

test('unitCases reads the report of the second reporter and leaves out what is no case', () => {
  const text = `${JSON.stringify(pass(LINT, 'a'))}\nnoise\n${JSON.stringify(fail(CATALOG, 'b', 'm'))}\n{"result":"skip","name":"c","file":"x"}\n{"result":"fail","na`;
  assert.deepEqual(unitCases(text), [pass(LINT, 'a'), fail(CATALOG, 'b', 'm')]);
  assert.deepEqual(unitCases(''), []);
});

test('a unit layer in which everything passes is nobody\'s problem', () => {
  assert.deepEqual(unitOutcome('filter', clean('filter', 'select')), { own: [], foreign: [], absent: [], total: 6 });
  // The catalog lists every category but ref: a ref node waits for no catalog case.
  assert.deepEqual(unitOutcome('ref', clean('ref')).absent, []);
});

test('another category that does not pass its lint, its catalog or its unit tests does not fail this one', () => {
  const cases = [
    ...clean('filter'),
    fail(LINT, lintCase('simulate'), 'file-name: src/core/nodes/simulate/snow.ts does not default-export a NodeDef'),
    fail(CATALOG, catalogCase('simulate'), 'docs/contract/nodes.md:120 lists simulate/snow, which is not registered'),
    fail('tests/nodes/simulate/unit/route.test.ts', 'the router fills a pit'),
    fail('tests/unit/docs.test.ts', 'docs/user/nodes.md is the reference the registry gives', 'line 12 holds "| Filter Radius"'),
    fail('tests/unit/cli/document.test.ts', 'the wiring rule', 'filter/blur is fed a terrain'),
    fail('tests/export/unit/plan.test.ts', 'tests/export/unit/plan.test.ts', 'test failed'),
  ];
  const outcome = unitOutcome('filter', cases);
  assert.deepEqual([outcome.own, outcome.absent, outcome.foreign.map((one) => one.file)], [[], [], [
    LINT, CATALOG, 'tests/nodes/simulate/unit/route.test.ts', 'tests/unit/docs.test.ts', 'tests/unit/cli/document.test.ts', 'tests/export/unit/plan.test.ts',
  ]]);
  // The same layer seen by the owner of the category that fails.
  assert.deepEqual(unitOutcome('simulate', [...cases, pass(LINT, 'placeholder')]).own.map((one) => one.name), [lintCase('simulate'), catalogCase('simulate'), 'the router fills a pit']);
});

test('the category\'s own failures: its lint and catalog cases, its unit tests, and a product-wide lint case that names it', () => {
  const own = [
    fail(LINT, lintCase('filter'), 'help: filter/blur: the help of "radius" does not end with a full stop'),
    fail(CATALOG, catalogCase('filter'), 'docs/contract/nodes.md:74: filter/blur has no parameter "radius"'),
    fail('tests/nodes/filter/unit/kernel.test.ts', 'the taps of a Gaussian sum to one'),
    fail(LINT, 'title-unique: no two nodes of the product have the same title', 'title-unique: filter/soften: the title "Blur" is also that of filter/blur'),
    fail(IMPORTS, 'every import of src/ and tests/ obeys the rules', 'import-node: src/core/nodes/filter/blur.ts imports "../select/_wgsl.ts"'),
    fail(LINT, 'test-location: every test file is in a folder that a layer of testing.md 8.1 runs', 'test-location: tests/nodes/filter/extra/blur.test.ts is matched by no layer'),
  ];
  const foreign = [
    fail(LINT, 'title-unique: no two nodes of the product have the same title', 'title-unique: select/steep: the title "Slope" is also that of select/slope'),
    fail(IMPORTS, 'every import of src/ and tests/ obeys the rules', 'import-src: src/app/panels/prefilter/x.ts imports "electron"'),
  ];
  const outcome = unitOutcome('filter', [...clean('select'), ...own, ...foreign]);
  assert.deepEqual([outcome.own, outcome.foreign, outcome.absent], [own, foreign, []]);
});

test('a lint that did not run for the category has checked nothing: the step waits for it', () => {
  // The lint file failed to load: the runner reports the file as one failed case, and no case of any category.
  const crashed = [fail(LINT, LINT, 'test failed'), pass(CATALOG, catalogCase('filter'))];
  const outcome = unitOutcome('filter', crashed);
  assert.deepEqual([outcome.own, outcome.foreign.map((one) => one.name), outcome.absent], [[], [LINT], ['the registry lint of filter (tests/unit/registry.test.ts)']]);
  assert.deepEqual(unitOutcome('filter', [pass(LINT, lintCase('filter'))]).absent, ['the catalog case of filter (tests/unit/catalog.test.ts)']);
  assert.deepEqual(unitOutcome('filter', []), { own: [], foreign: [], absent: ['the registry lint of filter (tests/unit/registry.test.ts)', 'the catalog case of filter (tests/unit/catalog.test.ts)'], total: 0 });
});
