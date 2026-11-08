import { spec, v, type BlockPack } from '../types';

/** 建材方块包：石砖、金属块、石英等 8 种，供结构阶段与玩家建造使用 */
export const BUILD_PACK: BlockPack = {
  id: 'pack.build',
  label: '建筑方块',
  category: 'mineral',
  blocks: [
    spec('stone_brick', '石砖', v('brick', [150, 150, 152], [112, 112, 116], 50), { hardness: 1.8 }),
    spec('mossy_brick', '苔石砖', v('brick', [120, 132, 110], [72, 104, 62], 51)),
    spec('chiseled_stone', '錾制石', v('checker', [166, 166, 168], [132, 132, 136], 52)),
    spec('iron_block', '铁块', v('solid', [222, 222, 224], undefined, 53), { hardness: 2.4 }),
    spec('gold_block', '金块', v('solid', [246, 206, 72], undefined, 54)),
    spec('diamond_block', '钻石块', v('solid', [86, 226, 220], undefined, 55)),
    spec('quartz_block', '石英块', v('solid', [236, 232, 226], undefined, 56)),
    spec('obsidian_brick', '黑曜石砖', v('brick', [40, 32, 58], [20, 16, 32], 57), { hardness: 6 }),
  ],
};
