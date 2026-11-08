# Voxel TS · 插件式 3D 方块世界

> 🔗 **在线预览**：https://qwerrrtttyyy.github.io/voxel-ts-v0.8/ （GitHub Pages，`main` 推送后自动重建）

TypeScript + Vite + Three.js（WebGL），零 UI 框架、零依赖注入框架。
**v0.8** 把「深度审批」做成一等插件：20 条类型化规则覆盖插件契约、服务装配、二进制段、沙箱、性能与协议版本，游戏内新增审批页面，每次从当前运行时重新采样；第三方插件用 `scope.audit(rule)` 追加规则，卸载自动撤销。同时用 TS 的名义类型、`const` 泛型、`satisfies`、模板字面量、判别联合与映射类型，把插件重名 / 权限写错 / 事件名乱起等错误前移到 `tsc --noEmit`。
**v0.7** 用**真 3D 密度场**替换掉「2D 高度图按列填满」的旧地形：`d(x,y,z)>0` 决定固体，于是悬垂岩板、浮空岛、天然拱门、连续洞穴管道、立体矿脉在数学上成为可能（旧模型永远做不出 `solid→air→solid` 的列）。仍是同一个 `IGenerator` 接口，关掉插件即回退到 v0.6 的 2D 流水线。
**v0.6** 加入运行时插件沙箱、存档版本迁移、逐插件性能画像，以及**分区系统与无限生成**：世界不再固定在 6×6 浮空岛，按玩家位置滑动加载 chunk，负坐标可无限延伸，玩家改动按 16×16 chunk 的 region 归档，离开再回来不丢建造。
**v0.5** 完成「全量 Cordis 化」：v0.2 的 7 个内置插件、v0.3 的 12 个扩展插件与 v0.4 的 19 个世界组件，全部编译进**同一个可逆内核**（38 个组件共用一套 `inject`/`provide` 编排）。四条形式化定理从「只覆盖世界组件」扩展到覆盖整个插件生态；`npm run verify` 增至 **173/173**。
**v0.4** 引入 Cordis 风格可逆内核，把插件系统的四条形式化定理落成可执行约束；方块库扩到 **100 种**、地形拆成 **8 阶段 / 11 生物群系**流水线，全部组件可热插拔并精确回滚。
**v0.3** 把「一切皆插件」推到运行时：主菜单、昼夜、挖/放、AABB 碰撞、物品栏、存档、云、粒子、AO 全部是可开关的插件；第三方插件可从 **URL 动态 import** 或**粘贴源码 Blob 热加载**，无需重建、无需刷新。底层架构与审查记录见 [`ARCHITECTURE_REVIEW.md`](./ARCHITECTURE_REVIEW.md)。

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc --noEmit + vite build
npm run verify   # 44+25+16+32+19+19+19+33+16+24+14 = 261 项 Node 自检（不需要 WebGL）
npm run preview  # 预览生产构建
```

> Vite 锁在 5.4.20：避开部分国内镜像源缺 `nanoid@^3.3.20` 导致的安装失败，功能无差异。

---

## 最新：v0.8 深度审批与 TypeScript 契约

主菜单 / 暂停菜单 →「深度审批」，点「重新审批」即可对**当前运行时**重新采样，按 错误 / 警告 / 提示 分级列出规则 id、说明与修复建议。关掉 `voxel.audit` 插件页面会显示「未启用」，其余功能零改动。

| 维度 | 做法 | 关键文件 |
| --- | --- | --- |
| 规则是插件 | `AuditRegistry` + 20 条内置规则，全部经 `scope.track` 纳入可逆效应栈；`AUDIT` / `AUDIT_API` 作为服务可整个替换 | `core/audit.ts` · `plugins/AuditPlugin.ts` |
| 规则可扩展 | 第三方 `ctx.scope.audit(rule)` 注册自定义规则，插件卸载时自动注销；单条规则抛错被隔离成一条 error 发现，不吞掉整份报告 | `core/PluginScope.ts` |
| 同一份实现 | 浏览器菜单与 `npm run verify` 共用 `core/audit.ts` 的纯数据规则；规则不认识 DOM / three / PluginHost | `tools/verify-audit.ts` |
| 映射类型 | `AuditReport.counts` / `byCategory` 由 `AuditSeverity` / `AuditCategory` 联合自动生成，新增级别自动跟上；发现项是判别联合，`error` 强制带 `remedy` | `core/audit.ts` |

20 条内置规则：插件 id 命名空间 / 唯一性 / `cap:` 可解析 / 硬依赖存在 / 依赖无环 / meta 完整；关键服务齐备 / 令牌命名空间 / owner；系统 tag 未被占用 / handler 自检 / 存档迁移链 / 协议版本；远程插件能力合法 / 已沙箱化；慢回调 / 主循环异常 / 生成器已装配 / dirty 未积压；strict 模式。

**TS 特性用在了刀刃上**（不是装饰性类型）：

- `core/brands.ts`：`unique symbol` 品牌让 `PluginId` / `SegmentTag` / `AuditRuleId` 成为名义类型，`PluginEventKey` 用模板字面量 `${string}:${string}` 约束动态事件名。
- `core/definePlugin.ts`：TS 5 `const` 类型参数保留字面量 id 与能力元组，`satisfies readonly Plugin[]` + 递归条件类型 `UniquePluginList` 让**清单里重复 id 编译失败**；未迁移的旧插件 id 推断为宽 `string` 会自动跳过，支持增量迁移。
- `ServiceToken<T, Id>`：`__type: (v: T) => T` 让 T **不变**（旧的 `__type?: T` 是协变的，`ServiceToken<Dog>` 能冒充 `ServiceToken<Animal>`），`private __nominal` 阻止对象字面量伪造令牌绕过注册表。
- `Sandbox.readonlyView`：`Pick<T, K[number]>` 取代 `Partial<T>`，投影出的每个键必需且保留原方法泛型。
- `Engine.invoke<T>`：泛型任务取代 `Task<unknown>` + 双重 `as` 断言。

```js
__VOXEL__.audit.run()          // 重新采样并拿到完整报告
__VOXEL__.audit.rules()        // 当前生效的 20+ 条规则
__VOXEL__.auditRegistry.size   // 规则数（第三方追加后同步变化）
```

> 说明：审批是**运行时一致性检查**，不是浏览器级安全隔离；远程插件仍同 realm。它回答的是「这份插件生态现在装配得对不对」，与沙箱的能力边界互补。

---

## 上一版：v0.7 真 3D 地形生成

`voxel.terrain-3d` 插件默认开启，在插件仓库里关掉它即回到 v0.6 的 2D 流水线，其它插件零改动。

旧模型每列只有一个 `surfaceY(x,z)`，生成时 `y<=surface` 一律实心、`y>surface` 一律空气，再挖几个洞。所以无论怎么加噪声，一列里**永远不可能**出现「实心 → 空气 → 实心」。

v0.7 改成三维标量场 `d(x,y,z)`：

| 层 | 作用 | 关键实现 |
| --- | --- | --- |
| 2D 骨架 | `(surface(x,z) - y)` 给可站立的大陆轮廓，并保证 `y<=surface` 有一层连续地板 | `Density3D.surface()` |
| 3D 起伏 | `fbm3(x,y,z)` 在近地表带扰动，山腰凸出、崖壁内凹；再叠一层垂直压缩的「岩板」噪声，长出水平伸出的 shelf 与天然拱门 | `Density3D.density()` |
| 浮岛场 | 按 14 格世界网格布椭球岛心，SDF 直接并入密度；岛下方天然是空气 → 真正悬垂 | `islandsNear()` |
| 洞穴场 | 两路 ridged 3D 噪声相交成连续管道，再叠低频团块腔室；保住基岩与地表层 | `caveAt()` |
| 矿脉场 | 3D 值噪声阈值 + 深度分级，相邻体素连成矿团而非逐格 hash | `oreTier()` |

`Terrain3DGenerator` 把它包装成原来的 `IGenerator`（`surfaceY` + `blockAt`），按列缓存整列 48 个 id。**World / mesher / AABB 碰撞 / 存档 / 分区流式加载一行都没改**。

所有输入都是世界整数坐标 + seed，没有 chunk 局部量、没有 `Math.random`：跨 chunk 边界、跨 region、负坐标、缓存淘汰后重算、存档往返都逐字节一致。实测 81 个 chunk（20736 列）整窗生成约 **0.4 秒**；滑动窗口时 `updateStreaming(..., maxLoad)` 按距玩家由近到远每帧只铺 4 个 chunk，把开销摊到多帧。

验收里有五项结构性断言直接排除「换皮高度图」：浮空岛、非单调列、带顶盖地下洞穴、悬垂、连续矿团；另有可回退性测试——把 `relief/caves/islands/ores` 全设为 0，地形退化为严格单调的 2D 列。

```js
__VOXEL__.terrain3d.stats                    // seed / 起伏 / 洞穴 / 浮岛 / 矿脉参数
__VOXEL__.terrain3d.inspect(120, -80)        // { blocks[48], surface, highest }
__VOXEL__.terrain3d.densityAt(120, 24, -80)  // 该点密度，>0 为固体
__VOXEL__.world.generatorId                  // 'density3d-v1'（HUD 也会显示）
```

> 说明：真 3D 下 `surfaceY` 是密度场的**地表基准**，不等于该列最高方块（浮岛会更高）。碰撞与拾取本来就读实际体素 `highestSolidY()`，不受影响。

---

## 负一、v0.6：分区系统与无限生成

`voxel.regions` 插件默认开启。关掉它即回到 v0.5 的有限 6×6 浮空岛，其余插件零改动。

| 能力 | 做法 | 关键文件 |
| --- | --- | --- |
| 无限生成 | `World.updateStreaming(cx, cz)` 以玩家所在 chunk 为中心维护 `(2r+1)²` 滑动窗口，负坐标用 `Math.floor` 正确换算 | `world/World.ts` |
| 分区归档 | 只把「被玩家改过且滑出窗口」的 chunk 按 region 存起来；未改动的靠确定性生成器重算，内存不随探索距离膨胀 | `world/RegionManager.ts` |
| 区域索引 | 存档多写一个 `REGN` 系统段，记录覆盖过哪些 region、各有多少改动；旧存档没有这段也能读 | `world/RegionCodec.ts` |
| 按区导出 | `toRegionEnvelope(binary, rx, rz)` / `fromRegionEnvelope()`，只搬运一个区域的 chunk 段 | `world/World.ts` |

一个 region = `REGION_CHUNKS × REGION_CHUNKS` 个 chunk（默认 16×16 = 256 方块见方）。窗口半径随设置里的「视距」自动调整，变化当帧补齐；新 chunk 的四邻会一起标脏，保证面剔除始终正确。HUD 会显示当前 region 坐标、窗口占用与归档数量。

存档里除活跃窗口外还包含所有已归档改动，读档后走近对应区域会自动恢复。控制台可直接观察：

```js
__VOXEL__.world.streamInfo          // 窗口半径 / 中心 / 归档数
__VOXEL__.world.regionIndex         // 各 region 的 chunk 与改动统计
__VOXEL__.world.updateStreaming(20, -8)  // 手动把窗口滑到任意坐标
```

---

## 零、v0.5：全量 Cordis 化（统一编排层）

v0.4 的四条定理只覆盖 **19 个世界组件**；插件仍由 `PluginHost` 自己管生命周期。v0.5 把
**7 个内置插件 + 12 个扩展插件**也编译成 Cordis 组件，与 19 个世界组件装进**同一个 `Kernel`**：
一套 `inject` / `provide` 依赖图、一套可逆效应栈、一次 `snapshot()` 看全生态。

| 层 | 职责 | 关键文件 |
| --- | --- | --- |
| `Kernel`（真值源） | 依赖图、能力多提供者、可逆性、四条定理 | `kernel/Registry.ts` · `Effect.ts` · `Fiber.ts` · `Context.ts` |
| `PluginGraph`（编译层） | 把真实 `Plugin` 编译成组件：`provides → claim`、`dependencies` / `cap: → inject`、`optionalDependencies` 只记录 | `core/PluginGraph.ts` |
| `PluginHost`（执行器） | 确定性拓扑、异步 `setup`、事件与日志、`reload` 幂等 | `core/PluginHost.ts` |
| `PluginScope`（资源层） | 每插件独享一条 `EffectStack`，由 Kernel 停用顺序 LIFO 回滚 | `core/PluginScope.ts` |

这是**控制反转**：Kernel 决定「谁能激活、按什么顺序停」，Host 决定「何时异步 setup」。
因此 v0.2 的 7 个内置插件**一个对象都不用改**，44/44 架构断言原样通过。

### 确定性代表：汇聚性 T80 的关键

`cap:generator` 同时由 `voxel.terrain` / `voxel.terrain-rich` / `voxel.cordis-world` 三个插件提供。
若代表用「先到先得」，不同激活顺序会选出不同 provider，`resolution` 就不同 —— 直接违反汇聚性。
v0.5 的代表只由**活跃贡献者集合**决定（字典序最小，此处恒为 `voxel.cordis-world`）：

```js
__VOXEL__.unified.capProviders('plugin.cap:generator')       // 3 个贡献者（已排序）
__VOXEL__.unified.capRepresentative('plugin.cap:generator')  // 'voxel.cordis-world'
__VOXEL__.graph.cascade('voxel.blocks')                     // 14 个传递依赖者，深度降序
```

移除非代表 provider 不改变代表 → 依赖者 `generation` 不变、不重激活。这对真实运行同样重要：
`activate` 会 `reset` 效应栈，抖动会误杀插件已挂载资源的逆。`cap:` 键没有单值绑定，
`Context.require()` 以确定性代表作为存在性见证；被停用后重激活时 `apply` 会重建资源栈。

### 19 条全生态验收

`tools/verify-unified.ts` 用真实插件定义装配统一内核，验证 T16 / T70 / T73 / T80 对整个生态
成立，另测 cap 多提供者稳定代表、optional 软依赖、级联停用、LIFO 回滚、共享单实例、
局部 `dispose` 不牵连另一组。**19/19 通过**，`npm run verify` 扩到 7 套 `173/173`。

控制台：

```js
__VOXEL__.unified === __VOXEL__.kernel        // true：服务与统一内核同一实例
__VOXEL__.unified.snapshot().active.length    // 38（19 插件 + 19 世界组件）
__VOXEL__.graph.status()                      // { total: 19, active: 19, failed: [], quiescent: true }
__VOXEL__.graph.deactivate(['voxel.achievements'])  // 内核级热插拔，世界组件不受影响
__VOXEL__.graph.activate('voxel.achievements')
```

---

## 零·前、v0.4：Cordis 可逆内核与完整地形

参考 **Cordis**（Koishi / DeepSeek Harness 的插件内核）及其形式化论文
《A Programming Paradigm for Spatiotemporal Composability》（arXiv:2608.25512，北京大学 + DeepSeek-AI）。
论文把「副作用 / 上下文依赖」从静态类型标注提升为运行时机制，并证明四条定理。

| 论文概念 | 本项目实现 | 带来的保证 |
| --- | --- | --- |
| Revertible Effects 可逆效应 | `kernel/Effect.ts`：每个副作用强制带逆函数，压入 LIFO 栈 | `undo ∘ do = id`；关闭方块包时贴图、方块定义、世界里的旧体素一起精确回滚 |
| Reactive Coeffects 反应式共效应 | `kernel/Registry.ts`：`inject` / `provide` 声明即依赖图 | 服务消失时依赖者自动停用；provider 换绑时只重解析真正受影响的组件 |
| Fiber / Context 树 | `kernel/Fiber.ts`、`Context.ts`：派生子 Context + Proxy 服务解析 | 父子级联卸载，失败组件不波及兄弟 |
| Theorem 16 恢复精确性 | 每 Fiber 独享效应栈 | 交错执行后撤销 A 不触碰 B 的绑定与效应 |
| Theorem 70 有序性 | 停用按依赖深度降序（consumer 先） | provider 的绑定在所有 consumer 停用后才释放 |
| Theorem 73 进展性 | 单轮 committed 快照 + inertial + 失败即撤销 | 无环依赖必在有限步内收敛到静止 |
| Theorem 80 汇聚性 | 终态只由绑定集合与声明决定 | 任意调度顺序得到观察等价的终态 |

`tools/verify-cordis.ts` 把四条定理写成 **19 条可执行断言**；`tools/verify-terrain.ts` 再用 **19 条**覆盖真实装配。
装配逻辑抽在 `world/terrain/assemble.ts`，浏览器插件与 Node 验收共用同一份，保证「测的就是跑的」。

### 模块化：19 个内核组件

- **10 个方块包**（`src/world/blocks/packs/`）：石质 / 土壤 / 木材 / 矿物 / 建材 / 16 色混凝土 / 光源 / 液体冰霜 / 植物 / 下界，共 **85 种新方块**；加上原有 15 种，世界共 **100 种方块**、107 张程序化贴图。贴图由 `paint.ts` 的 16 种原子算子 + `tint` / `mask` / `overlay` 组合子生成，新增方块只是一条数据。
- **8 个地形阶段**（`src/world/terrain/stages.ts`）：大陆基岩 → 生物群系地层 → 近地表 → 洞穴侵蚀 → 矿脉 → 植被 → 遗迹 → 水面装饰。**11 种生物群系**按高度 / 温度 / 湿度选择，`inject` 链保证关掉上游时下游自动停用，不会出现「跳过地层却在挖矿」的半成品世界。
- **1 个基础设施组件**把 atlas / blocks 作为反应式服务注入，其余 18 个组件全部 `inject` 它或其上游。
- **1 个桥接插件** `CordisWorldPlugin` 把结果交给原有的 `GENERATOR` / 物品栏 / 存档链路。v0.2 的 7 个内置插件一个对象都不用改。

控制台可直接热插拔：

```js
__VOXEL__.kernel.disable('pack.color')       // 100 → 84 种方块
__VOXEL__.kernel.enable('pack.color')        // 精确恢复，id 不变
__VOXEL__.kernel.disable('stage.vegetation') // 8 → 5 阶段（structure / decorate 级联停用）
__VOXEL__.kernel.snapshot()                  // 观察等价的规范化状态
__VOXEL__.pipeline.stageIds                  // 当前启用的阶段链
```

---

## 零·附、v0.3 新增：从「构建期插件」到「运行时插件市场」

保持 v0.2 的 7 个内置插件**一个对象都不改**（44/44 架构验收原样通过），所有新能力通过更高优先级的服务令牌顶替内置策略。

| 能力 | 实现 | 关键文件 |
| --- | --- | --- |
| 运行时插件市场 | 统一清单 `builtin / extension / community / url / source` 五类来源，支持开关、重载、移除、持久化、`cap:` 拓扑排序与级联卸载同步 | `core/PluginCatalog.ts` |
| URL 动态 import | `import(/* @vite-ignore */ url)` 从任意 ESM URL 安装插件 | `public/plugins/demo-fireflies.js` |
| 源码热加载 | 粘贴的 ESM 源码包成 `Blob` → `URL.createObjectURL()` → 动态 import，不写盘、不重建 | `PluginCatalog.installFromSource()` |
| 主菜单 / 暂停菜单 | 主菜单、设置、插件仓库、存档管理、操作说明、关于 + 暂停时相机环绕真实 3D 世界 | `core/Menu.ts` · `plugins/MenuCameraPlugin.ts` |
| M2 挖 / 放 | 复用射线命中面法线；左键破坏、右键放置，禁止把方块塞进玩家 AABB | `plugins/InteractionPlugin.ts` |
| M2 AABB 碰撞 | `0.6 × 1.8 × 0.6` 玩家盒 vs 体素盒，头顶碰撞、洞穴、沿墙滑动、自动登 1 格台阶 | `player/AABBCollision.ts` |
| M2 物品栏 | 扫描 `BlockRegistry` 自动收集可放置方块；第三方新方块热加载后自动进快捷栏 | `core/Inventory.ts` |
| M4 昼夜循环 | 6 分钟一天：日出日落暖辉、月亮、闪烁星空，驱动天空 shader / 雾色 / 地形材质亮度 | `core/DayCycle.ts` · `plugins/DayNightPlugin.ts` |
| M4 存档落盘 | TLV 信封 + CRC32 + IndexedDB；Node 自动降级内存；玩家状态作插件私有二进制段 | `core/SaveStore.ts` · `plugins/SavePlugin.ts` |
| 图形增强 | 顶点 AO、12 种程序化方块、丰富地形（山脊/沙滩/树林/洞穴/矿脉）、云层、破坏粒子、选中框、ACES 色调映射 | `render/*` · `plugins/BlocksExtraPlugin.ts` · `plugins/RichTerrainPlugin.ts` |

### 操作

| 输入 | 动作 |
| --- | --- |
| `WASD` / 鼠标 | 移动 / 转视角（`Shift` 疾跑，`Space` 跳，双击 `Space` 切换飞行） |
| 左键 / 右键 | 破坏 / 放置方块 |
| 滚轮 / `1`~`9` / `Q` | 切换快捷栏 / 翻页 |
| `F` / `R` / `T` | 切换创造·生存 / 重生 / 跳到下一时段 |
| `Esc` | 暂停并打开菜单（插件仓库、存档、设置） |

主菜单「插件仓库」可直接点「安装」加载 `/plugins/demo-fireflies.js`，或点「填入示例」后「编译并加载」体验源码热加载；新方块会立刻出现在快捷栏。

---

## 一、架构：插件宿主 + 服务注册表 + 作用域

```
main.ts                 纯 kernel：createContext → shell 服务 → 运行时清单 boot → 主菜单
   ├── core/
   │     createContext.ts   WebGL / 相机 / 渲染器 / ACES 色调映射 / v0.5 统一内核
   │     PluginGraph.ts     v0.5 插件 → Cordis 组件编译层 + 统一编排层
   │     PluginHost.ts      拓扑 / 能力依赖 / 生命周期 / 热插拔 / 失败回滚
   │     PluginScope.ts     每插件独享的可逆 EffectStack，注册的一切自动清理
   │     ServiceRegistry.ts ServiceToken<T> + 优先级覆盖 + onChange
   │     PluginCatalog.ts   v0.3 运行时插件市场（URL / 源码热加载、开关级联）
   │     Engine.ts          固定步长 + 显式阶段 + priority + 逐回调异常隔离
   │     GameState / DayCycle / Inventory / SaveStore / Menu / Ui / Input
   │     EventBus/EventMap  类型化事件（可 declare module 扩展）
   │     ConfigStore.ts     插件私有配置命名空间
   │     tokens.ts          内置可替换令牌 + v0.3 外壳服务令牌
   ├── kernel/   v0.5 可逆内核：Effect(LIFO 逆) · Fiber · Context · Registry(反应式共效应)
   ├── binary/   BinaryBuffer(DataView) · BinaryHub(TLV) · ChunkCodec · WasmHost
   ├── world/    BlockRegistry · Chunk · World(dirty 队列) · IGenerator · mesher/(CulledMesher + AO)
   ├── render/   TextureAtlas(动态扩容) · Sky(昼夜/日月/星空) · ChunkView · Clouds · Particles · Selection
   ├── player/   FirstPersonController · ICollision · AABBCollision · Raycast(DDA)
   └── plugins/  7 个内置插件 + 12 个扩展插件 + discover.ts + community/ 自动发现目录
```

**三条硬规则**

1. 固定字段只放基础设施；业务能力一律走 `services` / `events` / `scope`，所以加能力**不用改 `types.ts`，也不用改 `main.ts`**
2. 内置策略全部低优先级兜底，第三方 `provide` 更高优先级即顶替，世界自动响应
3. 插件用 `ctx.scope.*` 注册一切，卸载自动释放，不写 `dispose`

### 内置服务令牌

| Token | 类型 | 顶替后会怎样 |
| --- | --- | --- |
| `MESHER` | `IMesher` | 全部 chunk 自动重新网格化 |
| `GENERATOR` | `IGenerator` | 世界自动重新生成 + 重建 |
| `COLLISION` | `ICollision` | 控制器自动切换碰撞策略（v0.3 由 `AABBCollision` 以 priority 10 顶替） |
| `TERRAIN_MATERIALS` | `{ grass, dirt, ... }` | 地形插件换方块 id 来源 |
| `SKY_HANDLE` / `CHUNK_VIEW` / `FIRST_PERSON` | 句柄 | 直接操作天空 / 网格 / 玩家 |
| `GAME_STATE` / `DAY_CYCLE` / `INVENTORY` / `PLUGIN_CATALOG` / `SAVE_STORE` / `SAVE_API` / `EXTRA_BLOCKS` / `SELECTION` | v0.3 外壳服务 | 设置、昼夜、快捷栏、插件清单、存档、扩展方块 id、选中高亮 |

多个变更发生在同一 tick 会**合并成一次全量重建**，不会重复跑两遍。

---

## 二、写插件（推荐姿势）

把文件丢进 `src/plugins/community/`，构建时自动发现；**不需要改 `index.ts`、不需要改 `main.ts`**。v0.3 也可以完全不建文件，直接在主菜单「插件仓库」从 URL 或粘贴源码热加载。

```ts
// plugins/community/StonePlugin.ts
import { MESHER } from '../../core/tokens';
import type { Plugin } from '../../core/types';

export default {
  id: 'mypack.stone',
  version: '1.0.0',
  provides: ['stone'],
  dependencies: ['cap:chunkView'],        // 按能力依赖，不绑死插件 id
  optionalDependencies: ['cap:lighting'], // 缺失静默降级
  priority: 0,

  setup(ctx) {
    // key / id / tag 自动命名空间化，重复调用幂等，卸载自动释放
    const tile = ctx.scope.tile('stone', (set, s) => {
      for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) set(x, y, 128, 128, 132);
    });
    const id = ctx.scope.block('stone', { opaque: true, solid: true, all: tile });

    ctx.scope.service(MESHER, new GreedyMesher(), { priority: 10 }); // 顶掉内置 mesher
    ctx.scope.update((dt) => tick(dt), { phase: 'simulate' });
    ctx.scope.render(() => drawHud(), { phase: 'after' });
    ctx.scope.on('block:changed', (e) => ctx.log('block', e.x, e.y, e.z));
    ctx.scope.binary(0, {
      name: 'mypack.stone/meta',
      encode: (v: string) => new TextEncoder().encode(v).buffer as ArrayBuffer,
      decode: (b: ArrayBuffer) => new TextDecoder().decode(b),
      snapshot: () => `stone:${id}`,
    });
    ctx.scope.dom(window, 'keydown', onKey);
    ctx.scope.config('density', 0.5);
  },
} satisfies Plugin;
```

**不用写 `dispose`**。也可以完全不建文件，运行时热加载：

```js
__VOXEL__.host.mount(myPlugin)       // 加载
__VOXEL__.host.reload('mypack.stone') // 重载（连带恢复依赖者）
__VOXEL__.host.unmount('mypack.stone')// 卸载（连带卸载依赖它的插件）
__VOXEL__.host.capabilities()         // 查看所有能力声明
__VOXEL__.catalog.installFromUrl('/plugins/demo-fireflies.js')
__VOXEL__.catalog.installFromSource('export default { ... }')
```

卸载时事件订阅、循环回调、服务、方块、贴图、二进制段、DOM 监听**全部回落**；`setup` 中途抛错也会回滚，不留半初始化状态。

### 自定义事件类型

```ts
declare module '../core/EventMap' {
  interface EventMap { 'mypack:explode': { x: number; y: number; z: number } }
}
// ctx.scope.on('mypack:explode', e => e.x) —— 自动推导
```

### 循环阶段

`update`: `input → simulate → late`；`render`: `before → main → after`。同阶段按 `priority` 升序。
渲染提交在 `main / 1000`，所以任何插件都能声明在它之前改相机、之后做后处理。

---

## 三、二进制接缝（为「以后融合二进制」预留）

一条硬约定：**跨插件 / 跨存档 / 跨网络只传 `ArrayBuffer`、`Uint8Array`、数字 id、基本类型；不传 class 实例。JSON 只用于人读配置，不进热路径。**

| 你可能指的是 | 现在已有的东西 |
| --- | --- |
| 二进制存档 / 网络包 | TLV 信封 + `ChunkCodec v1`；`world.toEnvelope()` 一行导出整份世界，v0.3 由 `SaveStore` 落到 IndexedDB |
| WASM / Rust、C++ 模块 | `WasmHost.load()`；`IGenerator` / `IMesher` / `ICollision` 全是接口 |
| 二进制贴图 / 素材包 | `TextureAtlas` 是 `Uint8Array → DataTexture`，换 `define()` 的数据源即可 |
| 插件私有数据 | `claimTag(owner, local)` 派生 u16 段号 + `snapshot()` 自动收集，主程序不认识也能透传 |

```
u32 magic 'MCB0' | u16 version | u16 count
repeat: u16 tag | u32 len | u8[len] payload | align4 pad
```

未知 tag 原样保留，向后兼容靠这个。`ChunkCodec` 预留 `reserved` 与 palette 段，方块 id 升 uint16 走 version=2。
`binary.validate()` 在启动期体检（owner 缺失、编解码缺失、tag 冲突），控制台会打印信封大小、识别段和 `chunk round-trip`。

---

## 四、定死的设计

1. **方块是数据不是代码**：`scope.block()` 一条记录 + 一张 tile 就能加方块，mesher 不认识具体方块
2. **World 零 Mesh**：扁平 `Uint8Array`（`(y*S+z)*S+x`）；`CulledMesher` 只生成暴露面，每 chunk 一个 `BufferGeometry`、一次 draw call（实测 1000 面 vs 不剔除 21528 面）
3. **局部重建**：dirty 去重队列，`takeDirty(k)` 为 O(k)；改边界方块只标脏自己 + 邻居
4. **天空不用贴图**：Shader 渐变球 + 日月 + 星空 + 同色雾；顶点强制 `gl_Position.z = gl_Position.w` 钉在远平面并关闭深度测试，菜单环绕相机远离球心时也不会被 `far` 裁出黑洞
5. **控制自写**：`Input` 只产意图 → 控制器写相机 → 碰撞走 `ICollision`
6. **循环分离**：`update(1/60)` 固定步长，`render(alpha, elapsed)` 每帧绘制；主循环 `try/finally` + 逐回调异常隔离，单个插件抛错不冻结画面
7. **地面真值是实际体素**：`World.highestSolidY / groundY` 从 chunk 向下扫，挖 / 放方块立刻影响脚下；v0.3 默认 `AABBCollision` 真正做 AABB vs 体素解算（头顶、洞穴、沿墙滑动、自动登 1 格台阶），内置 `GroundFollowCollision` 保留作低优先级兜底
8. **射线给全信息**：`Raycast` 返回命中面法线 + `fromInside`，M2 挖 / 放直接复用；起点在方块内时法线不再全零

---

## 五、验收

`tsc --noEmit` 通过（含 `tools/`）· `vite build` 通过（91 modules，主包 129.59 KB + three 475 KB 独立分块）· **Node 自检 44/44 + 25/25 + 15/15 + 32/32 + 19/19 + 19/19 + 19/19 = 173/173**，脚本在 `tools/`，`npm run verify` 一键复现。新增三套：`verify-cordis.ts`（四条定理 + 逆元律 / 结合律 / 反应式共效应 / 失败隔离）、`verify-terrain.ts`（方块库 / 生物群系 / 洞穴矿脉植被 / 热插拔级联）、`verify-unified.ts`（全量 Cordis 化：真实 19 插件 + 19 世界组件共享内核的四条定理）。

v0.3 另用 Xvfb + Chromium + SwiftShader 做了**真实 WebGL 2.0 渲染与玩法验收**（13 张截图与 `report-v03.json` 见交付物 `shots/`）：

- 渲染：36 chunk / 21 draw call / 30,780 三角形，`pageErrors: []`、`consoleErrors: []`、`errorCount: 0`
- 玩法：左键破坏 / 右键放置各 1 次生效，选中框、成就提示、9 格图标快捷栏正常
- 插件：URL 插件 `remote.fireflies` 与源码插件 `demo.pulse` 均 `loaded: true`，新方块自动进快捷栏（14 → 15 → 16）；`voxel.clouds` 热卸载后 `loaded: 19/20`
- 存档：IndexedDB 往返 444,140 bytes，方块值 `before 65 → restored 65` 一致
- 画面：白天 / 黄昏 / 夜景（月亮、星空）逐张目视确认，主菜单渐变天空连续无遮挡

详见 `../v0.3-升级与验证说明.md` 与 `../修复与验证说明.md`。

v0.4 真实浏览器验收（9 张 `shots/v04-*.png` 与 `shots/report-v04.json`）：

- 内核 19/19 组件激活、100 种方块、107 张贴图、8 个阶段全部生效，生成器 `cordis-terrain-v1`
- 渲染：36 chunk / 21 draw call / 42,970 三角形；`pageErrors: []`、`consoleErrors: []`、`errorCount: 0`
- 热插拔：`disable('pack.color')` 使方块数 `100 → 84`，`enable` 后精确恢复且 id 不变；`disable('stage.vegetation')` 使阶段 `8 → 5`（下游级联），恢复后 `8`
- 玩法与存档：挖 / 放各 1 次生效，快捷栏可翻页浏览 99 种方块，IndexedDB 存读 `66 → 66` 一致
- 白天 / 黄昏 / 夜景 / 俯视全景逐张目视确认

详见 `../v0.4-Cordis内核与地形升级说明.md`。

v0.5 真实浏览器验收（9 张 `shots/v05-*.jpg` 与 `shots/report-v05.json`，`allPass: true`；**实拍截图未包含在此精简交付包，详见完整仓库**）：

- 单内核：`__VOXEL__.unified === __VOXEL__.kernel`，**38 个组件（19 插件 + 19 世界）全部激活**，`snapshotActive: 38`、`specIds: 38`
- 确定性代表：`cap:generator` 的 3 个贡献者，代表恒为 `voxel.cordis-world`；`cascade('voxel.blocks')` 返回 14 个传递依赖者
- 双向隔离：停用 `voxel.achievements` → 插件 `19 → 18 → 19`、世界组件恒 `19`；停用 `pack.color` → 方块 `100 → 84 → 100`、插件恒 `19`
- 渲染：36 chunk / 21 draw call / 42,970 三角形；`pageErrors: []`、`consoleErrors: []`、`errorCount: 0`
- 玩法与存档：挖 / 放各 1 次生效，快捷栏 99 种方块，IndexedDB `66 → 66` 一致
- 主菜单 / 白天 / 黄昏 / 夜景 / 俯视全景逐张目视确认

详见 `../v0.5-全量Cordis化说明.md`。

- 架构：拓扑与 `cap:` 依赖、scope 自动清理、策略热替换与回退、热插拔级联卸载、reload 幂等、setup 失败回滚、图集动态扩容、类型化事件、阶段顺序、二进制往返、`WasmHost` 挂载
- 游戏逻辑：三角形绕序（1856 个三角无反向）、侧面 UV 草边朝上、草顶 UV、挖/放方块后地面正确变化、WASD 方向、陡坡阻挡、一级台阶登顶、跳跃完整弧线、脚下抬升不吞跳跃、yaw 归一化、世界边缘不悬空、射线法线与 `fromInside`、dirty 队列
- v0.3 增量：昼夜相位与配色、AABB 头顶/洞穴/沿墙滑动、挖放底层链路、AO 多级顶点亮度、物品栏自动收集与缩回、存档内存后端与信封逐字节一致、`PluginCatalog` 拓扑/开关级联/持久化/重载、设置持久化

---

## 六、里程碑（都不改 `main.ts` 与 `Engine`）

- **M0/M1 ✅**：天空 + 草方块小丘 + 第一人称 + 插件骨架 + 二进制接缝
- **M2 ✅（v0.3）**：挖 / 放、`AABBCollision` 以 `COLLISION priority:10` 顶掉 `GroundFollowCollision`、自动收集式物品栏
- **M3**：无限 chunk 加载/卸载、greedy meshing、按视距排序重建
- **M4 ✅（v0.3，部分）**：顶点 AO / 昼夜循环、二进制存档落盘（IndexedDB + TLV/CRC32）；压缩段与完整光照仍待做
- **M5**：WASM 生成器或 mesher、网络二进制协议包
- **M6 ✅（v0.4）**：Cordis 可逆内核（四条形式化定理）、10 个方块包 / 85 种新方块、8 阶段生物群系地形、组件级热插拔与精确回滚
- **M7 ✅（v0.5）**：全量 Cordis 化 · `PluginGraph` 统一编排层 · 插件与世界组件共享单一内核 · 确定性代表修复汇聚性 T80 · 173/173 验收

控制台 `__VOXEL__` 暴露 `ctx / host / core / world / blocks / binary / wasm / game / cycle / inventory / store / catalog / menu / services / engine / unified / graph / kernel`：

```js
__VOXEL__.world.setBlock(48, 20, 48, 64)       // 局部重建
__VOXEL__.host.capabilities()                    // 能力表
__VOXEL__.core.services.tokens()                 // 已注册服务
__VOXEL__.catalog.stats                          // 运行时插件清单
__VOXEL__.cycle.setPhase(0.76)                   // 跳到夜晚
__VOXEL__.world.toEnvelope(__VOXEL__.binary).byteLength
```
