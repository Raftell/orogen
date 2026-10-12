import type { GpuCaps } from '../gpu/caps.ts';
import type { EnginePreferences } from './session.ts';

/** vramBytes null, budgetFraction 0.6 (runtime.md 2.4). */
export const DEFAULT_PREFERENCES: EnginePreferences = { vramBytes: null, budgetFraction: 0.6 };

const FRACTION_MIN = 0.3;
const FRACTION_MAX = 0.85;
/** The video memory assumed when neither the preference nor the platform says how much there is. */
const VRAM_UNKNOWN_BYTES = 4 * 2 ** 30;

/**
 * What the session leaves for fields beside what the engine has reserved, whatever the preferences say
 * (runtime.md 2.4): sixteen fields of a 1009 x 1009 preview. A budget below the reserved bytes fails every
 * allocation, the scratch of `inspect` included.
 */
export const MIN_FIELD_BYTES = 64 * 2 ** 20;

/** The budget the session applies: that of the preferences, and at least the reserved bytes plus MIN_FIELD_BYTES. */
export function budgetInForce(wantedBytes: number, reservedBytes: number): number {
  return Math.max(wantedBytes, reservedBytes + MIN_FIELD_BYTES);
}

const bytes = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

/**
 * runtime.md 2.4: floor(vram × fraction), with vram the preference when set, else caps.vramBytes, else 4 GiB,
 * and the fraction limited to 0.3 .. 0.85.
 */
export function budgetBytes(caps: GpuCaps, prefs: EnginePreferences): number {
  const vram = bytes(prefs.vramBytes) ?? bytes(caps.vramBytes) ?? VRAM_UNKNOWN_BYTES;
  const wanted = Number.isFinite(prefs.budgetFraction) ? prefs.budgetFraction : DEFAULT_PREFERENCES.budgetFraction;
  return Math.floor(vram * Math.min(FRACTION_MAX, Math.max(FRACTION_MIN, wanted)));
}
