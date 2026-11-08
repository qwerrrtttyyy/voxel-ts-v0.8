import { SKY_HANDLE } from '../core/tokens';
import type { Plugin } from '../core/types';
import { createSky } from '../render/Sky';

/** 内置插件 #3：渐变天空 + 雾 + 灯光 */
export function skyPlugin(): Plugin {
  return {
    id: 'voxel.sky',
    version: '0.2.0',
    provides: ['sky'],
    priority: -40,

    setup(ctx): void {
      const { scope } = ctx;
      const sky = createSky(ctx.scene);
      scope.service(SKY_HANDLE, sky);
      scope.render(() => sky.follow(ctx.camera), { phase: 'before', priority: -100 });
      scope.track(() => sky.dispose());
    },
  };
}
