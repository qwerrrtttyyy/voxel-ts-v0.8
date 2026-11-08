/**
 * 运行时远程插件示例（纯 ESM，不 import 任何裸模块，浏览器可直接动态 import）。
 *
 * 在主菜单「插件仓库 → 从 URL 安装」里点安装即可热加载，无需重新构建、无需刷新页面。
 * 加载后它会：
 *   1. 注册一张命名空间贴图 + 一个发光方块（自动进入快捷栏）
 *   2. 注册一个 update 回调，每 12 秒播报一次，证明循环确实在跑
 * 卸载时 PluginScope 会自动回收全部资源。
 */
export default {
  id: 'remote.fireflies',
  version: '1.0.0',
  meta: {
    label: '远程示例 · 萤火虫',
    description: '从 URL 动态 import 的第三方插件：注册发光方块并定时播报',
    category: 'remote',
    author: 'community',
    badge: 'RF',
  },
  provides: ['cap:fireflies'],

  setup(ctx) {
    const tile = ctx.scope.tile('firefly', (set, s) => {
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          const spark = (x * 7 + y * 11) % 13 === 0 ? 70 : 0;
          set(x, y, 150 + spark, 230, 96 + spark, 255);
        }
      }
    });

    const id = ctx.scope.block('firefly', {
      opaque: false, solid: true, emissive: true, all: tile,
    });

    let t = 0;
    ctx.scope.update((dt) => {
      t += dt;
      if (t >= 12) {
        t = 0;
        ctx.scope.emit('game:toast', {
          text: '萤火虫插件仍在运行 · 方块 id ' + id,
          kind: 'info',
        });
      }
    }, { phase: 'simulate' });

    ctx.log('remote.fireflies installed from URL · block=' + id);
  },
};
