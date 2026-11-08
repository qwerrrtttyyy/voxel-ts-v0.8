import { spec, v, type RGB, type BlockPack } from '../types';

/** 16 色混凝土：同一 wool 算子 + 不同基色，展示「数据即方块」 */
const COLORS: ReadonlyArray<readonly [string, string, RGB]> = [
  ['concrete_white', '白色混凝土', [222, 222, 222]],
  ['concrete_orange', '橙色混凝土', [226, 118, 42]],
  ['concrete_magenta', '品红混凝土', [186, 66, 178]],
  ['concrete_light_blue', '淡蓝混凝土', [92, 158, 208]],
  ['concrete_yellow', '黄色混凝土', [226, 196, 48]],
  ['concrete_lime', '黄绿混凝土', [96, 176, 58]],
  ['concrete_pink', '粉色混凝土', [226, 142, 152]],
  ['concrete_gray', '灰色混凝土', [72, 72, 76]],
  ['concrete_light_gray', '淡灰混凝土', [156, 156, 160]],
  ['concrete_cyan', '青色混凝土', [44, 152, 156]],
  ['concrete_purple', '紫色混凝土', [122, 62, 176]],
  ['concrete_blue', '蓝色混凝土', [62, 82, 178]],
  ['concrete_brown', '棕色混凝土', [112, 76, 50]],
  ['concrete_green', '绿色混凝土', [68, 108, 36]],
  ['concrete_red', '红色混凝土', [166, 48, 42]],
  ['concrete_black', '黑色混凝土', [26, 26, 30]],
];

export const COLOR_PACK: BlockPack = {
  id: 'pack.color',
  label: '彩色混凝土',
  category: 'color',
  blocks: COLORS.map(([local, label, rgb], i) =>
    spec(local, label, v('wool', rgb, undefined, 70 + i))),
};
