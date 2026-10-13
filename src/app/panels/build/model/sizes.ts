// The build resolution as the panel offers it, and what a build at it needs of the graphics memory.
// No DOM and no React.

import type { LandscapeLayout, ProjectSettings } from '../../../../core/runtime.ts';
import { formatLength } from './format.ts';

/**
 * The resolutions the panel offers: the four rows of Epic's table of recommended landscape sizes that the
 * contract names as build resolutions (export-unreal.md 5.2), with the layout Unreal gives each. They are data
 * of that table, not a formula: whether another size is a landscape is the plan's to say (E_SIZE_NOT_LANDSCAPE).
 */
export const LANDSCAPE_SIZES: readonly (LandscapeLayout & { readonly resolution: number })[] = [
  { resolution: 1009, quadsPerSection: 63, sectionsPerComponent: 2, components: 8, totalComponents: 64 },
  { resolution: 2017, quadsPerSection: 63, sectionsPerComponent: 2, components: 16, totalComponents: 256 },
  { resolution: 4033, quadsPerSection: 63, sectionsPerComponent: 2, components: 32, totalComponents: 1024 },
  { resolution: 8129, quadsPerSection: 127, sectionsPerComponent: 2, components: 32, totalComponents: 1024 },
];

export function presetLayout(resolution: number): LandscapeLayout | null {
  return LANDSCAPE_SIZES.find((size) => size.resolution === resolution) ?? null;
}

/** '8 × 8 components of 2 × 2 sections, 63 × 63 quads each', as the New Landscape panel names the three. */
export function describeLayout(layout: Pick<LandscapeLayout, 'quadsPerSection' | 'sectionsPerComponent' | 'components'>): string {
  const { components: c, sectionsPerComponent: s, quadsPerSection: q } = layout;
  return `${c} × ${c} components of ${s} × ${s} sections, ${q} × ${q} quads each`;
}

export interface ResolutionOption {
  readonly value: string;
  readonly label: string;
}

/**
 * The four sizes, and before them the project's own when it is another: shown as it is stored, so that it can be
 * seen and replaced. `customs` are the other sizes the project had while the list was shown: they stay in it, so
 * that the list does not change under the choice that was just made, and so that the way back is open.
 */
export function resolutionOptions(current: number, customs: readonly number[] = []): ResolutionOption[] {
  const isListed = (resolution: number): boolean => LANDSCAPE_SIZES.some((size) => size.resolution === resolution);
  const own = [...new Set([...customs, current])].filter((resolution) => !isListed(resolution)).sort((a, b) => a - b);
  return [
    ...own.map((resolution) => ({ value: String(resolution), label: `${resolution} × ${resolution} (custom)` })),
    ...LANDSCAPE_SIZES.map((size) => ({ value: String(size.resolution), label: `${size.resolution} × ${size.resolution}` })),
  ];
}

/**
 * The distance between two vertices. N samples span N − 1 quads (export-unreal.md 5.5): the terrain's width is
 * divided by the resolution minus one, never by the resolution.
 */
export function metresPerVertex(settings: Pick<ProjectSettings, 'terrainSize'>, resolution: number): number {
  return settings.terrainSize / (resolution - 1);
}

export function describeSpacing(settings: Pick<ProjectSettings, 'terrainSize'>, resolution: number): string {
  const metres = metresPerVertex(settings, resolution);
  if (!Number.isFinite(metres) || metres <= 0) return '';
  return `${formatLength(metres)} per vertex`;
}

// ---- memory ------------------------------------------------------------------------------------------------------------

/** One sample of a field is an r32float texel, one of a color map an rgba16float texel (runtime.md 2.4). */
const FIELD_BYTES_PER_SAMPLE = 4;
const COLOR_BYTES_PER_SAMPLE = 8;

export const fieldBytes = (resolution: number): number => resolution * resolution * FIELD_BYTES_PER_SAMPLE;
export const colorBytes = (resolution: number): number => resolution * resolution * COLOR_BYTES_PER_SAMPLE;

/** The most pool memory a node held while it ran, and the resolution it ran at. */
export interface Measurement {
  readonly bytes: number;
  readonly resolution: number;
}

/** What of the budget a build cannot use: MemoryReport, as far as the estimate reads it. */
export interface BudgetReport {
  readonly budgetBytes: number;
  readonly reservedBytes: number;
  readonly pinnedBytes: number;
}

export interface MemoryEstimate {
  /** One field at the build resolution. */
  readonly fieldBytes: number;
  readonly budgetBytes: number | null;
  /** What the engine has reserved and what is on screen: no build can use it. */
  readonly heldBytes: number;
  /** The node that needs the most, scaled to the build resolution; null: none was measured. */
  readonly largest: { readonly nodeId: string; readonly bytes: number; readonly measuredAt: number } | null;
  /** A lower bound of what the build holds at its height: `heldBytes` and the largest node, or one field when none was measured. */
  readonly needBytes: number;
  /** `needBytes` as a share of the budget; null without a budget. */
  readonly share: number | null;
  /** `over`: the bound alone is above the budget. `tight`: above four fifths of it. `unknown`: no budget is known yet. */
  readonly level: 'unknown' | 'fits' | 'tight' | 'over';
}

const TIGHT_SHARE = 0.8;

/**
 * What a build at `resolution` needs at the least. A node's working memory is textures of the resolution it
 * runs at, so what a node held in a preview is scaled by the number of samples. The fields that other nodes
 * still need come on top (the build checks those before its first node, runtime.md 5.3), so this is a lower
 * bound: it can say that a build will not fit, never that it will.
 */
export function estimateMemory(input: {
  readonly resolution: number;
  readonly budget: BudgetReport | null;
  readonly peaks: Readonly<Record<string, Measurement>>;
  /** The nodes the document holds: a measurement of a node that is gone counts for nothing. */
  readonly nodeIds: readonly string[];
}): MemoryEstimate {
  const { resolution, budget } = input;
  const samples = resolution * resolution;
  let largest: MemoryEstimate['largest'] = null;
  for (const nodeId of input.nodeIds) {
    const measured = Object.hasOwn(input.peaks, nodeId) ? input.peaks[nodeId] : undefined;
    if (!measured || !(measured.bytes > 0) || !(measured.resolution > 0)) continue;
    const bytes = Math.round(measured.bytes * (samples / (measured.resolution * measured.resolution)));
    if (largest === null || bytes > largest.bytes) largest = { nodeId, bytes, measuredAt: measured.resolution };
  }
  const one = fieldBytes(resolution);
  const heldBytes = budget ? budget.reservedBytes + budget.pinnedBytes : 0;
  const needBytes = heldBytes + (largest ? Math.max(largest.bytes, one) : one);
  const share = budget && budget.budgetBytes > 0 ? needBytes / budget.budgetBytes : null;
  const level = share === null ? 'unknown' : share > 1 ? 'over' : share > TIGHT_SHARE ? 'tight' : 'fits';
  return { fieldBytes: one, budgetBytes: budget?.budgetBytes ?? null, heldBytes, largest, needBytes, share, level };
}
