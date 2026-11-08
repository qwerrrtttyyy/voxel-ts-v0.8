import { spec, v, type BlockPack } from '../types';

/** 木材方块包：白桦 / 云杉 / 丛林 / 金合欢 / 深色橡木，共 12 种（原木带分面贴图） */
const log = (seed: number, bark: readonly [number, number, number], ring: readonly [number, number, number]) =>
  v('bark', bark, undefined, seed, {
    faces: {
      top: v('rings', ring, undefined, seed + 1),
      side: v('bark', bark, undefined, seed + 2),
    },
  });

export const WOOD_PACK: BlockPack = {
  id: 'pack.wood',
  label: '木材方块',
  category: 'natural',
  blocks: [
    spec('birch_log', '白桦原木', log(20, [214, 208, 186], [226, 216, 190])),
    spec('birch_plank', '白桦木板', v('plank', [206, 190, 150], undefined, 21)),
    spec('birch_leaves', '白桦树叶', v('cutout', [96, 168, 72], undefined, 22, { density: 0.16 }),
      { opaque: false, solid: false, hardness: 0.4 }),
    spec('spruce_log', '云杉原木', log(23, [84, 58, 36], [150, 112, 70])),
    spec('spruce_plank', '云杉木板', v('plank', [140, 102, 62], undefined, 24)),
    spec('spruce_leaves', '云杉树叶', v('cutout', [58, 112, 74], undefined, 25, { density: 0.17 }),
      { opaque: false, solid: false, hardness: 0.4 }),
    spec('jungle_log', '丛林木原木', log(26, [110, 84, 48], [166, 132, 78])),
    spec('jungle_plank', '丛林木板', v('plank', [166, 124, 78], undefined, 27)),
    spec('jungle_leaves', '丛林树叶', v('cutout', [66, 148, 52], undefined, 28, { density: 0.15 }),
      { opaque: false, solid: false, hardness: 0.4 }),
    spec('acacia_log', '金合欢原木', log(29, [128, 72, 52], [180, 124, 88])),
    spec('acacia_plank', '金合欢木板', v('plank', [186, 110, 68], undefined, 30)),
    spec('dark_oak_log', '深色橡木原木', log(31, [62, 44, 30], [110, 82, 52])),
  ],
};
