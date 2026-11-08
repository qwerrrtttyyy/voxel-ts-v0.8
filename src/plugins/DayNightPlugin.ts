import * as THREE from 'three';
import { FAR, FOG_FAR, FOG_NEAR } from '../config';
import { CHUNK_VIEW, DAY_CYCLE, GAME_STATE, SKY_HANDLE } from '../core/tokens';
import type { Plugin } from '../core/types';

/** M4 昼夜循环：纯数据 DayCycle 驱动天空 / 雾 / 地形亮度，三者始终同步 */
export function dayNightPlugin(): Plugin {
  return {
    id: 'voxel.day-night',
    version: '0.3.0',
    meta: {
      label: '昼夜循环', category: 'render', author: 'voxel-ts', badge: 'DN',
      description: '6 分钟一天：日出日落暖辉、月亮、闪烁星空、雾色与地形亮度联动；可加速 / 冻结',
    },
    provides: ['dayNight'],
    dependencies: ['cap:sky', 'cap:chunkView'],
    priority: 30,

    setup(ctx): void {
      const { scope, services } = ctx;
      const cycle = services.get(DAY_CYCLE);
      const sky = services.get(SKY_HANDLE);
      const view = services.get(CHUNK_VIEW);
      const game = services.tryGet(GAME_STATE);

      const applySettings = (): void => {
        cycle.enabled = game?.settings.dayCycle ?? true;
        const vd = game?.settings.viewDistance ?? 1;
        if (ctx.scene.fog instanceof THREE.Fog) {
          ctx.scene.fog.near = FOG_NEAR * vd;
          ctx.scene.fog.far = FOG_FAR * vd;
        }
        ctx.camera.far = FAR * vd;
        ctx.camera.updateProjectionMatrix();
      };
      applySettings();
      if (game) scope.track(game.onChange(applySettings));

      scope.update(
        (dt) => cycle.update(dt, game?.settings.timeScale ?? 1),
        { phase: 'simulate', priority: -50, every: 2 },
      );

      let lastEvent = -1;
      // v0.6：天空配色 30Hz 足够（palette 本身平滑插值），由 Engine 的 every 降频
      scope.render((_alpha, elapsed) => {
        const p = cycle.palette();
        sky.apply(p);
        sky.setTime(elapsed);
        view.setLight(p.ambient);
        // v0.6：ACES 曝光随日照联动，正午通透、夜晚压暗但保留细节；
        // 与 material.color 的亮度调制叠加，比单改地形材质更自然。
        ctx.renderer.toneMappingExposure = 0.82 + p.ambient * 0.42;
        if (ctx.scene.fog instanceof THREE.Fog) ctx.scene.fog.color.setHex(p.fog);
        if (elapsed - lastEvent >= 0.5) {
          lastEvent = elapsed;
          scope.emit('time:changed', { phase: cycle.phase, clock: cycle.clock(), daylight: p.ambient });
        }
      }, { phase: 'before', priority: -60, every: 2 });

      ctx.log('day-night cycle attached');
    },
  };
}
