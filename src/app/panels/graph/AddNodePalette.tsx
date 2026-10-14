// The add-node palette: every node of the product, found by a few letters of its title, by a keyword or by the
// name another tool has for it (the library's own search), narrowed by category, with the description of the
// one that is highlighted. It opens where the pointer is. Opened for a
// wire that was dropped on the canvas it lists only the types the wire can end at.
//
// It has the keyboard while it is open (runtime.md 8.8 rule 3): `data-chrome` tells the shell's key listener so.
// It is drawn over the window, not inside the panel, as a menu is: a graph panel that is lower or narrower than
// the palette would cut it off.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

import type { NodeRegistry } from '../../../core/runtime.ts';
import { SearchField } from '../../ui/index.ts';
import type { ProductCategory } from '../../ui/node-catalog.ts';
import styles from './graph.module.css';
import { CATEGORY_TITLES } from './model.ts';
import { paletteCategories, paletteEntries, palettePlace, searchPalette, type PaletteEntry } from './palette-model.ts';
import type { PaletteRequest } from './state.ts';

export const PALETTE_WIDTH = 480;
export const PALETTE_HEIGHT = 360;
/** Rows a page key moves by. */
const PAGE = 8;

export interface AddNodePaletteProps {
  readonly request: PaletteRequest;
  readonly registry: NodeRegistry;
  /** Where the graph's top-left corner is in the window: `request.at` is counted from it. */
  readonly origin: { readonly left: number; readonly top: number };
  /** What the wire the palette was opened for comes from or goes to, in words; null without a wire. */
  readonly wire: string | null;
  onPick(type: string): void;
  onClose(): void;
}

function ports(entry: PaletteEntry): string {
  const list = (names: readonly string[]): string => (names.length === 0 ? 'none' : names.join(', '));
  return `Inputs: ${list(entry.inputs)}. Outputs: ${list(entry.outputs)}`;
}

export function AddNodePalette(props: AddNodePaletteProps) {
  const { request, registry, origin } = props;
  const [text, setText] = useState('');
  const [category, setCategory] = useState<ProductCategory | null>(null);
  const [selected, setSelected] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const entries = useMemo(() => paletteEntries(registry, request.pending), [registry, request.pending]);
  const categories = useMemo(() => paletteCategories(entries, text), [entries, text]);
  // A category that the text leaves empty is not listed, and not searched either.
  const active = categories.some((item) => item.category === category) ? category : null;
  const rows = useMemo(() => searchPalette(entries, text, active), [entries, text, active]);
  const index = Math.min(selected, Math.max(0, rows.length - 1));
  const highlighted = rows[index]?.entry ?? null;

  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [index, rows]);
  // A press anywhere else closes the palette.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && root.current?.contains(event.target)) return;
      props.onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [props.onClose]);

  function stepCategory(by: number): void {
    const at = categories.findIndex((item) => item.category === active);
    const next = categories[(at + by + categories.length) % categories.length];
    setCategory(next?.category ?? null);
    setSelected(0);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const moves: Readonly<Record<string, number>> = {
      ArrowDown: index + 1, ArrowUp: index - 1, PageDown: index + PAGE, PageUp: index - PAGE,
    };
    if (Object.hasOwn(moves, event.key)) {
      event.preventDefault();
      setSelected(Math.min(rows.length - 1, Math.max(0, moves[event.key]!)));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (highlighted) props.onPick(highlighted.type);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      props.onClose();
    } else if (event.key === 'Tab') {
      // The palette keeps the focus while it is open; Tab goes through its categories.
      event.preventDefault();
      stepCategory(event.shiftKey ? -1 : 1);
    }
    // Nothing typed here is a key of the graph or of the library under it.
    event.stopPropagation();
  }

  // Beside the point it was opened for: right of the end of a wire that comes from the left, left of one from the right.
  const place = palettePlace(
    { x: origin.left + request.at.x, y: origin.top + request.at.y }, { width: window.innerWidth, height: window.innerHeight },
    { width: PALETTE_WIDTH, height: PALETTE_HEIGHT }, request.pending?.to ? 'left' : 'right',
  );

  return createPortal(
    <div
      ref={root}
      className={styles.palette}
      style={{ left: place.left, top: place.top, width: PALETTE_WIDTH, height: PALETTE_HEIGHT }}
      role="dialog"
      aria-label="Add Node"
      data-chrome=""
      data-graph="palette"
      onKeyDown={onKeyDown}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
    >
      <div className={styles.paletteSearch}>
        <SearchField
          ref={input}
          variant="plain"
          role="combobox"
          aria-expanded="true"
          aria-controls="graph-palette-list"
          aria-activedescendant={highlighted ? `graph-palette-item-${index}` : undefined}
          aria-label="Search nodes"
          placeholder="Search nodes by name, keyword or another tool's name"
          value={text}
          onChange={(next) => {
            setText(next);
            setSelected(0);
          }}
          // Escape closes the palette, whatever is typed: the key is the palette's (onKeyDown of the frame), not the field's.
          onKeyDown={(event) => { if (event.key === 'Escape') event.preventDefault(); }}
          end={props.wire ? <span className={styles.paletteWire} data-role="wire" title={props.wire}>{props.wire}</span> : null}
        />
      </div>
      <div className={styles.paletteMain}>
        <ul className={styles.paletteCategories} role="listbox" aria-label="Categories" data-role="categories">
          {categories.map((item) => (
            <li
              key={item.category ?? 'all'}
              className={styles.paletteCategory}
              role="option"
              aria-selected={item.category === active}
              data-category={item.category ?? 'all'}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                setCategory(item.category);
                setSelected(0);
                input.current?.focus();
              }}
            >
              <span className={styles.swatch} data-category={item.category ?? undefined} />
              <span className={styles.paletteCategoryName}>{item.category === null ? 'All' : CATEGORY_TITLES[item.category]}</span>
              <span className={styles.paletteCount}>{item.count}</span>
            </li>
          ))}
        </ul>
        {rows.length === 0 ? (
          <div className={styles.paletteEmpty} data-role="empty">No node matches</div>
        ) : (
          <ul className={styles.paletteList} id="graph-palette-list" role="listbox" aria-label="Nodes" ref={list} data-role="nodes">
            {rows.map((row, at) => (
              <li
                key={row.entry.type}
                id={`graph-palette-item-${at}`}
                className={styles.paletteItem}
                role="option"
                aria-selected={at === index}
                data-type={row.entry.type}
                onPointerMove={() => { if (at !== index) setSelected(at); }}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => props.onPick(row.entry.type)}
              >
                <span className={styles.swatch} data-category={row.entry.category} />
                <span className={styles.paletteItemTitle}>
                  {row.title.map((part, n) => (part.match ? <b key={n}>{part.text}</b> : <span key={n}>{part.text}</span>))}
                </span>
                <span className={styles.paletteItemNote}>{row.matchedKeywords ?? (active === null ? CATEGORY_TITLES[row.entry.category] : '')}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className={styles.paletteDetail} data-role="description">
        {highlighted ? (
          <>
            <div>{highlighted.description}</div>
            <div className={styles.paletteDetailPorts}>{ports(highlighted)}</div>
          </>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
