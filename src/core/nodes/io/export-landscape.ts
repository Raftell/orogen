// src/core/nodes/io/export-landscape.ts
import { defineNode } from '../../api.ts';

export default defineNode({
  type: 'io/export-landscape',
  title: 'Unreal Landscape',
  category: 'io',
  description: 'Exports a terrain as the heightmap of an Unreal Engine landscape, with the scale and location to import it at.',
  keywords: ['unreal', 'heightmap', 'build', 'r16', 'png', 'world partition', 'export', 'output', 'terrain'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [],
  params: [
    { kind: 'bool', name: 'enabled', label: 'Enabled', default: true, help: 'Include this node in builds.' },
    {
      kind: 'text', name: 'name', label: 'Name', default: 'Orogen', maxLength: 64,
      help: 'Names the files of the build. Only its letters are used, because Unreal is reported to refuse other file names.',
    },
    {
      kind: 'enum', name: 'rangeMode', label: 'Height range', default: 'measured',
      options: [
        { value: 'measured', label: 'Measured' },
        { value: 'fixed', label: 'Fixed' },
      ],
      help: 'Measured stores the terrain between its own lowest and highest point. Fixed stores a range you set, so the scale in Unreal stays the same from build to build.',
    },
    {
      kind: 'float', name: 'headroom', label: 'Headroom', unit: 'ratio', default: 0, min: 0, max: 1,
      visibleWhen: { param: 'rangeMode', equals: 'measured' },
      help: 'Widens the stored range by this share of itself above and below the terrain, leaving room to sculpt in Unreal.',
    },
    {
      kind: 'float', name: 'heightMin', label: 'Lowest height', unit: 'height', default: 0, min: 0, max: 1, soft: true,
      visibleWhen: { param: 'rangeMode', equals: 'fixed' },
      help: 'The height stored as the lowest value. Terrain below it is clipped.',
    },
    {
      kind: 'float', name: 'heightMax', label: 'Highest height', unit: 'height', default: 1, min: 0, max: 1, soft: true,
      visibleWhen: { param: 'rangeMode', equals: 'fixed' },
      help: 'The height stored as the highest value. Terrain above it is clipped.',
    },
    {
      kind: 'bool', name: 'dither', label: 'Dither', default: true,
      help: 'Adds noise of one height step so that gentle slopes do not become terraces. Turn it off for a terrain with large, exactly level surfaces.',
    },
    {
      kind: 'enum', name: 'zeroAt', label: 'Zero height', default: 'seaLevel',
      options: [
        { value: 'seaLevel', label: 'Sea level' },
        { value: 'bottom', label: 'Bottom' },
      ],
      help: 'Which height of the terrain the build places at world height zero in Unreal: the sea level of the project, or the bottom of its height range.',
    },
    {
      kind: 'enum', name: 'origin', label: 'Origin', default: 'center',
      options: [
        { value: 'center', label: 'Center' },
        { value: 'corner', label: 'Corner' },
      ],
      help: 'Which point of the terrain the build places at the world origin in Unreal: its center, or the corner of the first row and column.',
    },
    {
      kind: 'text', name: 'baseLayer', label: 'Base layer', default: 'Base', maxLength: 63, group: 'Layers',
      help: 'Name of the layer that receives the weight the weight-blended layers leave, so that no ground is unpainted.',
    },
    {
      kind: 'enum', name: 'layerBlend', label: 'Layer blend method', default: 'advanced', group: 'Layers',
      options: [
        { value: 'advanced', label: 'Advanced' },
        { value: 'final', label: 'Final' },
      ],
      help: 'The weight blending method the manifest names for the weight-blended layers. Final is the legacy method of Unreal.',
    },
    {
      kind: 'float', name: 'layerFloor', label: 'Layer floor', unit: 'ratio', default: 0.008, min: 0, max: 0.25, group: 'Layers',
      help: 'Layer weights below this are set to zero, which lets Unreal drop layers from the parts of the landscape that do not show them.',
    },
    {
      kind: 'int', name: 'layerLimit', label: 'Layers per point', default: 0, min: 0, max: 16, group: 'Layers',
      help: 'The most weight-blended layers kept at one point; the weakest are dropped. Zero keeps all of them.',
    },
    {
      kind: 'bool', name: 'partition', label: 'World Partition', default: true, group: 'World Partition',
      help: 'Marks the landscape as meant for a World Partition level. The two sizes below are written for the import either way.',
    },
    {
      kind: 'int', name: 'gridComponents', label: 'Grid size', default: 4, min: 1, max: 16, group: 'World Partition',
      help: 'Landscape components along one side of a streaming proxy. Larger values make fewer and larger proxies.',
    },
    {
      kind: 'int', name: 'regionComponents', label: 'Region size', default: 32, min: 4, max: 64, group: 'World Partition',
      help: 'Landscape components along one side of a region. Larger values make fewer and larger regions.',
    },
  ],
  kernels: [],
  evaluate() {},
  export(ctx) {
    const p = ctx.params;
    return [{
      kind: 'landscape',
      source: ctx.source('in'),
      name: p.name,
      range: p.rangeMode === 'fixed' ? { mode: 'fixed', min: p.heightMin, max: p.heightMax } : { mode: 'measured', headroom: p.headroom },
      dither: p.dither,
      zeroAt: p.zeroAt,
      origin: p.origin,
      baseLayer: p.baseLayer,
      layerBlend: p.layerBlend,
      layerFloor: p.layerFloor,
      layerLimit: p.layerLimit,
      worldPartition: { enabled: p.partition, gridSize: p.gridComponents, regionSize: p.regionComponents },
    }];
  },
});
