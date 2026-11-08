import { BinaryReader, BinaryWriter } from '../binary/BinaryBuffer';
import { GENERATOR, TERRAIN_MATERIALS } from '../core/tokens';
import type { Plugin } from '../core/types';
import { SEA_LEVEL } from '../config';
import { AIR_ID } from '../world/BlockRegistry';
import type { IGenerator } from '../world/IGenerator';

export const TERRAIN_SEED = 20261107;

function hash2(ix: number, iz: number, seed: number): number {
  let n = Math.imul(ix + seed * 101, 374761393) + Math.imul(iz + seed * 31, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

/** 自带 value noise，不引第三方依赖；以后换 WASM 或二进制高度图只换 surfaceY */
function valueNoise(x: number, z: number, scale: number, seed: number): number {
  const fx = x / scale, fz = z / scale;
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const tx = fx - ix, tz = fz - iz;
  const sx = tx * tx * (3 - 2 * tx), sz = tz * tz * (3 - 2 * tz);
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  return (a + (b - a) * sx) * (1 - sz) + (c + (d - c) * sx) * sz;
}

interface TerrainSnapshot { seed: number; version: number; generator: string }

/**
 * 内置插件 #2：带起伏的小丘。
 * 只声明 `cap:terrainMaterials`，不绑定具体方块插件；
 * 生成器通过 services 提供，第三方 provide 更高优先级即可整体替换地形。
 */
export function hillsPlugin(): Plugin {
  return {
    id: 'voxel.terrain',
    version: '0.2.0',
    provides: ['generator'],
    dependencies: ['cap:terrainMaterials'],
    priority: -20,

    setup(ctx): void {
      const { scope, services } = ctx;
      const mats = services.get(TERRAIN_MATERIALS);
      const seed = scope.config<number>('seed', TERRAIN_SEED);

      const gen: IGenerator = {
        id: 'hills-v1',
        surfaceY(wx, wz) {
          const big = valueNoise(wx, wz, 30, seed);
          const small = valueNoise(wx, wz, 11, seed + 7);
          return Math.round(SEA_LEVEL + (big - 0.5) * 7 + (small - 0.5) * 2.2);
        },
        blockAt(_wx, y, _wz, surface) {
          if (y > surface) return AIR_ID;
          if (y === surface) return mats.grass;
          return mats.dirt;
        },
      };
      scope.service(GENERATOR, gen, { priority: -10 });

      scope.binary(0, {
        name: 'voxel.terrain/params',
        encode: (v: TerrainSnapshot): ArrayBuffer =>
          new BinaryWriter().u16(v.version).f64(v.seed).string(v.generator).finish(),
        decode: (buf: ArrayBuffer): TerrainSnapshot => {
          const r = BinaryReader.from(buf);
          return { version: r.u16(), seed: r.f64(), generator: r.string() };
        },
        snapshot: () => ({ seed, version: 1, generator: gen.id }),
      });

      ctx.log(`generator=${gen.id} seed=${seed} (via services)`);
    },
  };
}
