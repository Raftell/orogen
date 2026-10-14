// The inspector's style sheet against the rules of a panel (runtime.md 8.7 rule 4) and against its own
// components: every color, space and font is a token of the theme, every class a component names exists (a CSS
// module gives `undefined` for one that does not, and nothing says so), and what the panel itself makes
// focusable draws its focus. The sheet and the sources are read as text: nothing here renders.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '../../../..');
const PANEL = path.join(ROOT, 'src/app/panels/inspector');
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), 'utf8');

const SHEET = read('src/app/panels/inspector/inspector.module.css');
/** The sheet without its comments, which may name anything. */
const RULES = SHEET.replace(/\/\*[\s\S]*?\*\//g, '');
const THEME = read('src/app/shell/theme.css');
/** `file` is the repository's path, written with `/` on every platform: what the tests below name a source by. */
const SOURCES = [PANEL, path.join(PANEL, 'controls')]
  .flatMap((folder) => fs.readdirSync(folder).filter((name) => name.endsWith('.tsx')).map((name) => path.join(folder, name)))
  .map((file) => ({ file: path.relative(ROOT, file).split(path.sep).join('/'), text: fs.readFileSync(file, 'utf8') }));

test('every color, space and font of the inspector is a token the theme defines', () => {
  const defined = new Set([...THEME.matchAll(/(--og-[a-z0-9-]+)\s*:/g)].map((found) => found[1]!));
  const used = [...new Set([...RULES.matchAll(/var\((--[a-z0-9-]+)/g)].map((found) => found[1]!))];
  assert.ok(used.length > 20, 'the sheet is read');
  assert.deepEqual(used.filter((token) => !defined.has(token)), [], 'tokens the theme does not define');
  // No color is written out, in the sheet or in a component: a hex code, rgb() or a named color in a declaration.
  assert.deepEqual(RULES.match(/#[0-9a-fA-F]{3,8}\b|\b(rgb|hsl)a?\(/g) ?? [], []);
  const declared = [...RULES.matchAll(/(?:^|[;{\s])(color|background|background-color|border-color|fill|stroke)\s*:\s*([^;}]+)/g)].map((found) => found[2]!.trim());
  assert.ok(declared.length > 30);
  for (const value of declared) assert.match(value, /^(var\(--og-[a-z0-9-]+\)|transparent|none|inherit|currentColor)$/, `"${value}" is no token of the theme`);
  for (const source of SOURCES) {
    assert.doesNotMatch(source.text.replace(/\/\/.*$/gm, ''), /['"`]#[0-9a-fA-F]{3,8}['"`]|\brgba?\(/, `${source.file} writes a color out`);
  }
  // A font is the theme's: its family and its sizes.
  for (const found of RULES.matchAll(/font-(family|size|weight)\s*:\s*([^;}]+)/g)) assert.match(found[2]!.trim(), /^var\(--og-font-[a-z-]+\)$/, `font-${found[1]}: ${found[2]}`);
});

test('every class a component names is in the sheet, and the sheet has none that nothing names', () => {
  const classes = new Set([...RULES.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)].map((found) => found[1]!));
  const named = new Map<string, string>();
  for (const source of SOURCES) {
    for (const found of source.text.matchAll(/\bstyles\.([A-Za-z][A-Za-z0-9_]*)/g)) named.set(found[1]!, source.file);
  }
  assert.ok(named.size > 40, 'the components are read');
  assert.deepEqual([...named].filter(([name]) => !classes.has(name)).map(([name, file]) => `${file}: styles.${name}`), [], 'classes that would be undefined');
  assert.deepEqual([...classes].filter((name) => !named.has(name)), [], 'rules that style nothing');
});

test('what the panel itself makes focusable draws its focus, and the panel answers its own width', () => {
  // The shared controls of src/app/ui/ draw their own. These are the panel's: a section's head, the name of a
  // file, the dial, a point of a curve, a stop of a gradient, and the disclosure of an error's full message.
  for (const selector of ['.sectionHead:focus-visible', '.fileName:focus-visible', '.dial:focus-visible', '.curvePoint:focus-visible', '.gradientStop:focus-visible', '.detail > summary:focus-visible']) {
    const rule = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^{]*\\{([^}]*)\\}`).exec(RULES);
    assert.ok(rule, `${selector} has a rule`);
    assert.match(rule[1]!, /var\(--og-focus-(ring|shadow)\)/, `${selector} draws the theme's focus`);
  }
  // Each of them takes the focus by the keyboard.
  const tabbable = (file: string, mark: RegExp): void => {
    const source = SOURCES.find((candidate) => candidate.file === `src/app/panels/inspector/${file}`);
    assert.ok(source, `${file} is a source of the panel`);
    assert.match(source.text, mark, file);
  };
  tabbable('Dial.tsx', /tabIndex=\{props\.disabled \? -1 : 0\}/);
  tabbable('controls/curve.tsx', /tabIndex=\{props\.disabled \? -1 : 0\}/);
  tabbable('controls/gradient.tsx', /<button[\s\S]*?data-stop=/);
  tabbable('Params.tsx', /<button type="button" className=\{styles\.sectionHead\}/);
  // The rows are laid out for the width of the panel, not of the window (the dock makes it anything).
  assert.match(RULES, /\.root\s*\{[^}]*container:\s*inspector\s*\/\s*inline-size/);
  assert.match(RULES, /@container inspector \(max-width: \d+px\)\s*\{[\s\S]*?\.row\s*\{/);
  assert.match(RULES, /@container inspector \(min-width: \d+px\)\s*\{[\s\S]*?\.vec2\[data-stacked\]/);
});
