import type { Mutable } from './commands.ts';

export interface PortRef { readonly node: string; readonly port: string }

export interface ProjectSettings {
  readonly terrainSize: number;        // metres across the terrain
  readonly heightRange: number;        // metres represented by height 1.0
  readonly seed: number;               // project seed, integer 0 .. 2^32 − 1
  readonly buildResolution: number;    // vertices per side of a build (engine.md 1.5)
  readonly previewLevel: number;       // ladder level of buildResolution used for previews
  readonly seaLevel: number;           // normalised height
}

export interface NodeInstance {
  readonly id: string;
  readonly type: string;               // NodeDef.type
  readonly version: number;            // NodeDef.version the params were stored with
  readonly position: { readonly x: number; readonly y: number };
  readonly params: Readonly<Record<string, unknown>>;
  readonly title?: string;             // user's label; default NodeDef.title
  readonly bypass?: boolean;           // default false
  readonly collapsed?: boolean;        // default false
}

export interface Edge { readonly id: string; readonly from: PortRef; readonly to: PortRef }   // from an output, to an input

/** A visual group of nodes in the graph editor. It has no effect on evaluation. */
export interface NodeGroup {
  readonly id: string;
  readonly title: string;
  readonly color?: string;             // '#rrggbb'
  readonly rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

export interface ViewBinding {
  readonly height?: PortRef;           // the terrain shown; absent: a flat plane
  readonly overlay?: { readonly ref: PortRef; readonly as: 'color' | 'mask' | 'heat'; readonly opacity: number };
  readonly locked?: boolean;           // true: selecting a node does not change the view
}

export interface GraphDoc {
  readonly format: 'orogen';
  readonly version: 1;                 // version of this schema
  readonly settings: ProjectSettings;
  readonly nodes: Readonly<Record<string, NodeInstance>>;
  readonly edges: Readonly<Record<string, Edge>>;
  readonly groups: Readonly<Record<string, NodeGroup>>;
  readonly ui: {
    readonly view?: ViewBinding;       // 7.4
    readonly graphViewport?: { readonly x: number; readonly y: number; readonly zoom: number };
  };
}

// A document is plain JSON (runtime.md 4.1). The helpers below are the only way this folder copies and compares it.

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A record's own member. An id is any string (4.5), so `record[id]` alone would find `constructor` on the prototype. */
export function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** A deep copy of arrays and plain objects that shares nothing with `value`. Reads through an immer draft, which structuredClone cannot. */
export function cloneJson<T>(value: T): Mutable<T> {
  if (Array.isArray(value)) return value.map((item) => cloneJson(item)) as Mutable<T>;
  // fromEntries defines members; assigning one named `__proto__` would set the copy's prototype instead.
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).map((key) => [key, cloneJson(value[key])])) as Mutable<T>;
  return value as Mutable<T>;
}

/** Deep equality of JSON values. The order of an object's members does not count. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]));
  }
  return false;
}
