import { DAY_CYCLE, GAME_STATE } from '../core/tokens';
import { definePlugin } from '../core/definePlugin';
import { createClouds } from '../render/Clouds';

/** 可开关的云层插件：完全独立，关掉它不影响天空 / 地形 / 昼夜 */
export function cloudsPlugin() {
  return definePlugin({
    id: 'voxel.clouds',
    version: '0.3.0',
    meta: {
      label: '漂移云层', category: 'render', author: 'voxel-ts', badge: 'CL',
      description: '程序化无缝噪声云图，缓慢漂移，夜间自动压暗；可在设置里关闭',
    },
    provides: ['clouds'],
    priority: 25,

    setup(ctx): void {
      const { scope, services } = ctx;
      const cycle = services.get(DAY_CYCLE);
      const game = services.tryGet(GAME_STATE);
      const clouds = createClouds(ctx.scene);
      scope.track(() => clouds.dispose());

      const sync = (): void => clouds.setVisible(game?.settings.clouds ?? true);
      sync();
      if (game) scope.track(game.onChange(sync));

      let prev = -1;
      scope.render((_alpha, elapsed) => {
        const dt = prev < 0 ? 0 : Math.min(0.1, elapsed - prev);
        prev = elapsed;
        clouds.follow(ctx.camera);
        clouds.update(dt, cycle.palette().ambient);
      }, { phase: 'before', priority: -45, every: 2 });
    },
  });
}
