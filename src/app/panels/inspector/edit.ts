// The document changes the inspector makes (runtime.md 4.6, 8.5): each is one transaction of the commands of
// 4.6, with the merge key of its parameter, so that a drag is one history entry and a typed burst is one too.
// No DOM and no React: tests run these against a document store of their own.

import type { StoreApi } from 'zustand/vanilla';

import type { NodeDef, ParamDef } from '../../../core/api.ts';
import {
  resetParam, setNodeFlags, setParam, setSettings, type DocDraft, type NodeInstance, type NodeRegistry, type ProjectSettings,
} from '../../../core/runtime.ts';
import type { DocState } from '../../state/doc-store.ts';
import { paramLabel } from './model.ts';
import { isUndoableSetting, SETTING_LABELS, type SettingName } from './settings.ts';

export interface EditContext {
  readonly doc: StoreApi<DocState>;
  readonly registry: NodeRegistry;
}

/** The nodes an edit goes to: one, or several of one type. */
export interface EditTarget {
  readonly def: NodeDef;
  readonly nodes: readonly NodeInstance[];
  readonly ids: readonly string[];
}

/** runtime.md 8.5 rule 4: `param:<nodeId>:<name>`. Several nodes that are edited together are named together. */
export const paramKey = (ids: readonly string[], name: string): string => `param:${ids.join('+')}:${name}`;
export const settingKey = (name: SettingName): string => `setting:${name}`;

/** How the history names what was edited: the node's own title, or the count and the type. */
export function targetLabel(target: EditTarget): string {
  if (target.nodes.length === 1) return target.nodes[0]!.title ?? target.def.title;
  return `${target.nodes.length} × ${target.def.title}`;
}

/** The nodes of the target the draft still holds: a control may outlive its node by one event. */
const held = (draft: DocDraft, ids: readonly string[]): string[] => ids.filter((id) => Object.hasOwn(draft.nodes, id));

/** Stores the value, normalised, on every node of the target. One transaction; it merges with the last of this parameter. */
export function setParamOf(ctx: EditContext, target: EditTarget, param: ParamDef, value: unknown): void {
  ctx.doc.getState().transact(`${targetLabel(target)}: ${paramLabel(param)}`, (draft) => {
    for (const id of held(draft, target.ids)) setParam(draft, ctx.registry, id, param.name, value);
  }, { mergeKey: paramKey(target.ids, param.name) });
}

/** Sets the parameters back to their defaults on every node of the target: one history entry, whatever their number. */
export function resetParamsOf(ctx: EditContext, target: EditTarget, params: readonly ParamDef[]): void {
  if (params.length === 0) return;
  const what = params.length === 1 ? `Reset ${paramLabel(params[0]!)}` : 'Reset Parameters';
  ctx.doc.getState().transact(`${targetLabel(target)}: ${what}`, (draft) => {
    for (const id of held(draft, target.ids)) {
      for (const param of params) resetParam(draft, ctx.registry, id, param.name);
    }
  });
}

export function setFlagsOf(ctx: Pick<EditContext, 'doc'>, ids: readonly string[], label: string, flags: { bypass?: boolean; title?: string | null }): void {
  ctx.doc.getState().transact(label, (draft) => {
    for (const id of held(draft, ids)) setNodeFlags(draft, id, flags);
  });
}

/**
 * One project setting. The build resolution and the preview level are no undo steps (runtime.md 8.5 rule 5); the
 * others are, and merge like a parameter.
 */
export function setSettingOf(ctx: Pick<EditContext, 'doc'>, name: SettingName, value: number): void {
  const patch: Partial<ProjectSettings> = { [name]: value };
  ctx.doc.getState().transact(`Project: ${SETTING_LABELS[name]}`, (draft) => setSettings(draft, patch), isUndoableSetting(name)
    ? { mergeKey: settingKey(name) }
    : { undoable: false });
}

/** A seed as the dice button draws it: any integer of the seed's range, 0 .. 2^32 − 1. */
export function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]!;
}

export interface Gesture {
  /** Pointer down on a control that drags (runtime.md 8.5 rule 4). */
  begin(): void;
  /** Pointer up. `kept` false: Escape took the drag back, and the control has stored the value it began with. */
  end(kept?: boolean): void;
}

/**
 * The gesture of one control. Everything transacted with `key` between `begin` and `end` is one history entry.
 * A drag that was taken back leaves none: its entry, which by then changes nothing, is undone, so that the next
 * undo is the step before the drag.
 */
export function createGesture(doc: StoreApi<DocState>, key: string): Gesture {
  /** The length of the history when the gesture began; null while none is in progress. */
  let before: number | null = null;
  return {
    begin() {
      const state = doc.getState();
      before = state.past.length;
      state.beginGesture(key);
    },
    end(kept = true) {
      const began = before;
      before = null;
      const state = doc.getState();
      if (state.gesture === key) state.endGesture();
      if (kept || began === null) return;
      const { past, undo } = doc.getState();
      if (past.length === began + 1 && past[past.length - 1]!.mergeKey === key) undo();
    },
  };
}
