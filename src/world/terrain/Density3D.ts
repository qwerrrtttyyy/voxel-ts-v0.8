import { CHUNK_HEIGHT, SEA_LEVEL } from '../../config';
import { fbm2, hash3, valueNoise2, valueNoise3 } from './Noise';

/**
 * v0.7 真 3D 地形密度场。
 *
 * 旧流水线的本质是「2D 高度图 → 每列填到 surface → 再挖几个洞」：
 * `surfaceY(x,z)` 一旦定下，该列在 y 方向就是单调的 solid→air，
 * 悬垂、浮空岛、天然拱门在数学上不可能出现。
 *
 * 这里改成**三维标量场** d(x,y,z)，d>0 为固体、d<=0 为空气：
 *   1. 骨架  `(surface(x,z) - y)`：仍给出可站立的大陆轮廓
 *   2. 3D 起伏 `fbm3(x,y,z)`：山腰凸出、崖壁内凹，垂直方向不再单调
 *   3. 浮岛场  按 14³ 世界网格布椭球岛心，SDF 直接加进密度
 *   4. 洞穴场  两路 ridged 3D 噪声相交，挖出连续管道 + 团块腔室
 *   5. 矿脉场  3D 值噪声阈值，形成跨体素的连续矿团而非逐格 hash
 *
 * 所有输入都是**世界整数坐标 + seed**，不含 chunk 局部量、不含 Math.random：
 * 因此跨 chunk / 跨 region / 存档重载 / 负坐标都逐字节一致。
 */

export interface Density3DOptions {
  readonly seed: number;
  /** 3D 起伏强度，0 关闭；越大悬垂与凸岩越多 */
  readonly relief: number;
  /** 洞穴密度，0 关闭；1 为标准 */
  readonly caves: number;
  /** 浮空岛密度，0 关闭；1 为标准 */
  readonly islands: number;
  /** 矿脉密度，0 关闭；1 为标准 */
  readonly ores: number;
}

export const DEFAULT_DENSITY3D: Density3DOptions = {
  seed: 20261107, relief: 1, caves: 1, islands: 1, ores: 1,
};

/** 3D 分形噪声：逐 octave 提高频率，输出仍归一化到 0~1 */
export function fbm3(
  x: number, y: number, z: number,
  scale: number, octaves: number, seed: number,
): number {
  let amplitude = 0.5, frequency = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amplitude * valueNoise3(x, y, z, scale / frequency, seed + o * 131);
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return sum / norm;
}

const ISLAND_CELL = 14;

interface IslandCell {
  readonly cx: number;
  readonly cz: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rx: number;
  readonly ry: number;
  readonly rz: number;
}

/** 矿脉等级：按深度从浅到深 */
export type OreTier = 0 | 1 | 2 | 3 | 4 | 5;

export class DensityField3D {
  private readonly surfaceCache = new Map<string, number>();
  private readonly islandCache = new Map<string, IslandCell[]>();

  constructor(readonly options: Density3DOptions = DEFAULT_DENSITY3D) {}

  get seed(): number { return this.options.seed; }

  /** 2D 骨架高度：真 3D 下它是「密度场基准」，不是该列最高体素 */
  surface(x: number, z: number): number {
    const key = `${x},${z}`;
    const hit = this.surfaceCache.get(key);
    if (hit !== undefined) return hit;
    const seed = this.options.seed;
    const continent = fbm2(x, z, 42, 4, seed);
    const ridge = fbm2(x, z, 18, 3, seed + 7);
    const detail = valueNoise2(x, z, 6, seed + 13);
    let h = Math.round(
      SEA_LEVEL + (continent - 0.48) * 22 + (ridge - 0.5) * 7 + (detail - 0.5) * 1.6,
    );
    h = Math.max(3, Math.min(CHUNK_HEIGHT - 12, h));
    if (this.surfaceCache.size > 40000) this.surfaceCache.clear();
    this.surfaceCache.set(key, h);
    return h;
  }

  /**
   * 3×3 邻域内的浮岛岛心。参数按 (cellX, cellZ) 缓存，
   * 每列只算 9 次 hash，而不是 48 个 y 各算一遍。
   */
  private islandsNear(x: number, z: number): IslandCell[] {
    const cx = Math.floor(x / ISLAND_CELL), cz = Math.floor(z / ISLAND_CELL);
    const key = `${cx},${cz}`;
    const hit = this.islandCache.get(key);
    if (hit) return hit;
    const seed = this.options.seed;
    const out: IslandCell[] = [];
    // islands=1 时约 28% 的 cell 有岛；0 时完全关闭
    const chance = 0.28 * this.options.islands;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const ix = cx + dx, iz = cz + dz;
        if (hash3(ix, 0, iz, seed + 900) > chance) continue;
        const jx = hash3(ix, 1, iz, seed + 901);
        const jz = hash3(ix, 2, iz, seed + 902);
        const jy = hash3(ix, 3, iz, seed + 903);
        const jr = hash3(ix, 4, iz, seed + 904);
        const s = this.surface(ix * ISLAND_CELL + 7, iz * ISLAND_CELL + 7);
        out.push({
          cx: ix, cz: iz,
          x: (ix + 0.2 + jx * 0.6) * ISLAND_CELL,
          z: (iz + 0.2 + jz * 0.6) * ISLAND_CELL,
          // 夹在世界高度内，避免高地表区域的岛被 CHUNK_HEIGHT 裁掉
          y: Math.min(CHUNK_HEIGHT - 5, s + 8 + jy * 9),
          rx: 5 + jr * 4,
          ry: 2.2 + jy * 1.2,
          rz: 5 + jx * 4,
        });
      }
    }
    if (this.islandCache.size > 20000) this.islandCache.clear();
    this.islandCache.set(key, out);
    return out;
  }

  /** 三维密度：>0 固体，<=0 空气（洞穴在此之前单独剔除） */
  density(x: number, y: number, z: number): number {
    const s = this.surface(x, z);
    let d = (s - y) * 0.55;

    // ---- 1. 3D 起伏：只在近地表带生效，深处仍是稳定基岩 ----
    if (this.options.relief > 0) {
      const dy = Math.abs(y - s);
      if (dy <= 14) {
        const w = 1 - dy / 14;
        const n = fbm3(x, y, z, 16, 2, this.options.seed + 311);
        d += (n - 0.5) * 2 * 3.4 * this.options.relief * w;
      }
      // 岩板：垂直方向压缩采样，形成水平伸出的 shelf / 天然拱门
      const above = y - s;
      if (above > 0 && above <= 7) {
        const n = valueNoise3(x, y * 0.55, z, 7, this.options.seed + 355);
        d += (n - 0.60) * 7.5 * this.options.relief * (1 - Math.abs(above - 3.5) / 4.5);
      }
    }

    // ---- 2. 浮岛：椭球 SDF 直接叠加，岛下方天然是空气（悬垂） ----
    if (this.options.islands > 0) {
      for (const c of this.islandsNear(x, z)) {
        const qx = (x - c.x) / c.rx, qy = (y - c.y) / c.ry, qz = (z - c.z) / c.rz;
        const q = qx * qx + qy * qy + qz * qz;
        if (q >= 1) continue;
        const island = (1 - Math.sqrt(q)) * 9;
        if (island > d) d = island; // SDF 取最大，多个岛可自然合并
      }
    }

    // ---- 3. 骨架地板：y<=surface 必须有一层连续可站立地面 ----
    // 3D 起伏 / 岩板只在地表以上造悬垂；地下结构交给洞穴场挖，
    // 否则 base=(s-y) 在 y=s 处恰为 0，起伏一负就出现「地表破洞」，
    // 玩家刚出生就可能踩空掉进虚空。
    if (y <= s) d = Math.max(d, 0.6 + (s - y) * 0.25);
    return d;
  }

  /** 洞穴：两路 ridged 噪声相交成连续管道，再叠低频团块腔室 */
  caveAt(x: number, y: number, z: number): boolean {
    if (this.options.caves <= 0) return false;
    const s = this.surface(x, z);
    // 保住基岩与地表层：玩家永远有一层可站立的地面
    if (y < 2 || y >= s - 1) return false;
    const seed = this.options.seed;
    const a = valueNoise3(x, y, z, 9, seed + 401);
    const b = valueNoise3(x, y, z, 21, seed + 402);
    const ridge = Math.min(1 - Math.abs(a * 2 - 1), 1 - Math.abs(b * 2 - 1));
    const threshold = 0.86 - 0.10 * this.options.caves;
    if (ridge > threshold) return true;
    // 大腔室：让洞穴不只是细管，也有可钻进去的空间
    const chamber = valueNoise3(x, y, z, 17, seed + 403);
    return chamber > 0.795 - 0.02 * this.options.caves;
  }

  /** 矿脉：3D 噪声阈值 → 相邻体素连续成团；返回 0 表示无矿 */
  oreTier(x: number, y: number, z: number): OreTier {
    if (this.options.ores <= 0) return 0;
    const n = valueNoise3(x, y, z, 4.5, this.options.seed + 511);
    if (n < 0.80 - 0.06 * this.options.ores) return 0;
    const s = this.surface(x, z);
    const depth = s - y;
    if (depth > 16) return 5;      // 钻石 / 绿宝石
    if (depth > 12) return 4;      // 金 / 红石
    if (depth > 9) return 3;       // 青金石
    if (depth > 6) return 2;       // 铁
    if (depth > 3) return 1;       // 铜 / 煤
    return 0;
  }

  /** 综合判定：密度为正且未被洞穴挖空 */
  isSolid(x: number, y: number, z: number): boolean {
    return this.density(x, y, z) > 0 && !this.caveAt(x, y, z);
  }

  get stats(): {
    seed: number; relief: number; caves: number; islands: number; ores: number;
    surfaceCache: number; islandCells: number;
  } {
    return {
      seed: this.options.seed,
      relief: this.options.relief, caves: this.options.caves,
      islands: this.options.islands, ores: this.options.ores,
      surfaceCache: this.surfaceCache.size, islandCells: this.islandCache.size,
    };
  }
}
