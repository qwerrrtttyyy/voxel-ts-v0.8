import type { Plugin } from '../core/types';

/**
 * 内置插件 #6：渲染提交。
 * 以前靠 main.ts 「最后注册 onRender」的隐式约定，现在用显式阶段 + 优先级。
 * 任何插件都能声明 before / after，不用再猜顺序。
 */
export function renderSubmitPlugin(): Plugin {
  return {
    id: 'voxel.render-submit',
    version: '0.2.0',
    provides: ['renderer'],
    dependencies: ['cap:chunkView'],
    priority: 100,

    setup(ctx): void {
      ctx.scope.render(
        () => ctx.renderer.render(ctx.scene, ctx.camera),
        { phase: 'main', priority: 1000 },
      );
    },
  };
}
