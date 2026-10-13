// The names other terrain and texture tools use for what a node does, so that someone who types the name they
// know finds the node. A node's own `keywords` hold the words of the trade (testing.md 6.2); this table holds
// product names, each with the product, because a row that matched one says so ("Erosion2 in Gaea").
//
// A name that equals the node's own title is not listed: the title is found already. The Gaea names are those of
// docs/research/gaea-features.md, section (a), and tests/ui/library/unit/search.test.ts holds them to it. The names
// of the other three tools are written as their makers' documentation writes them, from memory: no document of
// this repository lists them.

export type Tool = 'Gaea' | 'World Machine' | 'Houdini' | 'Substance Designer';

export interface Alias {
  readonly name: string;
  readonly tool: Tool;
}

const names = (tool: Tool, ...list: string[]): Alias[] => list.map((name) => ({ name, tool }));
const gaea = (...list: string[]): Alias[] => names('Gaea', ...list);
const wm = (...list: string[]): Alias[] => names('World Machine', ...list);
const houdini = (...list: string[]): Alias[] => names('Houdini', ...list);
const substance = (...list: string[]): Alias[] => names('Substance Designer', ...list);

/** By node type. */
export const ALIASES: Readonly<Record<string, readonly Alias[]>> = {
  'generate/gradient': [...gaea('LinearGradient'), ...substance('Gradient Linear')],
  'generate/radial-gradient': [...gaea('RadialGradient', 'Cone', 'Hemisphere'), ...wm('Radial Grad')],
  'generate/waves': [...gaea('Pattern'), ...houdini('HeightField Pattern')],
  'generate/fractal-noise': [...gaea('Perlin', 'MultiFractal'), ...wm('Advanced Perlin'), ...houdini('HeightField Noise'), ...substance('Perlin Noise', 'Clouds')],
  'generate/cellular-noise': [...gaea('Voronoi', 'Cellular'), ...substance('Cells')],
  'generate/mountain': gaea('MountainSide'),
  'generate/mountain-range': gaea('MountainRange', 'Ridge'),
  'generate/crater-field': gaea('CraterField'),
  'generate/dunes': gaea('DuneSea'),

  'adjust/levels': [...gaea('Adjust'), ...houdini('HeightField Remap'), ...substance('Histogram Range')],
  'adjust/curve': wm('Curves'),
  'adjust/clamp': [...gaea('Clip', 'SoftClip'), ...houdini('HeightField Clip')],
  'adjust/bias-gain': wm('Bias/Gain'),
  'adjust/invert': wm('Inverter'),
  'adjust/autolevel': gaea('Autolevel'),
  'adjust/equalize': wm('Equalizer'),
  'adjust/combine': [...gaea('Mixer', 'Layers', 'Mask'), ...wm('Combiner'), ...houdini('HeightField Layer'), ...substance('Blend')],
  'adjust/switch': [...gaea('Route'), ...wm('Chooser')],

  'filter/blur': [...houdini('HeightField Blur'), ...substance('Blur HQ')],
  'filter/slope-blur': gaea('SlopeBlur'),
  'filter/high-pass': gaea('Filter'),
  'filter/median': gaea('Denoise'),
  'filter/grow-shrink': [...gaea('Dilate', 'Aperture'), ...wm('Expander'), ...houdini('HeightField Mask Expand', 'HeightField Mask Shrink')],
  'filter/warp': [...gaea('DirectionalWarp'), ...wm('Displacement'), ...houdini('HeightField Distort by Noise'), ...substance('Directional Warp')],
  'filter/slope-warp': [...gaea('SlopeWarp'), ...houdini('HeightField Distort by Layer')],
  'filter/transform': [...houdini('HeightField Transform'), ...substance('Transformation 2D')],
  'filter/flip': wm('Flipper'),
  'filter/twirl': gaea('Swirl', 'Whorl'),
  'filter/edge-fade': gaea('Edge'),

  'simulate/hydraulic-erosion': [...gaea('Erosion2', 'Erosion', 'EasyErosion', 'Wizard'), ...wm('Erosion'), ...houdini('HeightField Erode', 'HeightField Erode Hydro')],
  'simulate/thermal-erosion': [...gaea('Thermal2', 'Thermal'), ...wm('Thermal Weathering'), ...houdini('HeightField Erode Thermal', 'HeightField Slump')],
  'simulate/sediment': gaea('Sediments'),
  'simulate/snow': gaea('Snowfield', 'Dusting'),
  'simulate/fill': [...gaea('HydroFix'), ...wm('Flow Restructure')],
  'simulate/flow': [...gaea('FlowMap'), ...wm('Select Wetness'), ...houdini('HeightField Flow Field')],
  'simulate/rivers': wm('River'),
  'simulate/lakes': [...gaea('Lake'), ...wm('Create Water')],
  'simulate/sea': wm('Coastal Erosion'),

  'select/height': [...wm('Select Height'), ...houdini('HeightField Mask by Feature')],
  'select/slope': [...wm('Select Slope'), ...houdini('HeightField Mask by Feature')],
  'select/curvature': [...wm('Select Convexity'), ...houdini('HeightField Mask by Feature')],
  'select/aspect': [...gaea('Angle'), ...wm('Select Angle'), ...houdini('HeightField Mask by Feature')],
  'select/exposure': gaea('Sunlight'),
  'select/occlusion': [...gaea('Soil'), ...houdini('HeightField Mask by Feature'), ...substance('Ambient Occlusion')],
  'select/roughness': wm('Select Roughness'),

  'color/gradient-map': [...gaea('CLUTer', 'SatMap', 'Tint', 'Synth'), ...wm('Colorizer')],
  'color/natural': [...gaea('SatMap', 'SuperColor', 'TextureBase', 'Texturizer'), ...wm('Basic Coverage')],
  'color/hue-saturation': [...gaea('HSL'), ...substance('HSL')],
  'color/normal-map': [...gaea('Normals'), ...wm('Normal Map Maker'), ...substance('Normal')],
  'color/hillshade': [...gaea('Shade', 'LightX'), ...wm('Light Map Maker')],
  'color/pack-channels': [...gaea('RGBMerge'), ...wm('Channel Combiner'), ...substance('RGBA Merge')],
  'color/extract-channel': [...gaea('RGBSplit', 'Splat'), ...wm('Channel Splitter'), ...substance('RGBA Split')],

  'surface/terraces': [...gaea('FractalTerraces', 'Steps'), ...wm('Terrace'), ...houdini('HeightField Terrace')],
  'surface/strata': gaea('Stratify', 'Sandstone'),
  'surface/outcrops': gaea('Rockscape', 'Craggy'),
  'surface/stones': gaea('RockNoise', 'Scree'),
  'surface/roughen': [...gaea('GroundTexture', 'Distress'), ...wm('Add Noise')],
  'surface/cracks': gaea('Shatter'),
  'surface/ripples': gaea('Sand'),
  'surface/fault': gaea('Shear'),
  'surface/scatter': gaea('Bomber'),

  'io/import-field': [...gaea('File'), ...wm('File Input'), ...houdini('HeightField File')],
  'io/import-color': gaea('File'),
  'io/export-landscape': gaea('Unreal'),
  'io/export-layer': wm('Splat Converter'),
  'io/export-field': [...gaea('Export'), ...wm('Height Output'), ...houdini('HeightField Output')],
  'io/export-color': [...gaea('Export'), ...wm('Bitmap Output')],
  'io/export-mask': gaea('Export'),
};
