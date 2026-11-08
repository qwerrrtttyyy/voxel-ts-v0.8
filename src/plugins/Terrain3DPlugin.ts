import { BinaryReader, BinaryWriter } from '../binary/BinaryBuffer';
import {
  BLOCK_LIBRARY, EXTRA_BLOCKS, GENERATOR, TERRAIN_MATERIALS, TERRAIN3D,
} from '../core/tokens';
import { definePlugin } from '../core/definePlugin';
import { createTerrain3D, resolveIds } from '../world/terrain/Generator3D';
import type { Density3DOptions } from '../world/terrain/Density3D';

interface Params extends Pick<Density3DOptions, 'seed' | 'relief' | 'caves' | 'islands' | 'ores'> {}

function encode(v: Params): ArrayBuffer {
  return new BinaryWriter()
    .f64(v.seed).f32(v.relief).f32(v.caves).f32(v.islands).f32(v.ores)
    .finish();
}

function decode(buf: ArrayBuffer): Params {
  const r = BinaryReader.from(buf);
  return {
    seed: r.f64(), relief: r.f32(), caves: r.f32(), islands: r.f32(), ores: r.f32(),
  };
}

/**
 * v0.7 真 3D 地形插件。
 *
 * 通过 GENERATOR 服务以 priority=30 顶掉 Cordis 2D 流水线(20)；
 * 关掉本插件世界自动回到「2D 高度图 + 洞穴侵蚀」的旧地形，其它插件零改动。
 * 密度场参数写进私有二进制段，存档 / 导入导出都带着同一套世界配置。
 */
export function terrain3DPlugin() {
  return definePlugin({
    id: 'voxel.terrain-3d',
    version: '0.7.0',
    meta: {
      label: '真 3D 地形', category: 'world', author: 'voxel-ts', badge: '3D',
      description: '3D 密度场替代高度图：悬垂岩板、浮空岛、连续洞穴管道与立体矿脉；关闭后回退为 2D 流水线',
    },
    provides: ['generator', 'generator3d', 'terrain3d'],
    optionalDependencies: ['cap:blockLibrary', 'cap:terrainMaterials', 'cap:extraBlocks'],
    priority: -12,

    setup(ctx): void {
      const { scope, services } = ctx;
      const ids = resolveIds({
        lib: services.tryGet(BLOCK_LIBRARY),
        blocks: ctx.blocks,
        mats: services.tryGet(TERRAIN_MATERIALS),
        extra: services.tryGet(EXTRA_BLOCKS),
      });
      const params: Params = {
        seed: scope.config<number>('seed', 20261107),
        relief: scope.config<number>('relief', 1),
        caves: scope.config<number>('caves', 1),
        islands: scope.config<number>('islands', 1),
        ores: scope.config<number>('ores', 1),
      };
      const gen = createTerrain3D(params, ids);

      scope.service(GENERATOR, gen, { priority: 30 });
      scope.service(TERRAIN3D, gen);
      scope.binary(3, {
        name: 'voxel.terrain-3d/params',
        encode: (v: Params): ArrayBuffer => encode(v),
        decode: (buf: ArrayBuffer): Params => decode(buf),
        snapshot: () => ({ ...params }),
      });

      ctx.log(
        `generator=${gen.id} · 密度场 relief=${params.relief} caves=${params.caves} ` +
        `islands=${params.islands} ores=${params.ores} seed=${params.seed}`,
      );
    },
  });
}
