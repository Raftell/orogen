import type { NodeDef } from '../../api.ts';
import exportColor from './export-color.ts';
import exportField from './export-field.ts';
import exportLandscape from './export-landscape.ts';
import exportLayer from './export-layer.ts';
import exportMask from './export-mask.ts';
import exportNormal from './export-normal.ts';
import importColor from './import-color.ts';
import importField from './import-field.ts';

export const nodes: readonly NodeDef[] = [
  exportColor,
  exportField,
  exportLandscape,
  exportLayer,
  exportMask,
  exportNormal,
  importColor,
  importField,
];
