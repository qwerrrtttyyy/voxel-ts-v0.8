import { CHUNK_VIEW, COLLISION, FIRST_PERSON } from '../core/tokens';
import type { Plugin } from '../core/types';
import { CHUNK_SIZE, WORLD_CHUNKS } from '../config';
import { FirstPersonController } from '../player/FirstPersonController';
import { GroundFollowCollision } from '../player/ICollision';

/**
 * 内置插件 #5：自写第一人称控制器 + 碰撞策略兜底。
 *
 * v0.6：删掉这里的 HUD / 准星射线 —— 它长期被 voxel.hud（priority 200）
 * 覆盖，等于每帧白跑一次 DDA + DOM 写入。射线统一由 voxel.interaction 的
 * RETICLE 服务提供；本插件只负责控制器与渲染阶段的视角插值。
 */
export function playerPlugin(): Plugin {
  return {
    id: 'voxel.player',
    version: '0.6.0',
    provides: ['collision', 'firstPerson'],
    dependencies: ['cap:chunkView'],
    priority: 10,

    setup(ctx): void {
      const { scope, services } = ctx;
      scope.service(COLLISION, new GroundFollowCollision(), { priority: -100 });

      const controller = new FirstPersonController(
        ctx.camera, ctx.input, ctx.world, services.get(COLLISION),
      );
      services.get(CHUNK_VIEW); // 保留硬依赖语义：没有 chunkView 时不装配
      scope.service(FIRST_PERSON, controller);
      const half = (WORLD_CHUNKS * CHUNK_SIZE) / 2;
      controller.spawn(half + 0.5, half + 0.5);
      scope.onService(COLLISION, (c) => { if (c) controller.setCollision(c); });

      scope.update((dt) => controller.update(dt), { phase: 'simulate' });
      // 在 before 阶段把相机旋转插值到「上一逻辑帧 → 当前逻辑帧」之间，
      // 渲染提交在 main/1000，顺序天然正确。
      scope.render((alpha) => controller.render(alpha), { phase: 'before', priority: 50 });

      scope.track(ctx.ui.onStart(() => ctx.input.requestLock()));
      scope.dom(document, 'pointerlockchange', () => ctx.ui.setLocked(ctx.input.state.locked));

      ctx.log(`collision=${controller.collisionId} · view interpolation on`);
    },
  };
}
