// What the six acceptance tests share (testing.md 10.2, 10.3): where a graph's project file is, its expectation
// file, and fields computed in a test from the fields an evaluation delivered.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { expectStats, type FieldData, type StatName } from '../helpers/index.ts';

const GRAPHS = import.meta.dirname;

/** The project file of an acceptance graph, as the harness takes it. */
export const graphFile = (name: string): string => path.join(GRAPHS, `${name}.orogen`);

/** testing.md 10.3: statistics, never values or images. */
export interface GraphExpectation {
  readonly res: number;
  readonly targets: Readonly<Record<string, Partial<Record<StatName, readonly [lo: number, hi: number]>>>>;
}

export function expectationOf(name: string): GraphExpectation {
  const file = path.join(GRAPHS, `${name}.expect.json`);
  const held = JSON.parse(fs.readFileSync(file, 'utf8')) as GraphExpectation;
  assert.ok(Number.isInteger(held.res) && Object.keys(held.targets).length > 0, `${file} names a resolution and targets`);
  return held;
}

/**
 * Holds the targets of a graph's expectation file to its ranges. `fields` are those of one evaluation at the
 * resolution of the file; a target the file names and the evaluation did not deliver fails. For a colour the
 * statistics are those of channel 0.
 */
export function expectTargets(name: string, fields: Readonly<Record<string, FieldData>>): void {
  const expectation = expectationOf(name);
  for (const [target, ranges] of Object.entries(expectation.targets)) {
    const field = fields[target];
    assert.ok(field, `${name}.expect.json names ${target}, which the evaluation did not deliver`);
    assert.equal(field.width, expectation.res, `${target} was evaluated at the resolution of the expectation file`);
    // Every range is at least 2e-4 wide: what one adapter computes differs from another's by a few 1e-6.
    for (const [stat, [lo, hi]] of Object.entries(ranges)) assert.ok(hi - lo >= 2e-4 - 1e-12, `${name}.expect.json: the range of ${stat} of ${target} is ${hi - lo} wide`);
    try {
      expectStats(field, ranges);
    } catch (thrown) {
      throw new assert.AssertionError({ message: `${target}: ${(thrown as Error).message} (tests/graphs/${name}.expect.json)` });
    }
  }
}

export const saturate = (v: number): number => Math.min(1, Math.max(0, v));

/** A field of the size of `like`, computed texel by texel in float64 and stored as float32. */
export function fieldFrom(like: FieldData, value: (texel: number) => number): FieldData {
  const data = new Float32Array(like.width * like.height);
  for (let i = 0; i < data.length; i++) data[i] = value(i);
  return { kind: 'field', width: like.width, height: like.height, channels: 1, data };
}

/** A colour of the size of `like`, computed texel by texel; alpha 1. */
export function colorFrom(like: FieldData, value: (texel: number) => readonly [number, number, number]): FieldData {
  const data = new Float32Array(like.width * like.height * 4);
  for (let i = 0; i < like.width * like.height; i++) data.set([...value(i), 1], i * 4);
  return { kind: 'color', width: like.width, height: like.height, channels: 4, data };
}

/** How many nodes of a report ended in each state, as `id: state` in the order given. */
export const states = (report: { readonly nodes: Readonly<Record<string, { readonly state: string }>> }, ids: readonly string[]): string[] =>
  ids.map((id) => `${id}: ${report.nodes[id]?.state ?? 'not reported'}`);
