import { spec, v, type BlockPack } from '../types';

/** 下界方块包：7 种，用于深层地层与特殊结构 */
export const NETHER_PACK: BlockPack = {
  id: 'pack.nether',
  label: '下界方块',
  category: 'mineral',
  blocks: [
    spec('netherrack', '地狱岩', v('speckle', [116, 58, 54], [156, 72, 62], 120, { density: 0.28 }),
      { hardness: 0.8 }),
    spec('soul_sand', '灵魂沙', v('speckle', [78, 62, 56], [46, 40, 38], 121, { density: 0.3 })),
    spec('obsidian', '黑曜石', v('solid', [30, 22, 44], undefined, 122), { hardness: 8 }),
    spec('magma_block', '岩浆块', v('glow', [196, 72, 32], undefined, 123), { emissive: true }),
    spec('basalt', '玄武岩', v('strata', [72, 72, 80], [52, 52, 60], 124)),
    spec('blackstone', '黑石', v('cracked', [46, 42, 46], undefined, 125)),
    spec('crimson_stem', '绯红菌柄', v('bark', [128, 52, 72], undefined, 126, {
      faces: {
        top: v('rings', [166, 72, 92], undefined, 127),
        side: v('bark', [128, 52, 72], undefined, 128),
      },
    })),
  ],
};
