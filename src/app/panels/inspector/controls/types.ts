// What every control of the inspector is given (runtime.md 8.7 rule 5): the parameter's definition, its value as
// the evaluator reads it, and the three calls that make an edit a transaction and a drag a gesture.

import type { ParamDef, ParamValue } from '../../../../core/api.ts';
import type { ProjectSettings } from '../../../../core/runtime.ts';

export interface ControlProps<P extends ParamDef = ParamDef, V = ParamValue> {
  readonly param: P;
  readonly value: V;
  /** The id of the element the row's label stands for. */
  readonly id: string;
  /** The parameter's label: the accessible name of the control. */
  readonly label: string;
  readonly disabled: boolean;
  /** For the metres of a length and of a height (engine.md 1.6). */
  readonly settings: ProjectSettings;
  /** The nodes whose parameter this is. */
  readonly nodeIds: readonly string[];
  /** A new value: one transaction, which merges with the last of this parameter (runtime.md 8.5 rule 3). */
  change(value: V): void;
  /** Around a drag: everything changed in between is one history entry (runtime.md 8.5 rule 4). */
  begin(): void;
  /** `kept` false: the drag was taken back and the value it began with is stored again. */
  end(kept?: boolean): void;
}
