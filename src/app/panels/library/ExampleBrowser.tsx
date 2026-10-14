// The example projects: a picture, a title, what the project shows, and what it holds. One opens as a new
// project without a file by its button, a double-click or Enter. The same list is the Examples tab of the panel
// and the content of the dialog of "Open Example…".

import { useEffect, useRef, type KeyboardEvent } from 'react';
import { useStore } from 'zustand';

import { Button, EmptyState, useCommandContext } from '../../ui/index.ts';
import type { NodeRegistry } from '../../../core/runtime.ts';
import { requestExample } from './actions.ts';
import { EXAMPLES } from './example-files.ts';
import { exampleDoc, gridMove, summarize, summaryText, type GridMove } from './examples.ts';
import styles from './library.module.css';
import { libraryStore } from './state.ts';

const MOVES: Readonly<Record<string, GridMove>> = {
  ArrowDown: 'down', ArrowRight: 'right', ArrowUp: 'up', ArrowLeft: 'left', Home: 'first', End: 'last', PageDown: 'last', PageUp: 'first',
};

const select = (id: string | null): void => {
  if (libraryStore.getState().example !== id) libraryStore.setState({ example: id });
};

/** What each project holds, read once for a registry; null for a file that is no project, which its card says. */
const SUMMARIES = new WeakMap<NodeRegistry, ReadonlyMap<string, string | null>>();
function summariesOf(registry: NodeRegistry): ReadonlyMap<string, string | null> {
  let held = SUMMARIES.get(registry);
  if (!held) {
    held = new Map(EXAMPLES.map((example) => {
      try {
        return [example.id, summaryText(summarize(exampleDoc(example.text, registry).doc))] as const;
      } catch {
        return [example.id, null] as const;
      }
    }));
    SUMMARIES.set(registry, held);
  }
  return held;
}

/** How many cards the first row of the grid holds, read from where the cards are. */
function columnsOf(grid: Element | null | undefined): number {
  const cards = grid ? [...grid.children] : [];
  if (cards.length === 0) return 1;
  const top = cards[0]!.getBoundingClientRect().top;
  let columns = 0;
  for (const card of cards) {
    if (Math.abs(card.getBoundingClientRect().top - top) > 1) break;
    columns++;
  }
  return Math.max(1, columns);
}

export function ExampleBrowser(props: { readonly place: 'panel' | 'dialog' }) {
  const ctx = useCommandContext();
  const { registry } = ctx;
  const selected = useStore(libraryStore, (state) => state.example);
  const list = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const summaries = summariesOf(registry);

  useEffect(() => {
    if (selected === null) return;
    list.current?.querySelector(`[data-example="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  function onKey(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.altKey || event.ctrlKey || event.metaKey || event.target !== event.currentTarget) return;
    const move = MOVES[event.key];
    if (move) {
      const at = gridMove(EXAMPLES.length, columnsOf(grid.current), EXAMPLES.findIndex((example) => example.id === selected), move);
      select(EXAMPLES[at]?.id ?? null);
      event.preventDefault();
    } else if (event.key === 'Enter' && selected !== null) {
      void requestExample(ctx, selected);
      event.preventDefault();
    }
  }

  if (EXAMPLES.length === 0) return <EmptyState title="No Examples">This build of Orogen holds no example project</EmptyState>;

  return (
    <div
      ref={list}
      className={props.place === 'dialog' ? `${styles.examples} ${styles.dialogExamples}` : styles.examples}
      role="listbox"
      tabIndex={0}
      aria-label="Example projects"
      aria-activedescendant={selected === null ? undefined : `library-example-${props.place}-${selected}`}
      data-library="examples"
      data-place={props.place}
      onKeyDown={onKey}
    >
      {props.place === 'panel' ? (
        <p className={styles.examplesIntro}>Complete projects to learn from and to start from. Each opens as a new project: nothing is saved until you save it.</p>
      ) : null}
      <div ref={grid} className={styles.exampleGrid}>
        {EXAMPLES.map((example) => {
          const summary = summaries.get(example.id) ?? null;
          return (
            <div
              key={example.id}
              id={`library-example-${props.place}-${example.id}`}
              className={styles.example}
              role="option"
              aria-selected={example.id === selected}
              data-example={example.id}
              onClick={() => select(example.id)}
              onDoubleClick={() => { void requestExample(ctx, example.id); }}
            >
              {example.picture !== null
                ? <img className={styles.examplePicture} src={example.picture} alt="" draggable={false} />
                : <div className={styles.examplePicture} />}
              <div className={styles.exampleBody}>
                <h3 className={styles.exampleTitle}>{example.title}</h3>
                <p className={styles.exampleText}>{example.description}</p>
                <div className={styles.exampleFoot}>
                  <span className={styles.exampleSummary}>{summary ?? 'This file is not a project'}</span>
                  <Button
                    size="small"
                    variant={example.id === selected ? 'primary' : 'default'}
                    data-action="open"
                    disabled={summary === null}
                    onClick={(event) => {
                      event.stopPropagation();
                      select(example.id);
                      ctx.run('library.openExample');
                    }}
                  >
                    Open
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
