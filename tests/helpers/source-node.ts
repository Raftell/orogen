import { defineNode, type NodeDef } from '../../src/core/api.ts';
import { checkFieldData, type FieldData } from './field-data.ts';

// The harness's private node types (testing.md 2.1). A port has one kind (engine.md 4.2), so there is one type
// for each kind of data: `ref/harness-source` uploads a field, `ref/harness-source-color` a colour. An instance
// names its data by a key of the table below; the data never enters the document.

interface Entry {
  readonly kind: 'field' | 'color';
  /** What the instance uploads at an evaluation resolution. A literal field has one; a fixture named by a graph gains one per resolution. */
  readonly byRes: Map<number, FieldData>;
  readonly label: string;
}

const table = new Map<string, Entry>();
let nextKey = 0;

export const SOURCE_TYPES: Readonly<Record<'field' | 'color', string>> = { field: 'ref/harness-source', color: 'ref/harness-source-color' };

function source(kind: 'field' | 'color'): NodeDef {
  return defineNode({
    type: SOURCE_TYPES[kind],
    title: kind === 'field' ? 'Harness Source (Reference)' : 'Harness Color Source (Reference)',
    category: 'ref',
    description: `Uploads a ${kind} the test process holds.`,
    inputs: [],
    outputs: [{ name: 'out', type: kind }],
    params: [{ kind: 'text', name: 'data', default: '', help: 'The key of the data in the table of the test process.' }],
    kernels: [],
    evaluate(ctx) {
      const entry = table.get(ctx.params.data);
      if (!entry) throw new Error(`The harness holds no data under the key "${ctx.params.data}"`);
      const data = entry.byRes.get(ctx.res);
      if (!data) {
        const held = [...entry.byRes.keys()].map((res) => `${res} x ${res}`).join(', ') || 'none';
        throw new Error(`${entry.label} has no data at ${ctx.res} x ${ctx.res} (held: ${held})`);
      }
      const out = ctx.alloc(kind);
      ctx.write(out, data.data);
      ctx.output('out', out);
    },
  });
}

const DEFS: Readonly<Record<'field' | 'color', NodeDef>> = { field: source('field'), color: source('color') };

/** The two source types. The same definitions on every call. */
export function harnessSources(): readonly NodeDef[] {
  return [DEFS.field, DEFS.color];
}

export interface SourceHandle {
  /** The node type whose instance uploads the data. */
  readonly type: string;
  /** The parameter values that make an instance upload it. */
  readonly params: Readonly<Record<string, string>>;
  readonly kind: 'field' | 'color';
  /** The data at a resolution, when the table holds it. */
  dataAt(res: number): FieldData | undefined;
  /** Gives the source its data at one more resolution: a fixture named by a graph is made per evaluation. */
  provide(data: FieldData): void;
  /** Removes the data from the table. An instance evaluated afterwards fails. */
  release(): void;
}

/** Stores CPU data for a source node of this process. `data` may follow later, through provide(). */
export function createSource(kind: 'field' | 'color', label: string, data?: FieldData): SourceHandle {
  const key = `k${++nextKey}`;
  const entry: Entry = { kind, byRes: new Map(), label };
  table.set(key, entry);
  const handle: SourceHandle = {
    type: SOURCE_TYPES[kind],
    params: { data: key },
    kind,
    dataAt: (res) => entry.byRes.get(res),
    provide(given) {
      checkFieldData(given, label);
      if (given.kind !== kind) throw new TypeError(`${label} is a ${kind}; the data is a ${given.kind}`);
      if (given.width !== given.height) throw new RangeError(`${label} is ${given.width} x ${given.height}; a field that crosses a port is square`);
      entry.byRes.set(given.width, given);
    },
    release() {
      table.delete(key);
    },
  };
  if (data) handle.provide(data);
  return handle;
}
