import * as THREE from 'three';
import {
  BREAK_INTERVAL, CHUNK_SIZE, PLAYER_HEIGHT, PLAYER_RADIUS, REACH, WORLD_CHUNKS,
} from '../config';
import { DAY_CYCLE, FIRST_PERSON, GAME_STATE, INVENTORY, RETICLE, SELECTION, type ReticleTarget } from '../core/tokens';
import type { Plugin } from '../core/types';
import type { VoxelHit } from '../player/Raycast';
import { raycastVoxel } from '../player/Raycast';
import { AIR_ID } from '../world/BlockRegistry';
import { BlockParticles } from '../render/Particles';
import { createSelection } from '../render/Selection';

/**
 * M2 核心：左键破坏 / 右键放置，复用 Raycast 返回的命中面法线。
 * 同时负责准星高亮、破坏粒子、放置时禁止塞进玩家身体、模式切换与重生。
 * 所有反馈都是独立可关的，关掉本插件世界就回到「只能看」的 v0.2。
 */
export function interactionPlugin(): Plugin {
  return {
    id: 'voxel.interaction',
    version: '0.3.0',
    meta: {
      label: '挖 / 放方块', category: 'gameplay', author: 'voxel-ts', badge: 'IN',
      description: '左键破坏、右键放置、选中框高亮、破坏粒子、F 切模式、R 重生、T 跳时段',
    },
    provides: ['interaction', 'selection'],
    dependencies: ['cap:firstPerson', 'cap:chunkView'],
    priority: 40,

    setup(ctx): void {
      const { scope, services } = ctx;
      const ctrl = services.get(FIRST_PERSON);
      const inv = services.get(INVENTORY);
      const game = services.get(GAME_STATE);
      const cycle = services.get(DAY_CYCLE);

      const selection = createSelection(ctx.scene);
      const particles = new BlockParticles(ctx.scene);
      scope.service(SELECTION, selection);
      // v0.6：全场唯一一次准星射线，HUD / 其它消费者只读这个稳定对象
      const reticle: ReticleTarget = { hit: null };
      scope.service(RETICLE, reticle);
      scope.track(() => selection.dispose());
      scope.track(() => particles.dispose());

      const dir = new THREE.Vector3();
      let hit: VoxelHit | null = null;
      let breakTimer = 0;
      let placeTimer = 0;
      let lastStats = 0;
      const lastPos = ctrl.feet.clone();

      /** 从 atlas tile 取平均色，粒子颜色跟着被破坏的方块走 */
      const colorOf = (id: number): [number, number, number] => {
        const def = ctx.blocks.get(id);
        const key = def.all ?? def.faces?.top ?? def.faces?.north ?? null;
        const px = key ? ctx.atlas.tilePixels(key) : null;
        if (!px) return [0.62, 0.62, 0.62];
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < px.length; i += 4) {
          if (px[i + 3] < 128) continue;
          r += px[i]; g += px[i + 1]; b += px[i + 2]; n++;
        }
        return n ? [r / n / 255, g / n / 255, b / n / 255] : [0.62, 0.62, 0.62];
      };

      const overlapsPlayer = (x: number, y: number, z: number): boolean => {
        const f = ctrl.feet;
        return x < f.x + PLAYER_RADIUS && x + 1 > f.x - PLAYER_RADIUS
          && y < f.y + PLAYER_HEIGHT && y + 1 > f.y
          && z < f.z + PLAYER_RADIUS && z + 1 > f.z - PLAYER_RADIUS;
      };

      const doBreak = (): void => {
        if (!hit || hit.id === AIR_ID) return;
        const { x, y, z, id } = hit;
        if (!ctx.world.setBlock(x, y, z, AIR_ID)) return;
        scope.emit('block:broken', { x, y, z, blockId: id, by: 'player' });
        game.addStat('broken');
        selection.pulse('break');
        if (game.settings.particles) particles.burst(x, y, z, colorOf(id));
      };

      const doPlace = (): void => {
        if (!hit || hit.fromInside) return;
        const item = inv.current();
        if (!item) return;
        const x = hit.x + hit.nx, y = hit.y + hit.ny, z = hit.z + hit.nz;
        if (overlapsPlayer(x, y, z)) return;
        const target = ctx.world.getBlock(x, y, z);
        if (target !== AIR_ID && !ctx.blocks.get(target).liquid) return;
        if (!ctx.world.setBlock(x, y, z, item.blockId)) return;
        scope.emit('block:placed', { x, y, z, blockId: item.blockId, by: 'player' });
        game.addStat('placed');
        selection.pulse('place');
      };

      scope.update((dt) => {
        selection.update(dt);
        particles.update(dt);
        particles.setVisible(game.settings.particles);

        ctx.camera.updateMatrixWorld();
        ctx.camera.getWorldDirection(dir);
        hit = raycastVoxel(ctx.camera.position, dir, REACH, ctx.world, ctx.blocks);
        reticle.hit = hit;
        selection.setHit(game.paused ? null : hit);

        game.addDistance(Math.hypot(ctrl.feet.x - lastPos.x, ctrl.feet.z - lastPos.z));
        lastPos.copy(ctrl.feet);

        if (!game.paused && game.started && performance.now() - lastStats > 500) {
          lastStats = performance.now();
          scope.emit('stats:changed', {
            placed: game.stats.placed,
            broken: game.stats.broken,
            distance: game.stats.distance,
          });
        }

        if (game.paused) { ctx.input.consumePress(); return; }
        const press = ctx.input.consumePress();
        breakTimer -= dt;
        placeTimer -= dt;

        if ((press.primary > 0 || ctx.input.state.attack) && breakTimer <= 0) {
          doBreak();
          breakTimer = BREAK_INTERVAL;
        }
        if ((press.secondary > 0 || ctx.input.state.use) && placeTimer <= 0) {
          doPlace();
          placeTimer = BREAK_INTERVAL;
        }

        if (ctx.input.consumeKey('KeyF')) {
          const next = game.mode === 'creative' ? 'survival' : 'creative';
          game.setMode(next);
          ctx.input.allowFly = next === 'creative';
          if (next === 'survival') ctx.input.state.flying = false;
          scope.emit('game:mode', { mode: next, flying: ctx.input.state.flying });
          scope.emit('game:toast', {
            text: next === 'creative' ? '创造模式 · 双击空格飞行' : '生存模式 · 重力生效',
            kind: 'info',
          });
        }
        if (ctx.input.consumeKey('KeyR')) {
          const c = (WORLD_CHUNKS * CHUNK_SIZE) / 2;
          ctrl.spawn(c + 0.5, c + 0.5);
          scope.emit('game:toast', { text: '已回到出生点', kind: 'info' });
        }
        if (ctx.input.consumeKey('KeyT')) {
          cycle.setPhase(cycle.phase + 0.25);
          scope.emit('game:toast', { text: `时间跳转到 ${cycle.clock()}`, kind: 'info' });
        }
      }, { phase: 'late', priority: 50 });

      ctx.log(`interaction ready: reach=${REACH} break=${BREAK_INTERVAL}s`);
    },
  };
}
