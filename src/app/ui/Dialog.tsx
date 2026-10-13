// A dialog: one question or one form above the application, which waits for it.

import { Dialog as Base } from '@base-ui/react/dialog';
import type { CSSProperties, ReactNode } from 'react';

import { IconButton } from './Button.tsx';
import './controls.css';

export interface DialogProps {
  readonly open: boolean;
  /** Escape, a press beside the dialog, or its close button. Not called for a dialog that is not `dismissible`. */
  onClose(): void;
  readonly title: string;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  /** The buttons at the bottom, the one that goes on last. */
  readonly actions?: ReactNode;
  /** CSS pixels; default 420. */
  readonly width?: number;
  /** False: the dialog asks something that must be answered with one of its buttons. Default true. */
  readonly dismissible?: boolean;
  /** Names the dialog for a test or a style: `data-dialog`. */
  readonly name?: string;
}

export function Dialog(props: DialogProps) {
  const dismissible = props.dismissible !== false;
  const style = props.width === undefined ? undefined : ({ '--og-dialog-width': `${props.width}px` } as CSSProperties);
  return (
    <Base.Root
      open={props.open}
      disablePointerDismissal={!dismissible}
      onOpenChange={(open, details) => {
        if (open) return;
        if (!dismissible) {
          details.cancel();
          return;
        }
        props.onClose();
      }}
    >
      <Base.Portal>
        <Base.Backdrop className="og-dialog-backdrop" data-chrome="" />
        <Base.Popup className="og-dialog" style={style} data-ui="dialog" data-dialog={props.name} data-chrome="">
          <div className="og-dialog-header">
            <Base.Title className="og-dialog-title">{props.title}</Base.Title>
            {dismissible ? <IconButton icon="close" label="Close" size="small" onClick={() => props.onClose()} /> : null}
          </div>
          {props.description ? <Base.Description className="og-dialog-description">{props.description}</Base.Description> : null}
          <div className="og-dialog-body">{props.children}</div>
          {props.actions ? <div className="og-dialog-actions">{props.actions}</div> : null}
        </Base.Popup>
      </Base.Portal>
    </Base.Root>
  );
}
