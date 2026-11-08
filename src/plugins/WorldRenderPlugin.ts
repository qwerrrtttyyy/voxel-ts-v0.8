import * as THREE from 'three';
import { CHUNK_TAG, decodeChunk, encodeChunk, type ChunkBinary } from '../binary/ChunkCodec';
import { CHUNK_VIEW, GAME_STATE, GENERATOR, MESHER } from '../core/tokens';
import type { Plugin } from '../core/types';
import { ChunkView } from '../render/ChunkView';
import { CulledMesher } from '../world/mesher/CulledMesher';
import type { IGenerator } from '../world/IGenerator';

/**
 * 内置插件 #4：世界网格化 + chunk mesh 生命周期 + chunk 二进制段。
 *
 * 扩展加固的核心：mesher / generator 都从 services 取，
 * 并监听 onChange。第三方只要 provide 一个更高优先级实现，
 * 世界会自动重新生成 / 重新网格化，不需要改这个插件一个字。
 */
export function worldRenderPlugin(): Plugin {
  return {
    id: 'voxel.world-render',
    version: '0.2.0',
    provides: ['mesher', 'chunkView'],
    dependencies: ['cap:blocks', 'cap:generator'],
    priority: 0,

    setup(ctx): void {
      const { scope, services, atlas, blocks, world, scene } = ctx;

      // chunk 段只注册解码能力，不写 snapshot（chunk 由 world.toEnvelope 单独产出）
      scope.track(ctx.binary.register<ChunkBinary>({
        tag: CHUNK_TAG,
        name: 'voxel/chunk-v1',
        owner: ctx.pluginId,
        encode: (v: ChunkBinary): ArrayBuffer =>
          encodeChunk({ cx: v.cx, cz: v.cz, size: v.size, height: v.height, data: v.voxels }),
        decode: (buf: ArrayBuffer): ChunkBinary => decodeChunk(buf),
      }));

      const texture = atlas.build();
      const material = new THREE.MeshBasicMaterial({
        map: texture, vertexColors: true, fog: true, side: THREE.FrontSide,
        // 玻璃 / 树叶 tile 的透明像素直接 discard，比开 transparent 少一套排序问题
        alphaTest: 0.42,
      });
      // GAME_STATE 是可选外壳服务：Node 自检里不存在时 AO 默认开启
      const game = services.tryGet(GAME_STATE);
      // 图集扩容时材质自动换 map，插件后置注册贴图无感
      scope.track(atlas.onTextureReplaced((t) => {
        material.map = t;
        material.needsUpdate = true;
      }));

      // 兜底实现：低优先级，任何第三方实现都能顶掉
      scope.service(MESHER, new CulledMesher(), { priority: -100 });

      const view = new ChunkView(
        scene, world, services.get(MESHER),
        { blocks, atlas, ao: () => game?.settings.ao ?? true }, material,
      );
      scope.service(CHUNK_VIEW, view);
      scope.track(() => view.dispose());

      // 启动首次同步生成，之后所有策略变更合并到一个 microtask 里只重建一次
      const syncGenerate = (gen: IGenerator): void => {
        world.setGenerator(gen);
        world.pregenerate();
        view.rebuildAll();
        ctx.log(`generator applied: ${gen.id} → ${world.keys().length} chunks`);
      };
      syncGenerate(services.get(GENERATOR));

      let scheduled = false;
      let nextGenerator: IGenerator | undefined;
      const scheduleRebuild = (gen?: IGenerator): void => {
        if (gen) nextGenerator = gen;
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(() => {
          scheduled = false;
          if (nextGenerator) {
            world.setGenerator(nextGenerator);
            world.pregenerate();
            ctx.log(`generator applied: ${nextGenerator.id}`);
            nextGenerator = undefined;
          }
          view.rebuildAll();
        });
      };

      scope.onService(GENERATOR, (gen) => { if (gen) scheduleRebuild(gen); });
      scope.onService(MESHER, (m) => {
        if (!m) return;
        view.setMesher(m, false);
        scheduleRebuild();
      });

      // v0.6：dirty 由 World 队列驱动，改为「每帧最多 4ms」的自适应预算。
      // 复杂地形 / 慢设备不再被固定 12 个/帧拖掉帧，快设备仍可一帧刷完。
      scope.update(() => view.flushBudgeted(4), { phase: 'late' });
      // v0.6：滑动窗口卸载 chunk 后，World.getChunk 已返回 undefined，
      // rebuild() 会顺手移除并 dispose 对应的 mesh，不留幽灵几何体。
      scope.on('chunk:streamed', (e) => { if (e.action === 'unloaded') view.rebuild(e.key); });
      scope.on('world:regenerated', (e) => ctx.log(`world:regenerated ${e.generatorId} / ${e.chunkCount}`));
      // 存档装载后整份世界重建一次，保证画面与体素一致
      scope.on('world:loaded', (e) => {
        view.rebuildAll();
        ctx.log(`world loaded: ${e.chunkCount} chunks / ${e.segmentCount} segments (${e.unknownSegments} unknown)`);
      });

      ctx.log(`mesher=${view.mesherId} chunks=${world.keys().length} meshes=${view.meshCount}`);
    },
  };
}
