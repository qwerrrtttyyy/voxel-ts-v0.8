import { BinaryReader, BinaryWriter } from '../binary/BinaryBuffer';
import { CHUNK_SIZE, SEA_LEVEL, WORLD_CHUNKS } from '../config';
import { EXTRA_BLOCKS, GENERATOR, TERRAIN_MATERIALS, type ExtraBlocks } from '../core/tokens';
import type { Plugin } from '../core/types';
import { AIR_ID } from '../world/BlockRegistry';
import type { IGenerator } from '../world/IGenerator';

function hash2(ix: number, iz: number, seed: number): number {
  let n = Math.imul(ix + seed * 101, 374761393) + Math.imul(iz + seed * 31, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function valueNoise(x: number, z: number, scale: number, seed: number): number {
  const fx = x / scale, fz = z / scale;
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const tx = fx - ix, tz = fz - iz;
  const sx = tx * tx * (3 - 2 * tx), sz = tz * tz * (3 - 2 * tz);
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  return (a + (b - a) * sx) * (1 - sz) + (c + (d - c) * sx) * sz;
}

/**
 * v0.3 丰富地形：沙滩 / 浅水 / 树林 / 矿层 / 地下洞穴。
 * 通过 GENERATOR 服务以 priority=10 顶掉内置 hills-v1；
 * 关掉本插件世界自动回退到原来的小丘，且不需要改任何其它插件。
 */
export function richTerrainPlugin(): Plugin {
  return {
    id: 'voxel.terrain-rich',
    version: '0.3.0',
    meta: {
      label: '丰富地形', category: 'world', author: 'voxel-ts', badge: 'TR',
      description: '多频噪声山脊 + 沙滩浅水 + 树林 + 地下洞穴与矿脉；关闭后回退为原始小丘',
    },
    provides: ['generator', 'richTerrain'],
    dependencies: ['cap:terrainMaterials'],
    optionalDependencies: ['cap:extraBlocks'],
    priority: -18,

    setup(ctx): void {
      const { scope, services } = ctx;
      const mats = services.get(TERRAIN_MATERIALS);
      const extra: ExtraBlocks = services.tryGet(EXTRA_BLOCKS) ?? {};
      const seed = scope.config<number>('seed', 20261107);

      const heightCache = new Map<number, number>();
      const treeCache = new Map<number, boolean>();
      const key = (x: number, z: number): number => x * 100003 + z;

      const height = (wx: number, wz: number): number => {
        const k = key(wx, wz);
        const hit = heightCache.get(k);
        if (hit !== undefined) return hit;
        const big = valueNoise(wx, wz, 34, seed);
        const mid = valueNoise(wx, wz, 15, seed + 7);
        const small = valueNoise(wx, wz, 6, seed + 13);
        const v = Math.round(SEA_LEVEL + (big - 0.5) * 9 + (mid - 0.5) * 3.4 + (small - 0.5) * 1.2);
        heightCache.set(k, v);
        return v;
      };

      // 出生点周围留一片开阔草地，否则玩家一睁眼就是树冠天花板，
      // 天空 / 昼夜 / 云全被挡住；森林按低频噪声成团簇分布，画面才有疏密层次。
      const spawnCenter = (WORLD_CHUNKS * CHUNK_SIZE) / 2;
      const isTree = (wx: number, wz: number): boolean => {
        const k = key(wx, wz);
        const hit = treeCache.get(k);
        if (hit !== undefined) return hit;
        const inSpawnClearing = Math.abs(wx - spawnCenter) < 11 && Math.abs(wz - spawnCenter) < 11;
        const forest = valueNoise(wx, wz, 24, seed + 1200) > 0.60;
        const v = !inSpawnClearing && height(wx, wz) > SEA_LEVEL
          && forest && hash2(wx, wz, seed + 991) > 0.982;
        treeCache.set(k, v);
        return v;
      };

      const treeHeight = (wx: number, wz: number): number =>
        3 + Math.floor(hash2(wx, wz, seed + 992) * 3);

      const gen: IGenerator = {
        id: 'rich-v1',
        surfaceY: height,
        blockAt(wx, y, wz, surface) {
          // 地表以上：树 / 浅水 / 空气
          if (y > surface) {
            if (y <= SEA_LEVEL && extra.water !== undefined) return extra.water;
            if (y <= surface + 9 && (extra.wood !== undefined || extra.leaves !== undefined)) {
              for (let dx = -2; dx <= 2; dx++) {
                for (let dz = -2; dz <= 2; dz++) {
                  const tx = wx + dx, tz = wz + dz;
                  if (!isTree(tx, tz)) continue;
                  const ts = height(tx, tz);
                  const rel = y - (ts + 1);
                  if (rel < 0 || rel > 8) continue;
                  const th = treeHeight(tx, tz);
                  if (dx === 0 && dz === 0 && rel < th && extra.wood !== undefined) return extra.wood;
                  if (rel >= th - 2 && rel <= th + 1 && extra.leaves !== undefined) {
                    const r = Math.abs(dx) + Math.abs(dz);
                    if (r <= 3 && !(r === 3 && rel === th + 1)
                      && hash2(wx + dx * 3, wz + dz * 3, seed + 993) > 0.14) return extra.leaves;
                  }
                }
              }
            }
            return AIR_ID;
          }

          // 地下洞穴：连续的管道状空腔，AABB 碰撞下可以真的钻进去
          if (y > 2 && y < surface - 4) {
            const cave = Math.sin(wx * 0.21 + y * 0.13) * Math.cos(wz * 0.19 - y * 0.11)
              + 0.42 * Math.sin(y * 0.37 + wx * 0.05);
            if (cave > 1.12) return AIR_ID;
          }

          // 沙滩 / 草顶
          if (y === surface) {
            if (surface <= SEA_LEVEL - 1 && extra.sand !== undefined) return extra.sand;
            return mats.grass;
          }
          // 近地表 3 层：土 / 沙
          if (y > surface - 4) {
            if (surface <= SEA_LEVEL - 1 && extra.sand !== undefined) return extra.sand;
            return mats.dirt;
          }
          // 深层：石头 + 零星矿脉
          const ore = hash2(wx + y * 7, wz - y * 3, seed + 1301);
          if (ore > 0.988 && extra.glowstone !== undefined) return extra.glowstone;
          if (ore > 0.955 && extra.gravel !== undefined) return extra.gravel;
          return extra.stone ?? mats.dirt;
        },
      };

      scope.service(GENERATOR, gen, { priority: 10 });

      scope.binary(0, {
        name: 'voxel.terrain-rich/params',
        encode: (v: { seed: number; generator: string }): ArrayBuffer =>
          new BinaryWriter().f64(v.seed).string(v.generator).finish(),
        decode: (buf: ArrayBuffer): { seed: number; generator: string } => {
          const r = BinaryReader.from(buf);
          return { seed: r.f64(), generator: r.string() };
        },
        snapshot: () => ({ seed, generator: gen.id }),
      });

      ctx.log(`generator=${gen.id} (hills + beach + forest + caves) seed=${seed}`);
    },
  };
}
