// Everything a panel imports of src/app/ui/ (runtime.md 8.7 rule 2). The exports of this file are frozen during
// panel work (8.10): a panel that needs another control asks the shell owner.

export type { AppServices, CommandContext, CommandDef, KeyBinding, MenuEntry, Notice, PanelDef, PanelId } from './types.ts';
export { AppProvider, useApp, useCommandContext, useCommandEnabled } from './app.tsx';

export { Button, CommandButton, IconButton } from './Button.tsx';
export type { ButtonProps, CommandButtonProps, IconButtonProps } from './Button.tsx';
export { Checkbox } from './Checkbox.tsx';
export type { CheckboxProps } from './Checkbox.tsx';
export { ColorSwatch } from './ColorSwatch.tsx';
export type { ColorSwatchProps } from './ColorSwatch.tsx';
export { Dialog } from './Dialog.tsx';
export type { DialogProps } from './Dialog.tsx';
export { Icon, ICON_NAMES } from './icons.tsx';
export type { IconName } from './icons.tsx';
export { EmptyState, PropertyRow, SectionTitle } from './layout.tsx';
export type { PropertyRowProps } from './layout.tsx';
export { commandItems, ContextMenu, Menu, MenuItems } from './Menu.tsx';
export type { ContextMenuProps, MenuItemSpec, MenuProps } from './Menu.tsx';
export { NumberField } from './NumberField.tsx';
export type { NumberFieldProps } from './NumberField.tsx';
export { Popover } from './Popover.tsx';
export type { PopoverProps } from './Popover.tsx';
export { Select } from './Select.tsx';
export type { SelectOption, SelectProps } from './Select.tsx';
export { Slider } from './Slider.tsx';
export type { SliderProps } from './Slider.tsx';
export { TextField } from './TextField.tsx';
export type { TextFieldProps } from './TextField.tsx';
export { Tooltip, TooltipProvider } from './Tooltip.tsx';
export type { TooltipProps } from './Tooltip.tsx';

export { isFailure, nodeErrorText, portLabel } from './node-text.ts';
export { fromDisplay, fromHex, linearToSrgb, srgbToLinear, toDisplay, toHex } from './color.ts';
export type { Rgb } from './color.ts';
export {
  clampValue, editText, fillFraction, formatMetres, formatNumber, metricUnits, parseEntry, precisionOf, stepOf, stepValue,
} from './number.ts';
export type { NumberRange, NumberUnits } from './number.ts';
