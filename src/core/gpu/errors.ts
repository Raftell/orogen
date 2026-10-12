// engine.md 3.13. Messages and the checks that raise them are defined there.

export class KernelDefError extends Error {       // defineKernel, defineLib
  override name = 'KernelDefError';
}
export class NodeDefError extends Error {         // defineNode, defineCpuTask, createRegistry
  override name = 'NodeDefError';
}
export class KernelBindingError extends Error {   // ctx.run
  override name = 'KernelBindingError';
}
export class FieldAccessError extends Error {     // misuse of a field handle
  override name = 'FieldAccessError';
}
