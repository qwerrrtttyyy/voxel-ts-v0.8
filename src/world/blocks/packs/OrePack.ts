import { spec, v, type RGB, type BlockPack } from '../types';

const stone: RGB = [128, 128, 132];
const ore = (local: string, label: string, gem: RGB, seed: number, hardness = 2.2) =>
  spec(local, label, v('ore', stone, gem, seed, { density: 0.22 }), { hardness });

/** 矿物方块包：8 种矿脉，地形 ore 阶段按高度分布 */
export const ORE_PACK: BlockPack = {
  id: 'pack.ore',
  label: '矿物方块',
  category: 'mineral',
  blocks: [
    ore('coal_ore', '煤矿石', [40, 40, 42], 40, 1.8),
    ore('iron_ore', '铁矿石', [206, 158, 116], 41),
    ore('copper_ore', '铜矿石', [206, 126, 74], 42),
    ore('gold_ore', '金矿石', [246, 206, 72], 43, 2.6),
    ore('redstone_ore', '红石矿石', [226, 54, 48], 44, 2.4),
    ore('lapis_ore', '青金石矿石', [54, 88, 206], 45, 2.4),
    ore('emerald_ore', '绿宝石矿石', [56, 206, 104], 46, 3.0),
    ore('diamond_ore', '钻石矿石', [86, 226, 220], 47, 3.2),
  ],
};
