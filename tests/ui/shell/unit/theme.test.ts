// The theme (runtime.md 8.7 rule 4, testing.md 6.7): theme.css defines the tokens, the category colours among
// them, and every other style sheet of the application takes its colours from them. Read as text: a test of this
// folder imports no CSS.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const APP = path.resolve(import.meta.dirname, '../../../../src/app');
const THEME = path.join(APP, 'shell/theme.css');

function styleSheets(folder: string): string[] {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) return styleSheets(file);
    return entry.name.endsWith('.css') ? [file] : [];
  });
}

const withoutComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '');
const theme = withoutComments(fs.readFileSync(THEME, 'utf8'));
const defined = new Map([...theme.matchAll(/(--og-[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1]!, match[2]!.trim()]));
const others = styleSheets(APP).filter((file) => file !== THEME);
const name = (file: string): string => path.relative(APP, file);

test('theme.css defines every token once, on :root', () => {
  const names = [...theme.matchAll(/(--og-[a-z0-9-]+)\s*:/g)].map((match) => match[1]!);
  assert.ok(names.length > 60, `${names.length} tokens`);
  const twice = names.filter((token, index) => names.indexOf(token) !== index);
  assert.deepEqual(twice, []);
  assert.equal([...theme.matchAll(/^[^\s@}][^{]*\{/gm)].map((match) => match[0].replace(/\s*\{$/, '')).join(), ':root');
});

test('the category colours are those of testing.md 6.7', () => {
  const table: Readonly<Record<string, string>> = {
    generate: '#79461d', adjust: '#246283', filter: '#412b51', simulate: '#2b652b', select: '#3c3c83', color: '#6e6e23', surface: '#1d725e', io: '#82354c',
    ref: '#374725',
  };
  for (const [category, color] of Object.entries(table)) assert.equal(defined.get(`--og-category-${category}`), color, category);
  assert.equal(defined.get('--og-category-text'), '#e6e6e6', 'they are header colours for text of this colour');
  assert.equal([...defined.keys()].filter((token) => token.startsWith('--og-category-')).length, Object.keys(table).length + 1);
});

test('the interface font is 12 to 13 px and the greys have no hue', () => {
  assert.equal(defined.get('--og-font-size'), '12px');
  assert.equal(defined.get('--og-font-size-large'), '13px');
  for (const [token, value] of defined) {
    if (!/^--og-(bg|border|text)-/.test(token) || !/^#[0-9a-f]{6}$/i.test(value)) continue;
    const [r, g, b] = [value.slice(1, 3), value.slice(3, 5), value.slice(5, 7)];
    assert.ok(r === g && g === b, `${token} is ${value}: a surface, a line and a text are grey`);
  }
});

test('every token a style sheet uses is one theme.css defines', () => {
  assert.ok(others.length >= 3, 'the shell, the controls and a panel have style sheets');
  for (const file of others) {
    const used = new Set([...withoutComments(fs.readFileSync(file, 'utf8')).matchAll(/var\(\s*(--og-[a-z0-9-]+)/g)].map((match) => match[1]!));
    // A token a rule sets for its own descendants, like the width of one dialog, is defined where it is set.
    const local = new Set([...withoutComments(fs.readFileSync(file, 'utf8')).matchAll(/(--og-[a-z0-9-]+)\s*:/g)].map((match) => match[1]!));
    const unknown = [...used].filter((token) => !defined.has(token) && !local.has(token) && token !== '--og-dialog-width');
    assert.deepEqual(unknown, [], `${name(file)} uses tokens theme.css does not define`);
  }
  for (const [token, value] of defined) {
    for (const match of value.matchAll(/var\(\s*(--og-[a-z0-9-]+)/g)) assert.ok(defined.has(match[1]!), `${token} refers to ${match[1]}`);
  }
});

test('no style sheet beside theme.css names a colour of its own', () => {
  for (const file of others) {
    const text = withoutComments(fs.readFileSync(file, 'utf8'));
    const literals = [...text.matchAll(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\(/gi)].map((match) => match[0]);
    assert.deepEqual(literals, [], `${name(file)}: colours come from the tokens of shell/theme.css (runtime.md 8.7 rule 4)`);
  }
});
