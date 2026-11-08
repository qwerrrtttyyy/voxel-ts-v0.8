import type { BlockPack } from '../types';
import { STONE_PACK } from './StonePack';
import { SOIL_PACK } from './SoilPack';
import { WOOD_PACK } from './WoodPack';
import { ORE_PACK } from './OrePack';
import { BUILD_PACK } from './BuildPack';
import { COLOR_PACK } from './ColorPack';
import { LIGHT_PACK } from './LightPack';
import { LIQUID_PACK } from './LiquidPack';
import { PLANT_PACK } from './PlantPack';
import { NETHER_PACK } from './NetherPack';

/**
 * 全部方块包。新增一个包 = 新建一个文件 + 在这里加一行；
 * 每个包会被包装成独立的 Cordis 组件，可在插件仓库里单独开关。
 */
export const allPacks: readonly BlockPack[] = [
  STONE_PACK, SOIL_PACK, WOOD_PACK, ORE_PACK, BUILD_PACK,
  COLOR_PACK, LIGHT_PACK, LIQUID_PACK, PLANT_PACK, NETHER_PACK,
];

export const packCount: number = allPacks.length;

export const totalBlockCount: number = allPacks.reduce((n, p) => n + p.blocks.length, 0);
