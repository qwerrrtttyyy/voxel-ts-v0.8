import { CHUNK_VIEW, DAY_CYCLE, FIRST_PERSON, GAME_STATE, INVENTORY, RETICLE } from '../core/tokens';
import type { Plugin } from '../core/types';
import { AIR_ID } from '../world/BlockRegistry';
import { regionCoord } from '../world/RegionManager';

/**
 * v0.3 HUD：时间 / 模式 / 统计 / 准星目标信息，节流到约 7 Hz；可整体隐藏。
 * v0.6：
 *  - 准星射线改读 RETICLE 单源服务（全场只算一次 DDA，不再与交互插件重复）
 *  - 新增「入水 / 置于实体内」的屏幕遮罩，给水下与洞穴一点沉浸感
 *  - 遮罩只在状态变化时写 DOM，避免热路径上重复样式赋值
 */
export function hudPlugin(): Plugin {
  return {
    id: 'voxel.hud',
    version: '0.6.0',
    meta: {
      label: '增强 HUD', category: 'gameplay', author: 'voxel-ts', badge: 'HU',
      description: '时间 / 模式 / 统计 / 准星目标信息 + 入水遮罩，节流 7Hz；可整体隐藏',
    },
    provides: ['hud'],
    dependencies: ['cap:firstPerson'],
    priority: 45,

    setup(ctx): void {
      const { scope, services } = ctx;
      const game = services.get(GAME_STATE);
      const cycle = services.get(DAY_CYCLE);
      const view = services.get(CHUNK_VIEW);
      const ctrl = services.get(FIRST_PERSON);
      const inv = services.tryGet(INVENTORY);
      let lastTint = '';

      const updateTint = (): void => {
        const p = ctx.camera.position;
        const id = ctx.world.getBlock(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
        let tint = '';
        if (id !== AIR_ID) {
          const def = ctx.blocks.get(id);
          tint = def.liquid
            ? 'rgba(24, 92, 148, 0.42)'
            : def.opaque ? 'rgba(8, 10, 16, 0.62)' : '';
        }
        if (tint !== lastTint) {
          lastTint = tint;
          ctx.ui.setTint(tint);
        }
      };

      // v0.6：降频交给 Engine（every:4 ≈ 15Hz），回调不再入栈做空转节流
      scope.render(() => {
        updateTint();
        if (!game.settings.showHud || game.paused) { ctx.ui.setHud(''); return; }

        // 服务注销后（交互插件被关掉）自动降级为「无目标」，不会显示过期命中
        const hit = services.tryGet(RETICLE)?.hit ?? null;
        const f = ctrl.feet;
        const face = hit
          ? ` (${hit.x},${hit.y},${hit.z}) ${hit.ny === 1 ? '+Y' : hit.ny === -1 ? '-Y' : 'side'}`
          : ' —';
        const modeText = game.mode === 'creative' ? '创造' : '生存';
        const si = ctx.world.streamInfo;
        const regionText = si.enabled
          ? `region ${regionCoord(si.centerCx)},${regionCoord(si.centerCz)} · 窗口 ${si.loadedChunks}/${si.windowChunks} · 归档 ${si.archived}`
          : '有限世界 6×6';

        ctx.ui.setHud(
          `VOXEL-TS  ·  v0.6 插件式方块世界\n` +
          `pos   ${f.x.toFixed(1)}, ${f.y.toFixed(1)}, ${f.z.toFixed(1)}   ${cycle.clock()}   fps ${ctx.engine.fps}\n` +
          `${modeText}${ctx.input.state.flying ? ' · 飞行' : ''}   chunk ${ctx.world.keys().length} · blocks ${ctx.blocks.all().length} · plugins ${ctx.host.loadedIds().length}\n` +
          `look  ${hit ? ctx.blocks.labelOf(hit.id) : 'sky'}${face}\n` +
          `放置 ${game.stats.placed} · 破坏 ${game.stats.broken} · 行走 ${Math.round(game.stats.distance)}m\n` +
          `${regionText}\n` +
          `gen ${ctx.world.generatorId} · mesher ${view.mesherId}\n` +
          `${inv ? `物品 ${inv.total}` : '无物品栏'} · 异常 ${ctx.engine.errorCount}`,
        );
        ctx.ui.setTarget(hit ? ctx.blocks.labelOf(hit.id) : '');
        ctx.ui.setClock(`${cycle.clock()}  ·  ${modeText}`);
      }, { phase: 'before', priority: 200, every: 4 });

      scope.on('game:toast', (e) => ctx.ui.toast(e.text, e.kind));
      scope.track(() => ctx.ui.setTint(''));
      ctx.log('enhanced hud ready · reticle shared · submerge tint active');
    },
  };
}
