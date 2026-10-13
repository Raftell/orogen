// A checkbox with its label. Pressing the label is pressing the box.

import { Checkbox as Base } from '@base-ui/react/checkbox';
import type { ReactNode } from 'react';

import './controls.css';
import { Icon } from './icons.tsx';

export interface CheckboxProps {
  readonly checked: boolean;
  onChange(checked: boolean): void;
  readonly label?: ReactNode;
  readonly disabled?: boolean;
  readonly id?: string;
  /** The name of a box without a label. */
  readonly 'aria-label'?: string;
}

export function Checkbox(props: CheckboxProps) {
  const box = (
    <Base.Root
      className="og-checkbox"
      data-ui="checkbox"
      id={props.id}
      checked={props.checked}
      disabled={props.disabled}
      aria-label={props['aria-label']}
      onCheckedChange={(checked) => props.onChange(checked)}
    >
      <Base.Indicator><Icon name="check" /></Base.Indicator>
    </Base.Root>
  );
  if (props.label === undefined) return box;
  return (
    <label className="og-check" data-disabled={props.disabled ? '' : undefined}>
      {box}
      <span>{props.label}</span>
    </label>
  );
}
