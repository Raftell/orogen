// The manifest and the report of a build (export-unreal.md section 6 and 3.10): their types, the JSON schema of
// the manifest, and how both become text. Pure: no Node module, no GPU, no I/O.

import type { BuildProblem, ImageItem, LandscapeLayout } from '../core/runtime.ts';
import type { LandscapeTransform, TextureSide, Vec3 } from './unreal.ts';
import { Z_SCALE_FORMULA } from './unreal.ts';

/** The version of Orogen that writes the build: `version` of package.json. */
export const GENERATOR_VERSION = '0.1.0';
export const MANIFEST_SCHEMA_ID = 'orogen.unreal.landscape/1';
export const REPORT_SCHEMA_ID = 'orogen.build-report/1';
export const TARGET_ENGINE = '5.8';

export interface ManifestLayer {
  name: string;
  r8: string;
  png: string;
  blend: 'none' | 'final' | 'advanced';
  base: boolean;
  meanWeight: number;
}

export interface ManifestLandscape {
  layout: { quadsPerSection: LandscapeLayout['quadsPerSection']; sectionsPerComponent: 1 | 2; components: { x: number; y: number } };
  heightmap: {
    r16: string;
    png: string;
    rangeMode: 'measured' | 'fixed';
    valueMin: number;
    valueMax: number;
    heightMinM: number;
    heightMaxM: number;
    measuredMin: number;
    measuredMax: number;
    clippedSamples: number;
    zScaleFormula: typeof Z_SCALE_FORMULA;
    dither: 'none' | 'tpdf-1lsb';
  };
  transform: {
    scaleCm: Vec3;
    actorLocationCm: Vec3;
    uiLocationCm: Vec3;
    rotationDeg: { pitch: 0; yaw: 0; roll: 0 };
  };
  orientation: { pixel00: 'minX_minY'; imageX: '+X'; imageY: '+Y'; flipYAxis: false };
  seaLevelZCm: number;
  worldPartition: { enabled: boolean; gridSize: number; regionSize: number };
  alphamapType: 'Additive';
  layers: ManifestLayer[];
}

export interface ManifestTexture {
  content: 'color' | 'data' | 'mask' | 'normal';
  file: string;
  size: TextureSide;
  channels: 1 | 3;
  bits: 8 | 16;
  srgb: boolean;
  covers: 'landscapeExtent';
  sampling: 'texel-center';
  normalEncoding?: 'xyz-landscape-axes';
}

export interface ManifestImage {
  file: string;
  format: ImageItem['format'];
  width: number;
  height: number;
  valueMin: number | null;
  valueMax: number | null;
}

/** Members are in the order of the example of 6.2, which is the order they are written in. */
export interface Manifest {
  schema: typeof MANIFEST_SCHEMA_ID;
  status: 'complete';
  generator: { name: 'Orogen'; version: string };
  targetEngine: typeof TARGET_ENGINE;
  project: { seed: number };
  terrain: { sizeM: number; heightRangeM: number; seaLevel: number };
  resolution: { x: number; y: number };
  landscape: ManifestLandscape | null;
  textures: ManifestTexture[];
  images: ManifestImage[];
  splines: null;
  files: { path: string; bytes: number }[];
}

/** 3.10. */
export interface BuildReport {
  schema: typeof REPORT_SCHEMA_ID;
  status: 'ok' | 'errors' | 'aborted' | 'device-lost';
  generator: { name: 'Orogen'; version: string };
  startedUtc: string;                            // ISO 8601
  endedUtc: string;
  durationMs: number;
  resolution: number;
  problems: BuildProblem[];
  targets: {
    nodeId: string;
    nodeType: string;
    title: string;
    kind: 'landscape' | 'layer' | 'texture' | 'image';
    evaluateMs: number | null;                   // from the end of the previous stage to this target's delivery; null when not reached
    exportMs: number | null;                     // duration of its stage
    min: number | null;                          // measured field values, where the stage measured them
    max: number | null;
  }[];
  weightsMs: number | null;                      // duration of phase 3
  commitMs: number | null;                       // duration of phase 4: every file closed and the manifest written; null when the build did not reach it
  peakPoolBytes: number | null;                  // the most the pool's ledger held at once while the build ran: GPU memory, in bytes; null when no engine ran
  height: null | {
    measuredMin: number; measuredMax: number;    // normalised heights
    valueMin: number; valueMax: number;          // normalised heights mapped to codes 0 and 65535
    clippedSamples: number;
  };
  layers: { name: string; base: boolean; blend: 'none' | 'final' | 'advanced'; meanWeight: number }[];
  files: { path: string; bytes: number }[];      // files made visible, in the order of plan.files
}

/** The `transform` member of a landscape, from the arithmetic of 5.5. */
export function manifestTransform(t: LandscapeTransform): ManifestLandscape['transform'] {
  const vec = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });
  return { scaleCm: vec(t.scaleCm), actorLocationCm: vec(t.actorLocationCm), uiLocationCm: vec(t.uiLocationCm), rotationDeg: { pitch: 0, yaw: 0, roll: 0 } };
}

/** The `layout` member of a landscape, from `landscapeLayout(resolution)`. */
export function manifestLayout(layout: LandscapeLayout): ManifestLandscape['layout'] {
  return { quadsPerSection: layout.quadsPerSection, sectionsPerComponent: layout.sectionsPerComponent, components: { x: layout.components, y: layout.components } };
}

export const ORIENTATION: ManifestLandscape['orientation'] = { pixel00: 'minX_minY', imageX: '+X', imageY: '+Y', flipYAxis: false };

/**
 * UTF-8 JSON, two-space indented, with a final newline, keys in the order the value holds them and numbers as
 * JavaScript writes them: the shortest text that reads back to the same float64 (6, 3.10).
 */
export function serializeJson(value: Manifest | BuildReport): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const vec3 = { $ref: '#/$defs/vec3' } as const;
const size = { $ref: '#/$defs/size' } as const;

/** 6.1. */
export const MANIFEST_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: MANIFEST_SCHEMA_ID,
  title: 'Orogen build manifest',
  type: 'object',
  required: ['schema', 'status', 'generator', 'targetEngine', 'project', 'terrain', 'resolution', 'landscape', 'textures', 'images', 'splines', 'files'],
  properties: {
    schema: { const: MANIFEST_SCHEMA_ID },
    status: { const: 'complete' },
    generator: {
      type: 'object', required: ['name', 'version'],
      properties: { name: { const: 'Orogen' }, version: { type: 'string' } },
    },
    targetEngine: { const: TARGET_ENGINE },
    project: {
      type: 'object', required: ['seed'],
      properties: { seed: { type: 'integer', minimum: 0, maximum: 4294967295 } },
    },
    terrain: {
      type: 'object', required: ['sizeM', 'heightRangeM', 'seaLevel'],
      properties: {
        sizeM: { type: 'number', exclusiveMinimum: 0, description: 'Terrain width, first vertex to last vertex, metres.' },
        heightRangeM: { type: 'number', exclusiveMinimum: 0, description: 'Metres represented by the normalised height 1.0.' },
        seaLevel: { type: 'number', description: "The project's sea level as a normalised height." },
      },
    },
    resolution: { ...size, description: 'Vertices per side of the build. x equals y.' },
    landscape: {
      oneOf: [
        { type: 'null' },
        {
          type: 'object',
          required: ['layout', 'heightmap', 'transform', 'orientation', 'seaLevelZCm', 'worldPartition', 'alphamapType', 'layers'],
          properties: {
            layout: {
              type: 'object', required: ['quadsPerSection', 'sectionsPerComponent', 'components'],
              properties: {
                quadsPerSection: { enum: [7, 15, 31, 63, 127, 255] },
                sectionsPerComponent: { enum: [1, 2], description: 'Per side: 2 is shown as 2x2 in Unreal.' },
                components: size,
              },
            },
            heightmap: {
              type: 'object',
              required: ['r16', 'png', 'rangeMode', 'valueMin', 'valueMax', 'heightMinM', 'heightMaxM', 'measuredMin', 'measuredMax', 'clippedSamples', 'zScaleFormula', 'dither'],
              properties: {
                r16: { type: 'string', description: 'uint16 little-endian, row-major, row 0 first, no header.' },
                png: { type: 'string', description: '16-bit greyscale PNG holding the same codes.' },
                rangeMode: { enum: ['measured', 'fixed'] },
                valueMin: { type: 'number', description: 'Normalised height stored as code 0.' },
                valueMax: { type: 'number', description: 'Normalised height stored as code 65535.' },
                heightMinM: { type: 'number', description: 'World Z of code 0, metres.' },
                heightMaxM: { type: 'number', description: 'World Z of code 65535, metres.' },
                measuredMin: { type: 'number', description: 'Smallest normalised height of the terrain.' },
                measuredMax: { type: 'number', description: 'Largest normalised height of the terrain.' },
                clippedSamples: { type: 'integer', minimum: 0 },
                zScaleFormula: { const: Z_SCALE_FORMULA },
                dither: { enum: ['none', 'tpdf-1lsb'] },
              },
            },
            transform: {
              type: 'object', required: ['scaleCm', 'actorLocationCm', 'uiLocationCm', 'rotationDeg'],
              properties: {
                scaleCm: { ...vec3, description: 'Actor scale: cm per quad in x and y; cm per 128 codes in z.' },
                actorLocationCm: { ...vec3, description: 'Actor location: world position of pixel (0, 0) at code 32768.' },
                uiLocationCm: { ...vec3, description: "The terrain's centre in x and y with the actor's z." },
                rotationDeg: {
                  type: 'object', required: ['pitch', 'yaw', 'roll'],
                  properties: { pitch: { const: 0 }, yaw: { const: 0 }, roll: { const: 0 } },
                },
              },
            },
            orientation: {
              type: 'object', required: ['pixel00', 'imageX', 'imageY', 'flipYAxis'],
              properties: {
                pixel00: { const: 'minX_minY' }, imageX: { const: '+X' }, imageY: { const: '+Y' },
                flipYAxis: { const: false },
              },
            },
            seaLevelZCm: { type: 'number', description: "World Z of the project's sea level." },
            worldPartition: {
              type: 'object', required: ['enabled', 'gridSize', 'regionSize'],
              properties: {
                enabled: { type: 'boolean' },
                gridSize: { type: 'integer', minimum: 1, maximum: 16 },
                regionSize: { type: 'integer', minimum: 4, maximum: 64 },
              },
            },
            alphamapType: { const: 'Additive' },
            layers: {
              type: 'array',
              items: {
                type: 'object', required: ['name', 'r8', 'png', 'blend', 'base', 'meanWeight'],
                properties: {
                  name: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,62}$' },
                  r8: { type: 'string', description: 'uint8, row-major, row 0 first, no header, landscape resolution.' },
                  png: { type: 'string', description: '8-bit greyscale PNG holding the same bytes.' },
                  blend: {
                    enum: ['none', 'final', 'advanced'],
                    description: 'ELandscapeTargetLayerBlendMethod: None, FinalWeightBlending, PremultipliedAlphaBlending.',
                  },
                  base: { type: 'boolean' },
                  meanWeight: { type: 'number', minimum: 0, maximum: 1 },
                },
              },
            },
          },
        },
      ],
    },
    textures: {
      type: 'array',
      items: {
        type: 'object', required: ['content', 'file', 'size', 'channels', 'bits', 'srgb', 'covers', 'sampling'],
        properties: {
          content: { enum: ['color', 'data', 'mask', 'normal'] },
          file: { type: 'string' },
          size: { enum: [1024, 2048, 4096, 8192] },
          channels: { enum: [1, 3] },
          bits: { enum: [8, 16] },
          srgb: { type: 'boolean', description: 'True when the file holds sRGB-encoded colour: content color. False for data, which is stored as it is.' },
          covers: { const: 'landscapeExtent' },
          sampling: { const: 'texel-center' },
          normalEncoding: { const: 'xyz-landscape-axes', description: 'Present for content normal.' },
        },
      },
    },
    images: {
      type: 'array',
      items: {
        type: 'object', required: ['file', 'format', 'width', 'height', 'valueMin', 'valueMax'],
        properties: {
          file: { type: 'string' },
          format: { enum: ['png8', 'png16', 'r16', 'r32', 'exr', 'tiff16', 'tiff32'] },
          width: { type: 'integer' },
          height: { type: 'integer' },
          valueMin: { type: ['number', 'null'], description: 'Field value stored as the lowest code; null for float formats.' },
          valueMax: { type: ['number', 'null'], description: 'Field value stored as the highest code; null for float formats.' },
        },
      },
    },
    splines: { type: 'null' },
    files: {
      type: 'array',
      description: 'Every file of the build except the manifest and the report.',
      items: {
        type: 'object', required: ['path', 'bytes'],
        properties: { path: { type: 'string' }, bytes: { type: 'integer', minimum: 0 } },
      },
    },
  },
  $defs: {
    size: {
      type: 'object', required: ['x', 'y'],
      properties: { x: { type: 'integer', minimum: 1 }, y: { type: 'integer', minimum: 1 } },
    },
    vec3: {
      type: 'object', required: ['x', 'y', 'z'],
      properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
    },
  },
} as const;
