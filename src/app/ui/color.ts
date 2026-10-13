// Colours between what the document stores and what a screen shows (engine.md 1.7): a `color` parameter and a
// gradient stop are linear RGB in 0..1; a swatch, a picker and a hex code are sRGB. No DOM and no React.

export type Rgb = readonly [number, number, number];

const unit = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

/** One channel, 0..1. */
export function srgbToLinear(value: number): number {
  const c = unit(value);
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(value: number): number {
  const c = unit(value);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

const byte = (value: number): number => Math.round(unit(value) * 255);

/** The 8-bit sRGB colour a stored colour is shown as. `linear` false: the stored colour is sRGB already. */
export function toDisplay(color: Rgb, linear = true): { r: number; g: number; b: number } {
  const [r, g, b] = linear ? [linearToSrgb(color[0]), linearToSrgb(color[1]), linearToSrgb(color[2])] : color;
  return { r: byte(r!), g: byte(g!), b: byte(b!) };
}

/** The stored colour of an 8-bit sRGB colour. */
export function fromDisplay(shown: { readonly r: number; readonly g: number; readonly b: number }, linear = true): Rgb {
  const channel = (value: number): number => {
    const c = unit(value / 255);
    // Six decimals: more than 8 bits can tell apart, and a document that stays readable.
    return Number((linear ? srgbToLinear(c) : c).toFixed(6));
  };
  return [channel(shown.r), channel(shown.g), channel(shown.b)];
}

export function toHex(color: Rgb, linear = true): string {
  const { r, g, b } = toDisplay(color, linear);
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** '#rrggbb', 'rrggbb', '#rgb' or 'rgb' as a stored colour; null: no hex code. */
export function fromHex(text: string, linear = true): Rgb | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim());
  if (!match) return null;
  const digits = match[1]!.length === 3 ? [...match[1]!].map((d) => d + d).join('') : match[1]!;
  const value = Number.parseInt(digits, 16);
  return fromDisplay({ r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }, linear);
}
