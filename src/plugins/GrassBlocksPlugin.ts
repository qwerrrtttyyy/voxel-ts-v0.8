import { BinaryReader, BinaryWriter } from '../binary/BinaryBuffer';
import { TERRAIN_MATERIALS } from '../core/tokens';
import type { Plugin } from '../core/types';

/** 确定性整数 hash，贴图不依赖 Math.random，重建结果一致 */
function hash(x: number, y: number, seed: number): number {
  let n = Math.imul(x + seed * 101, 374761393) + Math.imul(y + seed * 31, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

/**
 * 内置插件 #1：草方块 + 程序化贴图 + 自己的二进制段。
 * 全部走 scope：id / tile / tag 自动命名空间化，卸载自动释放，热重载幂等。
 */
export function grassBlocksPlugin(): Plugin {
  return {
    id: 'voxel.blocks',
    version: '0.2.0',
    provides: ['blocks', 'terrainMaterials'],
    priority: -30,

    setup(ctx): void {
      const { scope } = ctx;

      const grassTop = scope.tile('grass_top', (set, s) => {
        for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
          const v = (hash(x, y, 1) - 0.5) * 34;
          set(x, y, 106 + v, 170 + v * 0.8, 64 + v * 0.5);
        }
      });

      const grassSide = scope.tile('grass_side', (set, s) => {
        for (let x = 0; x < s; x++) {
          const edge = 12 - (hash(x, 0, 7) > 0.72 ? 2 : 0) - (hash(x, 0, 19) > 0.88 ? 1 : 0);
          for (let y = 0; y < s; y++) {
            const n = (hash(x, y, 3) - 0.5) * 26;
            if (y >= edge) set(x, y, 100 + n, 162 + n * 0.8, 58 + n * 0.5);
            else set(x, y, 134 + n, 96 + n * 0.7, 62 + n * 0.5);
          }
        }
      });

      const dirtTile = scope.tile('dirt', (set, s) => {
        for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
          const n = (hash(x, y, 5) - 0.5) * 30;
          set(x, y, 134 + n, 96 + n * 0.75, 62 + n * 0.5);
        }
      });

      const grass = scope.block('grass', {
        opaque: true, solid: true,
        faces: {
          top: grassTop, bottom: dirtTile,
          north: grassSide, south: grassSide, east: grassSide, west: grassSide,
        },
      });
      const dirt = scope.block('dirt', { opaque: true, solid: true, all: dirtTile });

      // 地形插件不硬编码方块名，通过这个服务拿 id
      scope.service(TERRAIN_MATERIALS, { grass, dirt }, { priority: -10 });

      scope.binary(0, {
        name: 'voxel.blocks/table',
        encode: (list: string[]): ArrayBuffer => {
          const w = new BinaryWriter().u16(list.length);
          for (const s of list) w.string(s);
          return w.finish();
        },
        decode: (buf: ArrayBuffer): string[] => {
          const r = BinaryReader.from(buf);
          const n = r.u16();
          const out: string[] = [];
          for (let i = 0; i < n; i++) out.push(r.string());
          return out;
        },
        snapshot: () => ctx.blocks.all().map((b) => `${b.id}:${b.name}`),
      });

      ctx.log(`defined ${ctx.blocks.all().length} blocks / ${ctx.atlas.tileCount} tiles (auto ids ${grass}, ${dirt})`);
    },
  };
}
