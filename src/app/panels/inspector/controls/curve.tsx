// A curve parameter (runtime.md 8.7 rule 5): the curve drawn with evalCurve, so that the picture is what kernels
// get, and its points to drag. A press on the plot adds a point and goes on dragging it; a point dragged well
// outside the plot is removed, and so is one that is double-clicked or deleted with the keyboard. Shift moves a
// point finely, Ctrl snaps it to sixteenths. Every point takes the focus: the arrow keys move it.

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

import type { CurveParam, CurvePoint } from '../../../../core/api.ts';
import { Button, IconButton, Menu, NumberField, type MenuItemSpec } from '../../../ui/index.ts';
import { addPoint, CURVE_MAX_POINTS, CURVE_PRESETS, CURVE_SNAP, curvePath, hitPoint, movePoint, removePoint, widestGap, xLimits } from '../curve.ts';
import styles from '../inspector.module.css';
import { sameValue } from '../model.ts';
import type { ControlProps } from './types.ts';

/** The plot lies this far inside the picture, so that a point on its edge is whole and can be taken. */
const PAD = 8;
const HEIGHT = 164;
/** How near a press must be to a point to take it, in pixels. */
const GRAB = 9;
/** How far outside the picture a dragged point is let go of. */
const PULL_OUT = 28;
const FINE = 0.1;
const GRID = [0.25, 0.5, 0.75];

interface Drag {
  readonly pointerId: number;
  /** The curve before the press: what Escape gives back. */
  readonly original: readonly CurvePoint[];
  /** The curve the drag moves a point of: the original, or the original with the point the press added. */
  readonly base: readonly CurvePoint[];
  readonly index: number;
  /** Where the pointer is taken to be, in curve units: it follows the pointer, a tenth as fast with Shift. */
  x: number;
  y: number;
  lastX: number;
  lastY: number;
  sent: readonly CurvePoint[];
  cancelled: boolean;
}

export function CurveControl(props: ControlProps<CurveParam, readonly CurvePoint[]>) {
  const points = props.value;
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const [width, setWidth] = useState(240);
  const [selected, setSelected] = useState(0);
  /** The point that was added by the press that may turn out to be the first of a double click. */
  const added = useRef<{ readonly index: number; readonly time: number } | null>(null);
  /** Set when the selected point is to take the focus once it is drawn. */
  const focusSelected = useRef(false);
  const latest = useRef(props);
  latest.current = props;
  const chosen = Math.min(selected, points.length - 1);

  useLayoutEffect(() => {
    const element = svg.current;
    if (!element) return undefined;
    const measure = (): void => {
      const measured = Math.round(element.getBoundingClientRect().width);
      if (measured > 0) setWidth(measured);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!focusSelected.current) return;
    focusSelected.current = false;
    svg.current?.querySelector<SVGGElement>(`[data-point="${chosen}"]`)?.focus();
  });

  // A control that goes away in the middle of a drag does not leave its gesture open.
  useEffect(() => () => {
    if (drag.current && !drag.current.cancelled) latest.current.end(true);
    drag.current = null;
  }, []);

  const plotWidth = Math.max(1, width - 2 * PAD);
  const plotHeight = HEIGHT - 2 * PAD;

  /** The pointer in curve units, from the picture as it lies on the screen now. */
  const toCurve = (event: { readonly clientX: number; readonly clientY: number }): { x: number; y: number; outside: boolean; w: number; h: number } => {
    const rect = svg.current!.getBoundingClientRect();
    const w = Math.max(1, rect.width - 2 * PAD);
    const h = Math.max(1, rect.height - 2 * PAD);
    const outside = event.clientX < rect.left - PULL_OUT || event.clientX > rect.right + PULL_OUT || event.clientY < rect.top - PULL_OUT || event.clientY > rect.bottom + PULL_OUT;
    return { x: (event.clientX - rect.left - PAD) / w, y: 1 - (event.clientY - rect.top - PAD) / h, outside, w, h };
  };

  const send = (next: readonly CurvePoint[]): void => {
    if (!sameValue(next, latest.current.value)) latest.current.change(next);
  };

  function onPointerDown(event: PointerEvent<SVGSVGElement>): void {
    if (props.disabled || event.button !== 0 || drag.current) return;
    const at = toCurve(event);
    let index = hitPoint(points, at.x, at.y, at.w, at.h, GRAB);
    let base = points;
    if (index < 0) {
      const made = addPoint(points, at.x, at.y);
      if (!made) return;
      base = made.points;
      index = made.index;
      added.current = { index, time: event.timeStamp };
    }
    // The press is the plot's alone: the browser's own answer to it would give the focus to whatever can take it
    // around the plot, away from the point this press takes, and Escape and the arrow keys would not reach it.
    event.preventDefault();
    props.begin();
    drag.current = {
      pointerId: event.pointerId, original: points, base, index, x: base[index]!.x, y: base[index]!.y,
      lastX: event.clientX, lastY: event.clientY, sent: points, cancelled: false,
    };
    if (base !== points) {
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

  function onPointerMove(event: PointerEvent<SVGSVGElement>): void {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId || d.cancelled) return;
    const at = toCurve(event);
    const speed = event.shiftKey ? FINE : 1;
    d.x += ((event.clientX - d.lastX) / at.w) * speed;
    d.y -= ((event.clientY - d.lastY) / at.h) * speed;
    d.lastX = event.clientX;
    d.lastY = event.clientY;
    const next = at.outside && d.base.length > 2
      ? removePoint(d.base, d.index)
      : movePoint(d.base, d.index, d.x, d.y, event.ctrlKey || event.metaKey ? CURVE_SNAP : 0);
    if (sameValue(next, d.sent)) return;
    d.sent = next;
    send(next);
  }

  function finish(event: PointerEvent<SVGSVGElement>, kept: boolean): void {
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
    else if (d.sent.length < d.base.length) setSelected(Math.max(0, d.index - 1));
    latest.current.end(kept);
  }

  function cancelDrag(): boolean {
    const d = drag.current;
    if (!d || d.cancelled) return false;
    d.cancelled = true;
    send(d.original);
    latest.current.end(false);
    return true;
  }

  function remove(index: number): void {
    const next = removePoint(points, index);
    if (next === points) return;
    props.change(next);
    setSelected(Math.max(0, Math.min(index, next.length - 1)));
  }

  function onPointKeyDown(event: KeyboardEvent<SVGGElement>, index: number): void {
    if (props.disabled) return;
    if (event.key === 'Escape') {
      if (cancelDrag()) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (drag.current || event.ctrlKey || event.metaKey) return;
    const step = event.shiftKey ? 0.1 : event.altKey ? 0.001 : 0.01;
    const dx = event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0;
    const dy = event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0;
    if (dx !== 0 || dy !== 0) {
      event.preventDefault();
      const point = points[index]!;
      send(movePoint(points, index, point.x + dx, point.y + dy));
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      focusSelected.current = true;
      remove(index);
    }
  }

  function onDoubleClick(event: { readonly clientX: number; readonly clientY: number; readonly timeStamp: number }): void {
    if (props.disabled) return;
    const at = toCurve(event);
    const index = hitPoint(points, at.x, at.y, at.w, at.h, GRAB);
    // The first press of a double click on the empty plot added this point: the second does not take it away again.
    const fresh = added.current !== null && added.current.index === index && event.timeStamp - added.current.time < 700;
    if (index >= 0 && !fresh) remove(index);
  }

  const point = points[chosen]!;
  const limits = xLimits(points, chosen);
  const moveChosen = (x: number, y: number): void => send(movePoint(points, chosen, x, y));
  const presets: MenuItemSpec[] = CURVE_PRESETS.map((preset) => ({ label: preset.label, id: preset.id, onSelect: () => send(preset.points) }));

  return (
    <div className={styles.curve} data-control="curve" data-points={points.length}>
      <svg
        ref={svg}
        className={styles.curvePlot}
        style={{ height: HEIGHT }}
        data-curve="plot"
        data-pad={PAD}
        data-disabled={props.disabled ? '' : undefined}
        role="group"
        aria-label={`${props.label}: ${points.length} points`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => finish(event, true)}
        onPointerCancel={(event) => finish(event, false)}
        onDoubleClick={onDoubleClick}
      >
        <g transform={`translate(${PAD} ${PAD})`}>
          <rect className={styles.curveFrame} width={plotWidth} height={plotHeight} />
          {GRID.map((t) => (
            <g key={t} className={styles.curveGrid}>
              <line x1={t * plotWidth} y1={0} x2={t * plotWidth} y2={plotHeight} />
              <line x1={0} y1={t * plotHeight} x2={plotWidth} y2={t * plotHeight} />
            </g>
          ))}
          <line className={styles.curveDiagonal} x1={0} y1={plotHeight} x2={plotWidth} y2={0} />
          <path className={styles.curveLine} data-curve="line" d={curvePath(points, plotWidth, plotHeight)} />
          {points.map((p, index) => (
            <g
              key={index}
              className={styles.curvePoint}
              data-point={index}
              data-selected={index === chosen ? '' : undefined}
              transform={`translate(${Number((p.x * plotWidth).toFixed(2))} ${Number(((1 - p.y) * plotHeight).toFixed(2))})`}
              role="slider"
              tabIndex={props.disabled ? -1 : 0}
              aria-label={`Point ${index + 1} of ${points.length}`}
              aria-valuemin={0}
              aria-valuemax={1}
              aria-valuenow={p.y}
              aria-valuetext={`x ${p.x}, y ${p.y}`}
              onFocus={() => setSelected(index)}
              onKeyDown={(event) => onPointKeyDown(event, index)}
            >
              <circle className={styles.curveHalo} r={GRAB} />
              <circle className={styles.curveDot} r={3.5} />
            </g>
          ))}
        </g>
      </svg>
      <div className={styles.editorTools}>
        <NumberField
          id={props.id}
          className={styles.fill}
          label="X"
          aria-label={`${props.label} point X`}
          value={point.x}
          min={limits.lo}
          max={limits.hi}
          step={0.01}
          precision={3}
          disabled={props.disabled}
          onChange={(x) => moveChosen(x, point.y)}
          onScrubStart={props.begin}
          onScrubEnd={props.end}
        />
        <NumberField
          className={styles.fill}
          label="Y"
          aria-label={`${props.label} point Y`}
          value={point.y}
          min={0}
          max={1}
          step={0.01}
          precision={3}
          disabled={props.disabled}
          onChange={(y) => moveChosen(point.x, y)}
          onScrubStart={props.begin}
          onScrubEnd={props.end}
        />
        <IconButton
          icon="plus"
          label="Add point"
          size="small"
          data-action="add-point"
          disabled={props.disabled || points.length >= CURVE_MAX_POINTS}
          onClick={() => {
            const made = addPoint(points, widestGap(points));
            if (!made) return;
            props.change(made.points);
            setSelected(made.index);
          }}
        />
        <IconButton icon="minus" label="Remove point" size="small" data-action="remove-point" disabled={props.disabled || points.length <= 2} onClick={() => remove(chosen)} />
        <Menu trigger={<Button size="small" disabled={props.disabled} data-action="presets">Presets</Button>} items={presets} align="end" />
      </div>
    </div>
  );
}
