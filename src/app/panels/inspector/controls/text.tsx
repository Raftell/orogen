// A text parameter: a line of text, stored when it is entered or the field is left.

import type { TextParam } from '../../../../core/api.ts';
import { TextField } from '../../../ui/index.ts';
import type { ControlProps } from './types.ts';

/** engine.md 4.3: the length of a text whose definition gives none. */
const TEXT_MAX_LENGTH = 256;

export function TextControl(props: ControlProps<TextParam, string>) {
  return (
    <TextField
      id={props.id}
      aria-label={props.label}
      value={props.value}
      maxLength={props.param.maxLength ?? TEXT_MAX_LENGTH}
      disabled={props.disabled}
      onCommit={props.change}
    />
  );
}
