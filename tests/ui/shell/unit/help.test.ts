// The Help reader's reading of the user documentation (runtime.md 8.8 rule 7): the Markdown subset the pages
// are written in becomes blocks, and every link of every page of docs/user leads to a page and a heading that
// exist, by the anchors the reader makes. No window: the reader's component only draws these values.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { HELP_PAGES } from '../../../../src/app/shell/app-commands.ts';
import { linkTarget, parseInline, parseMarkdown, plainText, slug, tableCells, type Block, type Inline } from '../../../../src/app/shell/help/markdown.ts';

const DOCS = path.resolve(import.meta.dirname, '../../../../docs/user');
const PAGES = fs.readdirSync(DOCS).filter((name) => name.endsWith('.md')).sort();
const read = (page: string): string => fs.readFileSync(path.join(DOCS, page), 'utf8');

/** Every inline part of a page, its nested ones included. */
function inlines(blocks: readonly Block[]): Inline[] {
  const found: Inline[] = [];
  const take = (parts: readonly Inline[]): void => {
    for (const part of parts) {
      found.push(part);
      if (part.kind === 'strong' || part.kind === 'em' || part.kind === 'link') take(part.parts);
    }
  };
  const walk = (list: readonly Block[]): void => {
    for (const block of list) {
      if (block.kind === 'heading' || block.kind === 'paragraph') take(block.parts);
      else if (block.kind === 'list') block.items.forEach(walk);
      else if (block.kind === 'quote') walk(block.blocks);
      else if (block.kind === 'table') [block.header, ...block.rows].forEach((row) => row.forEach(take));
    }
  };
  walk(blocks);
  return found;
}

/** The places of a page a link can lead to: its headings and its `<a id>` anchors. */
function anchors(blocks: readonly Block[]): Set<string> {
  const ids = new Set<string>();
  const walk = (list: readonly Block[]): void => {
    for (const block of list) {
      if (block.kind === 'heading') ids.add(block.id);
      else if (block.kind === 'list') block.items.forEach(walk);
      else if (block.kind === 'quote') walk(block.blocks);
    }
  };
  walk(blocks);
  for (const part of inlines(blocks)) if (part.kind === 'anchor') ids.add(part.id);
  return ids;
}

test('inline marks: code, strong, emphasis, links, pictures and anchors; anything else is text', () => {
  assert.deepEqual(parseInline('Press **Build**, then `Ctrl+S`.'), [
    { kind: 'text', text: 'Press ' }, { kind: 'strong', parts: [{ kind: 'text', text: 'Build' }] }, { kind: 'text', text: ', then ' }, { kind: 'code', text: 'Ctrl+S' }, { kind: 'text', text: '.' },
  ]);
  assert.deepEqual(parseInline('See [the *import* guide](unreal-import.md#2-the-import-by-hand).'), [
    { kind: 'text', text: 'See ' },
    { kind: 'link', href: 'unreal-import.md#2-the-import-by-hand', parts: [{ kind: 'text', text: 'the ' }, { kind: 'em', parts: [{ kind: 'text', text: 'import' }] }, { kind: 'text', text: ' guide' }] },
    { kind: 'text', text: '.' },
  ]);
  assert.deepEqual(parseInline('![The application](images/application.png)'), [{ kind: 'image', alt: 'The application', src: 'images/application.png' }]);
  assert.deepEqual(parseInline('<a id="generate-canyon"></a>`generate/canyon`'), [{ kind: 'anchor', id: 'generate-canyon' }, { kind: 'code', text: 'generate/canyon' }]);
  // Marks inside code are the code's own; a lone star, a bar and an angle bracket are text; an escape is its character.
  assert.deepEqual(parseInline('`a * b` and 2 * 3 < 7 | x \\| y'), [{ kind: 'code', text: 'a * b' }, { kind: 'text', text: ' and 2 * 3 < 7 | x | y' }]);
  assert.equal(plainText(parseInline('**4.** Known `risks` and [more](x.md)')), '4. Known risks and more');
});

test('blocks: headings with their anchors, paragraphs over several lines, code, rules, quotes, lists within lists, tables', () => {
  const blocks = parseMarkdown([
    '# Title', '', 'First line', 'of one paragraph.', '',
    '## 4. Known risks and workarounds', '', '```', 'orogen build <project.orogen> --out <dir>', '  indented', '```', '',
    '1. Start it:', '   a second line of the item', '', '   - a nested point', '   - another', '2. Next', '', '---', '', '> quoted', '',
    '| Key | Does |', '| --- | --- |', '| `F6` | top view |', '| `a \\| b` | a bar |', '', '## Title',
  ].join('\n'));
  assert.deepEqual(blocks.map((block) => block.kind), ['heading', 'paragraph', 'heading', 'code', 'list', 'rule', 'quote', 'table', 'heading']);
  const [title, paragraph, risks, code, list, , quote, table, again] = blocks as [Block, Block, Block, Block, Block, Block, Block, Block, Block];
  assert.deepEqual([title.kind === 'heading' && title.level, title.kind === 'heading' && title.id], [1, 'title']);
  assert.equal(paragraph.kind === 'paragraph' && plainText(paragraph.parts), 'First line of one paragraph.');
  assert.equal(risks.kind === 'heading' && risks.id, '4-known-risks-and-workarounds', 'the anchor the pages link to');
  assert.deepEqual(code.kind === 'code' && code.text, 'orogen build <project.orogen> --out <dir>\n  indented', 'code is kept as it stands: angle brackets are no markup');
  assert.ok(list.kind === 'list' && list.ordered && list.start === 1 && list.items.length === 2);
  if (list.kind === 'list') {
    assert.deepEqual(list.items[0]!.map((block) => block.kind), ['paragraph', 'list']);
    const nested = list.items[0]![1]!;
    assert.ok(nested.kind === 'list' && !nested.ordered && nested.items.length === 2);
    assert.equal(list.items[0]![0]!.kind === 'paragraph' && plainText((list.items[0]![0] as Extract<Block, { kind: 'paragraph' }>).parts), 'Start it: a second line of the item');
  }
  assert.ok(quote.kind === 'quote' && quote.blocks[0]!.kind === 'paragraph');
  assert.ok(table.kind === 'table' && table.header.length === 2 && table.rows.length === 2);
  if (table.kind === 'table') assert.deepEqual(table.rows[1]![0], [{ kind: 'code', text: 'a | b' }]);
  assert.equal(again.kind === 'heading' && again.id, 'title-1', 'a second heading of one name has a number behind');
  assert.deepEqual(tableCells('| a | `x|y` | c \\| d |'), ['a', '`x|y`', 'c | d']);
  assert.equal(slug('Units: the unit box'), 'units-the-unit-box');
  assert.deepEqual(parseMarkdown(''), []);
});

test('where a link leads: another page, a place in a page, the web, or a file that is no page of the guide', () => {
  assert.deepEqual(linkTarget('building.md', 'README.md', PAGES), { kind: 'page', page: 'building.md', anchor: null });
  assert.deepEqual(linkTarget('unreal-import.md#4-known-risks-and-workarounds', 'building.md', PAGES), { kind: 'page', page: 'unreal-import.md', anchor: '4-known-risks-and-workarounds' });
  assert.deepEqual(linkTarget('#io', 'nodes.md', PAGES), { kind: 'page', page: 'nodes.md', anchor: 'io' });
  assert.deepEqual(linkTarget('https://www.unrealengine.com/', 'README.md', PAGES), { kind: 'web', url: 'https://www.unrealengine.com/' });
  for (const href of ['../../unreal/OrogenBridge/README.md', 'missing.md', '/etc/passwd', 'file:///etc/passwd', 'javascript:alert(1)']) {
    assert.equal(linkTarget(href, 'README.md', PAGES).kind, 'elsewhere', href);
  }
});

test('every page of docs/user is read, and every link in it leads to a page and a place that exist', () => {
  assert.ok(PAGES.length >= 9, PAGES.join(', '));
  for (const page of HELP_PAGES) assert.ok(PAGES.includes(page.document), `the Help menu's ${page.document} is a page`);
  const parsed = new Map(PAGES.map((page) => [page, parseMarkdown(read(page))]));
  const places = new Map([...parsed].map(([page, blocks]) => [page, anchors(blocks)]));
  const broken: string[] = [];
  let links = 0;
  for (const [page, blocks] of parsed) {
    assert.ok(blocks[0]?.kind === 'heading' && blocks[0].level === 1, `${page} begins with its title`);
    for (const part of inlines(blocks)) {
      if (part.kind === 'image') {
        if (!fs.existsSync(path.join(DOCS, part.src))) broken.push(`${page}: the picture ${part.src} is missing`);
        continue;
      }
      if (part.kind !== 'link') continue;
      links++;
      const target = linkTarget(part.href, page, PAGES);
      if (target.kind === 'elsewhere' && !fs.existsSync(path.resolve(DOCS, target.path.split('#')[0]!))) broken.push(`${page}: ${part.href} names no file`);
      if (target.kind === 'page' && target.anchor !== null && !places.get(target.page)!.has(target.anchor)) broken.push(`${page}: ${part.href} names no heading of ${target.page}`);
    }
  }
  assert.ok(links > 100, `the pages link to each other: ${links} links`);
  assert.deepEqual(broken, []);
  // The node reference: a table per node, read as tables, with the anchors its contents list links to.
  const nodes = parsed.get('nodes.md')!;
  assert.ok(nodes.filter((block) => block.kind === 'table').length > 150);
  assert.ok(places.get('nodes.md')!.has('simulate-hydraulic-erosion'));
});
