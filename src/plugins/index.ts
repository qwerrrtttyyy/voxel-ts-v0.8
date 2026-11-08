import type { Plugin } from '../core/types';
import { definePluginList } from '../core/definePlugin';
import { auditPlugin } from './AuditPlugin';
import { grassBlocksPlugin } from './GrassBlocksPlugin';
import { hillsPlugin } from './HillsPlugin';
import { skyPlugin } from './SkyPlugin';
import { worldRenderPlugin } from './WorldRenderPlugin';
import { playerPlugin } from './PlayerPlugin';
import { renderSubmitPlugin } from './RenderSubmitPlugin';
import { viewportPlugin } from './ViewportPlugin';

/**
 * 内置插件清单。顺序故意打乱 —— 宿主按 dependencies / `cap:` / priority 拓扑排序。
 * 第三方插件不用碰这个数组：丢进 `plugins/community/*.ts` 由 discover.ts 自动收集，
 * 或运行时 `host.mount(plugin)` 热加载。
 */
export function builtinPlugins(): readonly Plugin[] {
  return definePluginList([
    skyPlugin(),
    playerPlugin(),
    renderSubmitPlugin(),
    hillsPlugin(),
    viewportPlugin(),
    worldRenderPlugin(),
    grassBlocksPlugin(),
  ] as const satisfies readonly Plugin[]);
}

// ---- v0.3：可选玩法 / 渲染插件，全部由 PluginCatalog 在运行时编排 ----
import { blocksExtraPlugin } from './BlocksExtraPlugin';
import { richTerrainPlugin } from './RichTerrainPlugin';
import { aabbCollisionPlugin } from './AABBCollisionPlugin';
import { dayNightPlugin } from './DayNightPlugin';
import { cloudsPlugin } from './CloudsPlugin';
import { inventoryPlugin } from './InventoryPlugin';
import { interactionPlugin } from './InteractionPlugin';
import { savePlugin } from './SavePlugin';
import { hudPlugin } from './HudPlugin';
import { menuCameraPlugin } from './MenuCameraPlugin';
import { achievementsPlugin } from './AchievementsPlugin';
import { profilerPlugin } from './ProfilerPlugin';
import { regionsPlugin } from './RegionsPlugin';
import { terrain3DPlugin } from './Terrain3DPlugin';
import { cordisWorldPlugin } from './CordisWorldPlugin';

/**
 * 扩展插件清单。顺序无关：PluginCatalog 会按 dependencies / `cap:` / priority 拓扑排序。
 * 每一个都可以在主菜单「插件仓库」里单独开关，关掉后系统自动回退到内置兜底实现。
 *
 * 注意：builtinPlugins() 刻意保持不变，v0.2 的 44/44 架构验收仍在原始 7 插件上跑。
 */
export function extendedPlugins(): readonly Plugin[] {
  return definePluginList([
    cordisWorldPlugin(), // v0.4：可逆内核（方块包 + 地形流水线），priority -100 尽早装配
    dayNightPlugin(),
    interactionPlugin(),
    richTerrainPlugin(),
    menuCameraPlugin(),
    hudPlugin(),
    blocksExtraPlugin(),
    cloudsPlugin(),
    inventoryPlugin(),
    achievementsPlugin(),
    profilerPlugin(),
    regionsPlugin(),
    terrain3DPlugin(),
    savePlugin(),
    aabbCollisionPlugin(),
    auditPlugin(),
  ] as const satisfies readonly Plugin[]);
}
