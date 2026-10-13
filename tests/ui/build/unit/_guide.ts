// Reads the import by hand out of docs/user/unreal-import.md: the legend of how far a statement has been
// checked, and sections 1 to 4. ../make-guide.ts writes what this returns into the panel, and guide.test.ts
// compares the two, so that the panel never says of Unreal what the documentation does not. Not a test file.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { GuideItem, GuideSection } from '../../../../src/app/panels/build/model/guide.ts';

export const ROOT = path.resolve(import.meta.dirname, '../../../..');
export const GUIDE_DOCUMENT = 'docs/user/unreal-import.md';
/** The sections of the document that are the import by hand; the others are the example, the test and the plugin. */
const SECTIONS = [1, 2, 3, 4];

export interface GuideText {
  readonly legend: { readonly lead: string; readonly marks: readonly string[]; readonly warning: string };
  readonly sections: readonly GuideSection[];
}

/** The blocks of a run of lines: paragraphs, whose wrapped lines are joined, and list items with what hangs under them. */
function blocks(lines: readonly string[]): { readonly kind: 'paragraph' | 'ordered' | 'bullet'; readonly item: GuideItem }[] {
  const out: { kind: 'paragraph' | 'ordered' | 'bullet'; item: { text: string; bullets: string[]; more: string[] } }[] = [];
  let open: 'text' | 'bullet' | 'more' | null = null;
  for (const line of lines) {
    if (line.trim() === '') {
      open = null;
      continue;
    }
    const last = out[out.length - 1];
    const ordered = /^(\d+)\. (.*)$/.exec(line);
    const bullet = /^- (.*)$/.exec(line);
    const nested = /^ {4}- (.*)$/.exec(line);
    const hanging = /^ {4}(\S.*)$/.exec(line);
    if (ordered) {
      out.push({ kind: 'ordered', item: { text: ordered[2]!, bullets: [], more: [] } });
      open = 'text';
    } else if (bullet) {
      out.push({ kind: 'bullet', item: { text: bullet[1]!, bullets: [], more: [] } });
      open = 'text';
    } else if (nested && last && last.kind !== 'paragraph') {
      last.item.bullets.push(nested[1]!);
      open = 'bullet';
    } else if (hanging && last && last.kind !== 'paragraph') {
      if (open === 'bullet') last.item.bullets[last.item.bullets.length - 1] += ` ${hanging[1]!}`;
      else if (open === 'more') last.item.more[last.item.more.length - 1] += ` ${hanging[1]!}`;
      else if (open === 'text') last.item.text += ` ${hanging[1]!}`;
      else {
        last.item.more.push(hanging[1]!);
        open = 'more';
      }
    } else if (open === 'text' && last && /^\S/.test(line) && last.kind === 'paragraph') {
      last.item.text += ` ${line.trim()}`;
    } else if (open === 'text' && last && /^ {2}\S/.test(line) && last.kind !== 'paragraph') {
      last.item.text += ` ${line.trim()}`;
    } else {
      out.push({ kind: 'paragraph', item: { text: line.trim(), bullets: [], more: [] } });
      open = 'text';
    }
  }
  return out;
}

const plain = (item: GuideItem): GuideItem => ({
  text: item.text,
  ...(item.bullets && item.bullets.length > 0 ? { bullets: [...item.bullets] } : {}),
  ...(item.more && item.more.length > 0 ? { more: [...item.more] } : {}),
});

export function readGuide(): GuideText {
  const lines = readFileSync(path.join(ROOT, GUIDE_DOCUMENT), 'utf8').split('\n');
  const heading = (line: string): { number: number; title: string } | null => {
    const found = /^## (\d+)\. (.*)$/.exec(line);
    return found ? { number: Number(found[1]), title: found[2]! } : null;
  };

  // The legend lies before the first section: a sentence, a mark per bullet, and what nobody has done.
  const first = lines.findIndex((line) => heading(line) !== null);
  const start = lines.findIndex((line) => line.startsWith('Each statement about Unreal says how far it has been checked'));
  if (first < 0 || start < 0 || start > first) throw new Error(`${GUIDE_DOCUMENT} has no legend before its first section`);
  const legend = blocks(lines.slice(start, first));
  const lead = legend[0];
  const warning = legend[legend.length - 1];
  const marks = legend.filter((block) => block.kind === 'bullet').map((block) => block.item.text);
  if (!lead || lead.kind !== 'paragraph' || !warning || warning.kind !== 'paragraph' || marks.length !== 4) {
    throw new Error(`${GUIDE_DOCUMENT}: the legend is a sentence, four marks and a paragraph`);
  }

  const sections: GuideSection[] = [];
  for (const wanted of SECTIONS) {
    const at = lines.findIndex((line) => heading(line)?.number === wanted);
    if (at < 0) throw new Error(`${GUIDE_DOCUMENT} has no section ${wanted}`);
    let end = lines.findIndex((line, i) => i > at && line.startsWith('## '));
    if (end < 0) end = lines.length;
    const body = blocks(lines.slice(at + 1, end));
    const listed = body.filter((block) => block.kind !== 'paragraph');
    const firstItem = body.findIndex((block) => block.kind !== 'paragraph');
    const lastItem = body.length - 1 - [...body].reverse().findIndex((block) => block.kind !== 'paragraph');
    sections.push({
      number: wanted,
      title: heading(lines[at]!)!.title,
      before: (firstItem < 0 ? body : body.slice(0, firstItem)).map((block) => block.item.text),
      list: listed.length === 0 ? null : listed[0]!.kind === 'ordered' ? 'ordered' : 'bullets',
      items: listed.map((block) => plain(block.item)),
      after: firstItem < 0 ? [] : body.slice(lastItem + 1).map((block) => block.item.text),
    });
  }
  return { legend: { lead: lead.item.text, marks, warning: warning.item.text }, sections };
}
