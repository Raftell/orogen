// The whole product in one document (testing.md 8.1, 8.4): registryDoc holds one instance of every node of
// src/core/nodes/index.ts, and one evaluation at 129 runs them all. Every node ends `done`, except a node with
// a `file` parameter, whose file is not selected, and what reads it. tests/electron/kernels.test.ts evaluates
// the same document inside the application.
//
// Sizes: fields of 129 x 129; no list is handed to an assertion.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { NodeDef } from '../../src/core/api.ts';
import { nodes } from '../../src/core/nodes/index.ts';
import { expectFinite, expectMask, registryDoc, renderGraph } from '../helpers/index.ts';

const hasFile = (def: NodeDef): boolean => def.params.some((param) => param.kind === 'file');

test('registry: one instance of every node of the product evaluates at 129', async () => {
  const doc = registryDoc(nodes);
  const byType = new Map(nodes.map((def) => [def.type, def]));
  const withOutputs = nodes.filter((def) => def.outputs.length > 0);
  for (const def of withOutputs) {
    const instances = Object.values(doc.nodes).filter((node) => node.type === def.type);
    assert.ok(instances.length >= 1, `the document holds an instance of ${def.type}`);
  }

  // The first terrain is the product's own, smooth valleys under rough crests (testing.md 2.4): its instance
  // feeds the first height input of the other nodes, and the mask is a slope mask of its first two octaves.
  const typeOf = (id: string): string => doc.nodes[id]!.type;
  const eroded = Object.keys(doc.nodes).filter((id) => typeOf(id) === 'generate/eroded-noise');
  if (byType.has('generate/eroded-noise')) {
    const first = eroded.find((id) => doc.nodes[id]!.params.octaves === 8), broad = eroded.find((id) => doc.nodes[id]!.params.octaves === 2);
    assert.ok(first !== undefined && broad !== undefined && eroded.length === 2, `the document holds the first terrain and its broad shape: ${eroded.length} nodes of generate/eroded-noise`);
    const fed = Object.values(doc.edges).filter((edge) => edge.from.node === first && edge.to.port === 'in').map((edge) => typeOf(edge.to.node));
    for (const type of ['filter/blur', 'select/slope', 'adjust/levels']) if (byType.has(type)) assert.ok(fed.includes(type), `${type} reads the first terrain`);
    assert.deepEqual(Object.values(doc.edges).filter((edge) => edge.from.node === broad).map((edge) => typeOf(edge.to.node)), ['ref/slope-mask']);
  }

  // An input the wiring knows by name is fed what it is named for (testing.md 2.4): the stamp of surface/scatter
  // a landform, the flow and the snow of color/natural the drainage of the first terrain and the snow on it.
  const feedOf = (type: string, port: string): string | null => {
    const node = Object.values(doc.nodes).find((candidate) => candidate.type === type);
    const edge = node && Object.values(doc.edges).find((candidate) => candidate.to.node === node.id && candidate.to.port === port);
    return edge ? `${typeOf(edge.from.node)}.${edge.from.port}` : null;
  };
  for (const [type, port, feed] of [['surface/scatter', 'stamp', 'generate/volcano.out'], ['color/natural', 'flow', 'simulate/flow.out'], ['color/natural', 'snow', 'simulate/snow.snow']] as const) {
    if (byType.has(type) && byType.has(feed.split('.')[0]!)) assert.equal(feedOf(type, port), feed, `${type}: the input ${port}`);
  }
  if (byType.has('color/natural') && byType.has('simulate/flow') && eroded.length > 0) {
    // The drainage is that of the terrain the node itself reads.
    const natural = Object.values(doc.nodes).find((candidate) => candidate.type === 'color/natural')!;
    const terrain = Object.values(doc.edges).find((edge) => edge.to.node === natural.id && edge.to.port === 'in')!.from.node;
    const flow = Object.values(doc.edges).find((edge) => edge.to.node === natural.id && edge.to.port === 'flow')!.from.node;
    assert.deepEqual(Object.values(doc.edges).filter((edge) => edge.to.node === flow).map((edge) => edge.from.node), [terrain]);
  }

  // Every node is a target, and so is every output: nothing of the product is left unevaluated.
  const ids = Object.keys(doc.nodes);
  const outputs = ids.flatMap((id) => (byType.get(doc.nodes[id]!.type)?.outputs ?? []).map((port) => ({ id, port, target: `${id}.${port.name}` })));
  const { fields, report } = await renderGraph(doc, [...ids, ...outputs.map((o) => o.target)], { res: 129, outputs: 'all' });

  // What reads a node with a file parameter, directly or not, may be skipped with it. Each node is queued once.
  const excused = new Set(ids.filter((id) => { const def = byType.get(doc.nodes[id]!.type); return def !== undefined && hasFile(def); }));
  const queue = [...excused];
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    for (const edge of Object.values(doc.edges)) {
      if (edge.from.node !== id || excused.has(edge.to.node)) continue;
      excused.add(edge.to.node);
      queue.push(edge.to.node);
    }
  }

  const problems: string[] = [];
  for (const id of ids) {
    const type = doc.nodes[id]!.type;
    const node = report.nodes[id];
    if (!node) problems.push(`${type}: the evaluation reported nothing`);
    else if (node.state === 'error' && ['shader-compile', 'binding', 'validation', 'internal'].includes(node.error!.kind)) {
      problems.push(`${type}: ${node.error!.kind}: ${node.error!.message}${node.error!.detail ? `\n${node.error!.detail}` : ''}`);
    } else if (node.state !== 'done' && !excused.has(id)) {
      problems.push(`${type}: ended ${node.state}${node.error ? ` (${node.error.kind}: ${node.error.message})` : ''}${node.upstream ? ` behind ${doc.nodes[node.upstream]?.type ?? node.upstream}` : ''}`);
    }
  }
  for (const { id, port, target } of outputs) {
    const field = fields[target];
    if (!field) {
      if (!excused.has(id)) problems.push(`${doc.nodes[id]!.type}: the output "${port.name}" was not delivered`);
      continue;
    }
    try {
      expectFinite(field);
      if (port.type === 'field' && port.role === 'mask') expectMask(field);
    } catch (thrown) {
      problems.push(`${doc.nodes[id]!.type}: output "${port.name}": ${(thrown as Error).message}`);
    }
  }
  assert.equal(problems.length, 0, `${problems.length} problems:\n${problems.slice(0, 25).join('\n')}`);
  assert.ok(report.nodesRun >= withOutputs.filter((def) => !hasFile(def)).length, `${report.nodesRun} nodes ran`);
});
