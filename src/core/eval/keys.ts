import type { GraphDoc } from '../graph/doc.ts';
import type { NodeDef } from '../graph/node.ts';
import type { ParamValue } from '../graph/param-types.ts';
import type { FileSource } from '../io/files.ts';
import type { EvalPlan, PlanNode } from './plan.ts';

/** Raised when a change to the core alters the result of unchanged nodes (runtime.md 5.4). */
export const KEY_VERSION = 1;

/**
 * The tokens of runtime.md 5.4: wherever a key or a content appears inside another key, its token stands for
 * it. A token is given to one string only and never again to another, so two keys are equal exactly when the
 * content they name is.
 */
export interface TokenTable {
  /** The token of `key`. Inside begin() and end(). */
  of(key: string): number;
  /** Brackets one computation of keys: no token used inside it is forgotten before its end(). */
  begin(): void;
  end(): void;
  readonly size: number;
}

/** Tokens kept beyond those of the computation in progress. A forgotten key gets a new token, which costs cache misses downstream of it and nothing else. */
const TOKEN_LIMIT = 32768;

export function createTokenTable(limit: number = TOKEN_LIMIT): TokenTable {
  /** Least recently used first. */
  const tokens = new Map<string, { readonly token: number; round: number }>();
  let next = 1;
  let round = 0;
  let active = 0;
  return {
    get size() { return tokens.size; },
    of(key) {
      const found = tokens.get(key);
      if (found) {
        tokens.delete(key);
        found.round = round;
        tokens.set(key, found);
        return found.token;
      }
      const token = next++;
      tokens.set(key, { token, round });
      return token;
    },
    begin() {
      if (active++ === 0) round++;
    },
    end() {
      if (--active > 0) return;
      let excess = tokens.size - limit;
      // Entries used in this round sit at the end: the walk stops at the first of them.
      for (const [key, entry] of tokens) {
        if (excess <= 0 || entry.round === round) break;
        tokens.delete(key);
        excess--;
      }
    },
  };
}

/**
 * What a reader receives: the content behind an output or an edge, as the evaluator obtains it. `id` is its
 * cache address (5.4, Entries); a node output is addressed by its node's key and found in that entry by port.
 */
export type Content =
  | { readonly type: 'node'; readonly id: string; readonly kind: 'field' | 'color'; readonly nodeKey: string; readonly port: string }
  | { readonly type: 'convert'; readonly id: string; readonly kind: 'field' | 'color'; readonly source: Content; readonly conversion: 'grey' | 'luma' }
  | { readonly type: 'mask'; readonly id: string; readonly kind: 'field' | 'color'; readonly raw: Content; readonly mask: Content; readonly base: Content }
  | { readonly type: 'const'; readonly id: string; readonly kind: 'field' | 'color' };

/** An output as other keys name it and as readers receive it. The two differ for a bypassed node, whose output is its input's content under a key of its own. */
export interface OutputKey {
  /** JSON.stringify(O(n, port)). */
  readonly key: string;
  readonly content: Content;
}

export interface NodeKeys {
  /** K(n); null for a bypassed node, which has no entry. */
  readonly key: string | null;
  /** contentKey(n). */
  readonly contentKey: string;
  /** By output port. */
  readonly outputs: Readonly<Record<string, OutputKey>>;
  /** The node's own result at outputs[0], before the mask blend: differs from outputs[...].content only for a maskable node whose mask is connected. */
  readonly raw: Readonly<Record<string, Content>>;
  /** By input: what evaluate() reads through the declared inputs, converted where needed, and `mask` for a maskable node. null: unconnected. */
  readonly inputs: Readonly<Record<string, Content | null>>;
  /** JSON.stringify(O(n, port)): the cache address of what readers of that output receive. */
  output(port: string): string;
}

export function constantContent(kind: 'field' | 'color'): Content {
  return { type: 'const', id: JSON.stringify(['const', kind]), kind };
}

/** C(edge): the content an edge or a target delivers, and the value that stands for it inside a key. */
export function edgeContent(tokens: TokenTable, source: OutputKey, conversion: '' | 'grey' | 'luma'): { readonly content: Content; readonly c: readonly [number, string] } {
  const c = [tokens.of(source.key), conversion] as const;
  if (conversion === '') return { content: source.content, c };
  return {
    c,
    content: { type: 'convert', id: JSON.stringify(c), kind: conversion === 'grey' ? 'color' : 'field', source: source.content, conversion },
  };
}

/** Step 3 of runtime.md 5.3 for one node, whose sources have their keys. */
function keysOf(node: PlanNode, def: NodeDef, doc: GraphDoc, external: string, tokens: TokenTable, sources: ReadonlyMap<string, NodeKeys>): NodeKeys {
  const inputs: Record<string, Content | null> = {};
  const cs: Record<string, readonly [number, string] | null> = {};
  for (const input of node.inputs) {
    const source = input.from ? sources.get(input.from.node)?.outputs[input.from.port] : undefined;
    if (!source) {
      inputs[input.port] = null;
      cs[input.port] = null;
      continue;
    }
    const edge = edgeContent(tokens, source, input.conversion);
    inputs[input.port] = edge.content;
    cs[input.port] = edge.c;
  }
  const first = def.inputs[0]?.name;
  const outputs: Record<string, OutputKey> = {};
  const raw: Record<string, Content> = {};

  if (node.bypassed) {
    // 5.6: outputs[0] is what inputs[0] would read; every other output is the constant of its kind.
    def.outputs.forEach((port, index) => {
      const kind = node.outputKinds[port.name]!;
      const through = index === 0 && first !== undefined ? inputs[first] : null;
      if (through) {
        outputs[port.name] = { key: JSON.stringify(cs[first!]), content: through };
      } else {
        const constant = constantContent(kind);
        outputs[port.name] = { key: constant.id, content: constant };
      }
      raw[port.name] = outputs[port.name]!.content;
    });
    const contentKey = outputs[def.outputs[0]!.name]!.key;
    return { key: null, contentKey, outputs, raw, inputs, output: (port) => outputs[port]!.key };
  }

  const settings = doc.settings;
  const key = JSON.stringify([
    KEY_VERSION, def.type, def.version ?? 1,
    def.params.map((p) => node.params![p.name]),
    def.inputs.map((p) => cs[p.name] ?? null),
    [
      settings.terrainSize, settings.heightRange,
      def.params.some((p) => p.kind === 'seed') ? settings.seed : null,
      ...(def.uses ?? []).map((name) => settings[name]),
    ],
    external,
  ]);
  const token = tokens.of(key);
  def.outputs.forEach((port, index) => {
    const kind = node.outputKinds[port.name]!;
    const id = JSON.stringify([token, port.name]);
    const own: Content = { type: 'node', id, kind, nodeKey: key, port: port.name };
    raw[port.name] = own;
    const mask = index === 0 && def.maskable ? inputs.mask : null;
    if (mask) {
      // O of a masked output: ['mask', K(n), C(edge into mask), C(edge into inputs[0])].
      const blended = JSON.stringify(['mask', token, cs.mask, first !== undefined ? cs[first] ?? null : null]);
      const base = (first !== undefined ? inputs[first] : null) ?? constantContent(kind);
      outputs[port.name] = { key: blended, content: { type: 'mask', id: blended, kind, raw: own, mask, base } };
    } else {
      outputs[port.name] = { key: id, content: own };
    }
  });
  const primary = def.outputs[0];
  return {
    key,
    contentKey: primary ? outputs[primary.name]!.key : key,
    outputs, raw, inputs,
    output: (port) => outputs[port]!.key,
  };
}

async function externalKeyOf(def: NodeDef, params: Readonly<Record<string, ParamValue>>, files: FileSource): Promise<string> {
  if (def.externalKey) {
    const key = await def.externalKey({ params, stat: (path) => files.stat(path) });
    if (typeof key !== 'string') throw new TypeError(`externalKey of "${def.type}" returned ${typeof key}, not a string`);
    return key;
  }
  return def.params.some((p) => p.kind === 'file') ? defaultExternalKey(def, params, files) : '';
}

/**
 * Step 3 of runtime.md 5.3: the keys of every node of the plan that is not blocked, awaiting each
 * externalKey at most once. Whatever an externalKey throws fails that node only: it is absent from the
 * result and reported in `errors` by node id, and so is every node that reads it.
 */
export async function computeKeys(plan: EvalPlan, doc: GraphDoc, files: FileSource, tokens: TokenTable, signal?: AbortSignal): Promise<{
  readonly keys: ReadonlyMap<string, NodeKeys>;
  readonly errors: ReadonlyMap<string, unknown>;
}> {
  const keys = new Map<string, NodeKeys>();
  const errors = new Map<string, unknown>();
  tokens.begin();
  try {
    for (const node of plan.nodes) {
      if (!node.def || node.error || node.upstream !== null) continue;
      // A source without keys failed in this call: its readers have none either.
      if (node.inputs.some((input) => input.from !== null && !keys.has(input.from.node))) continue;
      let external = '';
      if (!node.bypassed) {
        try {
          // Only a node that reads external data is awaited: the others keep the loop synchronous.
          if (node.def.externalKey || node.def.params.some((p) => p.kind === 'file')) {
            external = await externalKeyOf(node.def, node.params!, files);
            if (signal?.aborted) throw signal.reason;
          }
        } catch (thrown) {
          if (signal?.aborted) throw signal.reason;
          errors.set(node.nodeId, thrown);
          continue;
        }
      }
      keys.set(node.nodeId, keysOf(node, node.def, doc, external, tokens, keys));
    }
  } finally {
    tokens.end();
  }
  return { keys, errors };
}

/** runtime.md 6.1 rule 4: for each `file` param in order, [resolve(path), size, mtimeMs] or [resolve(path), null], joined into one string. */
export async function defaultExternalKey(def: NodeDef, params: Readonly<Record<string, ParamValue>>, files: FileSource): Promise<string> {
  const parts: unknown[] = [];
  for (const param of def.params) {
    if (param.kind !== 'file') continue;
    const path = params[param.name];
    // '' is "no file selected" (engine.md 4.12 rule 1); it has no resolved path.
    if (typeof path !== 'string' || path === '') {
      parts.push(['', null]);
      continue;
    }
    const resolved = files.resolve(path);
    const stat = await files.stat(path);
    parts.push(stat ? [resolved, stat.size, stat.mtimeMs] : [resolved, null]);
  }
  return JSON.stringify(parts);
}
