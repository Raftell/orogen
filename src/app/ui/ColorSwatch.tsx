// A colour: a swatch that opens a picker. The document stores linear RGB in 0..1 (engine.md 1.7); the swatch,
// the picker and the hex code show sRGB, and the three number fields show what is stored.

import { useRef, useState } from 'react';
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

  const begin = (): void => {
    if (dragging.current) return;
    dragging.current = true;
    props.onScrubStart?.();
  };
  const end = (): void => {
    if (!dragging.current) return;
    dragging.current = false;
    props.onScrubEnd?.();
  };

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
      <div className="og-color-popover" data-ui="color-picker" onPointerDownCapture={begin} onPointerUpCapture={end} onPointerCancelCapture={end}>
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
