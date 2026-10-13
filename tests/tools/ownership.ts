// Compares the paths a branch changes with the paths its owner may change (testing.md 7.1; runtime.md 8.10)
// and fails on any other. CI runs it on every pull request:
//
//   node tests/tools/ownership.ts [--branch <name>] [--base <ref>]
//
// The branch is --branch, else the head of the pull request (GITHUB_HEAD_REF), else the checked-out branch.
// The base is --base, else the base of the pull request, else origin/main, else main. The changed paths are
// those of `git diff <base>...HEAD`. Exit codes: 0 every path belongs to the branch's owner, 1 some do not,
// 2 the branch names no owner or git cannot answer.

import { spawnSync } from 'node:child_process';

const CATEGORIES: readonly string[] = ['generate', 'adjust', 'filter', 'simulate', 'select', 'color', 'surface'];

/**
 * The node reference of the user documentation. It is written by tools/node-reference.ts from the registry, and
 * the unit layer fails while it is behind (tests/unit/docs.test.ts): whoever changes a node hands in the page the
 * tool makes of it. Nobody edits it by hand.
 */
const NODE_REFERENCE = 'docs/user/nodes.md';

/** What each application owner may change besides its tests and change requests (runtime.md 8.10). A pattern ending in `/` is a folder. */
const APPLICATION: Readonly<Record<string, readonly string[]>> = {
  platform: ['src/platform/'],
  state: ['src/app/state/', 'src/app/engine/', 'src/app/platform.ts'],
  shell: ['src/app/main.tsx', 'src/app/shell/', 'src/app/ui/'],
  graph: ['src/app/panels/graph/'],
  viewport: ['src/app/panels/viewport/', 'src/viewport/'],
  inspector: ['src/app/panels/inspector/'],
  library: ['src/app/panels/library/'],
  build: ['src/app/panels/build/'],
};

export interface Owner {
  /** As the branch names it: `nodes/filter`, `export`, `ui/shell`, `core`. */
  readonly name: string;
  /** The folders and files the owner may change; null: everything (the integrator). */
  readonly paths: readonly string[] | null;
  /** The prefix of the owner's change requests, docs/changes/<prefix>-*.md; null for the integrator. */
  readonly requests: string | null;
}

/**
 * The owner a branch is named for: `nodes/<category>/<topic>`, `export/<topic>`, `ui/<owner>/<topic>` or
 * `core/<topic>`. null when the name is none of these.
 */
export function ownerOf(branch: string): Owner | null {
  const parts = branch.split('/');
  if (parts.some((part) => part === '')) return null;
  const [kind, second] = parts;
  if (kind === 'core' && parts.length >= 2) return { name: 'core', paths: null, requests: null };
  if (kind === 'export' && parts.length >= 2) {
    return { name: 'export', requests: 'export', paths: ['src/core/nodes/io/', 'tests/nodes/io/', 'src/export/', 'tests/export/', 'unreal/', 'docs/user/'] };
  }
  if (kind === 'nodes' && parts.length >= 3 && CATEGORIES.includes(second!)) {
    return { name: `nodes/${second}`, requests: second!, paths: [`src/core/nodes/${second}/`, `tests/nodes/${second}/`, NODE_REFERENCE] };
  }
  if (kind === 'ui' && parts.length >= 3 && Object.hasOwn(APPLICATION, second!)) {
    return { name: `ui/${second}`, requests: `ui-${second}`, paths: [...APPLICATION[second!]!, `tests/ui/${second}/`] };
  }
  return null;
}

/** Whether the owner may change the path. Paths are relative to the repository root, with `/`. */
export function owns(owner: Owner, path: string): boolean {
  if (owner.paths === null) return true;
  if (owner.paths.some((pattern) => (pattern.endsWith('/') ? path.startsWith(pattern) : path === pattern))) return true;
  // A change request: docs/changes/<prefix>-<slug>.md, directly in the folder.
  const request = /^docs\/changes\/([^/]+)\.md$/.exec(path)?.[1];
  return owner.requests !== null && request !== undefined && request.startsWith(`${owner.requests}-`) && request.length > owner.requests.length + 1;
}

/** The changed paths the branch's owner may not change, in the order given. Throws when the branch names no owner. */
export function foreignPaths(branch: string, changed: readonly string[]): string[] {
  const owner = ownerOf(branch);
  if (!owner) {
    throw new Error(`The branch "${branch}" names no owner: a branch is nodes/<category>/<topic>, export/<topic>, ui/<owner>/<topic> or core/<topic> (testing.md 7.1)`);
  }
  return changed.filter((path) => !owns(owner, path));
}

function git(args: readonly string[]): { readonly ok: boolean; readonly out: string; readonly problem: string } {
  const done = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 << 20 });
  return { ok: done.status === 0, out: done.stdout ?? '', problem: (done.stderr || done.error?.message || '').trim() };
}

function main(args: readonly string[]): number {
  const option = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const unknown = args.filter((arg, i) => arg.startsWith('--') ? !['--branch', '--base'].includes(arg) : !['--branch', '--base'].includes(args[i - 1] ?? ''));
  if (unknown.length > 0) {
    console.error(`usage: node tests/tools/ownership.ts [--branch <name>] [--base <ref>]   (not understood: ${unknown.join(' ')})`);
    return 2;
  }
  const branch = option('--branch') ?? (process.env.GITHUB_HEAD_REF || git(['rev-parse', '--abbrev-ref', 'HEAD']).out.trim());
  if (!branch || branch === 'HEAD') {
    console.error('ownership: no branch is checked out; name it with --branch');
    return 2;
  }
  const owner = ownerOf(branch);
  if (!owner) {
    console.error(`ownership: the branch "${branch}" names no owner. A branch is nodes/<category>/<topic>, export/<topic>, ui/<owner>/<topic> or core/<topic> (testing.md 7.1)`);
    return 2;
  }
  const pullRequestBase = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : undefined;
  const base = option('--base') ?? pullRequestBase ?? (git(['rev-parse', '--verify', '--quiet', 'origin/main']).ok ? 'origin/main' : 'main');
  // Three dots: what the branch changed since it left the base. A rename counts as both of its paths.
  const diff = git(['diff', '--name-only', '--no-renames', `${base}...HEAD`]);
  if (!diff.ok) {
    console.error(`ownership: git cannot compare ${base} with HEAD: ${diff.problem}`);
    return 2;
  }
  const changed = diff.out.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  const foreign = changed.filter((path) => !owns(owner, path));
  if (foreign.length === 0) {
    console.log(`ownership: ${changed.length} changed paths, all owned by ${owner.name}`);
    return 0;
  }
  console.error(`ownership: the branch "${branch}" belongs to ${owner.name} and changes ${foreign.length} of ${changed.length} paths that owner may not change:`);
  for (const path of foreign) console.error(`  ${path}`);
  console.error('A change to a file of another owner is requested with a file under docs/changes/ (testing.md 7.4).');
  return 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
