// A slider: a value between two ends, set by a thumb. For a parameter with a soft range, units or typed entry
// the number field is the control; this is for an amount that has two plain ends.

import { Slider as Base } from '@base-ui/react/slider';
import { useRef } from 'react';

import './controls.css';

export interface SliderProps {
  readonly value: number;
  readonly min: number;
  readonly max: number;
  /** Default: a hundredth of the range. */
  readonly step?: number;
  /** Every change while the thumb moves. */
  onChange(value: number): void;
  /** Once, with the value the interaction ended on. */
  onCommit?(value: number): void;
  /** Around a drag of the thumb: where a caller begins and ends a gesture (runtime.md 8.5 rule 4). */
  onScrubStart?(): void;
  onScrubEnd?(): void;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly 'aria-label'?: string;
  readonly className?: string;
}

export function Slider(props: SliderProps) {
  const dragging = useRef(false);
  const step = props.step ?? (props.max - props.min) / 100;
  const end = (): void => {
    if (!dragging.current) return;
    dragging.current = false;
    props.onScrubEnd?.();
  };
  return (
    <Base.Root
      className={props.className ? `og-slider ${props.className}` : 'og-slider'}
      data-ui="slider"
      id={props.id}
      value={props.value}
      min={props.min}
      max={props.max}
      step={step}
      disabled={props.disabled}
      onValueChange={(value) => { if (typeof value === 'number') props.onChange(value); }}
      onValueCommitted={(value) => {
        if (typeof value === 'number') props.onCommit?.(value);
        end();
      }}
      onPointerDown={() => {
        if (props.disabled || dragging.current) return;
        dragging.current = true;
        props.onScrubStart?.();
      }}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <Base.Control className="og-slider-control">
        <Base.Track className="og-slider-track">
          <Base.Indicator className="og-slider-indicator" />
          <Base.Thumb className="og-slider-thumb" aria-label={props['aria-label']} />
        </Base.Track>
      </Base.Control>
    </Base.Root>
  );
}
