import { SEA_LEVEL } from '../../config';

/** 11 种生物群系。每一种只是一组数据，阶段代码不认识具体群系 */
export type BiomeId =
  | 'ocean' | 'beach' | 'desert' | 'plains' | 'forest' | 'jungle'
  | 'swamp' | 'taiga' | 'tundra' | 'mountains' | 'peaks';

export type TreeKind = 'oak' | 'birch' | 'spruce' | 'jungle' | 'cactus' | 'none';

export interface BiomeDef {
  readonly id: BiomeId;
  readonly label: string;
  /** 方块 local 名，由 BlockLibrary 解析；包被关闭时自动降级 */
  readonly surface: string;
  readonly subsurface: string;
  readonly deep: string;
  readonly tree: TreeKind;
  readonly treeDensity: number;
  readonly snow: boolean;
  readonly water: boolean;
  readonly flower: string | null;
  readonly oreBias: number;
}

export const BIOMES: Readonly<Record<BiomeId, BiomeDef>> = {
  ocean: { id: 'ocean', label: '海洋', surface: 'sand', subsurface: 'sand', deep: 'stone', tree: 'none', treeDensity: 0, snow: false, water: true, flower: null, oreBias: 0.6 },
  beach: { id: 'beach', label: '沙滩', surface: 'sand', subsurface: 'sand', deep: 'stone', tree: 'none', treeDensity: 0, snow: false, water: true, flower: null, oreBias: 0.9 },
  desert: { id: 'desert', label: '沙漠', surface: 'red_sand', subsurface: 'sandstone', deep: 'sandstone', tree: 'cactus', treeDensity: 0.004, snow: false, water: false, flower: null, oreBias: 1.1 },
  plains: { id: 'plains', label: '平原', surface: 'grass', subsurface: 'dirt', deep: 'stone', tree: 'oak', treeDensity: 0.006, snow: false, water: false, flower: 'flower_red', oreBias: 1 },
  forest: { id: 'forest', label: '森林', surface: 'grass', subsurface: 'dirt', deep: 'stone', tree: 'oak', treeDensity: 0.032, snow: false, water: false, flower: 'flower_yellow', oreBias: 1 },
  jungle: { id: 'jungle', label: '丛林', surface: 'grass', subsurface: 'dirt', deep: 'stone', tree: 'jungle', treeDensity: 0.055, snow: false, water: false, flower: 'flower_blue', oreBias: 0.95 },
  swamp: { id: 'swamp', label: '沼泽', surface: 'grass', subsurface: 'mud', deep: 'stone', tree: 'oak', treeDensity: 0.012, snow: false, water: true, flower: 'mushroom_red', oreBias: 0.8 },
  taiga: { id: 'taiga', label: '针叶林', surface: 'podzol', subsurface: 'dirt', deep: 'stone', tree: 'spruce', treeDensity: 0.038, snow: true, water: false, flower: null, oreBias: 1.05 },
  tundra: { id: 'tundra', label: '冻原', surface: 'snow_block', subsurface: 'dirt', deep: 'stone', tree: 'none', treeDensity: 0, snow: true, water: true, flower: null, oreBias: 0.9 },
  mountains: { id: 'mountains', label: '山地', surface: 'cobblestone', subsurface: 'cobblestone', deep: 'stone', tree: 'none', treeDensity: 0, snow: true, water: false, flower: null, oreBias: 1.4 },
  peaks: { id: 'peaks', label: '雪峰', surface: 'snow_block', subsurface: 'cobblestone', deep: 'stone', tree: 'none', treeDensity: 0, snow: true, water: false, flower: null, oreBias: 1.6 },
};

/** 由高度 / 温度 / 湿度决定群系；纯函数，可缓存 */
export function selectBiome(height: number, temperature: number, humidity: number): BiomeId {
  if (height <= SEA_LEVEL - 3) return 'ocean';
  if (height <= SEA_LEVEL) return 'beach';
  if (height >= SEA_LEVEL + 14) return humidity > 0.62 ? 'peaks' : 'mountains';
  if (temperature < 0.24) return humidity > 0.52 ? 'taiga' : 'tundra';
  if (temperature > 0.70 && humidity < 0.38) return 'desert';
  if (humidity > 0.68 && temperature > 0.58) return 'jungle';
  if (humidity > 0.66 && height <= SEA_LEVEL + 2) return 'swamp';
  if (height > SEA_LEVEL + 9) return 'mountains';
  if (humidity > 0.56) return 'forest';
  return 'plains';
}

export const BIOME_IDS: readonly BiomeId[] = Object.keys(BIOMES) as BiomeId[];
