// The Help reader (runtime.md 8.8 rule 7): a page of the user documentation, drawn in the application from its
// Markdown. A link to another page opens that page here, a link into a page goes to its heading, and a web
// address is handed to the system's browser. Nothing of a page becomes HTML but through the elements made here.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { Button, Dialog } from '../ui/index.ts';
import { linkTarget, parseMarkdown, plainText, type Block, type Inline } from './help/markdown.ts';
import { HELP_PICTURES, HELP_TEXTS } from './help/pages.ts';
import type { Shell } from './shell.ts';

interface Place { readonly page: string; readonly anchor: string | null }

const PAGES = Object.keys(HELP_TEXTS).sort();

/** What a page is called where pages are listed: its first heading. */
function titleOf(page: string, blocks: readonly Block[]): string {
  const heading = blocks.find((block) => block.kind === 'heading');
  return heading?.kind === 'heading' ? plainText(heading.parts) : page;
}

function Parts(props: { readonly parts: readonly Inline[]; readonly go: (href: string) => void }): ReactNode {
  return props.parts.map((part, index) => {
    switch (part.kind) {
      case 'text': return part.text;
      case 'code': return <code key={index}>{part.text}</code>;
      case 'strong': return <strong key={index}><Parts parts={part.parts} go={props.go} /></strong>;
      case 'em': return <em key={index}><Parts parts={part.parts} go={props.go} /></em>;
      case 'anchor': return <span key={index} id={`help-${part.id}`} data-help-anchor={part.id} />;
      case 'image': {
        const src = Object.hasOwn(HELP_PICTURES, part.src) ? HELP_PICTURES[part.src] : undefined;
        return src !== undefined ? <img key={index} className="og-help-picture" src={src} alt={part.alt} /> : <em key={index}>{part.alt}</em>;
      }
      case 'link':
        return (
          <a
            key={index}
            href={part.href}
            data-help-link={part.href}
            onClick={(event) => {
              // The window navigates nowhere (8.2 rule 3): a link is a place in the reader, or an address for the browser.
              event.preventDefault();
              props.go(part.href);
            }}
          >
            <Parts parts={part.parts} go={props.go} />
          </a>
        );
    }
  });
}

function Blocks(props: { readonly blocks: readonly Block[]; readonly go: (href: string) => void }): ReactNode {
  return props.blocks.map((block, index) => {
    switch (block.kind) {
      case 'heading': {
        const Tag = `h${Math.min(6, Math.max(1, block.level))}` as 'h1';
        return <Tag key={index} id={`help-${block.id}`} data-help-anchor={block.id}><Parts parts={block.parts} go={props.go} /></Tag>;
      }
      case 'paragraph': return <p key={index}><Parts parts={block.parts} go={props.go} /></p>;
      case 'code': return <pre key={index} data-language={block.language || undefined}><code>{block.text}</code></pre>;
      case 'rule': return <hr key={index} />;
      case 'quote': return <blockquote key={index}><Blocks blocks={block.blocks} go={props.go} /></blockquote>;
      case 'list': {
        const items = block.items.map((item, at) => <li key={at}><Blocks blocks={item.length === 1 && item[0]!.kind === 'paragraph' ? [] : item} go={props.go} />{item.length === 1 && item[0]!.kind === 'paragraph' ? <Parts parts={item[0]!.parts} go={props.go} /> : null}</li>);
        return block.ordered ? <ol key={index} start={block.start}>{items}</ol> : <ul key={index}>{items}</ul>;
      }
      case 'table':
        return (
          <div key={index} className="og-help-table">
            <table>
              <thead><tr>{block.header.map((cell, at) => <th key={at}><Parts parts={cell} go={props.go} /></th>)}</tr></thead>
              <tbody>
                {block.rows.map((row, r) => <tr key={r}>{block.header.map((_cell, at) => <td key={at}><Parts parts={row[at] ?? []} go={props.go} /></td>)}</tr>)}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

export function HelpDialog(props: { readonly shell: Shell; readonly page: string }) {
  const { shell } = props;
  const [trail, setTrail] = useState<readonly Place[]>([{ page: props.page, anchor: null }]);
  const place = trail[trail.length - 1]!;
  const body = useRef<HTMLDivElement>(null);
  const text = Object.hasOwn(HELP_TEXTS, place.page) ? HELP_TEXTS[place.page]! : null;
  const blocks = useMemo(() => (text === null ? [] : parseMarkdown(text)), [text]);
  const titles = useMemo(() => PAGES.map((page) => ({ page, title: titleOf(page, parseMarkdown(HELP_TEXTS[page]!.slice(0, 2000))) })), []);

  // A new place: its heading at the top of what is shown, or the top of the page.
  useEffect(() => {
    const scroller = body.current?.closest('.og-dialog-body') ?? body.current;
    const target = place.anchor === null ? null : body.current?.querySelector(`[data-help-anchor="${CSS.escape(place.anchor)}"]`);
    if (target) target.scrollIntoView({ block: 'start' });
    else scroller?.scrollTo({ top: 0 });
  }, [place]);

  function go(href: string): void {
    const target = linkTarget(href, place.page, PAGES);
    if (target.kind === 'page') {
      setTrail([...trail, { page: target.page, anchor: target.anchor }]);
    } else if (target.kind === 'web') {
      shell.ctx.platform.openExternal(target.url).then(
        (opened) => { if (!opened) shell.notify({ level: 'warning', message: `The address could not be opened: ${target.url}` }); },
        () => shell.notify({ level: 'warning', message: `The address could not be opened: ${target.url}` }),
      );
    } else {
      shell.notify({ level: 'info', message: `${target.path} is a file of the Orogen repository, not a page of this guide` });
    }
  }

  return (
    <Dialog
      open
      name="help"
      width={920}
      title={titles.find((entry) => entry.page === place.page)?.title ?? place.page}
      onClose={() => shell.closeDialog()}
      actions={
        <>
          <Button className="og-dialog-actions-start" data-action="back" disabled={trail.length < 2} onClick={() => setTrail(trail.slice(0, -1))}>Back</Button>
          <Button variant="primary" data-action="close" onClick={() => shell.closeDialog()}>Close</Button>
        </>
      }
    >
      <div className="og-help" data-ui="help" data-help-page={place.page}>
        <nav className="og-help-pages" aria-label="Pages of the guide" data-help="pages">
          {titles.map((entry) => (
            <a
              key={entry.page}
              href={entry.page}
              data-help-link={entry.page}
              aria-current={entry.page === place.page ? 'page' : undefined}
              onClick={(event) => {
                event.preventDefault();
                if (entry.page !== place.page) setTrail([...trail, { page: entry.page, anchor: null }]);
              }}
            >
              {entry.title}
            </a>
          ))}
        </nav>
        <div className="og-help-text" ref={body} data-help="text">
          {text === null ? <p>The page {place.page} is not part of this build of Orogen.</p> : <Blocks blocks={blocks} go={go} />}
        </div>
      </div>
    </Dialog>
  );
}
