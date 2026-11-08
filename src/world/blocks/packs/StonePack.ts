import { spec, v, type BlockPack } from '../types';

/** 石质方块包：圆石、三种火成岩、沉积岩、基岩等 10 种 */
export const STONE_PACK: BlockPack = {
  id: 'pack.stone',
  label: '石质方块',
  category: 'natural',
  blocks: [
    spec('cobblestone', '圆石', v('cracked', [122, 122, 126], [90, 90, 94], 2)),
    spec('granite', '花岗岩', v('speckle', [156, 120, 104], [206, 178, 158], 3, { density: 0.28 })),
    spec('diorite', '闪长岩', v('speckle', [188, 188, 186], [120, 124, 126], 4, { density: 0.26 })),
    spec('andesite', '安山岩', v('speckle', [136, 136, 138], [96, 98, 102], 5, { density: 0.24 })),
    spec('sandstone', '砂岩', v('strata', [216, 198, 142], [196, 176, 120], 6)),
    spec('smooth_stone', '平滑石', v('solid', [176, 176, 178], undefined, 7)),
    spec('mossy_cobble', '苔石', v('speckle', [110, 122, 100], [62, 110, 52], 8, { density: 0.34 })),
    spec('bedrock', '基岩', v('cracked', [58, 58, 62], [30, 30, 34], 9), { hardness: 8 }),
    spec('cracked_stone', '裂石', v('cracked', [148, 148, 150], undefined, 10)),
    spec('tuff', '凝灰岩', v('speckle', [110, 116, 108], [150, 156, 142], 11, { density: 0.3 })),
  ],
};
