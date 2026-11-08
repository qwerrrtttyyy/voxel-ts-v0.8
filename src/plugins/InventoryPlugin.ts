import { GAME_STATE, INVENTORY } from '../core/tokens';
import type { Plugin } from '../core/types';

/**
 * 物品栏插件：不维护任何硬编码清单，直接扫描 BlockRegistry。
 * 因此「从 URL 装一个带新方块的第三方插件」→ 新方块自动进入快捷栏，
 * 卸载插件 → 自动缩回。热插拔端到端闭环。
 */
export function inventoryPlugin(): Plugin {
  return {
    id: 'voxel.inventory',
    version: '0.3.0',
    meta: {
      label: '物品栏 / 快捷栏', category: 'gameplay', author: 'voxel-ts', badge: 'IV',
      description: '自动收集所有插件方块；1~9 选槽、滚轮切换、Q 翻页；新方块随插件热插拔自动出现',
    },
    provides: ['inventory'],
    dependencies: ['cap:blocks'],
    priority: 22,

    setup(ctx): void {
      const { scope, services } = ctx;
      const inv = services.get(INVENTORY);
      const game = services.tryGet(GAME_STATE);

      const publish = (): void => {
        const cur = inv.current();
        scope.emit('inventory:changed', {
          selected: inv.selected,
          blockId: cur?.blockId ?? 0,
          label: cur?.label ?? '—',
          page: inv.page,
          total: inv.total,
        });
      };
      scope.track(inv.onChange(publish));

      const rebuild = (): void => inv.rebuild(ctx.blocks);
      rebuild();
      scope.on('plugin:loaded', rebuild);
      scope.on('plugin:unloaded', rebuild);
      scope.on('world:loaded', rebuild);

      scope.update(() => {
        if (game?.paused) return;
        const wheel = ctx.input.consumeWheel();
        if (wheel !== 0) inv.scroll(wheel > 0 ? 1 : -1);
        for (const d of ctx.input.consumeDigits()) inv.select(d);
        if (ctx.input.consumeKey('KeyQ')) inv.nextPage(1);
      }, { phase: 'input' });

      ctx.log(`inventory ready: ${inv.total} placeable blocks / ${inv.pageCount} pages`);
    },
  };
}
