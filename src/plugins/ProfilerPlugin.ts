import { PROFILER, type ProfilerApi } from '../core/tokens';
import { definePlugin } from '../core/definePlugin';

/**
 * v0.6 插件机可观测性：把 Engine 的逐回调耗时画像包装成一个服务。
 *
 * 每个由 scope.update / scope.render 注册的回调都会自动带上「插件 id」标签，
 * 因此这里能直接回答「哪个插件在吃帧」。菜单的插件仓库会展示 Top 5，
 * 第三方插件也能通过 services.tryGet(PROFILER) 做自己的性能面板。
 *
 * 本身没有任何 update / render 回调，零热路径开销。
 */
export function profilerPlugin() {
  return definePlugin({
    id: 'voxel.profiler',
    version: '0.6.0',
    meta: {
      label: '性能画像', category: 'extension', author: 'voxel-ts', badge: 'PF',
      description: '按插件聚合主循环回调耗时、慢回调计数，插件仓库可直接查看 Top 5',
    },
    provides: ['profiler'],
    priority: 55,

    setup(ctx): void {
      const { scope } = ctx;
      const api: ProfilerApi = {
        top: (n = 5) => [...ctx.engine.callbackStats]
          .sort((a, b) => b.totalMs - a.totalMs)
          .slice(0, n),
        slowCount: () => ctx.engine.callbackStats.reduce((s, x) => s + x.slow, 0),
        reset: () => ctx.engine.resetStats(),
      };
      scope.service(PROFILER, api);
      ctx.log('profiler ready · 逐回调画像已开启（慢回调预算 16ms）');
    },
  });
}
