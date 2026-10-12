import type { GpuCaps } from '../gpu/caps.ts';
import type { EnginePreferences } from './session.ts';

/** vramBytes null, budgetFraction 0.6 (runtime.md 2.4). */
export const DEFAULT_PREFERENCES: EnginePreferences = { vramBytes: null, budgetFraction: 0.6 };

/**
 * runtime.md 2.4: floor(vram × fraction), with vram the preference when set, else caps.vramBytes, else 4 GiB,
 * and the fraction limited to 0.3 .. 0.85.
 */
export function budgetBytes(caps: GpuCaps, prefs: EnginePreferences): number {
  throw new Error('not implemented: budgetBytes');
}
