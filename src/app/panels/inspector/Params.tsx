// The parameters of the inspected nodes: a row per parameter, generated from its ParamDef, in collapsible
// sections by group (engine.md 4.3). A row has the label with the help as its tooltip, the control of the
// parameter's kind, and the mark of a value that is not the default, which is the button that resets it.

import { useEffect, useId, useMemo, useRef, type ReactNode } from 'react';
import { useStore } from 'zustand';

import type { ParamDef, ParamValue } from '../../../core/api.ts';
import type { ProjectSettings } from '../../../core/runtime.ts';
import { ContextMenu, Icon, IconButton, Tooltip, useApp, type MenuItemSpec } from '../../ui/index.ts';
import { isBlockKind, ParamControl } from './controls/index.tsx';
import { createGesture, paramKey, resetParamsOf, setParamOf, type EditTarget } from './edit.ts';
import styles from './inspector.module.css';
import { paramLabel, paramTooltip, type Section, type SharedValue } from './model.ts';
import { inspectorStore, sectionKey, setHoverParam, setSectionOpen, setTouchedParam } from './state.ts';

export interface ParamTarget extends EditTarget {
  /** Why the parameters cannot be edited; null: they can. */
  readonly locked: string | null;
}

/** The label of a row, the mark of values that differ between the nodes, and the help as the tooltip. */
export function RowLabel(props: { readonly label: string; readonly help: string; readonly htmlFor?: string; readonly mixed?: boolean }) {
  return (
    <Tooltip content={props.mixed ? `${props.help} The selected nodes hold different values; a change gives all of them the new one.` : props.help} side="left">
      <label className={styles.label} htmlFor={props.htmlFor}>
        {props.label}
        {props.mixed ? <span className={styles.mixed} data-mixed="">mixed</span> : null}
      </label>
    </Tooltip>
  );
}

/** The end of a row: the reset button while the value is not the default, and its place while it is. */
export function RowEnd(props: { readonly changed: boolean; readonly disabled?: boolean; reset(): void }) {
  return (
    <span className={styles.rowEnd}>
      {props.changed ? <IconButton icon="reset" label="Reset to default" size="small" tooltipSide="left" disabled={props.disabled} data-action="reset" onClick={props.reset} /> : null}
    </span>
  );
}

function ParamRow(props: { readonly target: ParamTarget; readonly param: ParamDef; readonly shared: SharedValue; readonly settings: ProjectSettings }) {
  const app = useApp();
  const { target, param, shared, settings } = props;
  const id = useId();
  const key = paramKey(target.ids, param.name);
  const gesture = useMemo(() => createGesture(app.ctx.doc, key), [app.ctx.doc, key]);
  // A row that goes away in the middle of a drag (the selection changed, an undo) does not leave its gesture open.
  useEffect(() => () => gesture.end(true), [gesture]);
  // A row that goes away under the pointer (another parameter hid it) is not left as the one the pointer is on.
  useEffect(() => () => setHoverParam(param.name, false), [param.name]);
  // The handlers below outlive a render: a drag reads the nodes as they are now.
  const latest = useRef(target);
  latest.current = target;

  const label = paramLabel(param);
  const disabled = target.locked !== null;
  const guarded = (work: () => void): void => {
    try {
      work();
    } catch (thrown) {
      app.notify({ level: 'error', message: `${label} could not be changed`, detail: thrown instanceof Error ? thrown.message : String(thrown) });
    }
  };
  const change = (value: ParamValue): void => guarded(() => setParamOf(app.ctx, latest.current, param, value));
  const reset = (): void => guarded(() => resetParamsOf(app.ctx, latest.current, [param]));
  const touch = (): void => setTouchedParam(param.name);
  const items = (): MenuItemSpec[] => [{ label: 'Reset to Default', id: 'reset', disabled: disabled || !shared.changed, onSelect: reset }];

  const control = (
    <ParamControl
      param={param}
      value={shared.value}
      id={id}
      label={label}
      disabled={disabled}
      settings={settings}
      nodeIds={target.ids}
      change={change}
      begin={gesture.begin}
      end={gesture.end}
    />
  );
  const marks = {
    'data-param': param.name,
    'data-kind': param.kind,
    'data-changed': shared.changed ? '' : undefined,
    'data-mixed': shared.mixed ? '' : undefined,
    onPointerEnter: () => setHoverParam(param.name, true),
    onPointerLeave: () => setHoverParam(param.name, false),
    onPointerDownCapture: touch,
    onFocusCapture: touch,
  };
  const labelElement = <RowLabel label={label} help={paramTooltip(param, settings)} htmlFor={id} mixed={shared.mixed} />;
  const end = <RowEnd changed={shared.changed} disabled={disabled} reset={reset} />;

  return (
    <ContextMenu items={items} className={styles.rowMenu}>
      {isBlockKind(param.kind) ? (
        <div className={styles.block} {...marks}>
          <div className={styles.blockHead}>
            {labelElement}
            {end}
          </div>
          {control}
        </div>
      ) : (
        <div className={styles.row} {...marks}>
          {labelElement}
          <div className={styles.control}>{control}</div>
          {end}
        </div>
      )}
    </ContextMenu>
  );
}

function SectionView(props: { readonly nodeType: string; readonly title: string; readonly changed: number; readonly children: ReactNode }) {
  const key = sectionKey(props.nodeType, props.title);
  const open = useStore(inspectorStore, (state) => !Object.hasOwn(state.collapsed, key));
  return (
    <section className={styles.section} data-section={props.title} data-open={open ? '' : undefined}>
      <button type="button" className={styles.sectionHead} aria-expanded={open} onClick={() => setSectionOpen(key, !open)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        <span className={styles.sectionTitle}>{props.title}</span>
        {props.changed > 0 ? <span className={styles.sectionNote}>{props.changed} changed</span> : null}
      </button>
      {open ? <div className={styles.sectionBody}>{props.children}</div> : null}
    </section>
  );
}

export function ParamList(props: {
  readonly target: ParamTarget;
  readonly sections: readonly Section[];
  readonly values: Readonly<Record<string, SharedValue>>;
  readonly settings: ProjectSettings;
}) {
  const { target, values, settings } = props;
  return (
    <>
      {props.sections.map((section) => {
        const rows = section.params.map((param) => <ParamRow key={param.name} target={target} param={param} shared={values[param.name]!} settings={settings} />);
        if (section.title === null) return <div key="" className={styles.loose}>{rows}</div>;
        const changed = section.params.filter((param) => values[param.name]!.changed).length;
        return <SectionView key={section.title} nodeType={target.def.type} title={section.title} changed={changed}>{rows}</SectionView>;
      })}
    </>
  );
}
