import type { Field } from '../gpu/field.ts';
import type { NodeDef } from './node.ts';

export type PortType = 'field' | 'color' | 'any';
export type PortRole = 'height' | 'mask' | 'data';

export interface PortDef {
  readonly name: string;
  readonly type: PortType | { readonly sameAs: string };
  readonly role?: PortRole;
  readonly label?: string;
  readonly optional?: boolean;
}

export type PortNamed<Ports extends readonly PortDef[], N> =
  string extends Ports[number]['name'] ? Ports[number] : Extract<Ports[number], { name: N }>;
export type KindOfPortType<T> = T extends 'field' ? 'field' : T extends 'color' ? 'color' : 'field' | 'color';
/** The field of an 'any' port is a union of two handle types, so a test of `kind` narrows it. */
export type FieldOfPortType<T> = T extends 'field' ? Field<'field'> : T extends 'color' ? Field<'color'> : Field<'field'> | Field<'color'>;
export type InputField<Port extends PortDef> =
  FieldOfPortType<Port['type']> | (Port extends { optional: true } ? null : PortDef extends Port ? null : never);

/** The input the evaluator appends to a maskable node (engine.md 4.13 rule 2). */
export const MASK_PORT = { name: 'mask', type: 'field', role: 'mask', optional: true } as const satisfies PortDef;

/** The inputs a connection can target: the declared ones, then MASK_PORT for a maskable node. */
export function inputsOf(def: NodeDef): readonly PortDef[] {
  return def.maskable ? [...def.inputs, MASK_PORT] : def.inputs;
}

/** engine.md 4.14: inputs[0] and outputs[0] exist with the same type. */
export function canBypass(def: Pick<NodeDef, 'inputs' | 'outputs'>): boolean {
  const input = def.inputs[0];
  const output = def.outputs[0];
  if (!input || !output) return false;
  if (typeof output.type === 'object') return input.type === 'any' && output.type.sameAs === input.name;
  return (output.type === 'field' || output.type === 'color') && input.type === output.type;
}
