import { CHUNK_SIZE, WORLD_CHUNKS } from '../config';
import { GAME_STATE } from '../core/tokens';
import type { Plugin } from '../core/types';

/** 主菜单 / 暂停时让相机绕世界缓慢环绕，背景就是真实的 3D 世界而不是静态图 */
export function menuCameraPlugin(): Plugin {
  return {
    id: 'voxel.menu-camera',
    version: '0.3.0',
    meta: {
      label: '菜单环绕镜头', category: 'render', author: 'voxel-ts', badge: 'MC',
      description: '暂停 / 主菜单时自动环绕俯瞰世界，进入游戏后立即交还第一人称控制器',
    },
    provides: ['menuCamera'],
    priority: 60,

    setup(ctx): void {
      const { scope, services } = ctx;
      const game = services.get(GAME_STATE);
      const center = (WORLD_CHUNKS * CHUNK_SIZE) / 2;

      scope.render((_alpha, elapsed) => {
        if (!game.paused) return;
        const a = elapsed * 0.075 + 0.6;
        const r = 74;
        ctx.camera.position.set(center + Math.cos(a) * r, 46 + Math.sin(a * 0.6) * 6, center + Math.sin(a) * r);
        ctx.camera.lookAt(center, 11, center);
      }, { phase: 'before', priority: 500 });
    },
  };
}
