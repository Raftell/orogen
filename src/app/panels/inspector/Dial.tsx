// The dial of a direction (runtime.md 8.7 rule 5): its hand points where the direction points in every top view,
// 0° to the right and 90° down the screen (engine.md 1.8). Dragging turns the hand to the pointer, in whole
// degrees; Ctrl snaps to 15° and Shift gives tenths. The arrow keys turn it by a degree, with Shift by 15.

import { useRef, type KeyboardEvent, type PointerEvent } from 'react';

import styles from './inspector.module.css';
import { angleFromPointer, dialHand, wrapAngle } from './model.ts';

export interface DialProps {
  readonly value: number;
  readonly label: string;
  readonly disabled: boolean;
  change(value: number): void;
  begin(): void;
  end(kept?: boolean): void;
}

const RADIUS = 12;
const HAND = 8.5;
/** The four axes of the top view, as short marks on the rim. */
const MARKS = [0, 90, 180, 270].map((degrees) => ({ inner: dialHand(degrees, RADIUS - 2.5), outer: dialHand(degrees, RADIUS) }));

export function Dial(props: DialProps) {
  const drag = useRef<{ readonly pointerId: number; readonly start: number; last: number; cancelled: boolean } | null>(null);
  const latest = useRef(props);
  latest.current = props;

  const angleAt = (event: PointerEvent<SVGSVGElement>): number => {
    const rect = event.currentTarget.getBoundingClientRect();
    const snap = event.ctrlKey || event.metaKey ? 15 : event.shiftKey ? 0 : 1;
    return angleFromPointer(event.clientX - (rect.left + rect.width / 2), event.clientY - (rect.top + rect.height / 2), snap);
  };

  const turnTo = (angle: number): void => {
    const d = drag.current;
    if (!d || d.cancelled || angle === d.last) return;
    d.last = angle;
    latest.current.change(angle);
  };

  function onPointerDown(event: PointerEvent<SVGSVGElement>): void {
    if (props.disabled || event.button !== 0 || drag.current) return;
    event.currentTarget.focus();
    drag.current = { pointerId: event.pointerId, start: props.value, last: props.value, cancelled: false };
    props.begin();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A pointer the browser does not know (a synthesised event): the moves still arrive at this element.
    }
    turnTo(angleAt(event));
  }

  function onPointerMove(event: PointerEvent<SVGSVGElement>): void {
    if (drag.current?.pointerId === event.pointerId) turnTo(angleAt(event));
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
    if (!kept && d.last !== d.start) latest.current.change(d.start);
    latest.current.end(kept);
  }

  function onKeyDown(event: KeyboardEvent<SVGSVGElement>): void {
    if (props.disabled) return;
    const d = drag.current;
    if (d) {
      if (event.key !== 'Escape' || d.cancelled) return;
      event.preventDefault();
      event.stopPropagation();
      // The rest of the press does nothing: the value is the one the drag began with.
      d.cancelled = true;
      if (d.last !== d.start) props.change(d.start);
      props.end(false);
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // Clockwise on the screen is the turn from +X towards +Y: the angle grows.
    const turn = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (turn !== 0) {
      event.preventDefault();
      props.change(wrapAngle(Math.round(props.value) + turn * (event.shiftKey ? 15 : 1)));
    } else if (event.key === 'Home') {
      event.preventDefault();
      props.change(0);
    }
  }

  const hand = dialHand(props.value, HAND);
  return (
    <svg
      className={styles.dial}
      viewBox="-14 -14 28 28"
      data-control="dial"
      data-value={props.value}
      data-disabled={props.disabled ? '' : undefined}
      role="slider"
      tabIndex={props.disabled ? -1 : 0}
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={360}
      aria-valuenow={props.value}
      aria-valuetext={`${Number(props.value.toFixed(1))}°`}
      aria-disabled={props.disabled || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => finish(event, true)}
      onPointerCancel={(event) => finish(event, false)}
      onKeyDown={onKeyDown}
    >
      <circle className={styles.dialRim} r={RADIUS} />
      {MARKS.map((mark, index) => (
        <line key={index} className={styles.dialMark} x1={mark.inner.x} y1={mark.inner.y} x2={mark.outer.x} y2={mark.outer.y} />
      ))}
      <line className={styles.dialHand} x1={0} y1={0} x2={hand.x} y2={hand.y} />
      <circle className={styles.dialTip} cx={hand.x} cy={hand.y} r={2.2} />
    </svg>
  );
}
