import { WORLD_CHUNKS, toChunkCoord } from '../config';
import { FIRST_PERSON, GAME_STATE } from '../core/tokens';
import { definePlugin } from '../core/definePlugin';

/**
 * v0.6 分区系统 + 无限生成驱动插件。
 *
 * World 本体已经具备滑动窗口与 region 归档能力；这个插件只负责把它接到主循环：
 *  - 启动时以出生点所在 chunk 为中心开启窗口
 *  - 每 2 个逻辑帧读一次玩家坐标，中心变化时 World.updateStreaming() 自动增删 chunk
 *  - 视距设置变化时即时调整窗口半径并补齐
 *
 * 关掉这个插件即回到 v0.5 的有限 6×6 浮空岛，其余插件零改动。
 */
export function regionsPlugin() {
  return definePlugin({
    id: 'voxel.regions',
    version: '0.6.0',
    meta: {
      label: '分区与无限生成', category: 'world', author: 'voxel-ts', badge: 'RG',
      description: '按玩家位置滑动加载窗口，负坐标无限生成；改动按 16×16 chunk 分区归档，离开再回来不丢建造',
    },
    provides: ['regions', 'streaming'],
    priority: -15,

    setup(ctx): void {
      const { scope, services } = ctx;
      const game = services.tryGet(GAME_STATE);
      const radiusOf = (): number => 2 + Math.round((game?.settings.viewDistance ?? 1) * 2);

      const spawnChunk = Math.floor(WORLD_CHUNKS / 2);
      ctx.world.enableStreaming({
        radius: radiusOf(),
        centerCx: spawnChunk,
        centerCz: spawnChunk,
      });
      scope.track(() => ctx.world.disableStreaming());
      if (game) scope.track(game.onChange(() => ctx.world.setStreamRadius(radiusOf())));

      scope.update(() => {
        const ctrl = services.tryGet(FIRST_PERSON);
        if (!ctrl) return;
        // v0.7：3D 密度场生成较重，每次最多铺 4 个 chunk，按距玩家由近到远；
        // 中心不变但窗口未铺满时 World 会继续补齐，不额外占用回调。
        ctx.world.updateStreaming(
          toChunkCoord(ctrl.feet.x),
          toChunkCoord(ctrl.feet.z),
          false, 4,
        );
      }, { phase: 'late', priority: -10, every: 2 });

      const info = ctx.world.streamInfo;
      ctx.log(`regions ready · center=(${info.centerCx},${info.centerCz}) ` +
        `radius=${info.radius} window=${info.windowChunks} chunks`);
    },
  });
}
