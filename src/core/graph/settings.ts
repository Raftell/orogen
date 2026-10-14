import type { ProjectSettings } from './doc.ts';
import { isBuildResolution, ladder, ladderLevel, MAX_LEVEL } from './ladder.ts';

/** The defaults of runtime.md 4.2. */
export const DEFAULT_SETTINGS: ProjectSettings = {
  terrainSize: 4032,
  heightRange: 1008,
  seed: 0,
  buildResolution: 4033,
  previewLevel: 2,
  seaLevel: 0,
};

const SEED_MAX = 2 ** 32 - 1;
const BUILD_MIN = 129;
const BUILD_MAX = 8177;   // the largest B <= 8192 with (B − 1) divisible by 16

type Fix = { readonly value: number; readonly problem: string | null };

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const show = (v: unknown): string => (typeof v === 'number' ? String(v) : JSON.stringify(v) ?? String(v));

function fallback(name: keyof ProjectSettings, stored: Readonly<Record<string, unknown>>): Fix {
  const value = DEFAULT_SETTINGS[name];
  return {
    value,
    problem: Object.hasOwn(stored, name) && stored[name] !== undefined
      ? `setting "${name}": ${show(stored[name])} is not a finite number; the default ${value} is used`
      : `setting "${name}" is missing; the default ${value} is used`,
  };
}

function ranged(name: keyof ProjectSettings, stored: Readonly<Record<string, unknown>>, min: number, max: number, integer: boolean): Fix {
  const v = stored[name];
  if (!finite(v)) return fallback(name, stored);
  const value = Math.min(max, Math.max(min, integer ? Math.floor(v) : v));
  if (value === v) return { value, problem: null };
  const want = integer ? `an integer in ${min}..${max}` : `in ${min}..${max}`;
  return { value, problem: `setting "${name}": ${v} is not ${want}; ${value} is used` };
}

function buildResolution(stored: Readonly<Record<string, unknown>>): Fix {
  const v = stored.buildResolution;
  if (!finite(v)) return fallback('buildResolution', stored);
  if (isBuildResolution(v)) return { value: v, problem: null };
  const value = Math.min(BUILD_MAX, Math.max(BUILD_MIN, Math.round((v - 1) / 16) * 16 + 1));
  return { value, problem: `setting "buildResolution": ${v} is not a build resolution; ${value} is used` };
}

function previewLevel(stored: Readonly<Record<string, unknown>>, build: number): Fix {
  const v = stored.previewLevel;
  const base: Fix = finite(v) ? { value: v, problem: null } : fallback('previewLevel', stored);
  let value = Math.min(MAX_LEVEL, Math.max(0, Math.floor(base.value)));
  // Level 0 of a build resolution is always defined; the loop stops there whatever `build` is.
  while (value > 0 && ladderLevel(build, value) === null) value--;
  if (base.problem !== null || value === v) return { value, problem: base.problem };
  return {
    value,
    problem: Number.isInteger(v) && (v as number) >= 0
      ? `setting "previewLevel": level ${show(v)} is not defined for build resolution ${build}; lowered to ${value}`
      : `setting "previewLevel": ${show(v)} is not a ladder level; ${value} is used`,
  };
}

/**
 * The valid settings nearest to `stored` by the table of runtime.md 4.2: a missing or invalid member takes its
 * default or is clamped, and previewLevel is lowered to the largest level buildResolution defines. One sentence
 * per member that was changed. The one implementation behind parseDoc and setSettings.
 *
 * Members keep the order `stored` has them in, and members it has beyond the six are kept. When nothing was
 * changed the result is `stored` itself.
 */
export function normalizeSettings(stored: Readonly<Record<string, unknown>>): {
  readonly settings: ProjectSettings;
  readonly problems: readonly string[];
} {
  const build = buildResolution(stored);
  const fixes: Record<keyof ProjectSettings, Fix> = {
    terrainSize: ranged('terrainSize', stored, 1, 1_000_000, false),
    heightRange: ranged('heightRange', stored, 1, 100_000, false),
    seed: ranged('seed', stored, 0, SEED_MAX, true),
    buildResolution: build,
    previewLevel: previewLevel(stored, build.value),
    seaLevel: finite(stored.seaLevel) ? { value: stored.seaLevel, problem: null } : fallback('seaLevel', stored),
  };
  const names = Object.keys(fixes) as (keyof ProjectSettings)[];
  const problems = names.flatMap((name) => fixes[name].problem ?? []);
  if (problems.length === 0) return { settings: stored as unknown as ProjectSettings, problems };
  const settings: Record<string, unknown> = { ...stored };
  for (const name of names) settings[name] = fixes[name].value;
  return { settings: settings as unknown as ProjectSettings, problems };
}

/** (buildResolution − 1) / 2^previewLevel + 1. */
export function previewResolution(settings: ProjectSettings): number {
  return (settings.buildResolution - 1) / 2 ** settings.previewLevel + 1;
}

/**
 * The ladder level of `buildResolution` whose resolution is nearest to `resolution`, in vertices per side; of two
 * equally near, the coarser, which is the cheaper. Level 0, the build resolution itself, is a preview level like
 * any other (runtime.md 4.2).
 */
export function previewLevelNearest(buildResolution: number, resolution: number): number {
  const levels = ladder(buildResolution);
  let nearest = 0;
  for (let k = 1; k < levels.length; k++) {
    if (Math.abs(levels[k]! - resolution) <= Math.abs(levels[nearest]! - resolution)) nearest = k;
  }
  return nearest;
}

/**
 * What `setSettings` is given when the build resolution changes (runtime.md 4.2): the new build resolution as
 * normalizeSettings stores it, and the preview level that keeps the preview resolution nearest to what it is
 * now. Without it a smaller build would coarsen the previews with it and a larger one make them as much heavier.
 */
export function withBuildResolution(settings: ProjectSettings, next: number): { readonly buildResolution: number; readonly previewLevel: number } {
  const build = buildResolution({ buildResolution: next }).value;
  return { buildResolution: build, previewLevel: previewLevelNearest(build, previewResolution(settings)) };
}
