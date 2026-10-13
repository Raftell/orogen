// Buttons: with a label, with an icon alone, and bound to a command.

import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';

import { useApp, useCommandEnabled } from './app.tsx';
import './controls.css';
import { Icon, type IconName } from './icons.tsx';
import { Tooltip } from './Tooltip.tsx';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  /** `primary`: the one action a dialog expects. `quiet`: no frame until the pointer is on it. `danger`: discards something. */
  readonly variant?: 'default' | 'primary' | 'quiet' | 'danger';
  readonly size?: 'normal' | 'small';
  readonly icon?: IconName;
  readonly ref?: Ref<HTMLButtonElement>;
}

export function Button(props: ButtonProps) {
  const { variant = 'default', size = 'normal', icon, className, children, ...rest } = props;
  return (
    <button type="button" className={className ? `og-button ${className}` : 'og-button'} data-ui="button" data-variant={variant} data-size={size} {...rest}>
      {icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'children' | 'aria-label'> {
  readonly icon: IconName;
  /** What the button does: its accessible name and its tooltip. */
  readonly label: string;
  /** The key of what it does, as shown to the user; drawn in the tooltip. */
  readonly keyLabel?: string | null;
  readonly size?: 'normal' | 'small';
  /** For a button that stays down: true draws it so. */
  readonly pressed?: boolean;
  readonly tooltipSide?: 'top' | 'bottom' | 'left' | 'right';
  readonly ref?: Ref<HTMLButtonElement>;
}

export function IconButton(props: IconButtonProps) {
  const { icon, label, keyLabel, size = 'normal', pressed, tooltipSide, className, ...rest } = props;
  return (
    <Tooltip content={label} keyLabel={keyLabel} side={tooltipSide}>
      <button
        type="button"
        className={className ? `og-icon-button ${className}` : 'og-icon-button'}
        data-ui="icon-button"
        data-size={size}
        aria-label={label}
        aria-pressed={pressed}
        {...rest}
      >
        <Icon name={icon} />
      </button>
    </Tooltip>
  );
}

export interface CommandButtonProps {
  /** The command the button runs (runtime.md 8.8). Its title is the button's name; its key is in the tooltip. */
  readonly command: string;
  /** With an icon the button shows the icon alone; without, the command's title. */
  readonly icon?: IconName;
  readonly variant?: ButtonProps['variant'];
  readonly size?: 'normal' | 'small';
  readonly pressed?: boolean;
  readonly children?: ReactNode;
}

/** A button that is its command: disabled while the command is, named by it, and showing its current key. */
export function CommandButton(props: CommandButtonProps) {
  const app = useApp();
  const enabled = useCommandEnabled(props.command);
  const title = (app.commandTitle(props.command) ?? props.command).replace(/…$/, '');
  const run = (): void => app.ctx.run(props.command);
  if (props.icon && props.children === undefined) {
    return (
      <IconButton icon={props.icon} label={title} keyLabel={app.keyLabel(props.command)} size={props.size} pressed={props.pressed} disabled={!enabled} onClick={run} data-command={props.command} />
    );
  }
  return (
    <Tooltip content={props.children === undefined ? null : title} keyLabel={app.keyLabel(props.command)}>
      <Button icon={props.icon} variant={props.variant} size={props.size} disabled={!enabled} onClick={run} data-command={props.command}>
        {props.children ?? title}
      </Button>
    </Tooltip>
  );
}
