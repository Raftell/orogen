import { cloneJson, isPlainObject, type NodeInstance } from './doc.ts';
import type { NodeDef } from './node.ts';
import { normalizeStored } from './params.ts';
import type { NodeRegistry } from './registry.ts';

/**
 * A node stored with a version below the definition's: `migrate` applied once per step, `version` raised
 * (engine.md 4.6, runtime.md 4.5). Returns the instance itself when its version is not lower. Lets a throw of
 * `migrate` propagate; the caller then keeps the instance unchanged.
 */
export function migrateNode(def: NodeDef, node: NodeInstance): NodeInstance {
  const target = def.version ?? 1;
  if (!(node.version < target)) return node;
  // `migrate` works on a copy, so one that changes its argument and then throws leaves the instance as it was.
  let params: Record<string, unknown> = cloneJson(node.params);
  for (let from = node.version; from < target; from++) {
    if (typeof def.migrate !== 'function') throw new Error(`node "${def.type}" has version ${target} and no migrate function`);
    const next: unknown = def.migrate(params, from);
    if (!isPlainObject(next)) throw new TypeError(`migrate of node "${def.type}" returned no params for version ${from + 1}`);
    params = cloneJson(next);
  }
  return { ...node, version: target, params };
}

/**
 * A stored node as this build holds it, by the table of runtime.md 4.5: unchanged for an unknown type, a newer
 * version or a failed migration; otherwise migrated, with every param outside its limits normalised. One
 * sentence per row of the table that reports a problem. The loader and pasteNodes share it.
 */
export function loadNode(registry: NodeRegistry, node: NodeInstance): { readonly node: NodeInstance; readonly problems: readonly string[] } {
  const def = registry.get(node.type);
  if (!def) return { node, problems: [`Unknown node type "${node.type}"`] };
  const version = def.version ?? 1;
  if (node.version > version) {
    return { node, problems: [`Saved with version ${node.version} of this node; this build has version ${version}`] };
  }
  let loaded = node;
  try {
    loaded = migrateNode(def, node);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { node, problems: [`Saved with version ${node.version} of this node; the migration to version ${version} failed: ${why}`] };
  }
  const { params, problems, error } = normalizeStored(def, loaded.params);
  if (params !== loaded.params) loaded = { ...loaded, params };
  return { node: loaded, problems: error === null ? problems : [...problems, error] };
}
