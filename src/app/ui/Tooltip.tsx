// A tooltip: the name of a control that shows only an icon, and the key of its command (runtime.md 8.8 rule 5).

import { Tooltip as Base } from '@base-ui/react/tooltip';
import type { ReactElement, ReactNode } from 'react';

import './controls.css';

/** Around the application once: tooltips share one delay, and the second of a row opens at once. */
export function TooltipProvider(props: { readonly children: ReactNode }) {
  return <Base.Provider delay={600} closeDelay={0}>{props.children}</Base.Provider>;
}

export interface TooltipProps {
  /** Null or '': no tooltip, and the child is returned as it is. */
  readonly content: ReactNode;
  /** A key as shown to the user ('Ctrl+B'), drawn dim after the content. */
  readonly keyLabel?: string | null;
  readonly side?: 'top' | 'bottom' | 'left' | 'right';
  /** One element that takes a ref and DOM props. */
  readonly children: ReactElement<Record<string, unknown>>;
}

export function Tooltip(props: TooltipProps) {
  if (props.content === null || props.content === undefined || props.content === '') return props.children;
  return (
    <Base.Root>
      <Base.Trigger render={props.children} />
      <Base.Portal>
        <Base.Positioner side={props.side ?? 'bottom'} sideOffset={6} collisionPadding={6} data-chrome="">
          <Base.Popup className="og-tooltip" data-ui="tooltip">
            {props.content}
            {props.keyLabel ? <span className="og-tooltip-key">{props.keyLabel}</span> : null}
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}
