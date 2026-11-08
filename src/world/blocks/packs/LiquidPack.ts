import { spec, v, type BlockPack } from '../types';

/** 液体 / 冰霜方块包：5 种，非 opaque 但可渲染 */
export const LIQUID_PACK: BlockPack = {
  id: 'pack.liquid',
  label: '液体与冰霜',
  category: 'natural',
  blocks: [
    spec('packed_ice', '浮冰', v('glass', [176, 214, 238], [226, 246, 255], 100),
      { opaque: false, solid: true }),
    spec('blue_ice', '蓝冰', v('solid', [110, 168, 222], undefined, 101),
      { opaque: false, solid: true, hardness: 1.6 }),
    spec('snow_block', '雪块', v('solid', [238, 246, 252], undefined, 102), { hardness: 0.6 }),
    spec('frost', '霜', v('speckle', [206, 226, 238], [246, 252, 255], 103, { density: 0.3 })),
    spec('slime', '史莱姆块', v('liquid', [110, 196, 84], undefined, 104),
      { opaque: false, solid: true }),
  ],
};
