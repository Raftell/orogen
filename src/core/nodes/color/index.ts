import type { NodeDef } from '../../api.ts';
import constant from './constant.ts';
import extractChannel from './extract-channel.ts';
import gradientMap from './gradient-map.ts';
import hillshade from './hillshade.ts';
import hueSaturation from './hue-saturation.ts';
import natural from './natural.ts';
import normalMap from './normal-map.ts';
import packChannels from './pack-channels.ts';

export const nodes: readonly NodeDef[] = [constant, extractChannel, gradientMap, hillshade, hueSaturation, natural, normalMap, packChannels];
