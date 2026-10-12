// src/core/nodes/ref/fail.ts
import { defineNode } from '../../api.ts';

export default defineNode({
  type: 'ref/fail',
  title: 'Fail (Reference)',
  category: 'ref',
  description: 'Raises the error typed into it, or passes its input on when there is none; the reference node for documented errors.',
  keywords: ['error', 'throw', 'test'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    // A text, because the conformance suite varies every other kind of parameter and expects each value to evaluate.
    { kind: 'text', name: 'message', label: 'Message', default: '', help: 'The error the node raises. Left empty, the node passes its input on.' },
  ],
  kernels: [],
  evaluate(ctx) {
    const { message } = ctx.params;
    if (message !== '') throw new Error(message);   // a user-facing problem is a thrown Error with a one-sentence message
    ctx.output('out', ctx.input('in'));              // an alias of the input: no texture, no pass
  },
});
