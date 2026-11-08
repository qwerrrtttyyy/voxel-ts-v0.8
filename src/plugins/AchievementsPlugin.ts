import { GAME_STATE } from '../core/tokens';
import { definePlugin } from '../core/definePlugin';

interface Milestone { at: number; key: string; text: string }

const BREAKS: readonly Milestone[] = [
  { at: 1, key: 'first-break', text: '成就 · 第一锹：破坏 1 个方块' },
  { at: 10, key: 'break-10', text: '成就 · 拆迁办：破坏 10 个方块' },
  { at: 50, key: 'break-50', text: '成就 · 移山填海：破坏 50 个方块' },
];
const PLACES: readonly Milestone[] = [
  { at: 1, key: 'first-place', text: '成就 · 建筑师：放置 1 个方块' },
  { at: 25, key: 'place-25', text: '成就 · 营造司：放置 25 个方块' },
  { at: 100, key: 'place-100', text: '成就 · 造物主：放置 100 个方块' },
];

/** 轻量目标感：里程碑 toast + 首次入夜提示，全部由事件驱动，可整包关掉 */
export function achievementsPlugin() {
  return definePlugin({
    id: 'voxel.achievements',
    version: '0.3.0',
    meta: {
      label: '成就与目标', category: 'gameplay', author: 'voxel-ts', badge: 'AC',
      description: '挖掘 / 建造里程碑提示与首次入夜提示；纯事件驱动，可关闭',
    },
    provides: ['achievements'],
    priority: 50,

    setup(ctx): void {
      const { scope, services } = ctx;
      const game = services.get(GAME_STATE);

      const grant = (key: string, text: string): void => {
        if (game.stats.achievements.includes(key)) return;
        game.stats.achievements.push(key);
        scope.emit('game:toast', { text, kind: 'achievement' });
      };

      const check = (phase: 'broken' | 'placed'): void => {
        const value = game.stats[phase];
        const list = phase === 'broken' ? BREAKS : PLACES;
        for (const m of list) if (value >= m.at) grant(m.key, m.text);
      };

      scope.on('stats:changed', (e) => {
        game.stats.broken = e.broken;
        game.stats.placed = e.placed;
        check('broken');
        check('placed');
      });

      let wasNight = false;
      scope.on('time:changed', (e) => {
        const night = e.daylight < 0.4;
        if (night && !wasNight) grant('first-night', '夜幕降临 · 抬头看看星空和月亮');
        wasNight = night;
      });
    },
  });
}
