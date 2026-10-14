// The field a list is searched with: the command palette, the graph's add-node palette and the library's node
// list all type into this one. The caller holds the text, so the field can be cleared from outside (a list that
// takes a letter typed on it, a search that ends), and every key reaches the caller first: the arrows, Enter and
// Escape of a list are the list's. What the caller leaves, the field does: Escape empties a field that holds text.

import { useRef, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type Ref } from 'react';

import { IconButton } from './Button.tsx';
import './controls.css';
import { Icon } from './icons.tsx';

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  readonly value: string;
  /** Every change of the text: typed, or emptied by Escape or by the button. */
  onChange(value: string): void;
  /**
   * `boxed` (default): a bordered field in a panel, with a button that empties it. `plain`: the first line of a
   * palette, which has its own frame and closes on Escape.
   */
  readonly variant?: 'boxed' | 'plain';
  /** Drawn after the text, inside the field's line: what a palette says of what it was opened for. */
  readonly end?: ReactNode;
  readonly ref?: Ref<HTMLInputElement>;
}

export function SearchField(props: SearchFieldProps) {
  const { value, onChange, variant = 'boxed', end, ref, className, onKeyDown, ...rest } = props;
  /** The input, for the button that gives the keyboard back to it. */
  const input = useRef<HTMLInputElement | null>(null);
  const setRef = (element: HTMLInputElement | null): void => {
    input.current = element;
    if (typeof ref === 'function') ref(element);
    else if (ref) ref.current = element;
  };

  function keyDown(event: KeyboardEvent<HTMLInputElement>): void {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === 'Escape' && value !== '') {
      // The field takes the key: whatever is around it (a dialog, a panel's own Escape) stays as it is.
      event.preventDefault();
      event.stopPropagation();
      onChange('');
    }
  }

  return (
    <div className="og-search" data-ui="search-field" data-variant={variant}>
      <Icon name="search" className="og-search-icon" />
      <input
        ref={setRef}
        type="text"
        spellCheck={false}
        autoComplete="off"
        className={className ? `og-search-input ${className}` : 'og-search-input'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={keyDown}
        {...rest}
      />
      {end}
      {variant === 'boxed' && value !== '' ? (
        <span className="og-search-clear">
          <IconButton
            icon="close" label="Clear the search" keyLabel="Esc" size="small" data-action="clear"
            onClick={() => {
              onChange('');
              input.current?.focus();
            }}
          />
        </span>
      ) : null}
    </div>
  );
}
