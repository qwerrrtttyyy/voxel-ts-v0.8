import { BLOCK_LIBRARY, CHUNK_VIEW, EXTRA_BLOCKS, GENERATOR, TERRAIN_KERNEL, TERRAIN_MATERIALS, UNIFIED_KERNEL } from '../core/tokens';
import type { Plugin } from '../core/types';
import { assembleCordisWorld } from '../world/terrain/assemble';

const DEFAULT_SEED = 20261107;

/**
 * v0.4 桥接插件：把 Cordis 可逆内核接到现有插件宿主上。
 *
 * 内核里跑 19 个组件（1 基础设施 + 10 方块包 + 8 地形阶段），装配逻辑在
 * `world/terrain/assemble.ts`，与 Node 验收脚本共用同一份。
 * 这里只做四件事：暴露服务、把组件开关接到世界重建、把卸载接到内核 dispose。
 * v0.2 的 7 个内置插件与 116 项验收一个对象都不用改。
 */
export function cordisWorldPlugin(): Plugin {
  return {
    id: 'voxel.cordis-world',
    version: '0.4.0',
    meta: {
      label: 'Cordis 世界内核', category: 'world', author: 'voxel-ts', badge: 'CD',
      description: '可逆副作用内核：10 个方块包 + 8 阶段地形流水线，声明式依赖自动编排，热插拔精确回滚',
    },
    provides: ['generator', 'blockLibrary', 'terrainKernel'],
    dependencies: ['cap:terrainMaterials', 'cap:extraBlocks'],
    priority: -100, // 尽早装配：图集扩容必须发生在 chunk geometry 生成之前

    setup(ctx): void {
      const { scope, services, atlas, blocks, world } = ctx;
      // v0.5：注入统一内核，让 10 方块包 + 8 地形阶段与全部插件组件同处一个 Kernel。
      const sharedKernel = services.tryGet(UNIFIED_KERNEL);
      const { kernel, pipeline, library, refresh, dispose } = assembleCordisWorld({
        atlas, blocks,
        seed: scope.config<number>('seed', DEFAULT_SEED),
        mats: services.tryGet(TERRAIN_MATERIALS),
        extra: services.tryGet(EXTRA_BLOCKS),
        kernel: sharedKernel,
      });

      scope.service(BLOCK_LIBRARY, library, { priority: 0 });
      scope.service(TERRAIN_KERNEL, kernel, { priority: 0 });
      // priority 20 顶掉 rich-v1(10) 与 hills-v1(0)，世界自动重新生成
      scope.service(GENERATOR, pipeline, { priority: 20 });

      // 组件热插拔 → 刷新方块库并重建世界（合并到一个 microtask）
      let scheduled = false;
      const rebuild = (): void => {
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(() => {
          scheduled = false;
          refresh();
          // v0.7：取当前生效实现而不是硬编码 pipeline。若 terrain-3d 已顶替
          // GENERATOR，方块包开关不应把世界悄悄退回 2D 流水线。
          world.setGenerator(services.get(GENERATOR));
          world.pregenerate();
          services.tryGet(CHUNK_VIEW)?.rebuildAll();
        });
      };
      scope.track(kernel.onChange(rebuild));

      // 插件卸载 = 局部注销世界组件（共享内核时保留插件组件；独占时全量 dispose）
      scope.track(dispose);

      ctx.log(
        `cordis kernel: ${kernel.enabledIds.length} components · ` +
        `${library.total} block types · ${pipeline.stageCount} terrain stages`,
      );
    },
  };
}
