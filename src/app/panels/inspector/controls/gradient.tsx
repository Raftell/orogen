// A gradient parameter (runtime.md 8.7 rule 5): the gradient drawn from bakeGradient, the table kernels read, and
// its stops to drag below it. A press on the strip adds a stop with the gradient's own color there and goes on
// dragging it; a stop dragged well away from the strip is removed. Shift moves a stop finely, Ctrl snaps it to
// twentieths. The selected stop has its color and its position below, beside the palettes and the reversal; a
// double click on a stop, or Enter, opens its color.

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

import type { GradientParam, GradientStop } from '../../../../core/api.ts';
import { Button, ColorSwatch, IconButton, Menu, NumberField, toHex, type MenuItemSpec } from '../../../ui/index.ts';
import {
  addStop, distributeStops, GRADIENT_MAX_STOPS, gradientPixels, moveStop, PALETTES, removeStop, reverseStops, setStopColor, type StopEdit,
} from '../gradient.ts';
import styles from '../inspector.module.css';
import { sameValue } from '../model.ts';
import type { ControlProps } from './types.ts';

/** Pixels of the strip's picture: as many as the table a kernel reads has entries (engine.md 4.9). */
const SAMPLES = 256;
/** How far above or below the bar a dragged stop is let go of. */
const PULL_OUT = 30;
const FINE = 0.1;
const SNAP = 0.05;

interface Drag {
  readonly pointerId: number;
  /** The gradient before the press: what Escape gives back. */
  readonly original: readonly GradientStop[];
  /** The gradient the drag moves a stop of: the original, or the original with the stop the press added. */
  readonly base: readonly GradientStop[];
  readonly index: number;
  /** Where the pointer is taken to be, 0..1 along the strip: it follows the pointer, a tenth as fast with Shift. */
  t: number;
  lastX: number;
  sent: readonly GradientStop[];
  cancelled: boolean;
}

export function GradientControl(props: ControlProps<GradientParam, readonly GradientStop[]>) {
  const stops = props.value;
  const bar = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLCanvasElement>(null);
  const drag = useRef<Drag | null>(null);
  const [selected, setSelected] = useState(0);
  const focusSelected = useRef(false);
  const latest = useRef(props);
  latest.current = props;
  const chosen = Math.min(selected, stops.length - 1);

  useEffect(() => {
    const context = strip.current?.getContext('2d');
    if (context) context.putImageData(new ImageData(gradientPixels(stops, SAMPLES), SAMPLES, 1), 0, 0);
  }, [stops]);

  useEffect(() => {
    if (!focusSelected.current) return;
    focusSelected.current = false;
    bar.current?.querySelector<HTMLElement>(`[data-stop="${chosen}"]`)?.focus();
  });

  // A control that goes away in the middle of a drag does not leave its gesture open.
  useEffect(() => () => {
    if (drag.current && !drag.current.cancelled) latest.current.end(true);
    drag.current = null;
  }, []);

  const send = (next: readonly GradientStop[]): void => {
    if (!sameValue(next, latest.current.value)) latest.current.change(next);
  };
  /** Stores an edit and selects the stop it was made on, wherever the edit left it in the list. */
  const apply = (edit: StopEdit): void => {
    send(edit.stops);
    setSelected(edit.index);
  };

  /** The pointer along the strip, 0..1, and whether it has left the bar far enough to let a stop go. */
  const along = (event: { readonly clientX: number; readonly clientY: number }): { t: number; width: number; outside: boolean } => {
    const rect = strip.current!.getBoundingClientRect();
    const around = bar.current!.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    return { t: (event.clientX - rect.left) / width, width, outside: event.clientY < around.top - PULL_OUT || event.clientY > around.bottom + PULL_OUT };
  };

  function onPointerDown(event: PointerEvent<HTMLDivElement>): void {
    if (props.disabled || event.button !== 0 || drag.current) return;
    const marker = event.target instanceof Element ? event.target.closest('[data-stop]') : null;
    let index = marker ? Number(marker.getAttribute('data-stop')) : -1;
    let base = stops;
    if (!(index >= 0 && index < stops.length)) {
      const made = addStop(stops, along(event).t);
      if (!made) return;
      base = made.stops;
      index = made.index;
    }
    // A press on a stop must not also be the click of a button, which would take the focus by itself.
    event.preventDefault();
    props.begin();
    drag.current = { pointerId: event.pointerId, original: stops, base, index, t: base[index]!.t, lastX: event.clientX, sent: stops, cancelled: false };
    if (base !== stops) {
      drag.current.sent = base;
      send(base);
    }
    setSelected(index);
    focusSelected.current = true;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A pointer the browser does not know (a synthesised event): the moves still arrive at this element.
    }
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>): void {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId || d.cancelled) return;
    const at = along(event);
    d.t += ((event.clientX - d.lastX) / at.width) * (event.shiftKey ? FINE : 1);
    d.lastX = event.clientX;
    const snapped = event.ctrlKey || event.metaKey ? Math.round(d.t / SNAP) * SNAP : d.t;
    const pulled = at.outside && d.base.length > 2;
    const next = pulled ? { stops: removeStop(d.base, d.index), index: Math.max(0, d.index - 1) } : moveStop(d.base, d.index, snapped);
    if (sameValue(next.stops, d.sent)) return;
    d.sent = next.stops;
    apply(next);
    if (!pulled) focusSelected.current = true;
  }

  function finish(event: PointerEvent<HTMLDivElement>, kept: boolean): void {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    drag.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Not captured: see onPointerDown.
    }
    if (d.cancelled) return;
    if (!kept) send(d.original);
    latest.current.end(kept);
  }

  /** The picker of the selected stop: the swatch below the strip is pressed, as by the pointer. */
  const openPicker = (): void => {
    if (!props.disabled) document.getElementById(props.id)?.click();
  };

  function remove(index: number): void {
    const next = removeStop(stops, index);
    if (next === stops) return;
    props.change(next);
    setSelected(Math.max(0, Math.min(index, next.length - 1)));
  }

  function onStopKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    if (props.disabled) return;
    const d = drag.current;
    if (event.key === 'Escape') {
      if (!d || d.cancelled) return;
      event.preventDefault();
      event.stopPropagation();
      d.cancelled = true;
      send(d.original);
      props.end(false);
      return;
    }
    if (d || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      openPicker();
      return;
    }
    const step = event.shiftKey ? 0.1 : event.altKey ? 0.001 : 0.01;
    const dt = event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0;
    if (dt !== 0) {
      event.preventDefault();
      focusSelected.current = true;
      apply(moveStop(stops, index, stops[index]!.t + dt));
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      focusSelected.current = true;
      remove(index);
    }
  }

  const stop = stops[chosen]!;
  const menu: MenuItemSpec[] = [
    { type: 'label', label: 'Palettes' },
    ...PALETTES.map((palette): MenuItemSpec => ({ label: palette.label, id: palette.id, onSelect: () => send(palette.stops) })),
    { type: 'separator' },
    { label: 'Distribute Stops Evenly', id: 'distribute', onSelect: () => send(distributeStops(stops)) },
  ];

  return (
    <div className={styles.gradient} data-control="gradient" data-stops={stops.length}>
      <div
        ref={bar}
        className={styles.gradientBar}
        data-gradient="bar"
        data-disabled={props.disabled ? '' : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => finish(event, true)}
        onPointerCancel={(event) => finish(event, false)}
      >
        <canvas ref={strip} className={styles.gradientStrip} data-gradient="strip" width={SAMPLES} height={1} />
        <div className={styles.gradientStops} role="group" aria-label={`${props.label}: ${stops.length} stops`}>
          {stops.map((s, index) => (
            <button
              key={index}
              type="button"
              className={styles.gradientStop}
              data-stop={index}
              data-selected={index === chosen ? '' : undefined}
              data-color={toHex(s.color)}
              style={{ left: `${Number((s.t * 100).toFixed(3))}%`, background: toHex(s.color) }}
              role="slider"
              disabled={props.disabled}
              aria-label={`Stop ${index + 1} of ${stops.length}`}
              aria-valuemin={0}
              aria-valuemax={1}
              aria-valuenow={s.t}
              onFocus={() => setSelected(index)}
              onKeyDown={(event) => onStopKeyDown(event, index)}
              onDoubleClick={() => {
                setSelected(index);
                openPicker();
              }}
            />
          ))}
        </div>
      </div>
      <div className={styles.editorTools}>
        <div className={styles.stopColor}>
          <ColorSwatch
            id={props.id}
            aria-label={`${props.label} stop color`}
            value={stop.color}
            disabled={props.disabled}
            onChange={(color) => send(setStopColor(stops, chosen, color))}
            onScrubStart={props.begin}
            onScrubEnd={() => props.end(true)}
          />
        </div>
        <NumberField
          className={styles.fill}
          label="Position"
          aria-label={`${props.label} stop position`}
          value={stop.t}
          min={0}
          max={1}
          step={0.01}
          precision={3}
          disabled={props.disabled}
          onChange={(t) => apply(moveStop(stops, chosen, t))}
          onScrubStart={props.begin}
          onScrubEnd={props.end}
        />
        <IconButton
          icon="plus"
          label="Add stop"
          size="small"
          data-action="add-stop"
          disabled={props.disabled || stops.length >= GRADIENT_MAX_STOPS}
          onClick={() => {
            // Half way to the next stop; after the last one, half way back to the one before.
            const next = stops[chosen + 1] ?? stops[chosen - 1] ?? stop;
            const made = addStop(stops, (stop.t + next.t) / 2);
            if (made) apply(made);
          }}
        />
        <IconButton icon="minus" label="Remove stop" size="small" data-action="remove-stop" disabled={props.disabled || stops.length <= 2} onClick={() => remove(chosen)} />
        <Button size="small" disabled={props.disabled} data-action="reverse" onClick={() => { send(reverseStops(stops)); setSelected(stops.length - 1 - chosen); }}>Reverse</Button>
        <Menu trigger={<Button size="small" disabled={props.disabled} data-action="palettes">Palettes</Button>} items={menu} align="end" />
      </div>
    </div>
  );
}
