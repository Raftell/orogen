// src/core/nodes/select/_params.ts
import type { ParamDef } from '../../api.ts';

/** The last parameter of every node of the category but select/peaks, where inverting means the opposite landform. */
export const invert = {
  kind: 'bool', name: 'invert', label: 'Invert', default: false,
  help: 'Selects what was left out and leaves out what was selected.',
} as const satisfies ParamDef;
