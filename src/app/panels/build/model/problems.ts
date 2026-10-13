// The problems a build reports (export-unreal.md 3.3, 3.9), in plain words: what the code means and what to do
// about it. The pipeline's own sentence names the node and the values; this says the rest. No DOM and no React.

import type { BuildProblem, BuildProblemCode, GraphDoc } from '../../../../core/runtime.ts';

export interface ProblemText {
  /** What happened, as a title: no full stop (testing.md 6.2). */
  readonly title: string;
  /** What to do. One or two sentences. */
  readonly advice: string;
}

export const PROBLEM_TEXT: Readonly<Record<BuildProblemCode, ProblemText>> = {
  E_NOTHING_TO_EXPORT: {
    title: 'Nothing to export',
    advice: 'A build writes only what export nodes declare. Add an export node from the I/O category, connect it and switch it on.',
  },
  E_INPUT_MISSING: {
    title: 'An export node has no input',
    advice: 'Connect the terrain, mask or color map it should export, or switch the node off.',
  },
  E_HOOK_FAILED: {
    title: 'An export node cannot say what it exports',
    advice: 'The sentence above says why. Check the parameters of the node.',
  },
  E_RESOLUTION: {
    title: 'The build resolution is not valid',
    advice: 'Choose one of the resolutions in the list above.',
  },
  E_SIZE_NOT_LANDSCAPE: {
    title: 'Unreal has no landscape of this size',
    advice: 'A landscape is made of components of fixed sizes. Choose one of the resolutions in the list above.',
  },
  E_SEVERAL_LANDSCAPES: {
    title: 'More than one landscape',
    advice: 'A build makes one landscape. Switch off every Unreal Landscape node but one.',
  },
  E_LAYER_WITHOUT_LANDSCAPE: {
    title: 'A layer without a landscape',
    advice: 'A Landscape Layer belongs to a landscape. Add an Unreal Landscape node and switch it on, or switch the layer off.',
  },
  E_NAME_INVALID: {
    title: 'A name leaves no file name',
    advice: 'File names keep the letters of a name, and its digits for textures and images. Use 1 to 64 of them.',
  },
  E_LAYER_NAME_INVALID: {
    title: 'Unreal cannot take this layer name',
    advice: 'A layer name starts with a letter and holds letters, digits and underscores, 63 at the most.',
  },
  E_LAYER_NAME_DUPLICATE: {
    title: 'Two layers share a name',
    advice: 'Unreal does not tell capitals apart in layer names. Rename one of the two.',
  },
  E_TOO_MANY_LAYERS: {
    title: 'Too many weight-blended layers',
    advice: 'A landscape takes 15 beside its base layer. Switch some off, or turn Weight-blended off on masks that a material only reads.',
  },
  E_RANGE_INVALID: {
    title: 'The height range is empty',
    advice: 'On the Unreal Landscape node the highest height must lie above the lowest, and the headroom between 0 and 1.',
  },
  E_FORMAT_INVALID: {
    title: 'A setting of an export node is not valid',
    advice: 'The sentence above names it. Set it again in the inspector.',
  },
  E_FILE_COLLISION: {
    title: 'Two exports would write the same file',
    advice: 'A layer file keeps only the letters of its name: Rock1 and Rock2 are both LayerRock. Name them RockA and RockB.',
  },
  W_MANY_LAYERS: {
    title: 'Many layers',
    advice: 'More than 12 layers are reported to make Unreal fall back to its default material. Aim for 8 or fewer.',
  },
  W_GRID_SIZE: {
    title: 'The World Partition grid does not divide the landscape',
    advice: 'On the Unreal Landscape node choose a grid size that divides the number of components per side.',
  },
  W_REGION_SIZE: {
    title: 'World Partition region size 4',
    advice: 'Creating a landscape with region size 4 is reported to fail in Unreal Engine. Use 5 or more.',
  },
  E_NODE_FAILED: {
    title: 'A node failed while computing',
    advice: 'Select the node to see it in the graph. The build stopped there and put no file in place.',
  },
  E_NON_FINITE: {
    title: 'A value that is not a number',
    advice: 'What the node should export holds an infinite or undefined value. Look upstream for a division by zero.',
  },
  E_WRITE_FAILED: {
    title: 'A file could not be written',
    advice: 'Check the free space and the permissions of the disk that holds the output folder, then build again.',
  },
  E_DEVICE_LOST: {
    title: 'The graphics device was lost',
    advice: 'A build is not resumed. Build again when the status bar says that the device is ready.',
  },
  E_OUT_DIR: {
    title: 'The output folder cannot be used',
    advice: 'Choose a new or empty folder, or one that holds an earlier Orogen build and nothing else. Nothing in the folder was touched.',
  },
  E_COMMIT_FAILED: {
    title: 'The finished build could not be put in place',
    advice: 'A file of the output folder is probably open in another program. Close it and build again.',
  },
  E_INTERNAL: {
    title: 'Something unexpected happened',
    advice: 'This is a defect of Orogen, not of the project. The sentence above is what it reported.',
  },
  W_HEIGHT_CLIPPED: {
    title: 'Heights were clipped',
    advice: 'Terrain lies outside the fixed height range. Widen the range on the Unreal Landscape node, or set Height range to Measured.',
  },
  W_FLAT: {
    title: 'The terrain is nearly level',
    advice: 'Its heights span less than 1 m and were stored over 1 m. Check that the right node is connected.',
  },
  W_LAYER_EMPTY: {
    title: 'A layer is empty',
    advice: 'Its mask is 0 everywhere at this resolution. Check the mask, or switch the layer off.',
  },
};

export interface ProblemView {
  readonly key: string;
  readonly severity: 'error' | 'warning';
  readonly code: BuildProblemCode;
  readonly title: string;
  /** The pipeline's sentence, which names the node by its title. */
  readonly message: string;
  readonly advice: string;
  /** The node to select; null when the problem names none, or names one the document no longer holds. */
  readonly nodeId: string | null;
}

/** A code this version does not know is shown with the pipeline's sentence alone. */
const UNKNOWN: ProblemText = { title: 'A problem this version of Orogen does not know', advice: '' };

/** Errors first, each group in the order reported; the same problem reported twice is shown once. */
export function viewProblems(problems: readonly BuildProblem[], doc: Pick<GraphDoc, 'nodes'>): ProblemView[] {
  const seen = new Set<string>();
  const views: ProblemView[] = [];
  for (const problem of problems) {
    const key = `${problem.code} ${problem.nodeId ?? ''} ${problem.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = Object.hasOwn(PROBLEM_TEXT, problem.code) ? PROBLEM_TEXT[problem.code] : UNKNOWN;
    views.push({
      key,
      severity: problem.severity === 'warning' ? 'warning' : 'error',
      code: problem.code,
      title: text.title,
      message: problem.message,
      advice: text.advice,
      nodeId: problem.nodeId !== undefined && Object.hasOwn(doc.nodes, problem.nodeId) ? problem.nodeId : null,
    });
  }
  return [...views.filter((view) => view.severity === 'error'), ...views.filter((view) => view.severity === 'warning')];
}

/** The node of the first problem that names one the document holds, errors first. */
export function firstProblemNode(problems: readonly BuildProblem[], doc: Pick<GraphDoc, 'nodes'>): string | null {
  return viewProblems(problems, doc).find((view) => view.nodeId !== null)?.nodeId ?? null;
}
