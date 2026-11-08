# community 插件目录

把一个 `.ts` 文件放这里，构建时会被 `plugins/discover.ts` 自动收集并挂载，**不需要改 `main.ts`、不需要改 `plugins/index.ts`**。

```ts
// plugins/community/MyPlugin.ts
import { MESHER } from '../../core/tokens';
import type { Plugin } from '../../core/types';

export default {
  id: 'mypack.foo',
  version: '1.0.0',
  provides: ['foo'],
  dependencies: ['cap:chunkView'],
  setup(ctx) {
    ctx.scope.render(() => { /* 每帧 */ }, { phase: 'after' });
    ctx.scope.service(MESHER, myMesher, { priority: 10 }); // 顶掉内置 mesher
  },
} satisfies Plugin;
```

规则：

- 用 `ctx.scope.*` 注册一切（事件、循环、服务、方块、贴图、二进制段、DOM 监听），卸载时自动清理，不用写 `dispose`
- 资源 key 自动带插件 id 命名空间，方块 id 自动分配，不会和其他插件撞
- 硬依赖写 `dependencies`，可降级依赖写 `optionalDependencies`；`cap:xxx` 表示依赖某能力而非具体插件
- 想替换内置策略，只要 `scope.service(TOKEN, impl, { priority: 大于兜底 })`，世界会自动响应

也可以完全不建文件，运行时热加载：

```js
__VOXEL__.host.mount(myPlugin)     // 加载
__VOXEL__.host.reload('mypack.foo') // 重载
__VOXEL__.host.unmount('mypack.foo')// 卸载（连带卸载依赖它的插件）
```
