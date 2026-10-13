// An enum parameter: a list of its options. A stored value that is none of them is shown as it is stored.

import type { EnumParam } from '../../../../core/api.ts';
import { Select } from '../../../ui/index.ts';
import type { ControlProps } from './types.ts';

export function EnumControl(props: ControlProps<EnumParam, string>) {
  return <Select id={props.id} aria-label={props.label} value={props.value} options={props.param.options} disabled={props.disabled} onChange={props.change} />;
}
