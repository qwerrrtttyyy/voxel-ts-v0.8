/* 独立复审发现的缺陷 → 回归断言。不复用业务自检的装配，全部可复现。 */
import * as THREE from 'three';
import { EventBus } from '../src/core/EventBus';
import { Engine } from '../src/core/Engine';
import { ServiceRegistry, ServiceToken } from '../src/core/ServiceRegistry';
import { ConfigStore } from '../src/core/ConfigStore';
import { Input } from '../src/core/Input';
import { Ui } from '../src/core/Ui';
import { PluginHost } from '../src/core/PluginHost';
import type { IPluginHost, Plugin, PluginContext } from '../src/core/types';
import { WasmHost } from '../src/binary/WasmHost';
import { BinaryHub, pluginTag, ENVELOPE_MAGIC, ENVELOPE_VERSION } from '../src/binary/BinaryHub';
import { BinaryWriter } from '../src/binary/BinaryBuffer';
import { TextureAtlas, type TilePainter } from '../src/render/TextureAtlas';
import { BlockRegistry, AIR_ID } from '../src/world/BlockRegistry';
import { World } from '../src/world/World';
import { CulledMesher } from '../src/world/mesher/CulledMesher';
import { raycastVoxel } from '../src/player/Raycast';

const results: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  · ' + detail : ''}`);
  if (!cond) process.exitCode = 1;
}
/** 静音预期的错误日志，保持验收输出干净 */
function quiet<T>(fn: () => T): T {
  const orig = console.error;
  const warn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  try { return fn(); } finally { console.error = orig; console.warn = warn; }
}

// ---- 最小 DOM / rAF ----
function el(): any {
  return {
    textContent: '', classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, removeEventListener() {}, requestPointerLock() {}, style: {},
  };
}
(globalThis as any).document = {
  getElementById: () => el(), addEventListener() {}, removeEventListener() {}, pointerLockElement: null,
};
(globalThis as any).window = {
  addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 800, innerHeight: 600,
};
let rafCb: ((t: number) => void) | null = null;
let rafCount = 0;
(globalThis as any).requestAnimationFrame = (cb: (t: number) => void): number => {
  rafCb = cb; rafCount++; return rafCount;
};
(globalThis as any).cancelAnimationFrame = (): void => { rafCb = null; };

const paint: TilePainter = (set, s) => {
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) set(x, y, 9, 9, 9);
};
const flatGen = (id: number) => ({
  id: 'flat',
  surfaceY: () => 5,
  blockAt: (_x: number, y: number, _z: number, s: number) => y <= s ? id : AIR_ID,
});

async function main(): Promise<void> {
  // ===== 1. 主循环异常隔离（原：一个插件抛错 → 永久冻结）=====
  {
    const eng = new Engine(1 / 60);
    let calls = 0;
    eng.onUpdate(() => { calls++; throw new Error('plugin bug'); });
    quiet(() => {
      eng.start();
      rafCb!(0);
      const before = rafCount;
      rafCb!(100);
      rafCb!(200);
      ok('回调抛错后主循环仍继续调度（不再永久冻结）', rafCount > before && calls >= 2,
        `raf=${before}→${rafCount} calls=${calls} isolated=${eng.errorCount}`);
    });
    eng.stop();
  }

  // ===== 2. 事件总线监听器隔离 =====
  {
    const bus = new EventBus();
    let reached = 0;
    bus.on('block:changed', () => { reached++; throw new Error('bad listener'); });
    bus.on('block:changed', () => { reached++; });
    bus.on('block:changed', () => { reached++; });
    quiet(() => bus.emit('block:changed', { x: 0, y: 0, z: 0, oldId: 0, newId: 1 }));
    ok('首个监听器抛错不影响其余订阅者', reached === 3, `reached=${reached}/3`);
  }

  // ===== 3. 方块 id 释放 → 世界数据一致性（原：幽灵替换）=====
  {
    const blocks = new BlockRegistry();
    const world = new World(blocks, new EventBus());
    const stone = blocks.define('pack.a', 'stone', { opaque: true, solid: true, all: 'x' });
    world.setGenerator(flatGen(stone));
    world.pregenerate();
    const before = world.getBlock(3, 3, 3);
    blocks.release(stone);
    const after = world.getBlock(3, 3, 3);
    ok('卸载方块插件后世界体素被清洗为空气', before === stone && after === AIR_ID,
      `${before} → ${after}`);

    const lava = blocks.define('pack.b', 'lava', { opaque: true, solid: true, all: 'y' });
    ok('新插件复用同 id 不会把旧地形改写为新方块',
      lava === stone && world.getBlock(3, 3, 3) === AIR_ID, `reused id=${lava}`);
    ok('世界边界来自实际已生成 chunk', world.bounds.minX === 0 && world.bounds.maxX === 96,
      `bounds=[${world.bounds.minX},${world.bounds.maxX}]`);
  }

  // ===== 4. 射线可命中 non-opaque 方块（M2 挖/放前提）=====
  {
    const blocks = new BlockRegistry();
    const world = new World(blocks, new EventBus());
    const glass = blocks.define('g', 'glass', { opaque: false, solid: true, all: 't' });
    world.setGenerator({
      id: 'g', surfaceY: () => 5,
      blockAt: (_x: number, y: number) => y === 5 ? glass : AIR_ID,
    });
    world.pregenerate();
    const hit = raycastVoxel(
      new THREE.Vector3(0.5, 8, 0.5), new THREE.Vector3(0, -1, 0), 10, world, blocks,
    );
    ok('玻璃 / 水等非 opaque 方块可被射线拾取', !!hit && hit.id === glass,
      hit ? `hit id=${hit.id} @${hit.y}` : 'null');
  }

  // ===== 5. 相邻透明方块内部面剔除 =====
  {
    const blocks = new BlockRegistry();
    const world = new World(blocks, new EventBus());
    const atlas = new TextureAtlas();
    const tile = atlas.define('g', 'glass', paint);
    const glass = blocks.define('g', 'glass', { opaque: false, solid: true, all: tile });
    world.setGenerator({ id: 'empty', surfaceY: () => -1, blockAt: () => AIR_ID });
    world.pregenerate();
    world.setBlock(8, 5, 8, glass);
    world.setBlock(9, 5, 8, glass);
    const mesh = new CulledMesher().build(world.getChunk(0, 0)!, world, { blocks, atlas });
    const faces = mesh.indices.length / 6;
    ok('相邻玻璃只生成 10 个外露面（内部重叠面已剔除）', faces === 10, `faces=${faces}`);
  }

  // ===== 6. 存档闭环：导出 → 装载 =====
  {
    const blocks = new BlockRegistry();
    const world = new World(blocks, new EventBus());
    const grass = blocks.define('g', 'grass', { opaque: true, solid: true, all: 'x' });
    world.setGenerator(flatGen(grass));
    world.pregenerate();
    const hub = new BinaryHub();
    const envelope = world.toEnvelope(hub);

    const target = new World(new BlockRegistry(), new EventBus());
    const res = target.fromEnvelope(hub, envelope);
    let same = res.chunks === 36 && target.keys().length === 36;
    for (const key of world.keys()) {
      const a = world.getChunk(...key.split(',').map(Number) as [number, number]);
      const b = target.getChunk(...key.split(',').map(Number) as [number, number]);
      if (!a || !b || !a.data.every((v, i) => v === b.data[i])) { same = false; break; }
    }
    ok('toEnvelope → fromEnvelope 世界逐体素一致', same,
      `chunks=${res.chunks} segments=${res.segments} unknown=${res.unknown}`);

    const broken = new Uint8Array(envelope.slice(0));
    broken[broken.length - 5] ^= 0xff;
    let crcRejected = false;
    try { hub.decode(broken.buffer); } catch { crcRejected = true; }
    ok('CRC32 能检出被篡改 / 损坏的存档', crcRejected);

    const legacy = new BinaryWriter().u32(ENVELOPE_MAGIC).u16(1).u16(0).finish();
    ok('无 CRC 的旧格式信封仍可读取（向后兼容）', hub.decode(legacy).length === 0);
    // v0.6 起当前版本是 2，「未来版本」必须相对 ENVELOPE_VERSION 构造
    const future = new BinaryWriter().u32(ENVELOPE_MAGIC).u16(ENVELOPE_VERSION + 1).u16(0).finish();
    let futureRejected = false;
    try { hub.decode(future); } catch { futureRejected = true; }
    ok('未来版本信封被明确拒绝并提示升级', futureRejected);
    ok('v1 存档经迁移器升级后可读', hub.decode(
      new BinaryWriter().u32(ENVELOPE_MAGIC).u16(1).u16(0).finish(),
    ).length === 0);
  }

  // ===== 7. 16 位 tag 碰撞自动回退 =====
  {
    const seen = new Map<number, string>();
    let a = '', b = '';
    for (let i = 0; i < 10000; i++) {
      const id = `pack.extension.${i}`;
      const t = pluginTag(id, 0);
      if (seen.has(t)) { a = seen.get(t)!; b = id; break; }
      seen.set(t, id);
    }
    const hub = new BinaryHub();
    const t1 = hub.claimTag(a, 0);
    const t2 = hub.claimTag(b, 0);
    ok('FNV-16 碰撞时线性探测，两个合法插件可共存', a !== '' && t1 !== t2,
      `${a}=0x${t1.toString(16)} / ${b}=0x${t2.toString(16)}`);
    ok('同插件重复申领 tag 幂等', hub.claimTag(a, 0) === t1);
  }

  // ===== 8. 服务通知按生效值去重 =====
  {
    const reg = new ServiceRegistry();
    const T = new ServiceToken<number>('regression.token');
    let notifications = 0;
    reg.onChange(T, () => notifications++);
    const off1 = reg.provide(T, 1, { priority: 10 });
    const off2 = reg.provide(T, 1, { priority: 10 });
    const off3 = reg.provide(T, 1, { priority: 10 });
    ok('同值重复 provide 不触发多余全量重建', notifications === 1, `notifications=${notifications}`);
    off1(); off2(); off3();
  }

  // ===== 9. dispose 抛错不破坏宿主状态 =====
  {
    const scene = new THREE.Scene();
    const events = new EventBus();
    const engine = new Engine(1 / 60);
    const blocks = new BlockRegistry();
    const world = new World(blocks, events);
    const services = new ServiceRegistry();
    const config = new ConfigStore();
    const atlas = new TextureAtlas();
    const binary = new BinaryHub();
    const deps = { events, engine, services, config, blocks, atlas, binary };
    let ctx!: PluginContext;
    const host = new PluginHost(() => ctx, deps);
    ctx = {
      scene, camera: new THREE.PerspectiveCamera(), renderer: {} as any,
      events, input: new Input(el()), engine, ui: new Ui(),
      blocks, world, atlas, binary, wasm: new WasmHost(), services, config,
      scope: null as any, pluginId: 'core', cfg: config.namespace('core'),
      host: host as IPluginHost, capabilities: (n: string) => host.capabilities(n), log: () => {},
    };
    const bad: Plugin = {
      id: 'pack.bad', version: '1.0.0', provides: ['cap.a'],
      setup() {}, dispose() { throw new Error('dispose boom'); },
    };
    const dependent: Plugin = {
      id: 'pack.dependent', version: '1.0.0',
      dependencies: ['cap:cap.a'], setup() {},
    };
    host.useMany([bad, dependent]);
    await host.boot();
    await quiet(() => host.unmount('pack.bad').catch(() => {}));
    ok('dispose 抛错后级联卸载仍完成、宿主状态干净',
      !host.isLoaded('pack.bad') && !host.isLoaded('pack.dependent'));
  }

  console.log('\n===== 缺陷修复回归验收 =====');
  console.log(results.join('\n'));
  console.log(`\n结果：${results.filter((r) => r.startsWith('PASS')).length}/${results.length} 通过`);
}

void main().catch((e) => { console.error('REGRESSION CRASH', e); process.exit(1); });
