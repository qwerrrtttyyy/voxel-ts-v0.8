import { spec, v, type BlockPack } from '../types';

/** 光源方块包：5 种自发光方块，夜间仍醒目 */
export const LIGHT_PACK: BlockPack = {
  id: 'pack.light',
  label: '光源方块',
  category: 'light',
  blocks: [
    spec('sea_lantern', '海晶灯', v('glow', [214, 236, 236], undefined, 90), { emissive: true }),
    spec('jack_o_lantern', '南瓜灯', v('glow', [236, 146, 42], undefined, 91), { emissive: true }),
    spec('redstone_lamp', '红石灯', v('glow', [226, 96, 62], undefined, 92), { emissive: true }),
    spec('shroomlight', '菌光体', v('glow', [246, 176, 96], undefined, 93), { emissive: true }),
    spec('glow_glass', '荧光玻璃', v('glass', [160, 220, 220], [220, 250, 250], 94),
      { emissive: true, opaque: false, solid: true }),
  ],
};
