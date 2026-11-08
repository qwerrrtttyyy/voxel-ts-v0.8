import './style.css';

import { createContext, type CoreBundle } from './core/createContext';
import { builtinPlugins, extendedPlugins } from './plugins';
import { discoverPlugins } from './plugins/discover';
import { GameState } from './core/GameState';
import { DayCycle } from './core/DayCycle';
import { Inventory } from './core/Inventory';
import { SaveStore } from './core/SaveStore';
import { PluginCatalog } from './core/PluginCatalog';
import { Menu, regenerateWorld } from './core/Menu';
import {
  BLOCK_LIBRARY, DAY_CYCLE, GAME_STATE, GENERATOR, INVENTORY,
  AUDIT, AUDIT_API, PLUGIN_CATALOG, SAVE_STORE, TERRAIN_KERNEL, TERRAIN3D,
  UNIFIED_KERNEL, PLUGIN_GRAPH,
} from './core/tokens';
import type { IPluginHost } from './core/types';
import { Chunk } from './world/Chunk';

interface Runtime extends CoreBundle {
  game: GameState;
  catalog: PluginCatalog;
  menu: Menu;
  cycle: DayCycle;
  inventory: Inventory;
  store: SaveStore;
  /** v0.6：HMR 时解绑 canvas 上的 WebGL 生命周期监听 */
  detachWebgl?: () => void;
}

let current: Runtime | null = null;

async function boot(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;

  // 内核只做一件事：装配基础设施。插件集合完全由运行时清单决定。
  const { ctx, host, core } = createContext(canvas);

  core.engine.setErrorHandler((err, where) => {
    console.error(`[voxel] ${where} callback failed`, err);
  });
  // v0.6：上下文丢失不再只能刷新页面 —— stop 循环、等 restored、重建尺寸后 start。
  const onLost = (e: Event): void => {
    e.preventDefault();
    core.engine.stop();
    ctx.ui.toast('WebGL 上下文丢失，正在等待恢复…', 'warn');
  };
  const onRestored = (): void => {
    core.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    core.renderer.setSize(window.innerWidth, window.innerHeight);
    core.engine.start();
    ctx.ui.toast('WebGL 已恢复，继续游戏', 'good');
  };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  const detachWebgl = (): void => {
    canvas.removeEventListener('webglcontextlost', onLost);
    canvas.removeEventListener('webglcontextrestored', onRestored);
  };

  // ---- 外壳服务：与插件能力分开，通过服务令牌暴露，不改 PluginContext ----
  const shell = core.config.namespace('shell');
  const game = new GameState(shell);
  const cycle = new DayCycle();
  const inventory = new Inventory();
  const store = new SaveStore();
  const catalog = new PluginCatalog(
    host as IPluginHost, shell,
    (text, kind) => ctx.ui.toast(text, kind ?? 'info'),
  );

  core.services.provide(GAME_STATE, game, { priority: 1000, owner: 'core' });
  core.services.provide(DAY_CYCLE, cycle, { priority: 1000, owner: 'core' });
  core.services.provide(INVENTORY, inventory, { priority: 1000, owner: 'core' });
  core.services.provide(SAVE_STORE, store, { priority: 1000, owner: 'core' });
  core.services.provide(PLUGIN_CATALOG, catalog, { priority: 1000, owner: 'core' });
  // v0.5：把统一内核暴露为服务，供 CordisWorldPlugin 注入（必须在 catalog.boot 之前）
  core.services.provide(UNIFIED_KERNEL, core.kernel, { priority: 1000, owner: 'core' });
  core.services.provide(PLUGIN_GRAPH, core.graph, { priority: 1000, owner: 'core' });

  ctx.input.sensitivity = game.settings.sensitivity;
  ctx.input.allowFly = game.settings.mode === 'creative';
  core.camera.fov = game.settings.fov;
  core.camera.updateProjectionMatrix();

  // ---- 三类来源统一成一份清单：内置 / 扩展玩法 / 构建期社区插件 ----
  catalog.register(builtinPlugins(), 'builtin');
  catalog.register(extendedPlugins(), 'extension');
  catalog.register(discoverPlugins(), 'community');
  await catalog.boot();

  // 快捷栏图标直接取 atlas 像素，插件新方块自动获得图标
  inventory.onChange(() => {
    ctx.ui.renderHotbar(inventory.slots(), inventory.selected, (k) => ctx.atlas.tilePixels(k));
  });
  inventory.rebuild(ctx.blocks);

  core.engine.start();

  const menu = new Menu({
    game, catalog, services: core.services, input: ctx.input, ui: ctx.ui,
    world: ctx.world, blocks: ctx.blocks, camera: core.camera,
    onNewWorld: () => regenerateWorld({ services: core.services, world: ctx.world }),
  });
  menu.openMain();

  current = { ctx, host, core, game, catalog, menu, cycle, inventory, store, detachWebgl };

  (window as unknown as Record<string, unknown>).__VOXEL__ = {
    ctx, host, core, game, catalog, menu, cycle, inventory, store,
    world: ctx.world, blocks: ctx.blocks, binary: ctx.binary,
    wasm: ctx.wasm, engine: core.engine, camera: core.camera, scene: core.scene,
    services: core.services,
    // v0.4：Cordis 内核 / 方块库 / 地形流水线，供插件仓库与控制台热插拔
    kernel: core.services.tryGet(TERRAIN_KERNEL),
    library: core.services.tryGet(BLOCK_LIBRARY),
    pipeline: core.services.tryGet(GENERATOR),
    // v0.7：真 3D 密度场生成器（stats / inspect / densityAt 可直接调）
    terrain3d: core.services.tryGet(TERRAIN3D),
    // v0.8：深度审批门面与规则注册表（run / rules / register）
    audit: core.services.tryGet(AUDIT_API),
    auditRegistry: core.services.tryGet(AUDIT),
    // v0.5：统一内核（插件 + 世界组件同实例）与统一编排层
    unified: core.kernel,
    graph: core.graph,
  };
  ctx.log('world ready · runtime plugin catalog active');

  // 启动自检挪到空闲期，不压首屏关键路径
  const selfCheck = (): void => {
    try {
      const issues = ctx.binary.validate();
      const envelope = ctx.world.toEnvelope(ctx.binary, ctx.binary.snapshot());
      const segments = [...new Set(ctx.binary.decodeAll(envelope).map((e) => e.name))];
      const first = ctx.world.getChunk(0, 0);
      const roundTripOk = !!first && Chunk.fromBinary(first.toBinary()).data
        .every((v, i) => v === first.data[i]);
      ctx.log(`envelope ${(envelope.byteLength / 1024).toFixed(1)} KB / ${segments.length} segment types`);
      ctx.log(`chunk round-trip: ${roundTripOk ? 'OK' : 'FAILED'} · binary issues: ${issues.length}`);
      ctx.log(`catalog: ${catalog.stats.loaded}/${catalog.stats.total} loaded · capabilities: ${host.capabilities().length}`);
      ctx.log(`mesher: ${core.services.tokens().length} services · blocks: ${ctx.blocks.all().length}`);
    } catch (err) {
      console.warn('[voxel] self-check failed', err);
    }
  };
  const idle = (window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  }).requestIdleCallback;
  if (idle) idle.call(window, selfCheck, { timeout: 2000 });
  else setTimeout(selfCheck, 0);
}

void boot().catch((err: unknown) => {
  console.error('[voxel] boot failed', err);
  const hud = document.getElementById('hud');
  if (hud) hud.textContent = `启动失败：${err instanceof Error ? err.message : String(err)}`;
});

// Vite HMR：彻底释放菜单 / 插件 / 输入 / WebGL，避免重复注册与上下文泄漏
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (!current) return;
    const { ctx, host, core, menu } = current;
    current.detachWebgl?.();
    menu.dispose();
    core.engine.stop();
    ctx.input.dispose();
    host.dispose();
    ctx.atlas.dispose();
    core.renderer.dispose();
    current = null;
  });
}
