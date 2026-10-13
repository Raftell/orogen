// An int parameter: the number field in whole numbers, within the parameter's hard limits.

import type { IntParam } from '../../../../core/api.ts';
import { NumberField } from '../../../ui/index.ts';
import styles from '../inspector.module.css';
import { intSpec } from '../model.ts';
import type { ControlProps } from './types.ts';

export function IntControl(props: ControlProps<IntParam, number>) {
  const spec = intSpec(props.param);
  return (
    <NumberField
      id={props.id}
      className={styles.fill}
      aria-label={props.label}
      value={props.value}
      {...spec.range}
      precision={0}
      disabled={props.disabled}
      onChange={props.change}
      onScrubStart={props.begin}
      onScrubEnd={props.end}
    />
  );
}
