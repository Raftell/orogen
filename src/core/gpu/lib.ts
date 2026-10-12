import { KernelDefError } from './errors.ts';
import { moduleDeclarations, tokenize } from './scan.ts';
import { assertUnsealed } from './seal.ts';
import { NAME_PATTERN } from './wgsl-names.ts';

export interface WgslLib {
  readonly name: string;
  readonly code: string;
  readonly deps: readonly WgslLib[];
}

const defined = new WeakSet<WgslLib>();

/** True for an object defineLib returned. Anything else has not been checked against engine.md 3.7. */
export function isDefinedLib(lib: unknown): lib is WgslLib {
  return typeof lib === 'object' && lib !== null && defined.has(lib as WgslLib);
}

/**
 * The libraries reachable from `libs`, each once, after its dependencies (engine.md 3.7 rule 3).
 * Returns the name shared by two different libraries instead, when there is one.
 */
export function orderLibs(libs: readonly WgslLib[]): { readonly ordered: readonly WgslLib[]; readonly clash: string | null } {
  const ordered: WgslLib[] = [];
  const byName = new Map<string, WgslLib>();
  let clash: string | null = null;
  const visit = (lib: WgslLib): void => {
    const known = byName.get(lib.name);
    if (known === lib) return;
    if (known) { clash ??= lib.name; return; }
    byName.set(lib.name, lib);
    for (const dep of lib.deps) visit(dep);
    ordered.push(lib);
  };
  for (const lib of libs) visit(lib);
  return { ordered, clash };
}

export function defineLib(def: { name: string; code: string; deps?: readonly WgslLib[] }): WgslLib {
  assertUnsealed('defineLib');
  const fail = (problem: string): never => { throw new KernelDefError(`library "${def.name}": ${problem}`); };

  if (typeof def.name !== 'string' || !NAME_PATTERN.test(def.name)) fail('invalid library name; it must match [a-z][A-Za-z0-9]*');
  if (typeof def.code !== 'string') fail('code must be a string of WGSL');
  const deps = def.deps ?? [];
  deps.forEach((dep, i) => {
    if (!isDefinedLib(dep)) fail(`deps[${i}] is not a library made by defineLib`);
    if (dep.name === def.name) fail(`two different libraries are named "${def.name}"`);
  });
  const { clash } = orderLibs(deps);
  if (clash !== null) fail(`two different libraries are named "${clash}"`);

  const tokens = tokenize(def.code);
  const prefix = `${def.name}_`;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.text === '@' && (tokens[i + 1]?.text === 'compute' || tokens[i + 1]?.text === 'vertex' || tokens[i + 1]?.text === 'fragment')) {
      fail('a library declares no entry point');
    }
    if (t.text === '@' && (tokens[i + 1]?.text === 'group' || tokens[i + 1]?.text === 'binding')) {
      fail('a library declares no binding; it takes textures as function parameters');
    }
    if (t.ident && t.text.length > 1 && t.text.startsWith('_')) {
      fail(`code uses "${t.text}"; names beginning with "_" are reserved`);
    }
  }
  for (const decl of moduleDeclarations(tokens)) {
    if (decl.keyword === 'var' || decl.keyword === 'override') {
      fail(`a library declares no ${decl.keyword} ("${decl.name}")`);
    }
    if (!decl.name.startsWith(prefix) || decl.name.length === prefix.length) {
      fail(`"${decl.name}" must be named "${prefix}${decl.name}"`);
    }
  }

  const lib: WgslLib = Object.freeze({ name: def.name, code: def.code, deps: Object.freeze([...deps]) });
  defined.add(lib);
  return lib;
}
