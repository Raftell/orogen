// The example projects as the build packs them: the files of examples/ at the repository root, read when the
// page is built. The projects and the index are text; a picture is the address of a file beside the page.
// This module runs only in the built page: what needs no build is in examples.ts.

import { parseExampleIndex, type ExampleInfo } from './examples.ts';

const PROJECTS = import.meta.glob<string>('../../../../examples/*.orogen', { query: '?raw', import: 'default', eager: true });
const PICTURES = import.meta.glob<string>('../../../../examples/*.png', { query: '?url', import: 'default', eager: true });
const INDEX = import.meta.glob<string>('../../../../examples/index.json', { query: '?raw', import: 'default', eager: true });

const named = (files: Readonly<Record<string, string>>): Map<string, string> =>
  new Map(Object.entries(files).map(([path, value]) => [path.slice(path.lastIndexOf('/') + 1), value]));

const projects = named(PROJECTS);
const pictures = named(PICTURES);

export interface ExampleFile extends ExampleInfo {
  /** The text of the project file. */
  readonly text: string;
  /** The address of the picture; null when the folder holds none of that name. */
  readonly picture: string | null;
}

function load(): ExampleFile[] {
  const index = Object.values(INDEX)[0];
  if (index === undefined) return [];
  let listed: ExampleInfo[];
  try {
    listed = parseExampleIndex(index);
  } catch (thrown) {
    // The application starts without examples rather than not at all.
    console.error('[orogen] examples/index.json could not be read', thrown);
    return [];
  }
  const files: ExampleFile[] = [];
  for (const info of listed) {
    const text = projects.get(info.file);
    if (text === undefined) {
      console.error(`[orogen] examples/index.json names ${info.file}, which the folder does not hold`);
      continue;
    }
    files.push({ ...info, text, picture: pictures.get(info.image) ?? null });
  }
  return files;
}

/** The examples, in the order of the index. */
export const EXAMPLES: readonly ExampleFile[] = load();
