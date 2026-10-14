// The inspector (runtime.md 8.7): the parameters of the selected node, generated from its ParamDefs; of several
// selected nodes of one type, their parameters edited together; of nodes of several types, a summary; and with
// nothing selected, the project settings. It reads the document and the selection, and writes transactions.

import { useEffect, useMemo } from 'react';
import { useStore } from 'zustand';

import { canBypass, type ProjectSettings } from '../../../core/runtime.ts';
import { Icon, useCommandContext } from '../../ui/index.ts';
import styles from './inspector.module.css';
import { nodeValues, shareValues, targetOf, visibleSections, type Target } from './model.ts';
import { BypassBox, NodeAbout, NodeHeader, NodesStatus } from './NodeHeader.tsx';
import { ParamList } from './Params.tsx';
import { SettingsView } from './Settings.tsx';
import { forgetParams } from './state.ts';

function NodesView(props: { readonly target: Extract<Target, { kind: 'nodes' }>; readonly settings: ProjectSettings }) {
  const { target, settings } = props;
  const { def, nodes } = target;
  const all = useMemo(() => nodes.map((node) => nodeValues(def, node)), [def, nodes]);
  const values = useMemo(() => shareValues(def, all), [def, all]);
  const sections = useMemo(() => visibleSections(def.params, all), [def, all]);
  // "Reset Parameter" acts on a parameter of what is inspected now, never on one of the node before.
  useEffect(() => forgetParams, []);

  return (
    <>
      <NodeHeader def={def} nodes={nodes} />
      <div className={styles.scroll} data-inspector-body="">
        <NodeAbout def={def} nodes={nodes} settings={settings} locked={target.locked !== null} />
        {target.locked !== null ? (
          <div className={styles.notice} data-inspector-locked="">
            <Icon name="lock" />
            <span>{target.locked}. Its parameters are kept as they are and cannot be edited here.</span>
          </div>
        ) : null}
        {def.params.length === 0
          ? <div className={styles.none} data-inspector-empty="">This node has no parameters</div>
          : <ParamList target={target} sections={sections} values={values} settings={settings} />}
      </div>
    </>
  );
}

function SummaryView(props: { readonly target: Extract<Target, { kind: 'summary' }> }) {
  const { registry } = useCommandContext();
  const { nodes, types } = props.target;
  const unknown = types.filter((entry) => entry.category === null);
  const bypassable = nodes.filter((node) => {
    const def = registry.get(node.type);
    return def !== undefined && canBypass(def);
  });
  return (
    <>
      <header className={styles.header} data-inspector-header="summary">
        <div className={styles.category} />
        <div className={styles.headerMain}>
          <div className={styles.titleLine}>
            <div className={styles.multiTitle} data-field="count">{nodes.length === 1 ? '1 node selected' : `${nodes.length} nodes selected`}</div>
            <BypassBox nodes={bypassable} available={bypassable.length > 0} />
          </div>
          <div className={styles.typeLine}>
            <span className={styles.typeTitle}>{types.length === 1 ? '1 type' : `${types.length} types`}</span>
          </div>
        </div>
      </header>
      <div className={styles.scroll} data-inspector-body="">
        <ul className={styles.typeList} data-inspector-types="">
          {types.map((entry) => (
            <li key={entry.type} className={styles.typeItem} data-type={entry.type}>
              <span className={styles.chip} style={entry.category === null ? undefined : { background: `var(--og-category-${entry.category})` }} />
              <span>{entry.count} × {entry.title}</span>
              {entry.category === null ? null : <span className={styles.typeId}>{entry.type}</span>}
            </li>
          ))}
        </ul>
        <div className={styles.about}>
          <NodesStatus nodes={nodes} />
        </div>
        <div className={styles.none} data-inspector-hint="">
          {unknown.length > 0
            ? `${unknown.map((entry) => entry.type).join(', ')} ${unknown.length === 1 ? 'is no node type' : 'are no node types'} of this build. Such a node is kept as it is.`
            : 'Select nodes of one type to edit their parameters together.'}
        </div>
      </div>
    </>
  );
}

export function InspectorPanel() {
  const ctx = useCommandContext();
  const selection = useStore(ctx.ui, (state) => state.selection);
  const nodes = useStore(ctx.doc, (state) => state.doc.nodes);
  const settings = useStore(ctx.doc, (state) => state.doc.settings);
  const target = useMemo(() => targetOf(nodes, ctx.registry, selection), [nodes, ctx.registry, selection]);

  return (
    <div className={styles.root} data-inspector={target.kind}>
      {target.kind === 'settings' ? <SettingsView settings={settings} />
        : target.kind === 'nodes' ? <NodesView key={target.ids.join('+')} target={target} settings={settings} />
          : <SummaryView target={target} />}
    </div>
  );
}
