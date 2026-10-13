// A popover: content that opens beside the control that asked for it, and closes on Escape or a press outside.

import { Popover as Base } from '@base-ui/react/popover';
import type { ReactElement, ReactNode } from 'react';

import './controls.css';

export interface PopoverProps {
  /** The element that opens the popover: one element that takes a ref and DOM props. */
  readonly trigger: ReactElement<Record<string, unknown>>;
  readonly children: ReactNode;
  /** Given: the caller holds whether it is open. Not given: the popover does. */
  readonly open?: boolean;
  onOpenChange?(open: boolean): void;
  readonly title?: string;
  readonly side?: 'top' | 'bottom' | 'left' | 'right';
  readonly align?: 'start' | 'center' | 'end';
  readonly className?: string;
}

export function Popover(props: PopoverProps) {
  return (
    <Base.Root open={props.open} onOpenChange={(open) => props.onOpenChange?.(open)}>
      <Base.Trigger render={props.trigger} />
      <Base.Portal>
        <Base.Positioner side={props.side ?? 'bottom'} align={props.align ?? 'start'} sideOffset={4} collisionPadding={8} data-chrome="">
          <Base.Popup className={props.className ? `og-popup og-popover ${props.className}` : 'og-popup og-popover'} data-ui="popover">
            {props.title ? <Base.Title className="og-popover-title">{props.title}</Base.Title> : null}
            {props.children}
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}
