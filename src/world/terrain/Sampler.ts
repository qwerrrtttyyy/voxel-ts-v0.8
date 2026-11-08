import { CHUNK_HEIGHT, CHUNK_SIZE, SEA_LEVEL, WORLD_CHUNKS } from '../../config';
import { fbm2, hash2, valueNoise2 } from './Noise';
import { BIOMES, selectBiome, type BiomeId, type TreeKind } from './Biome';

export interface Sample {
  readonly height: number;
  readonly temperature: number;
  readonly humidity: number;
  readonly continent: number;
  readonly biome: BiomeId;
}

export interface TreeInfo {
  readonly kind: TreeKind;
  readonly trunk: number;
  readonly base: number;
}

/**
 * 地形采样器：把「大陆 / 温度 / 湿度 / 群系 / 树位」统一缓存。
 * 列构建、邻列植被查询共用同一份结果，避免 9216 列反复算 fbm。
 */
export class TerrainSampler {
  private readonly sampleCache = new Map<string, Sample>();
  private readonly treeCache = new Map<string, TreeInfo | null>();
  private readonly spawnCenter = (WORLD_CHUNKS * CHUNK_SIZE) / 2;

  constructor(readonly seed: number) {}

  /** v0.7：字符串 key 支持负坐标无限世界；整数键 wx*100003+wz 会与 (-1,100003) 碰撞 */
  private static key(wx: number, wz: number): string { return `${wx},${wz}`; }

  sample(wx: number, wz: number): Sample {
    const key = TerrainSampler.key(wx, wz);
    const hit = this.sampleCache.get(key);
    if (hit) return hit;

    const continent = fbm2(wx, wz, 42, 4, this.seed);
    const ridge = fbm2(wx, wz, 18, 3, this.seed + 7);
    const detail = valueNoise2(wx, wz, 6, this.seed + 13);
    let height = Math.round(
      SEA_LEVEL + (continent - 0.48) * 22 + (ridge - 0.5) * 7 + (detail - 0.5) * 1.6,
    );
    // 留 12 层给树冠与结构，同时不触碰世界底部
    height = Math.max(3, Math.min(CHUNK_HEIGHT - 12, height));

    const temperature = fbm2(wx, wz, 55, 3, this.seed + 101);
    const humidity = fbm2(wx, wz, 48, 3, this.seed + 211);
    const value: Sample = {
      height, temperature, humidity, continent,
      biome: selectBiome(height, temperature, humidity),
    };
    if (this.sampleCache.size > 60000) this.sampleCache.clear();
    this.sampleCache.set(key, value);
    return value;
  }

  /** 该列是否是一棵树的树干位置；出生点周围留空地，保证天空 / 昼夜可见 */
  treeAt(wx: number, wz: number): TreeInfo | null {
    const key = TerrainSampler.key(wx, wz);
    if (this.treeCache.has(key)) return this.treeCache.get(key) ?? null;
    const s = this.sample(wx, wz);
    const def = BIOMES[s.biome];
    const inClearing = Math.abs(wx - this.spawnCenter) < 11 && Math.abs(wz - this.spawnCenter) < 11;
    const cluster = valueNoise2(wx, wz, 24, this.seed + 1200) > 0.52;
    const roll = hash2(wx, wz, this.seed + 991);
    let result: TreeInfo | null = null;
    if (!inClearing && def.tree !== 'none' && s.height > SEA_LEVEL && cluster && roll < def.treeDensity) {
      result = {
        kind: def.tree,
        trunk: def.tree === 'jungle' ? 5 + Math.floor(hash2(wx, wz, this.seed + 992) * 3)
          : 3 + Math.floor(hash2(wx, wz, this.seed + 992) * 3),
        base: s.height,
      };
    }
    if (this.treeCache.size > 60000) this.treeCache.clear();
    this.treeCache.set(key, result);
    return result;
  }

  get cacheSize(): number { return this.sampleCache.size + this.treeCache.size; }
}
