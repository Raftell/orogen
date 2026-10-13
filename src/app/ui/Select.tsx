// A choice of one among named options, in a list that opens under the control.

import { Select as Base } from '@base-ui/react/select';

import './controls.css';
import { Icon } from './icons.tsx';

export interface SelectOption<T extends string = string> {
  readonly value: T;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SelectProps<T extends string = string> {
  readonly value: T;
  readonly options: readonly SelectOption<T>[];
  onChange(value: T): void;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly 'aria-label'?: string;
  readonly className?: string;
}

export function Select<T extends string = string>(props: SelectProps<T>) {
  const current = props.options.find((option) => option.value === props.value);
  return (
    <Base.Root
      value={props.value}
      disabled={props.disabled}
      onValueChange={(value) => {
        if (typeof value === 'string' && props.options.some((option) => option.value === value)) props.onChange(value as T);
      }}
    >
      <Base.Trigger className={props.className ? `og-select ${props.className}` : 'og-select'} data-ui="select" id={props.id} aria-label={props['aria-label']}>
        {/* A value that is none of the options is shown as it is stored, so that it can be seen and replaced. */}
        <span className="og-select-value">{current ? current.label : props.value}</span>
        <Base.Icon render={<span />}><Icon name="chevron-down" /></Base.Icon>
      </Base.Trigger>
      <Base.Portal>
        <Base.Positioner alignItemWithTrigger={false} sideOffset={2} collisionPadding={6} data-chrome="">
          <Base.Popup className="og-popup og-select-list" data-ui="select-list">
            <Base.List>
              {props.options.map((option) => (
                <Base.Item key={option.value} value={option.value} disabled={option.disabled} className="og-menu-item" data-value={option.value}>
                  <Base.ItemIndicator className="og-menu-item-mark"><Icon name="check" /></Base.ItemIndicator>
                  <Base.ItemText className="og-menu-item-label">{option.label}</Base.ItemText>
                </Base.Item>
              ))}
            </Base.List>
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}
