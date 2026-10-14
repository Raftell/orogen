// The Markdown of the user documentation, read into blocks the Help reader draws (runtime.md 8.8 rule 7). The
// pages of docs/user are written in a plain subset, and this reads that subset and nothing more: headings,
// paragraphs, lists (nested by their indentation), tables, fenced code, quotes, rules, and inline code, strong,
// emphasis, links, pictures and the `<a id>` anchors of the generated node reference. Anything else is text as
// it stands. No HTML is ever made from a page: the reader builds elements from these values. Pure: no DOM, no React.

export type Inline =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'strong' | 'em'; readonly parts: readonly Inline[] }
  | { readonly kind: 'link'; readonly href: string; readonly parts: readonly Inline[] }
  | { readonly kind: 'image'; readonly src: string; readonly alt: string }
  | { readonly kind: 'anchor'; readonly id: string };

export type Block =
  | { readonly kind: 'heading'; readonly level: number; readonly id: string; readonly parts: readonly Inline[] }
  | { readonly kind: 'paragraph'; readonly parts: readonly Inline[] }
  | { readonly kind: 'code'; readonly language: string; readonly text: string }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly start: number; readonly items: readonly (readonly Block[])[] }
  | { readonly kind: 'table'; readonly header: readonly (readonly Inline[])[]; readonly rows: readonly (readonly (readonly Inline[])[])[] }
  | { readonly kind: 'quote'; readonly blocks: readonly Block[] }
  | { readonly kind: 'rule' };

// ---- inline ------------------------------------------------------------------------------------------------------------

/** The first mark of each kind is tried where it stands; what matches none is text. */
const INLINE = /`([^`]+)`|!\[([^\]]*)\]\(([^)\s]+)\)|\[((?:[^\[\]]|\[[^\]]*\])*)\]\(([^)\s]+)\)|\*\*((?:[^*]|\*(?!\*))+)\*\*|\*([^*\s](?:[^*]*[^*\s])?)\*|<a id="([^"]+)"><\/a>|\\([\\`*_[\]<>|#])/g;

export function parseInline(text: string): Inline[] {
  const parts: Inline[] = [];
  const say = (plain: string): void => {
    if (plain === '') return;
    const last = parts[parts.length - 1];
    if (last?.kind === 'text') parts[parts.length - 1] = { kind: 'text', text: last.text + plain };
    else parts.push({ kind: 'text', text: plain });
  };
  let at = 0;
  for (const found of text.matchAll(INLINE)) {
    say(text.slice(at, found.index));
    at = found.index + found[0].length;
    if (found[1] !== undefined) parts.push({ kind: 'code', text: found[1] });
    else if (found[3] !== undefined) parts.push({ kind: 'image', alt: found[2] ?? '', src: found[3] });
    else if (found[5] !== undefined) parts.push({ kind: 'link', href: found[5], parts: parseInline(found[4] ?? '') });
    else if (found[6] !== undefined) parts.push({ kind: 'strong', parts: parseInline(found[6]) });
    else if (found[7] !== undefined) parts.push({ kind: 'em', parts: parseInline(found[7]) });
    else if (found[8] !== undefined) parts.push({ kind: 'anchor', id: found[8] });
    else say(found[9] ?? '');
  }
  say(text.slice(at));
  return parts;
}

/** The text of inline parts without their marks: what a heading is called, and what its anchor is made of. */
export function plainText(parts: readonly Inline[]): string {
  return parts.map((part) => (part.kind === 'text' || part.kind === 'code' ? part.text : part.kind === 'image' ? part.alt : part.kind === 'anchor' ? '' : plainText(part.parts))).join('');
}

/** The anchor of a heading as the pages link to it: lower case, punctuation gone, each space a hyphen ("4. Known risks" is `4-known-risks`). */
export function slug(title: string): string {
  return title.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

// ---- blocks ------------------------------------------------------------------------------------------------------------

const FENCE = /^(\s*)(```+|~~~+)\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const ITEM = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** The cells of a table row: split at the bars that are not escaped and not inside code. */
export function tableCells(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let code = false;
  const text = line.trim().replace(/^\|/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '\\' && text[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (c === '`') {
      code = !code;
      cell += c;
    } else if (c === '|' && !code) {
      cells.push(cell.trim());
      cell = '';
    } else cell += c;
  }
  if (cell.trim() !== '') cells.push(cell.trim());
  return cells;
}

/** A page as blocks. `depth` bounds what a list within a list within a quote may nest: a page is not that deep. */
export function parseMarkdown(text: string, depth = 0): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  const ids = new Map<string, number>();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const [, lead = '', mark = '```', language = ''] = fence;
      const body: string[] = [];
      for (i++; i < lines.length && !new RegExp(`^\\s*${mark[0] === '`' ? '`' : '~'}{${mark.length},}\\s*$`).test(lines[i]!); i++) {
        body.push(lines[i]!.startsWith(lead) ? lines[i]!.slice(lead.length) : lines[i]!.trimStart());
      }
      i++;
      blocks.push({ kind: 'code', language, text: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const parts = parseInline(heading[2]!);
      const base = slug(plainText(parts));
      // A second heading of one name is linked to as GitHub links to it: with a number behind.
      const seen = ids.get(base) ?? 0;
      ids.set(base, seen + 1);
      blocks.push({ kind: 'heading', level: heading[1]!.length, id: seen === 0 ? base : `${base}-${seen}`, parts });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      i++;
      continue;
    }
    if (line.trimStart().startsWith('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]!) && lines[i + 1]!.includes('-')) {
      const header = tableCells(line).map(parseInline);
      const rows: Inline[][][] = [];
      for (i += 2; i < lines.length && lines[i]!.trimStart().startsWith('|'); i++) rows.push(tableCells(lines[i]!).map(parseInline));
      blocks.push({ kind: 'table', header, rows });
      continue;
    }
    if (line.trimStart().startsWith('>')) {
      const body: string[] = [];
      for (; i < lines.length && lines[i]!.trimStart().startsWith('>'); i++) body.push(lines[i]!.trimStart().replace(/^>\s?/, ''));
      blocks.push({ kind: 'quote', blocks: depth < 8 ? parseMarkdown(body.join('\n'), depth + 1) : [{ kind: 'paragraph', parts: parseInline(body.join(' ')) }] });
      continue;
    }
    const first = ITEM.exec(line);
    if (first) {
      const indent = first[1]!.length;
      const ordered = first[3] !== undefined;
      const items: Block[][] = [];
      while (i < lines.length) {
        const item = ITEM.exec(lines[i]!);
        if (!item || item[1]!.length !== indent || (item[3] !== undefined) !== ordered) break;
        // What belongs to the item: its first line, and every line after it that is blank or indented under its text.
        const content = lines[i]!.length - item[4]!.length;
        const body: string[] = [item[4]!];
        for (i++; i < lines.length; i++) {
          const next = lines[i]!;
          if (next.trim() === '') {
            // A blank line stays in the item when what follows it is still indented under it.
            const after = lines.slice(i + 1).find((later) => later.trim() !== '');
            if (after === undefined || indentOf(after) <= indent) break;
            body.push('');
          } else if (indentOf(next) > indent) body.push(next.slice(Math.min(content, indentOf(next))));
          else break;
        }
        items.push(depth < 8 ? parseMarkdown(body.join('\n'), depth + 1) : [{ kind: 'paragraph', parts: parseInline(body.join(' ')) }]);
        // Blank lines between the items of one list.
        while (i < lines.length && lines[i]!.trim() === '' && ITEM.exec(lines.slice(i + 1).find((later) => later.trim() !== '') ?? '')?.[1]?.length === indent) i++;
      }
      blocks.push({ kind: 'list', ordered, start: ordered ? Number(first[3]) : 1, items });
      continue;
    }
    // A paragraph: the lines up to a blank one, or to a line that begins another kind of block.
    const body: string[] = [];
    for (; i < lines.length; i++) {
      const next = lines[i]!;
      if (next.trim() === '' || FENCE.test(next) || HEADING.test(next) || RULE.test(next) || next.trimStart().startsWith('>')) break;
      if (body.length > 0 && (ITEM.test(next) || (next.trimStart().startsWith('|') && TABLE_RULE.test(lines[i + 1] ?? '')))) break;
      body.push(next.trim());
    }
    blocks.push({ kind: 'paragraph', parts: parseInline(body.join(' ')) });
  }
  return blocks;
}

// ---- links -------------------------------------------------------------------------------------------------------------

export type LinkTarget =
  /** A page of the documentation, and a heading or an anchor in it. */
  | { readonly kind: 'page'; readonly page: string; readonly anchor: string | null }
  /** A web address: the system's browser shows it. */
  | { readonly kind: 'web'; readonly url: string }
  /** A file that is not a page of the documentation the application carries: said, not opened. */
  | { readonly kind: 'elsewhere'; readonly path: string };

/** Where a link of the page `from` leads. `pages` are the names of the pages there are. */
export function linkTarget(href: string, from: string, pages: readonly string[]): LinkTarget {
  if (/^https?:\/\//i.test(href)) return { kind: 'web', url: href };
  const hash = href.indexOf('#');
  const file = hash < 0 ? href : href.slice(0, hash);
  const anchor = hash < 0 || hash === href.length - 1 ? null : decodeURIComponent(href.slice(hash + 1));
  if (file === '') return { kind: 'page', page: from, anchor };
  if (/^[a-z][a-z0-9+.-]*:/i.test(file) || file.startsWith('/') || file.split('/').includes('..')) return { kind: 'elsewhere', path: file };
  return pages.includes(file) ? { kind: 'page', page: file, anchor } : { kind: 'elsewhere', path: file };
}
