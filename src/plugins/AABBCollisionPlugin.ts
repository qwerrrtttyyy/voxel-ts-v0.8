import { COLLISION } from '../core/tokens';
import type { Plugin } from '../core/types';
import { AABBCollision } from '../player/AABBCollision';

/**
 * M2：用 priority=10 顶掉内置 GroundFollowCollision。
 * 控制器、玩家插件、验收脚本都不用改 —— 这就是服务令牌策略替换的意义。
 */
export function aabbCollisionPlugin(): Plugin {
  return {
    id: 'voxel.physics-aabb',
    version: '0.3.0',
    meta: {
      label: 'AABB 实体碰撞', category: 'gameplay', author: 'voxel-ts', badge: 'PH',
      description: '玩家 0.6×1.8 盒 vs 体素：头顶碰撞、洞穴与悬空平台真实存在、可沿墙滑动',
    },
    provides: ['physics'],
    dependencies: ['cap:firstPerson'],
    priority: 20,

    setup(ctx): void {
      ctx.scope.service(COLLISION, new AABBCollision(), { priority: 10 });
      ctx.log('collision strategy replaced by aabb-v2 (priority 10)');
    },
  };
}
