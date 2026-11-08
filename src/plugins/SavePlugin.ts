import { BinaryReader, BinaryWriter } from '../binary/BinaryBuffer';
import { toChunkCoord } from '../config';
import { DAY_CYCLE, FIRST_PERSON, GAME_STATE, SAVE_API, SAVE_STORE, type SaveApi } from '../core/tokens';
import type { Plugin } from '../core/types';
import type { GameMode } from '../core/GameState';

interface PlayerSnapshot {
  x: number; y: number; z: number;
  yaw: number; pitch: number;
  phase: number;
  mode: GameMode;
  flying: boolean;
  placed: number; broken: number;
}

function encodePlayer(v: PlayerSnapshot): ArrayBuffer {
  return new BinaryWriter()
    .u16(1)
    .f64(v.x).f64(v.y).f64(v.z)
    .f32(v.yaw).f32(v.pitch).f32(v.phase)
    .u8(v.mode === 'survival' ? 1 : 0)
    .u8(v.flying ? 1 : 0)
    .u32(v.placed).u32(v.broken)
    .finish();
}

function decodePlayer(buf: ArrayBuffer): PlayerSnapshot {
  const r = BinaryReader.from(buf);
  const version = r.u16();
  // v0.8：之前直接丢弃版本号，未来结构升级时会静默读成一份错位的玩家状态
  if (version !== 1) throw new Error(`[saves] 不支持的玩家段版本 ${version}`);
  return {
    x: r.f64(), y: r.f64(), z: r.f64(),
    yaw: r.f32(), pitch: r.f32(), phase: r.f32(),
    mode: r.u8() === 1 ? 'survival' : 'creative',
    flying: r.u8() === 1,
    placed: r.u32(), broken: r.u32(),
  };
}

/**
 * M4 存档落盘：世界体素走既有 TLV 信封，玩家状态作为插件私有二进制段一起写进去。
 * 主程序完全不认识这个段，这正是 v0.1 预留的「二进制接缝」兑现。
 */
export function savePlugin(): Plugin {
  return {
    id: 'voxel.saves',
    version: '0.3.0',
    meta: {
      label: '世界存档', category: 'gameplay', author: 'voxel-ts', badge: 'SV',
      description: 'IndexedDB 三槽位存/读档、自动存档、.bin 导入导出；玩家状态走私有二进制段',
    },
    provides: ['saves'],
    dependencies: ['cap:chunkView'],
    priority: 35,

    setup(ctx): void {
      const { scope, services } = ctx;
      const store = services.get(SAVE_STORE);
      const ctrl = services.get(FIRST_PERSON);
      const cycle = services.get(DAY_CYCLE);
      const game = services.get(GAME_STATE);

      const tag = scope.binary(1, {
        name: 'voxel.saves/player',
        encode: encodePlayer,
        decode: decodePlayer,
        snapshot: (): PlayerSnapshot => ({
          x: ctrl.feet.x, y: ctrl.feet.y, z: ctrl.feet.z,
          yaw: ctrl.yaw, pitch: ctrl.pitch, phase: cycle.phase,
          mode: game.mode, flying: ctx.input.state.flying,
          placed: game.stats.placed, broken: game.stats.broken,
        }),
      });

      const restore = (buf: ArrayBuffer): void => {
        const entry = ctx.binary.decode(buf).find((e) => e.tag === tag);
        if (!entry) return;
        const s = decodePlayer(entry.payload);
        ctrl.feet.set(s.x, s.y, s.z);
        ctrl.yaw = s.yaw;
        ctrl.pitch = s.pitch;
        cycle.setPhase(s.phase);
        game.setMode(s.mode);
        ctx.input.allowFly = s.mode === 'creative';
        ctx.input.state.flying = s.mode === 'creative' && s.flying;
        game.stats.placed = s.placed;
        game.stats.broken = s.broken;
        // v0.6：读档位置可能远离当前窗口，立刻滑过去，避免玩家站在尚未加载的
        // chunk 上被贴地逻辑拽到虚空高度（等下一帧插件轮询就晚了）。
        if (ctx.world.streamInfo.enabled) {
          ctx.world.updateStreaming(toChunkCoord(s.x), toChunkCoord(s.z));
        }
      };

      const api: SaveApi = {
        async save(slot, name = `世界 ${slot + 1}`) {
          const buf = ctx.world.toEnvelope(ctx.binary, ctx.binary.snapshot());
          await store.write(slot, name, buf);
          scope.emit('save:changed', { slot, action: 'saved', bytes: buf.byteLength });
          ctx.log(`saved slot ${slot}: ${(buf.byteLength / 1024).toFixed(1)} KB`);
        },
        async load(slot) {
          const buf = await store.read(slot);
          if (!buf) return false;
          ctx.world.fromEnvelope(ctx.binary, buf);
          restore(buf);
          scope.emit('save:changed', { slot, action: 'loaded', bytes: buf.byteLength });
          scope.emit('game:toast', { text: `已读取存档 ${slot + 1}`, kind: 'good' });
          return true;
        },
        async remove(slot) {
          await store.remove(slot);
          scope.emit('save:changed', { slot, action: 'deleted', bytes: 0 });
        },
        async list() { return store.list(); },
        async export(slot) {
          const buf = await store.read(slot);
          if (buf) store.download(`voxel-world-${slot + 1}.bin`, buf);
        },
        async import(file, slot) {
          const buf = await store.upload(file);
          // 先校验信封，避免把坏文件写进槽位
          ctx.binary.decode(buf);
          await store.write(slot, '导入的世界', buf);
          scope.emit('save:changed', { slot, action: 'saved', bytes: buf.byteLength });
          scope.emit('game:toast', { text: '导入成功，可在槽位读取', kind: 'good' });
        },
      };
      scope.service(SAVE_API, api);

      let timer = 0;
      scope.update((dt) => {
        if (game.paused || !game.settings.autoSave) return;
        timer += dt;
        if (timer >= 90) {
          timer = 0;
          void api.save(0, '自动存档').catch((err: unknown) => {
            console.warn('[saves] auto-save failed', err);
          });
        }
      }, { phase: 'late', priority: 60, every: 4 });

      ctx.log(`save store backend=${store.backend} player segment tag=0x${tag.toString(16)}`);
    },
  };
}
