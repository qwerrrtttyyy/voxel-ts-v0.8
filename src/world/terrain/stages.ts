import { CHUNK_HEIGHT, SEA_LEVEL } from '../../config';
import { BIOMES, type TreeKind } from './Biome';
import type { ColumnContext } from './Column';
import { hash2, hash3, valueNoise3 } from './Noise';

/**
 * 地形阶段。
 *
 * 每个阶段是一个独立、纯增量的模块：只读 ColumnContext.meta、只写 blocks。
 * `inject` 声明它依赖哪些前置阶段 —— 这条依赖不写在流水线代码里，
 * 而是交给 Cordis 内核的反应式共效应：关掉上游，下游会自动停用，
 * 流水线随之缩短，不会出现「跳过地层却在挖矿」的半成品世界。
 */
export interface TerrainStage {
  readonly id: string;
  readonly label: string;
  readonly order: number;
  readonly inject: readonly string[];
  apply(col: ColumnContext): void;
}

const CONTINENT: TerrainStage = {
  id: 'stage.continent', label: '大陆与基岩', order: 10, inject: [],
  apply(col) {
    // 世界底部两层基岩，任何群系都一样；也是整条依赖链的根
    col.fill(0, 1, col.id('bedrock') || col.id('obsidian'));
  },
};

const BIOME: TerrainStage = {
  id: 'stage.biome', label: '生物群系地层', order: 20, inject: ['stage.continent'],
  apply(col) {
    const def = BIOMES[col.meta.biome];
    const deep = col.id(def.deep) || col.id('stone');
    // 深层基底按低频噪声混入不同火成岩，展示方块库的丰富度
    const variants = ['granite', 'diorite', 'andesite', 'tuff', 'basalt']
      .map((n) => col.id(n)).filter((v) => v !== 0);
    for (let y = 2; y <= col.height - 4; y++) {
      const r = hash3(col.wx, y, col.wz, col.seed + 250);
      if (variants.length && r > 0.93) col.set(y, variants[Math.floor(r * 1000) % variants.length]);
      else col.set(y, deep);
    }
  },
};

const STRATA: TerrainStage = {
  id: 'stage.strata', label: '近地表地层', order: 30, inject: ['stage.biome'],
  apply(col) {
    const def = BIOMES[col.meta.biome];
    const sub = col.id(def.subsurface) || col.id('dirt');
    const top = col.id(def.surface) || col.id('grass');
    col.fill(Math.max(2, col.height - 3), col.height - 1, sub);
    col.set(col.height, top);
  },
};

const CARVE: TerrainStage = {
  id: 'stage.carve', label: '洞穴与峡谷侵蚀', order: 40, inject: ['stage.strata'],
  apply(col) {
    // 3D 值噪声形成连续管道状空腔；AABB 碰撞下可真的钻进去
    for (let y = 3; y < col.height - 3; y++) {
      const a = valueNoise3(col.wx, y, col.wz, 9, col.seed + 300);
      const b = valueNoise3(col.wx, y, col.wz, 22, col.seed + 301);
      if (a > 0.715 || (b > 0.74 && y < 9)) col.clear(y);
    }
    // 峡谷：低频噪声在地表切出窄沟
    const ravine = valueNoise3(col.wx, 0, col.wz, 30, col.seed + 302);
    if (ravine > 0.78 && col.height > SEA_LEVEL) {
      // 保留最顶层地表：否则该列 surface 处变成空气，World.groundY 会把玩家判成悬空
      for (let y = Math.max(3, col.height - 6); y < col.height; y++) col.clear(y);
    }
  },
};

const ORE: TerrainStage = {
  id: 'stage.ore', label: '矿脉分布', order: 50, inject: ['stage.carve'],
  apply(col) {
    const bias = BIOMES[col.meta.biome].oreBias;
    for (let y = 2; y < col.height - 3; y++) {
      if (col.get(y) === 0) continue;
      const r = hash3(col.wx, y, col.wz, col.seed + 400) * bias;
      let ore: string | null = null;
      if (y < 7 && r > 0.994) ore = 'diamond_ore';
      else if (y < 10 && r > 0.991) ore = 'emerald_ore';
      else if (y < 12 && r > 0.988) ore = 'gold_ore';
      else if (y < 16 && r > 0.984) ore = 'redstone_ore';
      else if (y < 18 && r > 0.982) ore = 'lapis_ore';
      else if (y < 24 && r > 0.978) ore = 'iron_ore';
      else if (y < 28 && r > 0.975) ore = 'copper_ore';
      else if (r > 0.970) ore = 'coal_ore';
      if (ore) col.set(y, col.id(ore));
    }
  },
};

/** 树种类 → 树干 / 树叶方块 local 名 */
const TREE_BLOCKS: Readonly<Record<Exclude<TreeKind, 'none' | 'cactus'>, readonly [string, string]>> = {
  oak: ['wood', 'leaves'],
  birch: ['birch_log', 'birch_leaves'],
  spruce: ['spruce_log', 'spruce_leaves'],
  jungle: ['jungle_log', 'jungle_leaves'],
};

const VEGETATION: TerrainStage = {
  id: 'stage.vegetation', label: '植被', order: 60, inject: ['stage.ore'],
  apply(col) {
    // 树冠会跨列，所以检查 5×5 邻域里的树干
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const tree = col.sampler.treeAt(col.wx + dx, col.wz + dz);
        if (!tree) continue;
        if (tree.kind === 'cactus' || tree.kind === 'none') continue;
        const [trunkName, leafName] = TREE_BLOCKS[tree.kind];
        const trunk = col.id(trunkName) || col.id('wood');
        const leaf = col.id(leafName) || col.id('leaves');
        for (let y = Math.max(0, tree.base + 1); y < CHUNK_HEIGHT; y++) {
          const rel = y - (tree.base + 1);
          if (rel < 0 || rel > tree.trunk + 2) continue;
          if (dx === 0 && dz === 0 && rel < tree.trunk) {
            col.setIfAir(y, trunk);
          } else if (rel >= tree.trunk - 2 && rel <= tree.trunk + 1) {
            const ring = Math.abs(dx) + Math.abs(dz);
            if (ring <= 3 && !(ring === 3 && rel === tree.trunk + 1)
              && hash2(col.wx + dx * 3, col.wz + dz * 3, col.seed + 993) > 0.14) {
              col.setIfAir(y, leaf);
            }
          }
        }
      }
    }

    const def = BIOMES[col.meta.biome];
    const ground = col.height + 1;
    const r = hash2(col.wx, col.wz, col.seed + 500);
    // 植物是 1 格 sprite，密度必须低，否则地砖一样铺满并挡住准星
    if (def.tree === 'cactus' && r < 0.008) {
      const cactus = col.id('cactus');
      for (let y = ground; y <= ground + 2; y++) col.setIfAir(y, cactus);
    } else if (def.flower && r < 0.018) {
      col.setIfAir(ground, col.id(def.flower));
    } else if (r < 0.035 && col.meta.humidity > 0.5) {
      col.setIfAir(ground, col.id('tall_grass'));
    }
    // 沼泽 / 丛林水边的甘蔗
    if ((def.water || col.meta.biome === 'jungle') && r > 0.997) {
      for (let y = ground; y <= ground + 1; y++) col.setIfAir(y, col.id('sugar_cane'));
    }
  },
};

const STRUCTURE: TerrainStage = {
  id: 'stage.structure', label: '遗迹结构', order: 70, inject: ['stage.vegetation'],
  apply(col) {
    // 每 8×8 区域按确定性 hash 决定是否生成一处 2×2 石砖柱
    const rx = Math.floor(col.wx / 8), rz = Math.floor(col.wz / 8);
    if (hash2(rx, rz, col.seed + 600) <= 0.982) return;
    if (col.height <= SEA_LEVEL + 1) return;
    const localX = ((col.wx % 8) + 8) % 8, localZ = ((col.wz % 8) + 8) % 8;
    if (localX >= 2 || localZ >= 2) return;
    const brick = col.id('stone_brick') || col.id('cobblestone');
    const cap = col.id('chiseled_stone') || brick;
    for (let y = col.height + 1; y <= col.height + 3; y++) col.setIfAir(y, brick);
    col.setIfAir(col.height + 4, cap);
  },
};

const DECORATE: TerrainStage = {
  id: 'stage.decorate', label: '水面与装饰', order: 80, inject: ['stage.structure'],
  apply(col) {
    const def = BIOMES[col.meta.biome];
    const water = col.id('water');
    // 海平面以下的空气补成水
    if (def.water || col.height <= SEA_LEVEL) {
      for (let y = col.height + 1; y <= SEA_LEVEL; y++) col.setIfAir(y, water);
    }
    // 冻原水面结浮冰
    if (col.meta.temperature < 0.22 && col.height <= SEA_LEVEL) {
      col.setIfAir(SEA_LEVEL, col.id('packed_ice'));
    }
    // 雪层（不覆盖已放的花 / 树干）
    if (def.snow && col.height > SEA_LEVEL) {
      col.setIfAir(col.height + 1, col.id('snow_block') || col.id('snow'));
    }
    // 山地点缀发光石，夜景有亮点
    if (col.meta.biome === 'mountains' && hash2(col.wx, col.wz, col.seed + 700) > 0.985) {
      col.setIfAir(col.height + 1, col.id('sea_lantern') || col.id('glowstone'));
    }
  },
};

/** 全部阶段。顺序由 order 决定，依赖由 inject 决定，二者解耦 */
export const TERRAIN_STAGES: readonly TerrainStage[] = [
  CONTINENT, BIOME, STRATA, CARVE, ORE, VEGETATION, STRUCTURE, DECORATE,
];
