import { spec, v, type BlockPack } from '../types';

/** 土壤方块包：灰化土、红沙、黏土、耕地、菌丝等 7 种 */
export const SOIL_PACK: BlockPack = {
  id: 'pack.soil',
  label: '土壤方块',
  category: 'natural',
  blocks: [
    spec('podzol', '灰化土', v('speckle', [96, 74, 48], [58, 92, 40], 12, { density: 0.3 })),
    spec('red_sand', '红沙', v('solid', [196, 102, 62], undefined, 13)),
    spec('clay', '黏土', v('solid', [160, 166, 178], undefined, 14)),
    spec('mud', '泥', v('speckle', [78, 66, 54], [58, 50, 42], 15, { density: 0.32 })),
    spec('farmland', '耕地', v('strata', [110, 76, 44], [86, 58, 34], 16)),
    spec('mycelium', '菌丝', v('speckle', [110, 96, 110], [168, 150, 180], 17, { density: 0.3 })),
    spec('coarse_dirt', '粗土', v('speckle', [124, 92, 60], [90, 66, 44], 18, { density: 0.32 })),
  ],
};
