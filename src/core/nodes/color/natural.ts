// src/core/nodes/color/natural.ts
import { defineKernel, defineNode, hash, noise, ops, param } from '../../api.ts';

/** The ground whose slope decides between rock, scree and vegetation is the terrain smoothed over this length. */
const SLOPE_RADIUS = 0.002;
/** The terrain smoothed over this length is the hillside: the level a rib stands above and a gully lies below. */
const RIB_RADIUS = 0.008;
/** The terrain smoothed over this length is the level a point stands above, as a crest, or lies below, as a hollow. */
const RELIEF_RADIUS = 0.04;
/** The distance at which higher ground shelters a point most: the width of a side valley. */
const SHELTER_RADIUS = 0.03;
/** The flow is summed over a window of this length: a stream wets the ground on both sides of its line. */
const WET_RADIUS = 0.0025;
/** Summed over a window this much wider, a line of flow is the same sum and a flow that lies everywhere is this much more. */
const DAMP_WIDER = 8;
/** The edge of the snow is frayed over this length: within it the ground decides where snow lies. */
const SNOW_EDGE = 0.003;
/** The highest sea level the zones of the land are spread above: a sea at the top of the range leaves no land to spread them over. */
const HIGHEST_SEA = 0.9;

type Rgb = readonly [number, number, number];

/** A color as a designer writes it, sRGB in hexadecimal, as the linear RGB every color in the graph is. */
function hex(code: string): Rgb {
  const channel = (at: number): number => {
    const c = Number.parseInt(code.slice(at, at + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return [channel(1), channel(3), channel(5)];
}

/** What a landscape of one kind is painted with, and where each cover begins and ends. */
interface Biome {
  /** Vegetation: woods, the meadow of low ground, the grass of high ground, and grass that is dry. */
  readonly woods: Rgb; readonly meadow: Rgb; readonly grass: Rgb; readonly dry: Rgb;
  /** Bare ground on gentle slopes, low and high; loose scree; and the bare ground of the summits. */
  readonly soilLow: Rgb; readonly soilHigh: Rgb; readonly scree: Rgb; readonly summit: Rgb;
  /** Rock: the two tones its layers alternate between, and its creases. */
  readonly rockA: Rgb; readonly rockB: Rgb; readonly rockDark: Rgb;
  /** The bed of a stream; the shore of the sea; the ground under shallow water, and deep under the sea. */
  readonly bed: Rgb; readonly shore: Rgb; readonly shallow: Rgb; readonly seabed: Rgb;
  /** Snow in the open, and in shade. */
  readonly snow: Rgb; readonly snowShade: Rgb;
  /** The height at which vegetation ends, half the height it thins out over, and the share of that height woods reach. */
  readonly vegTop: number; readonly vegFade: number; readonly woodsTop: number;
  /** The slope, in degrees, beyond which the ground is bare rock: on the lowest ground, and at the height where vegetation ends. */
  readonly steepLow: number; readonly steepHigh: number;
  /** The moisture below which nothing grows, and the moisture at which the cover is whole. */
  readonly moisture: readonly [number, number];
  /** How plainly the layers of the rock show, 0..1, and how many of them a height of 1 holds. */
  readonly strata: number; readonly layers: number;
  /** The share of the ground vegetation covers where nothing limits it. */
  readonly cover: number;
  /** How many degrees gentler a slope may be at the summits and still be bare rock. */
  readonly summitRock: number;
}

const BIOMES = {
  alpine: {
    woods: hex('#456a3d'), meadow: hex('#7f9e4f'), grass: hex('#94995f'), dry: hex('#a69d6c'),
    soilLow: hex('#7f6548'), soilHigh: hex('#9a8a72'), scree: hex('#b0a694'), summit: hex('#c9c2b5'),
    rockA: hex('#a89d89'), rockB: hex('#cdc3b0'), rockDark: hex('#857a6a'),
    bed: hex('#4f5a56'), shore: hex('#c2b393'), shallow: hex('#3d7d84'), seabed: hex('#27434f'),
    snow: hex('#f2f5f8'), snowShade: hex('#c3d2e6'),
    vegTop: 0.68, vegFade: 0.12, woodsTop: 0.65, steepLow: 74, steepHigh: 50, moisture: [-1, -0.5],
    strata: 0.35, layers: 14, cover: 1, summitRock: 14,
  },
  temperate: {
    woods: hex('#4c7236'), meadow: hex('#7ea046'), grass: hex('#9aa556'), dry: hex('#b5ad66'),
    soilLow: hex('#7a5f43'), soilHigh: hex('#8f7a60'), scree: hex('#a59a8a'), summit: hex('#b3a999'),
    rockA: hex('#958b7d'), rockB: hex('#b5ab9b'), rockDark: hex('#726a5e'),
    bed: hex('#5b5a48'), shore: hex('#d2c097'), shallow: hex('#3a7a7c'), seabed: hex('#1f4552'),
    snow: hex('#f2f5f8'), snowShade: hex('#c3d2e6'),
    vegTop: 0.9, vegFade: 0.12, woodsTop: 0.8, steepLow: 74, steepHigh: 46, moisture: [-1, -0.5],
    strata: 0.3, layers: 12, cover: 1, summitRock: 8,
  },
  desert: {
    woods: hex('#6f7546'), meadow: hex('#8f8c5a'), grass: hex('#a49b68'), dry: hex('#b9a775'),
    soilLow: hex('#cfa97a'), soilHigh: hex('#dcbf95'), scree: hex('#c0946a'), summit: hex('#d6b58c'),
    rockA: hex('#a9653f'), rockB: hex('#cf9060'), rockDark: hex('#7c4830'),
    bed: hex('#96724e'), shore: hex('#e0c9a0'), shallow: hex('#3f8a8a'), seabed: hex('#1d4a58'),
    snow: hex('#f4f1ea'), snowShade: hex('#cfd3df'),
    vegTop: 0.95, vegFade: 0.1, woodsTop: 0.9, steepLow: 44, steepHigh: 34, moisture: [0.55, 0.95],
    strata: 0.9, layers: 22, cover: 0.7, summitRock: 0,
  },
  volcanic: {
    woods: hex('#4a6a2c'), meadow: hex('#74893a'), grass: hex('#8f924c'), dry: hex('#8f8250'),
    soilLow: hex('#46403c'), soilHigh: hex('#5f534d'), scree: hex('#5a514d'), summit: hex('#5e4a43'),
    rockA: hex('#3a3839'), rockB: hex('#544e4c'), rockDark: hex('#262527'),
    bed: hex('#2c2d31'), shore: hex('#3a3a3c'), shallow: hex('#2b5a66'), seabed: hex('#142f3d'),
    snow: hex('#eef1f4'), snowShade: hex('#bccbe0'),
    vegTop: 0.45, vegFade: 0.14, woodsTop: 0.5, steepLow: 54, steepHigh: 36, moisture: [0.25, 0.6],
    strata: 0.25, layers: 9, cover: 0.9, summitRock: 10,
  },
  arctic: {
    woods: hex('#5f6b45'), meadow: hex('#86885a'), grass: hex('#a6a682'), dry: hex('#9c8658'),
    soilLow: hex('#7d7868'), soilHigh: hex('#a2a6a6'), scree: hex('#a3a9ad'), summit: hex('#cfd6db'),
    rockA: hex('#717a83'), rockB: hex('#96a0a8'), rockDark: hex('#4f5760'),
    bed: hex('#555c63'), shore: hex('#9c9e9a'), shallow: hex('#3a6e86'), seabed: hex('#1c3a4d'),
    snow: hex('#f3f7fb'), snowShade: hex('#b9cde6'),
    vegTop: 0.34, vegFade: 0.14, woodsTop: 0.3, steepLow: 50, steepHigh: 34, moisture: [0.2, 0.55],
    strata: 0.3, layers: 12, cover: 0.9, summitRock: 12,
  },
} as const satisfies Record<string, Biome>;

/** A biome as the table the kernel reads: seventeen colors, then its numbers, four to an entry. */
function tableOf(biome: Biome): Float32Array {
  const colors = [
    biome.woods, biome.meadow, biome.grass, biome.dry, biome.soilLow, biome.soilHigh, biome.scree, biome.summit,
    biome.rockA, biome.rockB, biome.rockDark, biome.bed, biome.shore, biome.seabed, biome.snow, biome.snowShade,
    biome.shallow,
  ];
  return new Float32Array([
    ...colors.flatMap((color) => [...color, 1]),
    biome.vegTop, biome.vegFade, biome.steepLow, biome.steepHigh,
    ...biome.moisture, biome.strata, biome.layers,
    biome.cover, biome.summitRock, biome.woodsTop, 0,
  ]);
}

const paint = defineKernel({
  name: 'color/natural',
  // ground: the terrain smoothed over a few metres. local: over the width of a gully. broad: over a landform.
  // shelter: how sheltered a point is by the ground around it. wet, damp: the flow summed over the wet radius
  // and over a wider one; without them nothing is a stream. snow: the mask with its edge spread over the
  // length the snow is frayed over; without it there is none.
  inputs: {
    height: 'field', ground: 'field', local: 'field', broad: 'field', shelter: 'field',
    wet: { kind: 'field', default: 0 },
    damp: { kind: 'field', default: 0 },
    snow: { kind: 'field', default: 0, saturate: true },
  },
  outputs: { out: 'color' },
  // micro, fine, relief: what turns a height above the smoothed ground, above the hillside and above the broad
  // terrain into a slope over that radius.
  // wetGain, dampGain: what turns the summed flow into the share of the terrain that drains through the window.
  // sea: the sea level, and below every height where the project has no sea. land: the height the zones start at.
  params: { variation: 'f32', micro: 'f32', fine: 'f32', relief: 'f32', wetGain: 'f32', dampGain: 'f32', sea: 'f32', land: 'f32' },
  luts: { biome: 'vec4f' },
  includes: [hash, noise],
  cost: 152,
  code: /* wgsl */ `
const STEEPEST = 1e6;        // a slope as a tangent beyond which ground is a wall anyway: its square stays a float
const SLOPE_FINE = 0.3;      // the share of the terrain's own slope in the steepness; the rest is that of the smoothed ground
const FULL_SHELTER = 0.3;    // the occlusion of a valley floor
const LEVEL = 0.15;          // the slope a relief is measured against on level ground, where the ground has none of its own
const HALF_SPUR = 0.4;       // the height above the smoothed ground, against the slope it has over that radius, of half a spur or a crease
const HALF_RIB = 0.5;        // the same above the hillside, of half a rib or a gully
const HALF_RELIEF = 0.5;     // the same above the broad terrain, of half a crest or a hollow
const CLUMP_EDGE = 0.25;     // the share of the density of the woods over which a clump of them closes
const STREAM_FROM = -3.3;    // the decimal logarithm of the drained share of the terrain at which ground starts to be wet
const STREAM_TO = -1.7;      // and at which it is the bed of a stream
const BEACH = 0.012;         // the height above the sea a beach reaches
const SHOAL = 0.008;         // the depth down to which the ground shows through the water in its own tone
const DEEP = 0.05;           // the depth at which the ground under the sea has its darkest tone
const DIP = 0.12;            // the height the layers of the rock fall by across the terrain

// The smooth step from lo to hi: 0 at lo and below, 1 at hi and above.
fn rise(lo: f32, hi: f32, v: f32) -> f32 {
  let t = saturate((v - lo) / max(hi - lo, 1e-6));
  return t * t * (3.0 - 2.0 * t);
}
// How much of a landform ground is that stands v above its surroundings: nothing at 0 and below, a half at
// the height mid, all of it only far above. It has no end beyond which every rib would be the same rib.
fn eased(v: f32, mid: f32) -> f32 {
  let p = max(v, 0.0);
  return p / (p + mid);
}
fn tone(i: u32) -> vec3f { return biome_item(i).rgb; }
// Fractal noise of the feature size, a length, spread to about -1..1.
fn wander(uv: vec2f, size: f32, stream: u32, octaves: i32) -> f32 {
  return clamp(1.7 * noise_fbm(uv / size, seedFor(stream), octaves, 2.0, 0.55), -1.0, 1.0);
}

fn compute(px: vec2i, uv: vec2f) -> vec4f {
  let top = biome_item(17u);      // where vegetation ends: the height and half the fade; the steepest covered slope, low and high
  let lim = biome_item(18u);      // the two ends of the moisture vegetation needs; the strength and the number of the rock's layers
  let etc = biome_item(19u);      // the cover, the summit's rock, and how high the woods reach

  // Variation at four scales: of the climate, of patches of cover, of the mottling within one, and of grain.
  let v = 2.0 * P.variation;   // the default, a half, is noise of its full spread
  let climate = v * wander(uv, 0.35, 0u, 3);
  let patches = v * wander(uv, 0.07, 1u, 4);
  let mottle = v * wander(uv, 0.014, 2u, 3);
  let grain = v * wander(uv, 0.003, 3u, 4);
  let ragged = 7.0 * mottle + 4.0 * grain;   // degrees: the limits of a cover wander by this much

  // What the terrain is at this point. Slopes are physical, in degrees.
  let h = height_at(px);
  let even = ground_at(px);
  let groundSlope = length(clamp(slopeAt(ground, px), vec2f(-STEEPEST), vec2f(STEEPEST)));
  let ownSlope = length(clamp(slopeAt(height, px), vec2f(-STEEPEST), vec2f(STEEPEST)));
  let steep = degrees(atan(mix(groundSlope, ownSlope, SLOPE_FINE))) + ragged;
  // The hillside a point lies on: its slope without the walls of its gullies. Vegetation follows that.
  let hillSlope = length(clamp(slopeAt(local, px), vec2f(-STEEPEST), vec2f(STEEPEST)));
  let hill = mix(degrees(atan(hillSlope)) + ragged, steep, 0.4);
  let sheltered = saturate(shelter_at(px) / FULL_SHELTER);
  // Relief at three scales, each as what stands above and what lies below: the spurs and creases of the ground
  // itself, the ribs and gullies of a hillside, the crests and hollows of a landform. Each is the height above
  // the terrain smoothed over a radius, against the fall of the slope over that radius: a rib on a steep
  // hillside stands higher than the same rib on a gentle one, and steep and gentle terrains have ribs alike.
  let detail = clamp((h - even) * P.micro / (groundSlope + LEVEL), -8.0, 8.0);
  let spur = eased(detail, HALF_SPUR);
  let crease = eased(-detail, HALF_SPUR);
  let standing = clamp((even - local_at(px)) * P.fine / (hillSlope + LEVEL), -8.0, 8.0);
  let rib = eased(standing, HALF_RIB);
  let gully = eased(-standing, HALF_RIB);
  let relief = clamp((h - broad_at(px)) * P.relief / (hillSlope + LEVEL), -8.0, 8.0);
  let crest = eased(relief, HALF_RELIEF);
  let hollow = eased(-relief, HALF_RELIEF);

  // The height the zones are read at, from the sea upwards: a crest stands in the zone above its own, sheltered
  // ground in the one below.
  let z = (h - P.land) / (1.0 - P.land) + 0.07 * climate + 0.035 * patches + 0.05 * crest - 0.03 * sheltered;
  let zone = saturate(z / max(top.x, 0.05));

  // Moisture: sheltered ground, hollows and gullies hold it, ribs and crests shed it, and a stream brings it.
  var stream = 0.0;
  var line = 0.0;
  if (wet_bound()) {
    let drained = clamp(wet_at(px), 1e-12, 1e12) * P.wetGain;
    stream = rise(STREAM_FROM, STREAM_TO, log(drained) * 0.4342945);
    // On the line of a stream the wider window drains no more than the narrow one; where the flow lies
    // everywhere, as a field that is no drainage does, it drains as much more as it is wider. Only a line has a bed.
    line = rise(0.3, 0.7, drained / max(clamp(damp_at(px), 1e-12, 1e12) * P.dampGain, drained));
  }
  let moist = saturate(max(
    0.45 + 0.25 * sheltered + 0.22 * hollow + 0.3 * gully + 0.1 * crease - 0.3 * rib - 0.25 * crest - 0.08 * spur
      + 0.15 * patches + 0.08 * mottle - 0.15 * rise(0.5, 1.0, zone),
    sqrt(stream)));

  // The slope beyond which ground is bare rock: low ground holds a cover on steeper slopes than high ground,
  // and the summits hold none. The covers follow one another across it: vegetation thins out below it, loose
  // ground lies around it, rock stands beyond it.
  let limit = mix(top.z, top.w, zone) - etc.y * rise(top.x, 1.0, z);
  let rock = rise(-3.0, 13.0, steep - limit + 9.0 * rib + 5.0 * spur - 10.0 * gully);
  var veg = (1.0 - rise(-14.0, 5.0, hill - limit - 8.0 * (moist - 0.5)))
    * (1.0 - rise(top.x - top.y, top.x + top.y, z - 0.12 * (moist - 0.5) + 0.03 * mottle + 0.02 * grain))
    * rise(lim.x, lim.y, moist + 0.06 * grain) * etc.x;
  veg *= 1.0 - 0.2 * rise(0.3, 0.9, -patches - 0.5 * mottle);

  // Vegetation: meadow on low ground and the grass of high ground above it, the drier the yellower. Woods stand
  // on the hillsides below their own limit, more of them where it is moist, and in patches on level ground; at
  // their edge they stand in clumps.
  let sward = mix(tone(1u), tone(2u), rise(0.4, 0.95, zone + 0.15 * patches + 0.1 * climate));
  let dryness = (1.0 - rise(0.18, 0.7, moist + 0.2 * climate + 0.1 * mottle)) * mix(0.55, 0.85, rise(0.3, 0.8, zone));
  var green = mix(sward, tone(3u), dryness);
  green *= 1.0 + 0.1 * patches + 0.16 * mottle + 0.1 * grain;
  let wooded = rise(0.0, 0.55, 0.38 * rise(6.0, 22.0, hill) + 0.9 * (moist - 0.45) + 0.5 * patches + 0.25 * climate + 0.25 * mottle - 0.08)
    * (1.0 - rise(etc.z - 0.35, etc.z + 0.15, zone + 0.15 * mottle + 0.1 * patches));
  // Where the woods thin out they stand in clumps: each spot of ground takes them at a density of its own.
  let woods = rise(0.0, CLUMP_EDGE, wooded * (1.0 + CLUMP_EDGE) - saturate(0.5 + 0.9 * grain + 0.35 * mottle));
  // A canopy is darker between its crowns than on them.
  green = mix(green, tone(0u) * (1.0 + 0.1 * patches + 0.14 * mottle + 0.22 * grain), woods);

  // Bare ground: soil on gentle slopes, scree on steeper ones, at the foot of slopes and near the summits.
  let soil = mix(tone(4u), tone(5u), rise(0.15, 0.75, z + 0.1 * patches));
  let loose = mix(tone(6u), tone(7u), rise(top.x - 0.1, top.x + 0.3, z + 0.12 * patches + 0.08 * mottle));
  var bare = mix(soil, loose, saturate(max(rise(22.0, 38.0, steep + 8.0 * gully), rise(top.x - 0.05, top.x + 0.2, z)) + 0.4 * hollow * rise(12.0, 30.0, steep)));
  bare *= 1.0 + 0.12 * mottle + 0.14 * grain;

  // Rock: its layers follow the height, dip across the terrain and are bent by the variation; what stands out
  // of it is weathered pale and what is cut into it dark, and it is paler towards the summits.
  let dip = 6.2831853 * hash_unit(seedFor(5u));
  let bedded = h + DIP * dot(uv - vec2f(0.5), vec2f(cos(dip), sin(dip)));
  let layer = 0.5 + 0.7 * noise_gradient(vec2f(bedded * lim.w + 0.6 * patches + 0.15 * mottle, 7.3), seedFor(4u));
  var stone = mix(tone(8u), tone(9u), saturate(mix(0.5, layer, lim.z) + 0.2 * patches + 0.25 * mottle + 0.3 * (rib - gully) + 0.3 * (spur - crease)));
  stone = mix(stone, tone(10u), saturate(0.6 * rise(limit + 8.0, limit + 30.0, steep) + 0.2 * gully + 0.25 * crease + 0.25 * sheltered + 0.18 * rise(0.2, 0.9, -grain)));
  stone = mix(stone, tone(5u), 0.4 * (1.0 - rise(0.15, 0.95, zone + 0.2 * patches)));
  stone = mix(stone, tone(7u), 0.55 * rise(top.x - 0.05, top.x + 0.35, z + 0.1 * patches));
  stone *= (1.0 + 0.16 * grain) * mix(0.92, 1.06, rise(0.0, 1.2, zone));

  var c = mix(mix(bare, green, saturate(veg)), stone, rock);

  // A stream darkens the ground it wets, and its line is its bed. Sheltered ground lies in its own shade, and
  // so does every crease of the ground; what stands out of it is weathered lighter.
  c = mix(c, 0.8 * c, stream);
  c = mix(c, tone(11u) * (1.0 + 0.1 * mottle), 0.85 * rise(0.55, 1.0, stream) * line);
  c *= 1.0 - 0.1 * sheltered - 0.06 * gully + 0.1 * (spur - crease);

  // The sea: a beach on the gentle ground just above it, and under it the ground as it shows through the
  // water: wet at the waterline, in the tone of the shallows below it, and in that of the deep further down.
  let depth = P.sea - h;
  let under = rise(-0.003, 0.003, depth + 0.003 * mottle);
  let beach = (1.0 - rise(0.0, BEACH * max(1.0 + 0.6 * patches, 0.2), -depth)) * (1.0 - rise(10.0, 26.0, steep));
  c = mix(c, tone(12u) * (1.0 + 0.08 * mottle + 0.06 * grain), beach);
  let waterline = 0.7 * mix(tone(12u), stone, 0.6 * rock);
  var seafloor = mix(waterline, tone(16u), rise(0.0, SHOAL, depth + 0.004 * mottle));
  seafloor = mix(seafloor, tone(13u), rise(0.2 * DEEP, DEEP, depth + 0.015 * patches));
  c = mix(c, seafloor * (1.0 + 0.05 * mottle), under);

  // Snow: where the mask says and the sea is not. Along its edge, and wherever the mask is partial, it lies in
  // patches: it stays in gullies, hollows and shelter and goes first from ribs, spurs and steep rock, and the
  // variation frays it. It is bluish where it lies in shade.
  let cover = snow_at(px);
  let holds = 0.3 * sheltered + 0.35 * (gully - rib) + 0.25 * (hollow - crest) + 0.3 * (crease - spur) - 0.5 * rise(35.0, 65.0, steep);
  let lying = cover + 4.0 * cover * (1.0 - cover) * (0.4 * holds + 0.35 * mottle + 0.25 * grain + 0.15 * patches);
  let white = rise(0.3, 0.7, lying) * (1.0 - under);
  let shaded = saturate(0.55 * sheltered + 0.3 * crease + 0.2 * gully + 0.15 * hollow - 0.15 * spur - 0.1 * rib);
  c = mix(c, mix(tone(14u), tone(15u), shaded) * (1.0 + 0.03 * grain), white);

  // No surface reflects more light than falls on it.
  return vec4f(saturate(c), 1.0);
}`,
});

export default defineNode({
  type: 'color/natural',
  title: 'Natural Color',
  category: 'color',
  description: 'Colors a terrain as a landscape: rock on steep ground, vegetation and soil by height and shelter, wet valley lines and snow.',
  keywords: ['biome', 'texture', 'satellite', 'landscape', 'vegetation', 'rock', 'snow', 'colorize', 'satmap', 'albedo', 'forest', 'grass'],
  inputs: [
    { name: 'in', type: 'field' },
    { name: 'flow', type: 'field', role: 'data', optional: true },
    { name: 'snow', type: 'field', role: 'mask', optional: true },
  ],
  outputs: [{ name: 'out', type: 'color' }],
  params: [
    {
      kind: 'enum', name: 'mode', label: 'Landscape', default: 'alpine',
      options: [
        { value: 'alpine', label: 'Alpine' },
        { value: 'temperate', label: 'Temperate' },
        { value: 'desert', label: 'Desert' },
        { value: 'volcanic', label: 'Volcanic' },
        { value: 'arctic', label: 'Arctic' },
      ],
      help: 'The kind of landscape: its palette of rock, soil and vegetation, and the heights and slopes each of them covers.',
    },
    {
      kind: 'float', name: 'variation', label: 'Variation', unit: 'ratio', default: 0.5, min: 0, max: 1,
      help: 'Larger values break the cover into patches and mottle its colors; 0 colors the terrain by its shape alone.',
    },
    param.seed(),
  ],
  kernels: [paint],
  uses: ['seaLevel'],
  async evaluate(ctx) {
    const height = ctx.input('in');
    const flow = ctx.input('flow');
    const shelter = await ops.occlusion(ctx, height, SHELTER_RADIUS, { progress: [0, 0.6] });
    const ground = ops.smooth(ctx, height, SLOPE_RADIUS);
    const local = ops.smooth(ctx, height, RIB_RADIUS);
    const broad = ops.smooth(ctx, height, RELIEF_RADIUS);
    // A stream is one texel wide at every resolution. Summed over a window of a fixed length it is the same
    // stream at each: the Gaussian's weights add up to this many texels.
    const wet = flow ? ops.blur(ctx, flow, WET_RADIUS) : null;
    const damp = flow ? ops.blur(ctx, flow, DAMP_WIDER * WET_RADIUS) : null;
    // A mask is read saturated; its edge is then spread, so that the ground can decide where along it snow lies.
    const mask = ctx.input('snow');
    const cover = mask ? ops.remap(ctx, mask, { from: [0, 1], clamp: true }) : null;
    const snow = cover ? ops.blur(ctx, cover, SNOW_EDGE) : null;
    if (cover) ctx.release(cover);
    const windowOf = (radius: number): number => {
      const sigma = ctx.lengthToPx(radius);
      // Below a quarter of a texel the blur is a copy: the window is the texel.
      if (sigma < 0.25) return 1;
      let texels = 1;
      for (let k = 1; k <= Math.ceil(3 * sigma); k++) texels += 2 * Math.exp(-(k * k) / (2 * sigma * sigma));
      return texels;
    };
    // A sea level of 0, the bottom of the height range, is a project without a sea.
    const sea = ctx.setting('seaLevel');

    // Everything the node holds at once is allocated here. The smoothing then runs before the painting is
    // encoded: a cancellation takes effect between the two.
    const out = ctx.alloc('color');
    await ctx.flush();
    ctx.progress(0.8);
    ctx.run(paint, {
      in: { height, ground, local, broad, shelter, wet, damp, snow },
      out: { out },
      params: {
        variation: ctx.params.variation,
        micro: ctx.heightRange / (SLOPE_RADIUS * ctx.terrainSize),
        fine: ctx.heightRange / (RIB_RADIUS * ctx.terrainSize),
        relief: ctx.heightRange / (RELIEF_RADIUS * ctx.terrainSize),
        wetGain: windowOf(WET_RADIUS),
        dampGain: windowOf(DAMP_WIDER * WET_RADIUS),
        sea: sea > 0 ? sea : -1e9,
        land: Math.min(Math.max(sea, 0), HIGHEST_SEA),
      },
      luts: { biome: ctx.lut(tableOf(BIOMES[ctx.params.mode]), 'vec4f') },
    });
    ctx.release(shelter);
    ctx.release(ground);
    ctx.release(local);
    ctx.release(broad);
    if (wet) ctx.release(wet);
    if (damp) ctx.release(damp);
    if (snow) ctx.release(snow);
    ctx.output('out', out);
  },
});
