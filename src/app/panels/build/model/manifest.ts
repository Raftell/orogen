// Reading what a build wrote (export-unreal.md 3.10, section 6): the manifest and the report, as files. The
// panel is a reader like any other: it takes the members it shows, rejects a major version it does not know and
// ignores members it does not know. And the manifest's numbers laid out as Unreal's New Landscape panel asks for
// them (section 7.2). Every number is shown as the manifest writes it: no number is rounded, and none is computed.
// No DOM and no React.

import { joinPath } from './paths.ts';

export interface Vec3 { readonly x: number; readonly y: number; readonly z: number }

export interface ManifestLayer {
  readonly name: string;
  readonly png: string;
  readonly r8: string;
  readonly blend: 'none' | 'final' | 'advanced';
  readonly base: boolean;
  readonly meanWeight: number;
}

export interface ManifestLandscape {
  readonly layout: { readonly quadsPerSection: number; readonly sectionsPerComponent: number; readonly components: { readonly x: number; readonly y: number } };
  readonly heightmap: {
    readonly png: string; readonly r16: string; readonly rangeMode: string; readonly dither: string;
    readonly heightMinM: number; readonly heightMaxM: number; readonly clippedSamples: number;
  };
  readonly transform: { readonly scaleCm: Vec3; readonly actorLocationCm: Vec3; readonly uiLocationCm: Vec3 };
  readonly seaLevelZCm: number;
  readonly worldPartition: { readonly enabled: boolean; readonly gridSize: number; readonly regionSize: number };
  readonly alphamapType: string;
  readonly layers: readonly ManifestLayer[];
}

export interface ManifestView {
  readonly schema: string;
  readonly generator: string;
  readonly targetEngine: string;
  readonly resolution: { readonly x: number; readonly y: number };
  readonly terrain: { readonly sizeM: number; readonly heightRangeM: number; readonly seaLevel: number };
  readonly landscape: ManifestLandscape | null;
  readonly textures: readonly { readonly file: string; readonly content: string; readonly size: number; readonly bits: number; readonly srgb: boolean }[];
  readonly images: readonly { readonly file: string; readonly format: string; readonly width: number; readonly height: number }[];
  readonly files: readonly { readonly path: string; readonly bytes: number }[];
}

export type Read<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

const MANIFEST_FAMILY = 'orogen.unreal.landscape/';
const REPORT_FAMILY = 'orogen.build-report/';
const KNOWN_MAJOR = '1';

/** A member that is missing or not of its type. The message names it by its path in the file. */
class Malformed extends Error {}

type Json = Readonly<Record<string, unknown>>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

function object(of: Json, name: string, path: string): Json {
  const value = of[name];
  if (!isObject(value)) throw new Malformed(`${path}${name} is missing`);
  return value;
}
function number(of: Json, name: string, path: string): number {
  const value = of[name];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Malformed(`${path}${name} is not a number`);
  return value;
}
function text(of: Json, name: string, path: string): string {
  const value = of[name];
  if (typeof value !== 'string') throw new Malformed(`${path}${name} is not a text`);
  return value;
}
function list(of: Json, name: string, path: string): Json[] {
  const value = of[name];
  if (!Array.isArray(value) || !value.every(isObject)) throw new Malformed(`${path}${name} is not a list`);
  return value as Json[];
}
const vec3 = (of: Json, name: string, path: string): Vec3 => {
  const value = object(of, name, path);
  return { x: number(value, 'x', `${path}${name}.`), y: number(value, 'y', `${path}${name}.`), z: number(value, 'z', `${path}${name}.`) };
};

/** The JSON object of a file with the schema of `family` in a version this reader knows. */
function jsonFile(source: string, family: string, what: string): Json {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Malformed(`The ${what} is not JSON`);
  }
  if (!isObject(value) || typeof value.schema !== 'string' || !value.schema.startsWith(family)) throw new Malformed(`The file is no ${what} of Orogen`);
  const major = value.schema.slice(family.length);
  if (major !== KNOWN_MAJOR) throw new Malformed(`The ${what} has the version ${major}, which this version of Orogen does not read`);
  return value;
}

function reading<T>(read: () => T): Read<T> {
  try {
    return { ok: true, value: read() };
  } catch (thrown) {
    if (thrown instanceof Malformed) return { ok: false, reason: thrown.message };
    throw thrown;
  }
}

export function parseManifest(source: string): Read<ManifestView> {
  return reading(() => {
    const root = jsonFile(source, MANIFEST_FAMILY, 'manifest');
    const resolution = object(root, 'resolution', '');
    const terrain = object(root, 'terrain', '');
    const generator = isObject(root.generator) && typeof root.generator.version === 'string' ? `Orogen ${root.generator.version}` : 'Orogen';

    let landscape: ManifestLandscape | null = null;
    if (root.landscape !== null) {
      const land = object(root, 'landscape', '');
      const layout = object(land, 'layout', 'landscape.');
      const components = object(layout, 'components', 'landscape.layout.');
      const heightmap = object(land, 'heightmap', 'landscape.');
      const transform = object(land, 'transform', 'landscape.');
      const partition = object(land, 'worldPartition', 'landscape.');
      landscape = {
        layout: {
          quadsPerSection: number(layout, 'quadsPerSection', 'landscape.layout.'),
          sectionsPerComponent: number(layout, 'sectionsPerComponent', 'landscape.layout.'),
          components: { x: number(components, 'x', 'landscape.layout.components.'), y: number(components, 'y', 'landscape.layout.components.') },
        },
        heightmap: {
          png: text(heightmap, 'png', 'landscape.heightmap.'), r16: text(heightmap, 'r16', 'landscape.heightmap.'),
          rangeMode: text(heightmap, 'rangeMode', 'landscape.heightmap.'), dither: text(heightmap, 'dither', 'landscape.heightmap.'),
          heightMinM: number(heightmap, 'heightMinM', 'landscape.heightmap.'), heightMaxM: number(heightmap, 'heightMaxM', 'landscape.heightmap.'),
          clippedSamples: number(heightmap, 'clippedSamples', 'landscape.heightmap.'),
        },
        transform: {
          scaleCm: vec3(transform, 'scaleCm', 'landscape.transform.'),
          actorLocationCm: vec3(transform, 'actorLocationCm', 'landscape.transform.'),
          uiLocationCm: vec3(transform, 'uiLocationCm', 'landscape.transform.'),
        },
        seaLevelZCm: number(land, 'seaLevelZCm', 'landscape.'),
        worldPartition: {
          enabled: partition.enabled === true,
          gridSize: number(partition, 'gridSize', 'landscape.worldPartition.'), regionSize: number(partition, 'regionSize', 'landscape.worldPartition.'),
        },
        alphamapType: text(land, 'alphamapType', 'landscape.'),
        layers: list(land, 'layers', 'landscape.').map((layer, i) => {
          const at = `landscape.layers[${i}].`;
          const blend = text(layer, 'blend', at);
          if (blend !== 'none' && blend !== 'final' && blend !== 'advanced') throw new Malformed(`${at}blend is "${blend}", which is no blend method`);
          return { name: text(layer, 'name', at), png: text(layer, 'png', at), r8: text(layer, 'r8', at), blend, base: layer.base === true, meanWeight: number(layer, 'meanWeight', at) };
        }),
      };
    }
    return {
      schema: text(root, 'schema', ''),
      generator,
      targetEngine: typeof root.targetEngine === 'string' ? root.targetEngine : '',
      resolution: { x: number(resolution, 'x', 'resolution.'), y: number(resolution, 'y', 'resolution.') },
      terrain: { sizeM: number(terrain, 'sizeM', 'terrain.'), heightRangeM: number(terrain, 'heightRangeM', 'terrain.'), seaLevel: number(terrain, 'seaLevel', 'terrain.') },
      landscape,
      textures: list(root, 'textures', '').map((texture, i) => ({
        file: text(texture, 'file', `textures[${i}].`), content: text(texture, 'content', `textures[${i}].`),
        size: number(texture, 'size', `textures[${i}].`), bits: number(texture, 'bits', `textures[${i}].`), srgb: texture.srgb === true,
      })),
      images: list(root, 'images', '').map((image, i) => ({
        file: text(image, 'file', `images[${i}].`), format: text(image, 'format', `images[${i}].`),
        width: number(image, 'width', `images[${i}].`), height: number(image, 'height', `images[${i}].`),
      })),
      files: list(root, 'files', '').map((file, i) => ({ path: text(file, 'path', `files[${i}].`), bytes: number(file, 'bytes', `files[${i}].`) })),
    };
  });
}

// ---- the report --------------------------------------------------------------------------------------------------------

export interface ReportView {
  readonly status: string;
  readonly durationMs: number;
  readonly resolution: number;
  readonly targets: readonly {
    readonly nodeId: string; readonly title: string; readonly kind: string;
    /** The time the nodes took that lead to this target; null: the build did not come to it. */
    readonly evaluateMs: number | null;
    /** The time its conversion and encoding took. */
    readonly exportMs: number | null;
  }[];
  readonly weightsMs: number | null;
  readonly commitMs: number | null;
  readonly files: readonly { readonly path: string; readonly bytes: number }[];
}

const optionalNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export function parseReport(source: string): Read<ReportView> {
  return reading(() => {
    const root = jsonFile(source, REPORT_FAMILY, 'build report');
    return {
      status: text(root, 'status', ''),
      durationMs: number(root, 'durationMs', ''),
      resolution: number(root, 'resolution', ''),
      targets: list(root, 'targets', '').map((target, i) => ({
        nodeId: text(target, 'nodeId', `targets[${i}].`), title: text(target, 'title', `targets[${i}].`), kind: text(target, 'kind', `targets[${i}].`),
        evaluateMs: optionalNumber(target.evaluateMs), exportMs: optionalNumber(target.exportMs),
      })),
      weightsMs: optionalNumber(root.weightsMs),
      commitMs: optionalNumber(root.commitMs),
      files: list(root, 'files', '').map((file, i) => ({ path: text(file, 'path', `files[${i}].`), bytes: number(file, 'bytes', `files[${i}].`) })),
    };
  });
}

/** The stages of a build by the report's own figures (3.10): they account for its duration up to the plan and the bookkeeping. */
export function reportStages(report: ReportView): { readonly label: string; readonly ms: number }[] {
  const sum = (pick: (target: ReportView['targets'][number]) => number | null): number => report.targets.reduce((total, target) => total + (pick(target) ?? 0), 0);
  const stages = [
    { label: 'Compute the nodes', ms: sum((target) => target.evaluateMs) },
    { label: 'Convert and encode', ms: sum((target) => target.exportMs) },
  ];
  if (report.weightsMs !== null) stages.push({ label: 'Layer weights', ms: report.weightsMs });
  if (report.commitMs !== null) stages.push({ label: 'Finish the files', ms: report.commitMs });
  return stages;
}

// ---- the numbers Unreal needs ------------------------------------------------------------------------------------------

export interface ImportRow {
  readonly id: string;
  /** The field of Unreal's panel, in its words. */
  readonly label: string;
  /** What to type or choose there. */
  readonly value: string;
  /** `value` in Unreal's own words, where the row shortens them. */
  readonly full?: string;
  /** What the copy button puts on the clipboard; null for a row that is chosen, not typed. */
  readonly copy: string | null;
}

export interface ImportGroup {
  readonly id: string;
  readonly title: string;
  /** The steps of the import guide (section 2) the group belongs to: '7', '10'. */
  readonly step: string;
  /** What to do with the rows, and how far the statement behind them has been checked. */
  readonly note: string;
  readonly rows: readonly ImportRow[];
}

/** A number as the manifest writes it: the shortest text that reads back to the same value (section 6). */
export const exact = (value: number): string => String(value);

/** The layer info to create and its blending method, as Unreal names the two (export-unreal.md 7.2 step 10). */
const BLEND_LABEL: Readonly<Record<ManifestLayer['blend'], string>> = {
  advanced: 'Weight-Blended Layer, Advanced Weight Blending',
  final: 'Weight-Blended Layer, Final Weight Blending (Legacy)',
  none: 'Non Weight-Blended Layer, No Weight Blending',
};
/** The same on one line of a row: a landscape has a dozen layers, and all but a few say the same. */
const BLEND_SHORT: Readonly<Record<ManifestLayer['blend'], string>> = {
  advanced: 'Weight-Blended, Advanced',
  final: 'Weight-Blended, Final (Legacy)',
  none: 'Non Weight-Blended',
};
const BLEND_METHOD: Readonly<Record<ManifestLayer['blend'], string>> = {
  advanced: 'Advanced Weight Blending', final: 'Final Weight Blending (Legacy)', none: 'No Weight Blending',
};

/** What to do with the layers of a build, naming the kinds and methods it has. */
function layersNote(layers: readonly ManifestLayer[]): string {
  const blends = (['advanced', 'final', 'none'] as const).filter((blend) => layers.some((layer) => layer.blend === blend));
  const kinds = blends.map((blend) => (
    blend === 'none'
      ? `Non Weight-Blended: a Non Weight-Blended Layer info with the method ${BLEND_METHOD.none}`
      : `${BLEND_SHORT[blend]}: a Weight-Blended Layer info with the method ${BLEND_METHOD[blend]}`
  ));
  return `For each layer, in the row of the target layer with the same name: create its layer info, set its Weight Blending Method, and choose its file by hand. ${kinds.join('. ')}.`;
}

/**
 * The manifest as the import by hand asks for it, in the order of its steps. `folder` is where the build lies:
 * with it a file's row copies its whole path, which is what a file dialog takes.
 */
export function importGroups(manifest: ManifestView, folder: string | null): ImportGroup[] {
  const file = (name: string): string => (folder === null ? name : joinPath(folder, name));
  const groups: ImportGroup[] = [];
  const land = manifest.landscape;
  if (land) {
    const { layout, transform } = land;
    groups.push({
      id: 'heightmap', title: 'Heightmap', step: '3 to 5',
      note: 'Choose the PNG. Leave Flip Y Axis off, and answer No if Unreal asks about the tiled image path.',
      rows: [
        { id: 'heightmap-file', label: 'Heightmap File', value: land.heightmap.png, copy: file(land.heightmap.png) },
        { id: 'flip-y', label: 'Flip Y Axis', value: 'Off', copy: null },
      ],
    });
    groups.push({
      id: 'layout', title: 'Layout', step: '6',
      note: 'Compare with what the panel shows and correct the panel where it differs.',
      rows: [
        { id: 'section-size', label: 'Section Size', value: `${layout.quadsPerSection}x${layout.quadsPerSection} quads`, copy: exact(layout.quadsPerSection) },
        { id: 'sections', label: 'Sections Per Component', value: `${layout.sectionsPerComponent}x${layout.sectionsPerComponent}`, copy: exact(layout.sectionsPerComponent) },
        { id: 'components', label: 'Number of Components', value: `${layout.components.x} x ${layout.components.y}`, copy: exact(layout.components.x) },
        { id: 'resolution', label: 'Overall Resolution', value: `${manifest.resolution.x} x ${manifest.resolution.y}`, copy: exact(manifest.resolution.x) },
      ],
    });
    groups.push({
      id: 'scale', title: 'Scale', step: '7',
      note: 'Type every digit: a scale shortened to two decimals moves the far edge of the terrain.',
      rows: [
        { id: 'scale-x', label: 'Scale X', value: exact(transform.scaleCm.x), copy: exact(transform.scaleCm.x) },
        { id: 'scale-y', label: 'Scale Y', value: exact(transform.scaleCm.y), copy: exact(transform.scaleCm.y) },
        { id: 'scale-z', label: 'Scale Z', value: exact(transform.scaleCm.z), copy: exact(transform.scaleCm.z) },
      ],
    });
    groups.push({
      id: 'location', title: 'Location', step: '8',
      note: 'This assumes that the panel\'s Location is the center of the landscape, which is unconfirmed; the check after the import settles it.',
      rows: [
        { id: 'location-x', label: 'Location X', value: exact(transform.uiLocationCm.x), copy: exact(transform.uiLocationCm.x) },
        { id: 'location-y', label: 'Location Y', value: exact(transform.uiLocationCm.y), copy: exact(transform.uiLocationCm.y) },
        { id: 'location-z', label: 'Location Z', value: exact(transform.uiLocationCm.z), copy: exact(transform.uiLocationCm.z) },
        { id: 'rotation', label: 'Rotation', value: '0, 0, 0', copy: null },
      ],
    });
    if (land.layers.length > 0) {
      groups.push({
        id: 'layers', title: 'Layers', step: '10',
        note: layersNote(land.layers),
        rows: [
          ...land.layers.flatMap((layer, i): ImportRow[] => [
            { id: `layer-${i}`, label: `${i + 1}. ${layer.name}`, value: BLEND_SHORT[layer.blend], full: BLEND_LABEL[layer.blend], copy: layer.name },
            { id: `layer-${i}-file`, label: 'File', value: layer.png, copy: file(layer.png) },
          ]),
          { id: 'alphamap', label: 'Layer Alphamap Type', value: land.alphamapType, copy: null },
        ],
      });
    }
    groups.push({
      id: 'partition', title: 'World Partition', step: '11',
      note: land.worldPartition.enabled
        ? 'For a level that uses World Partition only.'
        : 'For a level that uses World Partition only. World Partition is switched off on the Unreal Landscape node; these are its values all the same.',
      rows: [
        // The panel names both with "World Partition" before them; the group's title says it here.
        { id: 'grid-size', label: 'Grid Size', value: exact(land.worldPartition.gridSize), copy: exact(land.worldPartition.gridSize) },
        { id: 'region-size', label: 'Region Size', value: exact(land.worldPartition.regionSize), copy: exact(land.worldPartition.regionSize) },
      ],
    });
    groups.push({
      id: 'check', title: 'After the import', step: '13',
      note: 'Select the Landscape actor: its Location must show these values and its Scale those above. If it shows the Location typed before, type these into the actor\'s Location.',
      rows: [
        { id: 'actor-x', label: 'Actor Location X', value: exact(transform.actorLocationCm.x), copy: exact(transform.actorLocationCm.x) },
        { id: 'actor-y', label: 'Actor Location Y', value: exact(transform.actorLocationCm.y), copy: exact(transform.actorLocationCm.y) },
        { id: 'actor-z', label: 'Actor Location Z', value: exact(transform.actorLocationCm.z), copy: exact(transform.actorLocationCm.z) },
      ],
    });
  }
  if (manifest.textures.length > 0) {
    groups.push({
      id: 'textures', title: 'Textures', step: '16',
      note: 'Import as ordinary textures. Sample with U = (WorldX − Actor Location X) / extent and V = (WorldY − Actor Location Y) / extent, where extent is the terrain size in centimeters.',
      rows: [
        ...manifest.textures.map((texture, i): ImportRow => ({
          id: `texture-${i}`, label: texture.file, value: texture.srgb ? 'sRGB on' : 'sRGB off', copy: file(texture.file),
        })),
        { id: 'terrain-size', label: 'Terrain size', value: `${exact(manifest.terrain.sizeM)} m`, copy: exact(manifest.terrain.sizeM) },
      ],
    });
  }
  return groups;
}

/**
 * Every row as one line of text, for the clipboard: 'Scale X<tab>198.4126984126984'. A row that shortens
 * Unreal's words is written out in full: a layer's line says what to create, which its button, copying the
 * layer's name, does not.
 */
export function importText(groups: readonly ImportGroup[]): string {
  return groups.flatMap((group) => [group.title, ...group.rows.map((row) => `${row.label}\t${row.full ?? row.copy ?? row.value}`), '']).join('\n').trimEnd();
}
