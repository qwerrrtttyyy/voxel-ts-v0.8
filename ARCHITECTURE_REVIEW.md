# 插件架构深入审批报告

**审批对象**：`minecraft-ts` 首版插件式方块世界（2026-11-07）
**审批范围**：插件扩展效率（第二轮）＋ 游戏逻辑正确性（第三轮）
**结论**：**首版方向通过，扩展能力不通过（有条件）**。第二轮按 12 项整改、第三轮按 10 项游戏逻辑缺陷整改，重验后结论为 **通过**（44/44 架构 + 25/25 游戏逻辑）。

---

## 一、审批方法

不靠读 README，按三条硬标准逐文件核对：

1. **加一个功能，要改几个文件？** 理想 = 1（只新增插件文件）
2. **换一个核心策略，要不要动已有插件源码？** 理想 = 不动
3. **卸载一个插件，系统能不能回到干净状态？** 理想 = 能，且不重启

再用 Node 侧全量装配跑 44 项断言（无 WebGL 依赖），覆盖拓扑排序、资源生命周期、策略热替换、热插拔、二进制链路、阶段化循环。

---

## 二、发现的问题与整改

### P0 — 阻塞扩展（4 项）

| # | 问题 | 影响 | 整改 |
| --- | --- | --- | --- |
| 1 | `PluginContext` 是封闭大接口，`main.ts` 手工 new 11 个对象 | 第三方想提供新服务，必须改 `types.ts` + `main.ts`，核心开始腐化 | 新增 `ServiceRegistry` + `ServiceToken<T>`；`createContext()` 统一装配，`main.ts` 缩到 46 行 |
| 2 | `new CulledMesher()` / `new GroundFollowCollision()` 写死在插件内部 | 换网格算法或碰撞要改 `WorldRenderPlugin` / `PlayerPlugin` 源码 | `MESHER / GENERATOR / COLLISION / SKY_HANDLE / CHUNK_VIEW / FIRST_PERSON` 全部走服务令牌；内置实现用 `priority: -100` 兜底，第三方 `priority: 10` 即顶替，并监听 `onChange` 自动重新生成 / 重建 / 切换 |
| 3 | 每个插件手写 3~5 个 `let offXxx` + `dispose()` 逐个清理 | 漏一个就是重复回调 / 内存泄漏；样板占插件代码一半 | 新增 `PluginScope`：事件、循环、服务、方块、贴图、二进制段、DOM 监听一行注册，`host` 卸载时逆序全清；`setup` 抛错也自动回滚 |
| 4 | `boot()` 一次性，无卸载能力 | 改插件必须刷页面，谈不上"扩展效率" | `mount / unmount / reload / enable / disable`；卸载连带卸载（传递）依赖者；`reload` 会按原顺序把依赖者一起装回来 |

### P1 — 易错 / 会撞车（5 项）

| # | 问题 | 整改 |
| --- | --- | --- |
| 5 | 事件名裸字符串 + 手写泛型，拼错不报错 | `EventMap` 类型化映射，`events.on<K>()` 编译期校验；支持 `declare module` 合并扩展；`onDynamic` 兜底 |
| 6 | 循环顺序靠"谁最后注册"隐式约定 | `Engine` 显式阶段：`input → simulate → late` / `before → main → after`，同阶段按 `priority` 排序；渲染提交改为 `phase: 'main', priority: 1000` |
| 7 | 方块 id 手动分配（示例硬编码 `10`），贴图 key 全局裸名 | `scope.block()` 自动分配 uint8 id（`AUTO_ID_START=64`）+ `owner:local` 命名空间；`scope.tile()` 同理；`release` 后 id 升序复用，reload 确定性 |
| 8 | 图集固定 64 格，后置插件注册贴图要重建材质 | 按需翻倍扩容 + `onTextureReplaced` 通知材质换 `map`；扩容后所有 UV 按新宽度重算 |
| 9 | 二进制 tag 冲突只能等存档读出来才发现 | `claimTag(owner, local)` 注册期检测；`BinaryHandler.owner` + `validate()` 启动自检 |

### P2 — 效率 / 表达力（3 项）

| # | 问题 | 整改 |
| --- | --- | --- |
| 10 | 依赖只有硬 id，没有能力声明 | `provides` + `cap:能力名` 依赖 + `optionalDependencies` 降级 + `priority` 层级排序 |
| 11 | 插件没有私有配置空间 | `ConfigStore.namespace(owner)`，带 `onChange` 与 localStorage 持久化（Node 自动降级内存） |
| 12 | `ChunkView.flush` 每帧遍历全部 chunk 找 dirty，O(n) | `World` 维护去重 dirty 队列，`takeDirty(k)` 为 O(k)；同时 `setBlock` 新增 `block:changed` 事件 |

### 验收中发现并额外修掉的 2 个真实缺陷

- **热加载重复重建**：一个插件同时换 mesher + generator 时，原本触发两遍全量重建（72 次 mesh build）。改为 microtask 批处理，合并成一次（36 次）。
- **reload 丢失依赖者**：`reload('voxel.blocks')` 连带卸载了 terrain / world-render / player / render-submit，却只装回自己。改为按原加载顺序恢复全部受影响插件。

---

## 三、整改前后：写一个插件的成本

**整改前**（首版）

```ts
export function stonePlugin(): Plugin {
  let offBinary: (() => void) | null = null;
  let offEvent: (() => void) | null = null;
  let offUpdate: (() => void) | null = null;
  return {
    id: 'mypack.stone', version: '1.0.0',
    dependencies: ['voxel.blocks', 'voxel.world-render'],
    setup(ctx) {
      ctx.atlas.registerTile('stone', paint);              // 全局 key，可能撞
      ctx.blocks.register({ id: 10, name: 'stone', ... }); // 手写 id，多插件必撞
      offBinary = ctx.binary.register({ tag: ..., ... });
      offEvent  = ctx.events.on('chunk:dirty', handler);   // 泛型手写
      offUpdate = ctx.engine.onUpdate(tick);               // 顺序靠运气
    },
    dispose() { offBinary?.(); offEvent?.(); offUpdate?.(); }, // 漏一个就泄漏
  };
}
```

换 mesher 要改 `WorldRenderPlugin`；换地形要改 `HillsPlugin`；加新服务要改 `types.ts` + `main.ts`；改插件要刷新页面。

**整改后**

```ts
// plugins/community/StonePlugin.ts —— 丢进目录，构建时自动发现，零配置项
import { MESHER } from '../../core/tokens';
import type { Plugin } from '../../core/types';

export default {
  id: 'mypack.stone', version: '1.0.0',
  provides: ['stone'],
  dependencies: ['cap:chunkView'],
  setup(ctx) {
    const tile = ctx.scope.tile('stone', paint);
    ctx.scope.block('stone', { opaque: true, solid: true, all: tile });
    ctx.scope.service(MESHER, new GreedyMesher(), { priority: 10 }); // 世界自动重建
  },
} satisfies Plugin;
```

无 `dispose`、无手写 id / tag / key、无 `main.ts` 改动、卸载自动释放、不重启即可热插拔。

---

## 四、加固后的分层

```
main.ts                 46 行：createContext → useMany(内置 + 自动发现) → boot → 自检 → start
core/
  createContext.ts      唯一装配点
  PluginHost.ts         拓扑 / 能力依赖 / 生命周期 / 热插拔 / 级联卸载 / 失败回滚
  PluginScope.ts        每插件独享的自动清理作用域
  ServiceRegistry.ts    ServiceToken<T> + 优先级覆盖 + onChange
  Engine.ts             固定步长 + 显式阶段 + priority
  EventBus/EventMap     类型化事件
  ConfigStore.ts        插件命名空间配置
  tokens.ts             6 个内置可替换令牌
plugins/
  ×7 内置插件           全部只通过 scope / services 工作，无一个写 dispose
  discover.ts           import.meta.glob 自动发现 community/*.ts
  community/            第三方插件落地点
binary/ · world/ · render/ · player/   业务层不变，只补了队列与命名空间
```

---

## 五、验收结果

`tsc --noEmit` 通过 · `vite build` 通过（41 modules / 511 KB）· **Node 逻辑验收 44/44 通过**。

关键证据：

- 启动顺序 `sky → blocks → terrain → world-render → player → render-submit → viewport`（含 `cap:` 解析）
- 7 个插件分别持有 `3/7/2/9/7/1/1` 个 scope 资源，卸载后循环回调、监听、方块、二进制段**全部回落**
- 第三方 `mount` 后：mesher / generator / collision 自动切换，世界只重建 **1 次**（36 chunk）；`unmount` 后三者自动回退到内置实现
- `reload('voxel.blocks')` 连带恢复 4 个依赖者，方块 id 与二进制段名不膨胀
- setup 中途抛错 → 不留半初始化资源
- 图集 `256px → 512px` 扩容，旧 tile UV 仍有效
- 二进制信封 433 KB，3 类段，`ChunkCodec` 往返一致，`validate()` 零问题

---

## 六、仍存在的限制（不掩饰）

1. **未做像素级渲染回归**：沙盒无可用 WebGL 上下文，画面正确性靠构建产物 + 逻辑验收保证，未在真机截图比对。本地 `npm run dev` 即可目视确认。
2. **策略覆盖是"最高优先级通吃"**：没有版本协商 / 兼容性检查，两个第三方都给 `priority: 10` 时后加载者胜出。
3. **插件无权限沙箱**：`ctx` 暴露了 renderer / world / host，加载不可信第三方代码需要再加 capability 白名单（当前自托管场景无需）。
4. **自动发现是构建期**：`import.meta.glob` 在构建时扫描；运行时从网络动态 import 插件尚未实现。
5. **单 chunk 全量重建**：`CulledMesher` 已做面剔除（1000 面 vs 全量 21528），但没有 greedy meshing，也没有按视距排序重建队列 —— M3 无限地形时再补。
6. **信封未压缩**：36 chunk 约 433 KB，M4 可加 RLE / 通用压缩段。
7. **碰撞仍是简化实现**：第三轮已改成「实际体素地面 + 1 格台阶限制 + 边缘阻挡」，但仍是列级贴地，不是玩家 AABB vs 体素盒的完整碰撞；AABB 实现留到 M2。

---

## 七、第三轮：游戏逻辑审查与修复

第二轮只验了架构，没验「游戏跑起来对不对」。本轮写了 `tools/verify-gameplay.ts`，
在 Node 里用真实世界数据驱动控制器 / 射线 / 网格，**修复前先跑出 10 个失败**作为证据，再逐项修。

### 修复的游戏逻辑缺陷

| # | 缺陷 | 后果 | 修复 |
| --- | --- | --- | --- |
| 1 | `groundAt` 读 `generator.surfaceY`，不是实际体素 | 挖掉脚下方块仍浮空、放方块仍入地；M2 一加挖放立刻暴露 | 新增 `World.highestSolidY / groundY`，从 chunk 顶向下扫 `solid` 方块；`surfaceY` 降级为生成器调试用 |
| 2 | `move` 无阻挡 + `feet.y <= ground` 无条件 clamp | 能瞬移到任意高的崖顶，跳跃被地形抬升吞掉 | `MAX_STEP_UP = 1.05`，以「脚下原地面」为基准做台阶限制，分轴回退可沿墙滑动；控制器只在下落时落地，先把脚抬出方块再起跳 |
| 3 | 跳跃上升途中仍被 clamp 回地面 | 上坡时跳跃失效 | 垂直逻辑重写：抬升 → 起跳 → 重力 → 仅 `velocityY <= 0 && nextY <= ground` 时落地 |
| 4 | `BlockRegistry.tileOf` 对 `opaque=false` 直接返回 null | 玻璃 / 水 / 树叶会整块不可见（面剔除仍会保留它们的邻居面） | 是否渲染由方块自己有没有 tile 决定；`opaque` 只用于邻接剔除 |
| 5 | `Raycast` 起点在方块内时法线 `(0,0,0)` | M2 无法判断方块该放在哪一面 | 初始法线 `(0,-1,0)`，新增 `fromInside` 标记（M2 据此禁止往玩家身体里放方块） |
| 6 | `setGenerator` 与 `pregenerate` 各发一次 `world:regenerated` | 订阅者收到一次 `chunkCount: 0` 的假事件，可能重建空世界 | `setGenerator` 只清状态，生成完由 `pregenerate` 广播一次 |
| 7 | `markDirty` 对不存在的邻居 chunk 也入队 + 发事件 | 重建队列里混入空 key，白跑一次 `rebuild` | 只在 chunk 存在时标记 |
| 8 | `yaw` 无界累加 | 连续转视角数小时后浮点精度下降 | 归一化到 `(-π, π]` |
| 9 | 走出有限世界后 `groundY` 返回 `VOID_GROUND_Y=0` | 玩家悬在虚空 y=0 | `GroundFollowCollision.move` 把 x/z 夹在世界边界内，浮空岛变成有隐形墙 |
| 10 | 验收脚本自身 2 处误判 | 侧面 UV 绕序假设只覆盖 east/west、台阶测试残留了上一用例的高墙 | 按面分组比较最低/最高 y 处的 v；台阶测试改用独立世界 + 连续平台 |

### 复核通过、确认没问题的部分

- **三角形绕序**：1856 个三角形逐一对 `(B-A)×(C-A)` 与法线求点积，0 个反向 —— `FrontSide` 下不会整片看不见
- **侧面 UV**：416 个侧面全部 `v` 随世界 `y` 递增，草边朝上；草顶 UV 落在 `grass_top` tile
- **WASD 方向**：`yaw=0` 时 W 朝 `-Z`、D 朝 `+X`，与 Three 的 `YXZ` 相机旋转一致
- **跳跃弧线**：起跳有正向速度，峰值 14.18，完整落回 13.00，全程无 NaN
- **射线**：向下命中草方块且法线 `+Y`，向上返回 `null`

### 第三轮验收

`tsc --noEmit` 0 · `vite build` 0 · 架构 **44/44** · 游戏逻辑 **25/25**。
`npm run verify` 一键复现，脚本在 `tools/verify-architecture.ts` 与 `tools/verify-gameplay.ts`。

沙盒无可用 WebGL 上下文，像素级画面仍未截图回归；几何侧已用绕序 / UV / 法线断言尽可能覆盖。

---

## 八、下一步建议（按优先级）

1. **M2**：挖 / 放（复用 `Raycast` 的命中面法线）+ `AABBCollision` 顶掉 `GroundFollowCollision` + 物品栏 —— 全部是新增插件 + provide 更高优先级实现
2. **M3**：无限 chunk 加载 / 卸载，重建队列按相机距离排序
3. **M4**：二进制存档落盘 / 加载、压缩段、昼夜天空
4. **M5**：WASM 生成器或 mesher、网络协议包

> 附件里 `README.md` 是更新后的使用文档，`ARCHITECTURE_REVIEW.md` 即本报告，`tools/` 是可复现的自检脚本。
