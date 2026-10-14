// The project settings as the inspector offers them (runtime.md 4.2): the build resolutions Unreal takes, the
// preview levels a build resolution has with the resolution each gives, and the numbers shown beside them.
// No DOM and no React.

import { ladder, previewResolution, type ProjectSettings } from '../../../core/runtime.ts';
import { formatMetres, type NumberRange, type NumberUnits } from '../../ui/number.ts';

/** The landscape sizes of Unreal Engine that are build resolutions (engine.md 1.5). */
export const UNREAL_RESOLUTIONS: readonly number[] = [1009, 2017, 4033, 8129];

export interface PreviewLevel {
  readonly level: number;
  readonly resolution: number;
}

/**
 * The preview levels a build resolution defines, finest first: the core's own ladder (engine.md 1.5), of which
 * level 0 is the build resolution itself (runtime.md 4.2).
 */
export function previewLevels(settings: Pick<ProjectSettings, 'buildResolution'>): PreviewLevel[] {
  return ladder(settings.buildResolution).map((resolution, level) => ({ level, resolution }));
}

/**
 * What the previews are computed at, in words: '1009 × 1009, a quarter of the build's vertices per side', and
 * for level 0 'the build resolution itself'.
 */
export function previewResolutionText(settings: ProjectSettings): string {
  const resolution = previewResolution(settings);
  const share = settings.previewLevel === 0 ? 'the build resolution itself'
    : `1/${2 ** settings.previewLevel} of the build's ${resolutionLabel(settings.buildResolution)}`;
  return `${resolutionLabel(resolution)}, ${share}`;
}

export const resolutionLabel = (resolution: number): string => `${resolution} × ${resolution}`;

/** '1/4 · 1009 × 1009': the share of the build resolution's cells per side, and the vertices that gives. */
export function previewLevelLabel(level: PreviewLevel): string {
  return `${level.level === 0 ? 'Full' : `1/${2 ** level.level}`} · ${resolutionLabel(level.resolution)}`;
}

/** The choices of the build resolution: Unreal's sizes, and the project's own when it is another. */
export function buildResolutionOptions(current: number): { readonly value: string; readonly label: string }[] {
  const options = UNREAL_RESOLUTIONS.map((resolution) => ({ value: String(resolution), label: resolutionLabel(resolution) }));
  if (!UNREAL_RESOLUTIONS.includes(current)) options.push({ value: String(current), label: `${resolutionLabel(current)} (custom)` });
  return options;
}

/** Metres between two vertices of a build: 1 for the default project, which is Unreal's 100 cm per quad. */
export function metresPerVertex(settings: Pick<ProjectSettings, 'terrainSize' | 'buildResolution'>): number {
  return settings.terrainSize / (settings.buildResolution - 1);
}

/** '1 m', '0.5 m', '2.25 m' */
export function formatSpacing(metres: number): string {
  if (!Number.isFinite(metres)) return '';
  return `${Number(metres.toPrecision(3))} m`;
}

/**
 * Where the top of the height range lies: in metres, and against the sea. A sea level above the range puts all of
 * it under water, which is said so and not as a negative height above the sea.
 */
export function highestPointText(settings: Pick<ProjectSettings, 'heightRange' | 'seaLevel'>): string {
  const top = `${formatMetres(1, settings.heightRange)} at height 1`;
  const above = 1 - settings.seaLevel;
  if (!Number.isFinite(above)) return top;
  return above >= 0
    ? `${top}, ${formatMetres(above, settings.heightRange)} above the sea`
    : `${top}, ${formatMetres(-above, settings.heightRange)} below the sea`;
}

/** A size in metres is typed in metres or kilometres. */
export const METRE_UNITS: NumberUnits = { m: 1, km: 1000 };

/** The limits of runtime.md 4.2, and the part of them a drag covers. */
export const TERRAIN_SIZE_RANGE: NumberRange = { min: 1, max: 1_000_000, softMin: 256, softMax: 65536, scale: 'log', step: 1 };
export const HEIGHT_RANGE_RANGE: NumberRange = { min: 1, max: 100_000, softMin: 64, softMax: 16384, scale: 'log', step: 1 };
/** The sea level is a normalised height and may lie below the range, which means no sea (runtime.md 4.2). */
export const SEA_LEVEL_RANGE: NumberRange = { softMin: 0, softMax: 1 };

export type SettingName = keyof ProjectSettings;

export const SETTING_LABELS: Readonly<Record<SettingName, string>> = {
  terrainSize: 'Terrain size',
  heightRange: 'Height range',
  seaLevel: 'Sea level',
  seed: 'Seed',
  buildResolution: 'Build resolution',
  previewLevel: 'Preview',
};

export const SETTING_HELP: Readonly<Record<SettingName, string>> = {
  terrainSize: 'Width of the terrain in meters. Lengths in the graph are fractions of it, so the shape stays and only its scale changes.',
  heightRange: 'Meters that a height of 1 stands for. A larger range makes every slope steeper.',
  seaLevel: 'Height at and below which the terrain is sea. A value below the terrain means no sea.',
  seed: 'Changes every random feature of the project at once.',
  buildResolution: 'Vertices per side of a build. These are the landscape sizes Unreal Engine takes.',
  previewLevel: 'Resolution of the previews, as a share of the build resolution. Coarser is faster.',
};

/** runtime.md 8.5 rule 5: these two are no undo steps, and no undoable transaction touches them. */
export const isUndoableSetting = (name: SettingName): boolean => name !== 'buildResolution' && name !== 'previewLevel';
