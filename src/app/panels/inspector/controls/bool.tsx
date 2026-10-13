// A bool parameter: a checkbox. The row's label names it.

import type { BoolParam } from '../../../../core/api.ts';
import { Checkbox } from '../../../ui/index.ts';
import type { ControlProps } from './types.ts';

export function BoolControl(props: ControlProps<BoolParam, boolean>) {
  return <Checkbox id={props.id} aria-label={props.label} checked={props.value === true} disabled={props.disabled} onChange={props.change} />;
}
