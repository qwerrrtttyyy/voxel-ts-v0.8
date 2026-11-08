/* 独立复现实验：不复用项目自带断言，专门找缺陷 */
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
import { BinaryHub, pluginTag, ENVELOPE_MAGIC } from '../src/binary/BinaryHub';
import { BinaryWriter } from '../src/binary/BinaryBuffer';
import { CHUNK_TAG } from '../src/binary/ChunkCodec';
import { TextureAtlas, type TilePainter } from '../src/render/TextureAtlas';
import { BlockRegistry, AIR_ID } from '../src/world/BlockRegistry';
import { World } from '../src/world/World';
import { CulledMesher } from '../src/world/mesher/CulledMesher';
import { raycastVoxel } from '../src/player/Raycast';
import type { IGenerator } from '../src/world/IGenerator';

// ---- DOM stub ----
const el = (): any => ({
  textContent: '', classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {}, removeEventListener() {}, requestPointerLock() {}, style: {},
});
(globalThis as any).document = {
  getElementById: () => el(), addEventListener() {}, removeEventListener() {}, pointerLockElement: null,
};
(globalThis as any).window = {
  addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 800, innerHeight: 600,
};
const paint: TilePainter = (set, s) => { for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) set(x, y, 9, 9, 9); };
const flat = (id: number): IGenerator => ({ id: 'flat', surfaceY: () => 5, blockAt: (_x, y, _z, s) => y <= s ? id : AIR_ID });

function section(n: number, title: string) { console.log(`\n[实验 ${n}] ${title}`); }

// ===== 1. 主循环回调抛错 → 整个游戏永久冻结 =====
section(1, 'Engine 回调抛错是否会导致主循环永久停止');
{
  let rafCb: ((t: number) => void) | null = null;
  let rafCount = 0;
  (globalThis as any).requestAnimationFrame = (cb: (t: number) => void) => { rafCb = cb; rafCount++; return rafCount; };
  (globalThis as any).cancelAnimationFrame = () => { rafCb = null; };

  const eng = new Engine(1 / 60);
  let calls = 0;
  eng.onUpdate(() => { calls++; throw new Error('第三方插件 update 抛错'); });
  eng.start();
  rafCb!(0);            // 建立时基，正常调度下一帧
  const before = rafCount;
  let escaped = '';
  try { rafCb!(100); } catch (e) { escaped = (e as Error).message; }
  console.log(`  抛错前已调度帧数 = ${before}, 抛错后已调度帧数 = ${rafCount}`);
  console.log(`  异常逃逸到 rAF 之外 = ${JSON.stringify(escaped)}`);
  console.log(`  engine 仍标记 running = ${(eng as any).running}, 但再无新帧被调度 => ${rafCount === before ? '主循环永久冻结（确认）' : '仍存活'}`);
  eng.stop();
}

// ===== 2. EventBus 单个监听器抛错 → 后续监听器不执行 =====
section(2, 'EventBus 单个监听器抛错是否中断其余监听器');
{
  const bus = new EventBus();
  let reached = 0;
  bus.on('block:changed', () => { reached++; throw new Error('bad listener'); });
  bus.on('block:changed', () => { reached++; });
  bus.on('block:changed', () => { reached++; });
  let err = '';
  try { bus.emit('block:changed', { x: 0, y: 0, z: 0, oldId: 0, newId: 1 }); } catch (e) { err = (e as Error).message; }
  console.log(`  3 个监听器中实际执行 = ${reached}, 异常冒泡 = ${JSON.stringify(err)}`);
  console.log(`  结论: ${reached < 3 ? '首个监听器抛错即吞掉后续订阅者（确认）' : '隔离良好'}`);
}

// ===== 3. 卸载方块插件 → 世界体素 id 悬空 / 复用后"幽灵替换" =====
section(3, '卸载方块插件后世界体素数据的 id 一致性');
{
  const blocks = new BlockRegistry();
  const events = new EventBus();
  const world = new World(blocks, events);
  const stone = blocks.define('pack.a', 'stone', { opaque: true, solid: true, all: 'x' });
  world.setGenerator(flat(stone));
  world.pregenerate();
  const voxelId = world.getBlock(3, 3, 3);
  console.log(`  生成时该体素 id=${voxelId}, 定义=${blocks.get(voxelId).name}`);

  blocks.release(stone); // 模拟 scope.block 在 unmount/reload 时自动释放
  console.log(`  卸载插件后同一体素 id=${voxelId}, 定义=${blocks.get(voxelId).name}  <-- 定义凭空消失`);

  const lava = blocks.define('pack.b', 'lava', { opaque: true, solid: true, all: 'y' });
  console.log(`  新插件复用 id=${lava} 后, 旧体素定义=${blocks.get(voxelId).name}`);
  console.log(`  结论: ${blocks.get(voxelId).name === 'pack.b:lava' ? '整片旧地形被静默改写成新方块（确认）' : '未复现'}`);
}

// ===== 4. 射线拾取忽略非 opaque 方块（玻璃/水点不中） =====
section(4, 'raycast 能否命中 non-opaque 方块');
{
  const blocks = new BlockRegistry();
  const events = new EventBus();
  const world = new World(blocks, events);
  const glass = blocks.define('g', 'glass', { opaque: false, solid: true, all: 't' });
  world.setGenerator({ id: 'g', surfaceY: () => 5, blockAt: (_x, y) => y === 5 ? glass : AIR_ID });
  world.pregenerate();
  const solidAtFeet = world.getBlock(0, 5, 0);
  const hit = raycastVoxel(new THREE.Vector3(0.5, 8, 0.5), new THREE.Vector3(0, -1, 0), 10, world, blocks);
  console.log(`  (0,5,0) 实际方块 id=${solidAtFeet} (${blocks.get(solidAtFeet).name})`);
  console.log(`  从上方垂直向下射线命中 = ${hit ? JSON.stringify({ x: hit.x, y: hit.y, z: hit.z, id: hit.id }) : 'null'}`);
  console.log(`  结论: ${hit === null ? '玻璃/水完全无法拾取，M2 挖放对此类方块失效（确认）' : '可命中'}`);
}

// ===== 5. mesher 对相邻透明方块不剔除内部面 =====
section(5, '相邻 non-opaque 方块之间的内部面');
{
  const blocks = new BlockRegistry();
  const events = new EventBus();
  const world = new World(blocks, events);
  const atlas = new TextureAtlas();
  const tile = atlas.define('g', 'glass', paint);
  const glass = blocks.define('g', 'glass', { opaque: false, solid: true, all: tile });
  world.setGenerator({ id: 'empty', surfaceY: () => -1, blockAt: () => AIR_ID });
  world.pregenerate();
  world.setBlock(8, 5, 8, glass);
  world.setBlock(9, 5, 8, glass);
  const mesh = new CulledMesher().build(world.getChunk(0, 0)!, world, { blocks, atlas });
  const faces = mesh.indices.length / 6;
  console.log(`  2 个相邻玻璃方块生成面数 = ${faces} (理论外露面 = 10, 内部面 = 2)`);
  console.log(`  结论: ${faces === 12 ? '内部面未剔除，多出 2 个重叠面 → 过度绘制 / 透明排序错乱（确认）' : '面数 ' + faces}`);
}

// ===== 6. 二进制存档只有导出、没有导入；版本硬拒 =====
section(6, '二进制存档链路的完整性');
{
  const worldProto = Object.getOwnPropertyNames(World.prototype);
  const hasLoader = worldProto.some((m) => /envelope|load|restore|from/i.test(m));
  console.log(`  World 的方法: ${worldProto.join(', ')}`);
  console.log(`  含存档装载方法 = ${hasLoader}  <-- toEnvelope 存在但无逆路径`);

  const hub = new BinaryHub();
  const w = new BinaryWriter().u32(ENVELOPE_MAGIC).u16(2).u16(0);
  let msg = '';
  try { hub.decode(w.finish()); } catch (e) { msg = (e as Error).message; }
  console.log(`  version=2 信封解码 = ${JSON.stringify(msg)}  <-- 旧存档无法读取，无迁移路径`);

  const d = new BinaryWriter().u32(ENVELOPE_MAGIC).u16(1).u16(1).u16(CHUNK_TAG).u32(1).u8(0xab);
  let alignErr = '';
  try { hub.decode(d.finish()); } catch (e) { alignErr = (e as Error).message; }
  console.log(`  末尾未补齐 4 字节对齐的信封解码 = ${alignErr || '通过（align4 越界未校验）'}`);
}

// ===== 7. FNV-16 tag 碰撞：合法插件无法共存 =====
section(7, 'pluginTag 16 位哈希碰撞与 claimTag 无回退');
{
  const seen = new Map<number, string>();
  let a = '', b = '', tag = -1;
  for (let i = 0; i < 20000; i++) {
    const id = `pack.extension.${i}`;
    const t = pluginTag(id, 0);
    if (seen.has(t)) { a = seen.get(t)!; b = id; tag = t; break; }
    seen.set(t, id);
  }
  console.log(`  找到碰撞: "${a}" 与 "${b}" 均派生 tag=0x${tag.toString(16)}`);
  const hub = new BinaryHub();
  hub.claimTag(a, 0);
  let rejected = '';
  try { hub.claimTag(b, 0); } catch (e) { rejected = (e as Error).message; }
  console.log(`  第二个插件 claimTag = ${JSON.stringify(rejected)}`);
  console.log(`  结论: ${rejected ? '两个合法第三方插件因哈希碰撞无法共存，且无重哈希/协商回退（确认）' : '无碰撞'}`);
}

// ===== 8. ServiceRegistry 无值去重 → 重复全量重建 =====
section(8, '策略注册是否按值去重');
{
  const reg = new ServiceRegistry();
  const T = new ServiceToken<number>('test.generator');
  let notifications = 0;
  reg.onChange(T, () => notifications++);
  const same = { id: 'gen-v1' } as unknown as number;
  const off1 = reg.provide(T, same, { priority: 10 });
  const off2 = reg.provide(T, same, { priority: 10 });
  const off3 = reg.provide(T, same, { priority: 10 });
  console.log(`  同一个生成器实例连续注册 3 次, onChange 触发 = ${notifications} 次`);
  console.log(`  结论: ${notifications === 3 ? '无值去重，每次 provide 都触发世界全量重建（确认）' : '有去重'}`);
  off1(); off2(); off3();
}

// ===== 9. unmount 中 dispose 抛错 → 级联卸载中断、状态残留 =====
section(9, '插件 dispose 抛错对级联卸载的影响');
{
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const renderer: any = { render() {} };
  const events = new EventBus();
  const engine = new Engine(1 / 60);
  const input = new Input(el());
  const ui = new Ui();
  const blocks = new BlockRegistry();
  const world = new World(blocks, events);
  const atlas = new TextureAtlas();
  const binary = new BinaryHub();
  const wasm = new WasmHost();
  const services = new ServiceRegistry();
  const config = new ConfigStore();
  const deps = { events, engine, services, config, blocks, atlas, binary };
  let ctx!: PluginContext;
  const host = new PluginHost(() => ctx, deps);
  ctx = {
    scene, camera, renderer, events, input, engine, ui,
    blocks, world, atlas, binary, wasm, services, config,
    scope: null as any, pluginId: 'core', cfg: config.namespace('core'),
    host: host as IPluginHost, capabilities: (n: string) => host.capabilities(n),
    log: () => {},
  };
  const bad: Plugin = {
    id: 'pack.bad', version: '1.0.0', provides: ['cap.a'],
    setup() {}, dispose() { throw new Error('第三方 dispose 抛错'); },
  };
  const dependent: Plugin = {
    id: 'pack.dependent', version: '1.0.0', dependencies: ['cap:cap.a'],
    setup() {},
  };
  (async () => {
    host.useMany([bad, dependent]);
    await host.boot();
    let err = '';
    try { await host.unmount('pack.bad'); } catch (e) { err = (e as Error).message; }
    console.log(`  unmount 抛错 = ${JSON.stringify(err)}`);
    console.log(`  unmount 后 pack.bad 仍在 loaded = ${host.isLoaded('pack.bad')}`);
    console.log(`  结论: ${host.isLoaded('pack.bad') ? '级联卸载中途崩溃，宿主状态不一致（确认）' : '状态干净'}`);
  })();
}
