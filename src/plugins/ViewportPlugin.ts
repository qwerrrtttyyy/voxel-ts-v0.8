import type { Plugin } from '../core/types';

/**
 * 内置插件 #7：视口自适应（也演示 scope.dom 自动解绑）。
 *
 * v0.6：resize 时同步刷新 devicePixelRatio，跨不同 DPR 屏幕拖动 / 睡眠唤醒
 * 不再糊成一半分辨率；同时监听 webglcontextrestored，重设渲染器尺寸后
 * 由 main.ts 负责重启主循环。
 */
export function viewportPlugin(): Plugin {
  return {
    id: 'voxel.viewport',
    version: '0.6.0',
    priority: 100,

    setup(ctx): void {
      const sync = (): void => {
        const w = Math.max(1, window.innerWidth);
        const h = Math.max(1, window.innerHeight);
        ctx.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        ctx.renderer.setSize(w, h);
        ctx.camera.aspect = w / h;
        ctx.camera.updateProjectionMatrix();
      };
      ctx.scope.dom(window, 'resize', sync);
      // 上下文恢复后 Three 会重建内部状态，尺寸与 dpr 需要重新下发。
      // Node 验收里的 renderer 是 stub，没有 domElement，跳过即可。
      const canvas = ctx.renderer.domElement as EventTarget | undefined;
      if (canvas && typeof canvas.addEventListener === 'function') {
        ctx.scope.dom(canvas, 'webglcontextrestored', sync);
      }
    },
  };
}
