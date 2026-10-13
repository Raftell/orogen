// A line of text. While it has the focus the field holds its own text: Enter or leaving the field commits it,
// Escape takes it back.

import { useRef, useState, type InputHTMLAttributes, type Ref } from 'react';

import './controls.css';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  readonly value: string;
  /** Every change of the text while it is typed. */
  onChange?(value: string): void;
  /** The text as it is when the user is done with it: on Enter, and on leaving the field with a text that differs from `value`. */
  onCommit?(value: string): void;
  /** Draws the field as holding something that will not be accepted. */
  readonly invalid?: boolean;
  /** Selects the whole text when the field gets the focus. */
  readonly selectOnFocus?: boolean;
  readonly ref?: Ref<HTMLInputElement>;
}

export function TextField(props: TextFieldProps) {
  const { value, onChange, onCommit, invalid, selectOnFocus, className, onFocus, onBlur, onKeyDown, ...rest } = props;
  /** The text while it is being typed; null: the field shows `value`. */
  const [draft, setDraftState] = useState<string | null>(null);
  // Read by the blur that follows Enter or Escape in the same task, before the next render.
  const held = useRef<string | null>(null);
  const setDraft = (text: string | null): void => {
    held.current = text;
    setDraftState(text);
  };

  return (
    <input
      type="text"
      spellCheck={false}
      autoComplete="off"
      className={className ? `og-text-field ${className}` : 'og-text-field'}
      data-ui="text-field"
      data-invalid={invalid ? '' : undefined}
      value={draft ?? value}
      onChange={(event) => {
        setDraft(event.target.value);
        onChange?.(event.target.value);
      }}
      onFocus={(event) => {
        if (selectOnFocus) event.target.select();
        onFocus?.(event);
      }}
      onBlur={(event) => {
        const text = held.current;
        setDraft(null);
        if (text !== null && text !== value) onCommit?.(text);
        onBlur?.(event);
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          const text = held.current;
          setDraft(null);
          if (text !== null) onCommit?.(text);
          event.currentTarget.blur();
        } else if (event.key === 'Escape' && held.current !== null) {
          // The field takes the key: a dialog around it stays open.
          event.stopPropagation();
          const text = held.current;
          setDraft(null);
          if (text !== value) onChange?.(value);
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          // Nothing was typed: the key is whoever's is around the field (a dialog closes), and the field is left
          // all the same. A field that kept the focus would take the next plain key, B or Delete, as text.
          event.currentTarget.blur();
        }
      }}
      {...rest}
    />
  );
}
