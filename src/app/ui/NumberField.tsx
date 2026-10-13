// The number field: the control of every numeric parameter. Dragging across it changes the value (the pointer is
// locked, so the drag has no end of the screen); Shift slows the drag to a tenth and Ctrl snaps it to steps; a
// drag stays within the soft range. A click, Enter or F2 turns the field into a text entry that takes arithmetic,
// units ("500m") and changes of the current value ("+=5"), up to the hard limits. number.ts holds the arithmetic.

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

import './controls.css';
import {
  clampValue, editText, fillFraction, formatNumber, parseEntry, precisionOf, scrubMove, scrubStart, scrubValue, stepValue,
  type NumberRange, type NumberUnits,
} from './number.ts';

export interface NumberFieldProps extends NumberRange {
  readonly value: number;
  /** Every new value: each step of a drag, a committed entry, an arrow key. Always within the hard limits. */
  onChange(value: number): void;
  /** A drag began: where a caller begins a gesture (runtime.md 8.5 rule 4). */
  onScrubStart?(): void;
  /** The drag ended. `kept` is false when Escape took it back: `onChange` has then given the value it began with. */
  onScrubEnd?(kept: boolean): void;
  /** Drawn inside the field, at its left. */
  readonly label?: string;
  /** Drawn after the value: '°', ' %', ' px'. */
  readonly unit?: string;
  /** The unit suffixes a typed entry may carry (number.ts). */
  readonly units?: NumberUnits;
  /** Drawn dim after the value: the metric equivalent of a length or a height. */
  readonly secondary?: string;
  /** Decimals shown; default from the step and the range. */
  readonly precision?: number;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly className?: string;
  readonly 'aria-label'?: string;
  readonly 'aria-labelledby'?: string;
}

/** Pixels the pointer moves before a press is a drag and no longer a click. */
const DRAG_THRESHOLD = 3;

interface Drag {
  readonly pointerId: number;
  readonly startX: number;
  readonly startValue: number;
  lastX: number;
  position: number;
  lastValue: number;
  /** The threshold was passed: this is a drag. */
  active: boolean;
  /** The pointer lock was granted, so its loss means Escape. */
  locked: boolean;
  /** Escape took the drag back; the rest of the press does nothing. */
  cancelled: boolean;
}

export function NumberField(props: NumberFieldProps) {
  const { value, disabled } = props;
  const range: NumberRange = {
    min: props.min, max: props.max, softMin: props.softMin, softMax: props.softMax, step: props.step, scale: props.scale, integer: props.integer,
  };
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  /** The text being edited; null: the field shows the value. */
  const [entry, setEntry] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  /** Whether the entry that opens selects the whole text (a click) or goes on after what was typed (a digit). */
  const selectAll = useRef(true);
  // What the listeners below read is that of the last render.
  const latest = useRef({ props, range, entry });
  latest.current = { props, range, entry };

  const change = (next: number): void => {
    if (Number.isFinite(next) && next !== latest.current.props.value) latest.current.props.onChange(next);
  };

  function endDrag(kept: boolean): void {
    const d = drag.current;
    if (!d || d.cancelled) return;
    const element = root.current;
    if (element && document.pointerLockElement === element) document.exitPointerLock();
    if (!d.active) return;
    setScrubbing(false);
    if (!kept) {
      d.cancelled = true;
      if (d.lastValue !== d.startValue) latest.current.props.onChange(d.startValue);
    }
    latest.current.props.onScrubEnd?.(kept);
  }

  useEffect(() => {
    const element = root.current;
    if (!element) return undefined;
    // Chromium ends a pointer lock on Escape and gives the page no key event: the loss of a lock that was
    // granted, while the button is still down, is that Escape.
    const onLockChange = (): void => {
      const d = drag.current;
      if (!d || !d.active || d.cancelled) return;
      if (document.pointerLockElement === element) d.locked = true;
      else if (d.locked) endDrag(false);
    };
    // React's own wheel listener is passive and cannot keep the panel from scrolling.
    const onWheel = (event: WheelEvent): void => {
      const now = latest.current;
      if (!event.ctrlKey || now.props.disabled || now.entry !== null || event.deltaY === 0) return;
      event.preventDefault();
      change(stepValue(now.props.value, event.deltaY < 0 ? 1 : -1, now.range, { coarse: event.shiftKey, fine: event.altKey }));
    };
    document.addEventListener('pointerlockchange', onLockChange);
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      document.removeEventListener('pointerlockchange', onLockChange);
      element.removeEventListener('wheel', onWheel);
      // A field that goes away in the middle of a drag ends it: the caller's gesture is not left open.
      endDrag(true);
      drag.current = null;
    };
    // Attached once: the listeners read `latest`.
  }, []);

  function openEntry(text: string, select: boolean): void {
    selectAll.current = select;
    setInvalid(false);
    setEntry(text);
  }

  /** True when the text was an entry: the value is then set and the entry closed. */
  function commit(text: string): boolean {
    const parsed = parseEntry(text, { current: value, units: props.units });
    if (parsed === null) return false;
    closeEntry();
    change(clampValue(parsed, range));
    return true;
  }

  function closeEntry(): void {
    // The input loses the focus as it goes; its blur must find the entry closed already and commit nothing more.
    latest.current = { ...latest.current, entry: null };
    setEntry(null);
    setInvalid(false);
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>): void {
    if (disabled || entry !== null || event.button !== 0 || drag.current) return;
    event.currentTarget.focus();
    drag.current = {
      pointerId: event.pointerId, startX: event.clientX, startValue: value, lastX: event.clientX,
      position: scrubStart(value, range), lastValue: value, active: false, locked: false, cancelled: false,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A pointer the browser does not know (a synthesised event): the moves still arrive at this element.
    }
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>): void {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId || d.cancelled) return;
    const element = event.currentTarget;
    const locked = document.pointerLockElement === element;
    let dx = locked ? event.movementX : event.clientX - d.lastX;
    d.lastX = event.clientX;
    if (!d.active) {
      const travelled = event.clientX - d.startX;
      if (Math.abs(travelled) <= DRAG_THRESHOLD) return;
      d.active = true;
      dx = travelled;
      setScrubbing(true);
      props.onScrubStart?.();
      try {
        // Not every browser returns a promise here, and a window that may not lock the pointer rejects it: the
        // drag then follows the pointer as far as the screen goes.
        const asked = element.requestPointerLock() as Promise<void> | undefined;
        asked?.catch?.(() => undefined);
      } catch {
        // The same, said synchronously.
      }
    }
    d.position = scrubMove(d.position, dx, range, { trackWidth: element.clientWidth, fine: event.shiftKey });
    const next = scrubValue(d.position, range, { snap: event.ctrlKey || event.metaKey });
    if (next !== d.lastValue && Number.isFinite(next)) {
      d.lastValue = next;
      props.onChange(next);
    }
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>): void {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    endDrag(true);
    drag.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Not captured: see onPointerDown.
    }
    if (!d.active && !d.cancelled) openEntry(editText(value, range), true);
  }

  function onPointerCancel(event: PointerEvent<HTMLDivElement>): void {
    if (drag.current?.pointerId !== event.pointerId) return;
    endDrag(false);
    drag.current = null;
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (disabled || entry !== null) return;
    if (drag.current?.active) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        endDrag(false);
      }
      return;
    }
    if (event.ctrlKey || event.metaKey) return;
    const direction = event.key === 'ArrowUp' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowDown' || event.key === 'ArrowLeft' ? -1 : 0;
    if (direction !== 0) {
      event.preventDefault();
      change(stepValue(value, direction, range, { coarse: event.shiftKey, fine: event.altKey }));
    } else if (event.key === 'Enter' || event.key === 'F2') {
      event.preventDefault();
      event.stopPropagation();
      openEntry(editText(value, range), true);
    } else if (!event.altKey && /^[0-9.+\-=*/(]$/.test(event.key)) {
      // Typing over the field begins an entry with what was typed.
      event.preventDefault();
      openEntry(event.key, false);
    }
  }

  function onEntryKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      if (commit(event.currentTarget.value)) root.current?.focus();
      else setInvalid(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeEntry();
      root.current?.focus();
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const parsed = parseEntry(event.currentTarget.value, { current: value, units: props.units });
      if (parsed === null) return;
      event.preventDefault();
      const next = stepValue(clampValue(parsed, range), event.key === 'ArrowUp' ? 1 : -1, range, { coarse: event.shiftKey, fine: event.altKey });
      setEntry(editText(next, range));
      setInvalid(false);
      change(next);
    }
  }

  const precision = props.precision ?? precisionOf(range);
  const text = formatNumber(value, precision);
  const fill = fillFraction(value, range);
  const className = props.className ? `og-number ${props.className}` : 'og-number';

  return (
    <div
      ref={root}
      id={props.id}
      className={className}
      data-ui="number-field"
      data-value={Number.isFinite(value) ? value : undefined}
      data-editing={entry !== null ? '' : undefined}
      data-scrubbing={scrubbing ? '' : undefined}
      data-disabled={disabled ? '' : undefined}
      data-invalid={invalid ? '' : undefined}
      role="spinbutton"
      tabIndex={disabled || entry !== null ? -1 : 0}
      aria-label={props['aria-label'] ?? props.label}
      aria-labelledby={props['aria-labelledby']}
      aria-valuenow={Number.isFinite(value) ? value : undefined}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      aria-valuetext={`${text}${props.unit ?? ''}`}
      aria-disabled={disabled || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onKeyDown={onKeyDown}
    >
      {entry === null ? (
        <>
          {fill === null ? null : <div className="og-number-fill" style={{ width: `${fill * 100}%` }} />}
          {props.label ? <span className="og-number-label">{props.label}</span> : null}
          <span className="og-number-value">{text}{props.unit ? <span className="og-number-unit">{props.unit}</span> : null}</span>
          {props.secondary ? <span className="og-number-secondary">{props.secondary}</span> : null}
        </>
      ) : (
        <input
          className="og-number-input"
          type="text"
          inputMode="decimal"
          spellCheck={false}
          autoComplete="off"
          aria-label={props['aria-label'] ?? props.label}
          aria-invalid={invalid || undefined}
          value={entry}
          ref={(input) => {
            if (!input || input.dataset.opened) return;
            input.dataset.opened = 'true';
            input.focus();
            if (selectAll.current) input.select();
            else input.setSelectionRange(input.value.length, input.value.length);
          }}
          onChange={(event) => {
            setEntry(event.target.value);
            setInvalid(false);
          }}
          onKeyDown={onEntryKeyDown}
          onBlur={(event) => {
            // Leaving the field commits what it holds; a text that is no entry is dropped.
            if (latest.current.entry === null) return;
            if (!commit(event.target.value)) closeEntry();
          }}
        />
      )}
    </div>
  );
}
