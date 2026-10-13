// The import guide the panel opens says of Unreal exactly what the user documentation says, with every mark of
// how far a statement has been checked: the text in the panel is that of docs/user/unreal-import.md, sections 1
// to 4, and this test fails when the two differ. `tools/guard node tests/ui/build/make-guide.ts` writes it anew.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GUIDE_DOCUMENT, GUIDE_LEGEND, GUIDE_SECTIONS } from '../../../../src/app/panels/build/model/guide-text.ts';
import { inlineParts, STEP_GROUPS, STEPS_SECTION } from '../../../../src/app/panels/build/model/guide.ts';
import { importGroups, parseManifest } from '../../../../src/app/panels/build/model/manifest.ts';
import { read } from './_docs.ts';
import { GUIDE_DOCUMENT as SOURCE, readGuide } from './_guide.ts';

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

test('the guide in the panel is the text of the user documentation, word for word', () => {
  assert.equal(GUIDE_DOCUMENT, SOURCE);
  const document = readGuide();
  assert.ok(same(GUIDE_LEGEND, document.legend), 'the legend differs: run tools/guard node tests/ui/build/make-guide.ts');
  assert.equal(GUIDE_SECTIONS.length, document.sections.length);
  for (const [i, section] of document.sections.entries()) {
    assert.ok(same(GUIDE_SECTIONS[i], section), `section ${section.number} differs: run tools/guard node tests/ui/build/make-guide.ts`);
  }
});

test('the guide holds the whole import by hand: every line of sections 1 to 4 of the document is in it', () => {
  const text = read(SOURCE);
  const from = text.indexOf('## 1. Before you start');
  const to = text.indexOf('## 5. ');
  assert.ok(from > 0 && to > from);
  const said = [
    ...GUIDE_SECTIONS.flatMap((section) => [...section.before, ...section.items.flatMap((item) => [item.text, ...(item.bullets ?? []), ...(item.more ?? [])]), ...section.after]),
  ].join('\n');
  // Every word of the document's four sections, in order, whatever the line breaks and list marks.
  const words = (source: string): string[] => source.replace(/^## \d+\. .*$/gm, ' ').replace(/^\s*(?:\d+\.|-) /gm, ' ').split(/\s+/).filter((word) => word !== '');
  assert.deepEqual(words(said).join(' ') === words(text.slice(from, to)).join(' '), true, 'the panel\'s text and the document\'s differ');
  assert.deepEqual(GUIDE_SECTIONS.map((section) => [section.number, section.title, section.list, section.items.length]), [
    [1, 'Before you start', 'ordered', 5], [2, 'Steps', 'ordered', 17], [3, 'Importing a rebuilt terrain', 'bullets', 2], [4, 'Known risks and workarounds', 'ordered', 7],
  ]);
});

test('nothing in the guide claims more than the documentation: the marks and the warning are there', () => {
  assert.match(GUIDE_LEGEND.warning, /^Nobody at Orogen has run this procedure in Unreal Engine\./);
  assert.deepEqual(GUIDE_LEGEND.marks.map((mark) => /^\*\*([a-z ]+)\*\*/.exec(mark)![1]), ['confirmed', 'third party', 'derived', 'unconfirmed']);
  const steps = GUIDE_SECTIONS.find((section) => section.number === STEPS_SECTION)!;
  // The statements the import depends on carry their mark in the step itself.
  assert.match(steps.items[7]!.text, /^Location: .*which is unconfirmed; step 13 checks it/);
  assert.match(steps.items[6]!.text, /^Scale: .*\(derived\)\.$/);
  assert.match(steps.items[13]!.text, /unconfirmed; the acceptance test checks it/);
});

test('the values of a build stand under the steps that ask for them', () => {
  const steps = GUIDE_SECTIONS.find((section) => section.number === STEPS_SECTION)!;
  const contract = read('docs/contract/export-unreal.md');
  const open = contract.indexOf('```json', contract.indexOf('### 6.2 Example'));
  const manifest = parseManifest(contract.slice(open + 7, contract.indexOf('```', open + 7)));
  assert.ok(manifest.ok);
  const groups = importGroups(manifest.value, null);
  // Every group belongs to exactly one step, and every step named exists and speaks of what its group holds.
  const placed = Object.values(STEP_GROUPS).flat();
  assert.deepEqual([...placed].sort(), groups.map((group) => group.id).sort());
  const about: Readonly<Record<string, RegExp>> = {
    heightmap: /^Heightmap File/, layout: /Section Size/, scale: /^Scale:/, location: /^Location:/, layers: /^Layers\./, partition: /^World Partition/,
    check: /^Select the Landscape actor/, textures: /^Textures:/,
  };
  for (const [step, ids] of Object.entries(STEP_GROUPS)) {
    const item = steps.items[Number(step) - 1];
    assert.ok(item, `step ${step} exists`);
    for (const id of ids) assert.match(item.text, about[id]!, `step ${step} is where ${id} belongs`);
    // The group itself names the step it stands under.
    for (const id of ids) assert.ok(groups.find((group) => group.id === id)!.step.split(' ')[0] === step, `${id} names step ${step}`);
  }
});

test('the inline marks of the text: code and strong, and nothing else is touched', () => {
  assert.deepEqual(inlineParts('Scale: type `landscape.transform.scaleCm` x, y and z (derived).'), [
    { kind: 'text', text: 'Scale: type ' }, { kind: 'code', text: 'landscape.transform.scaleCm' }, { kind: 'text', text: ' x, y and z (derived).' },
  ]);
  assert.deepEqual(inlineParts('**Stale image size.** The editor caches `a` and `b`'), [
    { kind: 'strong', text: 'Stale image size.' }, { kind: 'text', text: ' The editor caches ' }, { kind: 'code', text: 'a' }, { kind: 'text', text: ' and ' }, { kind: 'code', text: 'b' },
  ]);
  assert.deepEqual(inlineParts('U = (WorldX − x) / extent * 2'), [{ kind: 'text', text: 'U = (WorldX − x) / extent * 2' }]);
  assert.deepEqual(inlineParts(''), []);
  // Every part of the guide's own text comes back whole.
  for (const section of GUIDE_SECTIONS) {
    for (const item of section.items) assert.equal(inlineParts(item.text).map((part) => part.text).join(''), item.text.replace(/`|\*\*/g, ''));
  }
});
