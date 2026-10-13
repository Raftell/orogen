// The pieces a panel is laid out with: a row of a property list, the title of a section, and what a panel
// shows when it has nothing to show.

import type { ReactNode } from 'react';

import './controls.css';
import { Tooltip } from './Tooltip.tsx';

export interface PropertyRowProps {
  readonly label: string;
  /** One or two sentences shown when the pointer rests on the label (testing.md 6.2). */
  readonly help?: string;
  /** The id of the control, so that pressing the label reaches it. */
  readonly htmlFor?: string;
  readonly children: ReactNode;
}

/** A label and its control on one row. The label column is `--og-label-width` wide in every panel. */
export function PropertyRow(props: PropertyRowProps) {
  const label = <label className="og-row-label" htmlFor={props.htmlFor}>{props.label}</label>;
  return (
    <div className="og-row" data-ui="row">
      {props.help ? <Tooltip content={props.help} side="left">{label}</Tooltip> : label}
      <div className="og-row-control">{props.children}</div>
    </div>
  );
}

export function SectionTitle(props: { readonly children: ReactNode }) {
  return <h3 className="og-section-title">{props.children}</h3>;
}

export function EmptyState(props: { readonly title: string; readonly children?: ReactNode }) {
  return (
    <div className="og-empty" data-ui="empty">
      <div className="og-empty-title">{props.title}</div>
      {props.children ? <div>{props.children}</div> : null}
    </div>
  );
}
