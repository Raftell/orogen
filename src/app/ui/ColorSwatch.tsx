// A colour: a swatch that opens a picker. The document stores linear RGB in 0..1 (engine.md 1.7); the swatch,
// the picker and the hex code show sRGB, and the three number fields show what is stored.

import { useEffect, useRef, useState } from 'react';
import { RgbColorPicker } from 'react-colorful';

import { fromDisplay, fromHex, toDisplay, toHex, type Rgb } from './color.ts';
import './controls.css';
import { NumberField } from './NumberField.tsx';
import { Popover } from './Popover.tsx';
import { TextField } from './TextField.tsx';

export interface ColorSwatchProps {
  readonly value: Rgb;
  /** Every new colour: each step of a drag in the picker, a committed hex code, a channel. */
  onChange(value: Rgb): void;
  /** Around a drag in the picker or of a channel: where a caller begins and ends a gesture (runtime.md 8.5 rule 4). */
  onScrubStart?(): void;
  onScrubEnd?(): void;
  /** False: `value` is sRGB already. Default true. */
  readonly linear?: boolean;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly 'aria-label'?: string;
}

const CHANNELS = ['R', 'G', 'B'] as const;

export function ColorSwatch(props: ColorSwatchProps) {
  const linear = props.linear !== false;
  const [open, setOpen] = useState(false);
  const dragging = useRef(false);
  const hex = toHex(props.value, linear);
  const [badHex, setBadHex] = useState(false);

  // What the listeners below call is that of the last render.
  const latest = useRef(props);
  latest.current = props;
  /** Ends the drag in progress; null when none is. */
  const stop = useRef<(() => void) | null>(null);

  // The picker follows the mouse through the window without capturing the pointer, and a drag across its square
  // ends as often outside the popover as inside: at its edges lie the purest colors. The release is therefore
  // heard on the window, wherever it happens; a release heard only inside the popover left the caller's gesture open.
  const begin = (): void => {
    if (stop.current !== null) return;
    const finish = (): void => {
      window.removeEventListener('pointerup', finish, true);
      window.removeEventListener('pointercancel', finish, true);
      window.removeEventListener('blur', finish);
      stop.current = null;
      dragging.current = false;
      latest.current.onScrubEnd?.();
    };
    stop.current = finish;
    dragging.current = true;
    window.addEventListener('pointerup', finish, true);
    window.addEventListener('pointercancel', finish, true);
    // A window that loses the focus in the middle of a drag never sees the button come up.
    window.addEventListener('blur', finish);
    latest.current.onScrubStart?.();
  };
  const end = (): void => stop.current?.();
  // A swatch that goes away in the middle of a drag ends it: the caller's gesture is not left open.
  useEffect(() => () => stop.current?.(), []);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) end();
        setOpen(next);
      }}
      trigger={
        <button
          type="button"
          className="og-swatch"
          data-ui="color-swatch"
          data-color={hex}
          id={props.id}
          disabled={props.disabled}
          aria-label={props['aria-label'] ?? `Color ${hex}`}
          style={{ background: hex }}
        />
      }
    >
      <div className="og-color-popover" data-ui="color-picker" onPointerDownCapture={begin}>
        <RgbColorPicker color={toDisplay(props.value, linear)} onChange={(shown) => props.onChange(fromDisplay(shown, linear))} />
        <TextField
          value={hex}
          invalid={badHex}
          selectOnFocus
          aria-label="Hex code"
          onChange={(text) => setBadHex(text !== '' && fromHex(text, linear) === null)}
          onCommit={(text) => {
            const color = fromHex(text, linear);
            setBadHex(false);
            if (color) props.onChange(color);
          }}
        />
        <div className="og-color-channels">
          {CHANNELS.map((channel, index) => (
            <NumberField
              key={channel}
              label={channel}
              value={props.value[index]!}
              min={0}
              max={1}
              step={0.01}
              precision={3}
              onChange={(next) => {
                const color: [number, number, number] = [props.value[0], props.value[1], props.value[2]];
                color[index] = next;
                props.onChange(color);
              }}
            />
          ))}
        </div>
      </div>
    </Popover>
  );
}
