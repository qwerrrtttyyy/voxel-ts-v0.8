import { CHUNK_HEIGHT, SEA_LEVEL, WORLD_CHUNKS, CHUNK_SIZE } from '../../config';
import { AIR_ID, type BlockRegistry } from '../BlockRegistry';
import type { IGenerator } from '../IGenerator';
import type { BlockLibrary } from '../blocks/types';
import { BIOMES, selectBiome, type TreeKind } from './Biome';
import { DensityField3D, DEFAULT_DENSITY3D, type Density3DOptions } from './Density3D';
import { fbm2, hash2, valueNoise2 } from './Noise';

/** 生成器需要的方块 id 表；全部按 local 名解析，缺哪个就自动降级 */
export interface Generator3DIds {
  grass: number; dirt: number; stone: number; sand: number; water: number;
  bedrock: number; snow: number; cobble: number; wood: number; leaves: number;
  /** 按 OreTier 1..5 索引 */
  ores: readonly number[];
}

export interface ResolveIdsOptions {
  lib?: BlockLibrary;
  blocks?: BlockRegistry;
  mats?: Readonly<Record<string, number>>;
  extra?: Readonly<Record<string, number>>;
}

/** 从 Cordis 方块库 / 注册表 / 外壳材质表里挑出可用 id，全部缺失时返回 0 */
export function resolveIds(o: ResolveIdsOptions): Generator3DIds {
  const byName = new Map<string, number>();
  if (o.blocks) {
    for (const d of o.blocks.all()) {
      const local = d.name.includes(':') ? d.name.slice(d.name.indexOf(':') + 1) : d.name;
      if (!byName.has(local)) byName.set(local, d.id);
    }
  }
  const pick = (...names: string[]): number => {
    for (const n of names) {
      const a = o.lib?.id(n) ?? 0; if (a) return a;
      const b = byName.get(n) ?? 0; if (b) return b;
      const c = o.mats?.[n] ?? 0; if (c) return c;
      const d = o.extra?.[n] ?? 0; if (d) return d;
    }
    return 0;
  };
  return {
    grass: pick('grass', 'grass_block'),
    dirt: pick('dirt', 'mud'),
    stone: pick('stone', 'deepslate'),
    sand: pick('sand', 'red_sand'),
    water: pick('water'),
    bedrock: pick('bedrock', 'obsidian'),
    snow: pick('snow_block', 'snow'),
    cobble: pick('cobblestone', 'stone'),
    wood: pick('wood', 'oak_log'),
    leaves: pick('leaves', 'oak_leaves'),
    ores: [
      pick('copper_ore', 'coal_ore'),
      pick('iron_ore'),
      pick('lapis_ore', 'redstone_ore'),
      pick('gold_ore'),
      pick('diamond_ore', 'emerald_ore'),
    ],
  };
}

interface TreeAt {
  readonly base: number;
  readonly trunk: number;
  readonly kind: TreeKind;
}

interface ColumnResult {
  readonly blocks: Uint8Array;
  readonly surface: number;
  readonly highest: number;
}

const MAX_COLUMNS = 40000;

/**
 * 把 3D 密度场包装成 `IGenerator`。
 *
 * World / mesher / 碰撞 / 存档完全不用改：它们只认 `surfaceY` + `blockAt`。
 * 内部按列缓存整列 48 个 id —— 密度场是纯世界坐标函数，缓存只是性能，
 * 淘汰后重算结果逐字节一致，因此无限世界里反复进出同一区域不会「漂移」。
 */
export class Terrain3DGenerator implements IGenerator {
  readonly id = 'density3d-v1';
  private readonly columns = new Map<string, ColumnResult>();

  constructor(
    readonly field: DensityField3D = new DensityField3D(DEFAULT_DENSITY3D),
    readonly ids: Generator3DIds = resolveIds({}),
    readonly seed: number = field.options.seed,
  ) {}

  /** 该列 2D 骨架高度（真 3D 下不是最高体素，见 inspect().highest） */
  surfaceY(wx: number, wz: number): number {
    return this.field.surface(wx, wz);
  }

  blockAt(wx: number, y: number, wz: number, _surface: number): number {
    if (y < 0 || y >= CHUNK_HEIGHT) return AIR_ID;
    return this.column(wx, wz).blocks[y];
  }

  /** 验收 / 控制台用：整列 + 骨架高度 + 实际最高固体（能看出浮岛） */
  inspect(wx: number, wz: number): { blocks: number[]; surface: number; highest: number } {
    const c = this.column(wx, wz);
    return { blocks: [...c.blocks], surface: c.surface, highest: c.highest };
  }

  /** 直接读密度，用于连续性 / 等值面自检 */
  densityAt(x: number, y: number, z: number): number {
    return this.field.density(x, y, z);
  }

  get stats(): {
    id: string; columns: number; cacheSize: number;
    seed: number; relief: number; caves: number; islands: number; ores: number;
  } {
    const f = this.field.stats;
    return {
      id: this.id, columns: this.columns.size, cacheSize: this.columns.size,
      seed: f.seed, relief: f.relief, caves: f.caves, islands: f.islands, ores: f.ores,
    };
  }

  resetCache(): void { this.columns.clear(); }

  /** 群系：与 2D 流水线用同一套温度/湿度公式，地表材质风格保持一致 */
  private biomeAt(wx: number, wz: number, s: number) {
    const temperature = fbm2(wx, wz, 55, 3, this.seed + 101);
    const humidity = fbm2(wx, wz, 48, 3, this.seed + 211);
    const biome = selectBiome(s, temperature, humidity);
    return { def: BIOMES[biome], temperature, humidity, biome };
  }

  private treeAt(wx: number, wz: number): TreeAt | null {
    const s = this.field.surface(wx, wz);
    const { def } = this.biomeAt(wx, wz, s);
    const spawn = (WORLD_CHUNKS * CHUNK_SIZE) / 2;
    const clearing = Math.abs(wx - spawn) < 11 && Math.abs(wz - spawn) < 11;
    const cluster = valueNoise2(wx, wz, 24, this.seed + 1200) > 0.52;
    if (clearing || def.tree === 'none' || def.tree === 'cactus'
      || s <= SEA_LEVEL || !cluster
      || hash2(wx, wz, this.seed + 991) > def.treeDensity) return null;
    return {
      base: s,
      trunk: def.tree === 'jungle'
        ? 5 + Math.floor(hash2(wx, wz, this.seed + 992) * 3)
        : 3 + Math.floor(hash2(wx, wz, this.seed + 992) * 3),
      kind: def.tree,
    };
  }

  private column(wx: number, wz: number): ColumnResult {
    const key = `${wx},${wz}`;
    const hit = this.columns.get(key);
    if (hit) return hit;

    const s = this.field.surface(wx, wz);
    const { def } = this.biomeAt(wx, wz, s);
    const blocks = new Uint8Array(CHUNK_HEIGHT);
    const { ids } = this;
    const top = (def.snow && ids.snow ? ids.snow : 0)
      || (s <= SEA_LEVEL + 1 && ids.sand ? ids.sand : 0)
      || (def.surface === 'cobblestone' && ids.cobble ? ids.cobble : 0)
      || ids.grass || ids.dirt || ids.stone;
    const sub = (s <= SEA_LEVEL + 1 && ids.sand ? ids.sand : 0) || ids.dirt || ids.stone || top;
    const deep = ids.stone || ids.cobble || sub || top;

    for (let y = 0; y < CHUNK_HEIGHT; y++) {
      if (y <= 1) {
        blocks[y] = ids.bedrock || deep;   // 基岩不受密度场 / 洞穴影响
        continue;
      }
      if (this.field.isSolid(wx, y, wz)) {
        const tier = y < s - 2 ? this.field.oreTier(wx, y, wz) : 0;
        const ore = tier > 0 ? ids.ores[tier - 1] : 0;
        blocks[y] = ore || (y >= s ? top : y >= s - 3 ? sub : deep);
      } else if (y <= SEA_LEVEL && y >= s - 6 && ids.water) {
        // 低洼积水只补近地表，不灌进深层洞穴
        blocks[y] = ids.water;
      }
    }

    // 轻量植被：3×3 邻域树冠，只填空气格，不破坏浮岛 / 悬垂 / 岩板
    if (ids.wood || ids.leaves) {
      const nearby: Array<{ dx: number; dz: number; t: TreeAt }> = [];
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          const t = this.treeAt(wx + dx, wz + dz);
          if (t) nearby.push({ dx, dz, t });
        }
      }
      for (const { dx, dz, t } of nearby) {
        for (let y = Math.max(s + 1, t.base + 1); y < CHUNK_HEIGHT; y++) {
          if (blocks[y] !== AIR_ID) continue;
          const rel = y - (t.base + 1);
          if (rel < 0 || rel > t.trunk + 2) continue;
          if (dx === 0 && dz === 0 && rel < t.trunk) {
            if (ids.wood) blocks[y] = ids.wood;
          } else if (rel >= t.trunk - 2 && rel <= t.trunk + 1
            && Math.abs(dx) + Math.abs(dz) <= 3
            && hash2(wx + dx * 3, wz + dz * 3, this.seed + 993) > 0.14) {
            if (ids.leaves) blocks[y] = ids.leaves;
          }
        }
      }
    }

    let highest = -1;
    for (let y = CHUNK_HEIGHT - 1; y >= 0; y--) {
      if (blocks[y] !== AIR_ID) { highest = y; break; }
    }
    const result: ColumnResult = { blocks, surface: s, highest };
    if (this.columns.size >= MAX_COLUMNS) {
      let drop = Math.max(1, Math.floor(this.columns.size / 4));
      for (const k of this.columns.keys()) {
        this.columns.delete(k);
        if (--drop <= 0) break;
      }
    }
    this.columns.set(key, result);
    return result;
  }
}

/** 从可调参数构造一台生成器（菜单 / 插件 / 验收共用） */
export function createTerrain3D(
  options: Partial<Density3DOptions> = {},
  ids: Generator3DIds = resolveIds({}),
): Terrain3DGenerator {
  const opts: Density3DOptions = { ...DEFAULT_DENSITY3D, ...options };
  return new Terrain3DGenerator(new DensityField3D(opts), ids, opts.seed);
}
