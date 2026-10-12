import { NodeDefError } from '../gpu/errors.ts';
import type { NodeDef } from './node.ts';

export interface NodeRegistry {
  get(type: string): NodeDef | undefined;
  list(): readonly NodeDef[];            // in the order of the list the registry was made from
}

/** Pure. Throws NodeDefError for two definitions of one type. */
export function createRegistry(defs: readonly NodeDef[]): NodeRegistry {
  const byType = new Map<string, NodeDef>();
  for (const def of defs) {
    if (byType.has(def.type)) throw new NodeDefError(`node "${def.type}": the list holds two definitions of this type`);
    byType.set(def.type, def);
  }
  const list: readonly NodeDef[] = Object.freeze([...defs]);
  return {
    get: (type) => byType.get(type),
    list: () => list,
  };
}
