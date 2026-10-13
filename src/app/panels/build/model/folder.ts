// The output folder: what the pipeline asks of it (export-unreal.md 3.8), said before a build is started, and
// what the panel can tell from the two paths alone. The pipeline is the judge of a folder: it alone can look
// into one (the page has no file system), and it refuses with E_OUT_DIR. What is said here it is certain to
// refuse. No DOM and no React.

import { contains, folderOf, isRoot, sameFolder } from './paths.ts';

/** The rules, in the order a person meets them. Shown under the folder, whatever folder is chosen. */
export const FOLDER_RULES: readonly string[] = [
  'The folder belongs to the build: every build replaces everything in it.',
  'It must be new, empty, or hold an earlier Orogen build and nothing else. Any other folder is refused and not touched.',
  'Never the folder of the project file, and keep no files of your own in it.',
];

/** What lies beside the output folder while a build runs, and after one that fails. */
export const STAGING_RULE = 'A build is written beside it, into a folder ending in .partial, and swapped in when it has succeeded: one that fails or is cancelled changes nothing here.';

/**
 * Why a build into `folder` is certain to be refused, as far as the two paths say; null when they say nothing.
 * A folder that holds foreign files is refused as well, and only the build can find that out.
 */
export function folderWarning(folder: string, projectPath: string | null): string | null {
  if (isRoot(folder)) return 'This is the root of a drive. A build needs a folder of its own';
  if (projectPath === null) return null;
  const home = folderOf(projectPath);
  if (home === '') return null;
  if (sameFolder(folder, home)) return 'This folder holds the project file. A build replaces everything in its folder, so it is refused here: choose a folder of its own';
  if (contains(folder, home)) return 'The project lies inside this folder. A build replaces everything in its folder, so it is refused here: choose a folder of its own';
  return null;
}

/**
 * The other projects that build into `folder`, by the paths of their files: every build replaces everything in
 * its folder, so two projects that share one replace each other's builds, and the pipeline does not refuse it
 * (the folder holds an earlier Orogen build and nothing else). `folders` is the folder of each project the panel
 * knows, by the path of its file; `projectPath` is the project that is open.
 */
export function sharedWith(folder: string, projectPath: string | null, folders: Readonly<Record<string, string>>): string[] {
  return Object.keys(folders).filter((other) => other !== '' && other !== (projectPath ?? '') && sameFolder(folders[other]!, folder)).sort();
}
