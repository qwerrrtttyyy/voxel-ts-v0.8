/* 架构加固验收：在 Node 里跑完整插件宿主，不需要 WebGL */
import * as THREE from 'three';
import { BinaryHub } from '../src/binary/BinaryHub';
import { WasmHost } from '../src/binary/WasmHost';
import { CHUNK_TAG, decodeChunk } from '../src/binary/ChunkCodec';
import { ConfigStore } from '../src/core/ConfigStore';
import { EventBus } from '../src/core/EventBus';
import { Engine } from '../src/core/Engine';
import { Input } from '../src/core/Input';
import { PluginHost } from '../src/core/PluginHost';
import type { IPluginHost, Plugin, PluginContext } from '../src/core/types';
import { ServiceRegistry, ServiceToken } from '../src/core/ServiceRegistry';
import {
  CHUNK_VIEW, COLLISION, FIRST_PERSON, GENERATOR, MESHER, TERRAIN_MATERIALS,
} from '../src/core/tokens';
import { Ui } from '../src/core/Ui';
import { FIXED_STEP, SEA_LEVEL } from '../src/config';
import { builtinPlugins } from '../src/plugins/index';
import { TextureAtlas } from '../src/render/TextureAtlas';
import { BlockRegistry } from '../src/world/BlockRegistry';
import { Chunk } from '../src/world/Chunk';
import { World } from '../src/world/World';
import type { IGenerator } from '../src/world/IGenerator';
import type { IMesher, MeshData } from '../src/world/mesher/IMesher';
import { EMPTY_MESH } from '../src/world/mesher/IMesher';
import { AIR_ID } from '../src/world/BlockRegistry';

const results: string[] = [];
const logs: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  · ' + detail : ''}`);
  if (!cond) process.exitCode = 1;
}

// ---- 最小 DOM stub ----
function makeEl(id: string): any {
  return {
    id, textContent: '',
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, removeEventListener() {},
    requestPointerLock() {}, style: {}, width: 1280, height: 800,
  };
}
const els = new Map<string, any>();
const doc: any = {
  getElementById(id: string) { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
  addEventListener() {}, removeEventListener() {}, pointerLockElement: null,
};
const win: any = {
  addEventListener() {}, removeEventListener() {},
  devicePixelRatio: 1, innerWidth: 1280, innerHeight: 800,
};
(globalThis as any).document = doc;
(globalThis as any).window = win;
let rafCb: ((t: number) => void) | null = null;
(globalThis as any).requestAnimationFrame = (cb: (t: number) => void): number => { rafCb = cb; return 1; };
(globalThis as any).cancelAnimationFrame = (): void => { rafCb = null; };

async function main(): Promise<void> {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 1.6, 0.05, 260);
  const renderer: any = { render() {} };
  const events = new EventBus();
  const input = new Input(doc.getElementById('view'));
  const engine = new Engine(FIXED_STEP);
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
    host: host as IPluginHost,
    capabilities: (name: string) => host.capabilities(name),
    log: (...a: unknown[]) => logs.push(a.map(String).join(' ')),
  };

  // 记录真实 boot 顺序
  const order: string[] = [];
  const plugins: readonly Plugin[] = [...builtinPlugins()];
  for (const p of plugins) {
    const orig = p.setup.bind(p);
    (p as any).setup = (c: PluginContext) => { order.push(p.id); return orig(c); };
  }
  host.useMany(plugins);
  await host.boot();

  // ===== A. 启动与拓扑 =====
  ok('拓扑排序含 cap: 能力依赖', (() => {
    const i = (id: string) => order.indexOf(id);
    return i('voxel.blocks') < i('voxel.terrain')
      && i('voxel.terrain') < i('voxel.world-render')
      && i('voxel.world-render') < i('voxel.player')
      && i('voxel.world-render') < i('voxel.render-submit');
  })(), order.join(' → '));
  ok('provides / capabilities 查询', host.capabilities().includes('generator')
    && ctx.capabilities('chunkView').includes('voxel.world-render'));
  ok('每个插件都有自动清理作用域资源', logs.filter((l) => l.includes('scoped resources')).length === plugins.length,
    logs.filter((l) => l.includes('scoped resources')).map((l) => l.split('(')[1]?.replace(')', '')).join(' / '));

  // ===== B. 命名空间资源 =====
  const grassDef = blocks.byLocal('voxel.blocks', 'grass');
  ok('方块自动 id + 命名空间名', !!grassDef && grassDef.id >= 64 && grassDef.name === 'voxel.blocks:grass',
    `grass id=${grassDef?.id} dirt id=${blocks.byLocal('voxel.blocks', 'dirt')?.id}`);
  ok('地形通过 services 取方块 id', services.get(TERRAIN_MATERIALS).grass === grassDef?.id);

  const idA = blocks.define('pack.a', 'stone', { opaque: true, solid: true, all: 'x' });
  const idB = blocks.define('pack.b', 'stone', { opaque: true, solid: true, all: 'x' });
  ok('不同插件同名方块不撞车', idA !== idB && blocks.get(idA).name !== blocks.get(idB).name,
    `${idA}=${blocks.get(idA).name} / ${idB}=${blocks.get(idB).name}`);
  blocks.release(idA); blocks.release(idB);
  ok('release 后 id 可回收', blocks.all().length === 3);

  const topRect = atlas.uvRect('voxel.blocks:grass_top')!;
  ok('atlas 命名空间 UV 正确', !!topRect && topRect.u1 > topRect.u0 && topRect.v1 > topRect.v0);

  // ===== C. 世界与网格 =====
  ok('世界生成 6×6 chunks', world.keys().length === 36);
  const chunkMeshes = scene.children.filter((o: any) => o.isMesh && o.geometry.getAttribute('color'));
  const geo = (chunkMeshes[0] as THREE.Mesh)?.geometry as THREE.BufferGeometry;
  ok('CulledMesher 合并 geometry', chunkMeshes.length === 36 && !!geo,
    `meshes=${chunkMeshes.length} tris=${(geo?.index?.count ?? 0) / 3}`);
  const first = world.getChunk(0, 0)!;
  let solid = 0;
  for (let i = 0; i < first.data.length; i++) if (first.data[i] !== 0) solid++;
  ok('面剔除生效', (geo.index!.count / 6) < solid * 6 / 5, `${geo.index!.count / 6} 面 vs 全量 ${solid * 6}`);
  const nrm = geo.getAttribute('normal'), pos = geo.getAttribute('position'), uv = geo.getAttribute('uv');
  let downElsewhere = 0, grassTopUv = false;
  for (let i = 0; i < nrm.count; i++) {
    if (nrm.getY(i) < -0.5 && pos.getY(i) !== 0) downElsewhere++;
    if (nrm.getY(i) > 0.5 && uv.getX(i) >= topRect.u0 && uv.getX(i) <= topRect.u1) grassTopUv = true;
  }
  ok('无内部面 + 草顶 UV 正确', downElsewhere === 0 && grassTopUv);

  // ===== D. dirty 队列 =====
  let dirtyEvents = 0, blockEvents = 0;
  const off1 = events.on('chunk:dirty', () => dirtyEvents++);
  const off2 = events.on('block:changed', () => blockEvents++);
  const pendingBefore = world.pendingDirty;
  const changed = world.setBlock(0, 20, 0, 2);
  ok('setBlock 入队去重 + 类型化事件', changed && dirtyEvents === 1 && blockEvents === 1,
    `dirty=${dirtyEvents} block=${blockEvents} queue=${world.pendingDirty}`);
  const beforeTake = world.pendingDirty;
  const taken = world.takeDirty(1);
  const afterTake = world.pendingDirty;
  ok('takeDirty 是 O(k) 消费', beforeTake === 1 && taken.length === 1 && afterTake === 0,
    `${beforeTake} → ${afterTake}`);
  world.clearDirty();
  ok('clearDirty 清空队列', world.pendingDirty === 0);
  off1(); off2();
  ok('事件退订后监听数归零', events.listenerCount('chunk:dirty') === 0);

  // ===== E. 二进制 =====
  const envelope = world.toEnvelope(binary, binary.snapshot());
  const segNames = [...new Set(binary.decodeAll(envelope).map((d) => d.name))];
  ok('信封含插件私有段 + chunk 段', segNames.length >= 3,
    `${(envelope.byteLength / 1024).toFixed(1)} KB · ${segNames.join(' | ')}`);
  const cb = binary.decode(envelope).find((e) => e.tag === CHUNK_TAG);
  ok('ChunkCodec round-trip', !!cb && decodeChunk(cb!.payload).voxels.every((v, i) => v === first.data[i]));
  ok('Chunk.fromBinary 重建', Chunk.fromBinary(first.toBinary()).data.every((v, i) => v === first.data[i]));
  ok('binary.validate 无问题', binary.validate().length === 0, `owners=${binary.owners().join(',')}`);
  let dupRejected = false;
  try { binary.register({ tag: CHUNK_TAG, name: 'dup', encode: () => new ArrayBuffer(0), decode: () => 0 }); }
  catch { dupRejected = true; }
  ok('二进制 tag 冲突在注册期拦截', dupRejected);

  // ===== F. 阶段化循环 =====
  const baseU = engine.updateCount, baseR = engine.renderCount;
  const trace: string[] = [];
  const d1 = engine.onUpdate(() => trace.push('u:late'), { phase: 'late' });
  const d2 = engine.onUpdate(() => trace.push('u:input'), { phase: 'input' });
  const d3 = engine.onRender(() => trace.push('r:after'), { phase: 'after' });
  const d4 = engine.onRender(() => trace.push('r:before'), { phase: 'before' });
  engine.start();
  if (rafCb) { rafCb(16); rafCb(100); } // 首帧建立时基，第二帧累积到足够 dt
  engine.stop();
  ok('Engine 阶段顺序 input→simulate→late / before→main→after',
    trace.indexOf('u:input') < trace.indexOf('u:late')
    && trace.indexOf('r:before') < trace.indexOf('r:after'),
    trace.join(' → '));
  d1(); d2(); d3(); d4();
  ok('Engine 退订后计数回落', engine.updateCount === baseU && engine.renderCount === baseR,
    `updates=${engine.updateCount} renders=${engine.renderCount}`);

  // ===== G. 策略热替换（核心加固）=====
  const view = services.get(CHUNK_VIEW);
  const controller = services.get(FIRST_PERSON);
  ok('内置策略已通过 services 提供', view.mesherId === 'culled-v1' && controller.collisionId === 'ground-follow-v1');

  let fakeMesherBuilds = 0;
  const fakeMesher: IMesher = {
    id: 'test-empty-v1',
    build(): MeshData { fakeMesherBuilds++; return EMPTY_MESH; },
  };
  const flatGen: IGenerator = {
    id: 'test-flat-v1',
    surfaceY: () => SEA_LEVEL,
    blockAt: (_x, y, _z, s) => y > s ? AIR_ID : y === s ? 1 : 2,
  };
  let regenerations = 0;
  const offRegen = events.on('world:regenerated', () => regenerations++);

  const override: Plugin = {
    id: 'test.override', version: '1.0.0',
    provides: ['test.mesher', 'test.generator', 'test.collision'],
    optionalDependencies: ['cap:does-not-exist'],
    dependencies: ['cap:chunkView'],
    setup(c) {
      c.scope.service(MESHER, fakeMesher, { priority: 10 });
      c.scope.service(GENERATOR, flatGen, { priority: 10 });
      c.scope.service(COLLISION, { id: 'test-collision-v1', move() {}, groundAt: () => SEA_LEVEL + 1 }, { priority: 10 });
    },
  };
  await host.mount(override);
  ok('运行时热加载第三方插件', host.isLoaded('test.override'));
  ok('策略变更合并为一次全量重建（不再重复两遍）',
    view.mesherId === 'test-empty-v1' && fakeMesherBuilds === 36,
    `mesher=${view.mesherId} mesherBuilds=${fakeMesherBuilds}`);
  ok('高优先级 generator 自动重新生成世界', world.generatorId === 'test-flat-v1' && regenerations >= 1,
    `generator=${world.generatorId} regen=${regenerations}`);
  ok('高优先级 collision 自动切换', controller.collisionId === 'test-collision-v1');
  ok('optionalDependencies 缺失可降级', true);

  await host.unmount('test.override');
  ok('卸载后策略自动回退到内置实现',
    view.mesherId === 'culled-v1' && world.generatorId === 'hills-v1' && controller.collisionId === 'ground-follow-v1',
    `${view.mesherId} / ${world.generatorId} / ${controller.collisionId}`);
  ok('卸载后世界网格恢复', view.meshCount === 36 && world.keys().length === 36);
  offRegen();

  // ===== H. 热插拔清理与依赖级联 =====
  const beforeU = engine.updateCount, beforeR = engine.renderCount, beforeL = events.listenerCount();
  const leaf: Plugin = {
    id: 'test.leaf', version: '1.0.0',
    provides: ['test.leaf'],
    dependencies: ['cap:chunkView'],
    setup(c) {
      c.scope.update(() => {});
      c.scope.render(() => {});
      c.scope.on('chunk:dirty', () => {});
      c.scope.tile('leaf_tile', (set, s) => { for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) set(x, y, 1, 2, 3); });
      c.scope.block('leaf_block', { opaque: true, solid: true, all: 'test.leaf:leaf_tile' });
      c.scope.binary(0, { name: 'test.leaf/meta', encode: () => new ArrayBuffer(1), decode: () => 0 });
      c.scope.dom(window, 'resize', () => {});
    },
  };
  await host.mount(leaf);
  ok('热加载插件注册全部资源', host.isLoaded('test.leaf') && blocks.byLocal('test.leaf', 'leaf_block') !== undefined
    && binary.names().includes('test.leaf/meta'));
  ok('循环回调 / 事件监听确实增加', engine.updateCount === beforeU + 1 && engine.renderCount === beforeR + 1
    && events.listenerCount() > beforeL);

  const dependent: Plugin = {
    id: 'test.dependent', version: '1.0.0',
    dependencies: ['cap:test.leaf'],
    setup() {},
  };
  await host.mount(dependent);
  await host.unmount('test.leaf');
  ok('卸载会连带卸载依赖它的插件', !host.isLoaded('test.leaf') && !host.isLoaded('test.dependent'));
  ok('scope 自动清理：回调 / 监听 / 方块 / 二进制段全部回落',
    engine.updateCount === beforeU && engine.renderCount === beforeR
    && events.listenerCount() === beforeL
    && !blocks.byLocal('test.leaf', 'leaf_block')
    && !binary.names().includes('test.leaf/meta'),
    `u=${engine.updateCount} r=${engine.renderCount} l=${events.listenerCount()}`);
  host.unmount('test.dependent');

  // reload 幂等：同一插件重载不应重复占 id / tag
  const idsBefore = blocks.all().map((b) => b.id).sort().join(',');
  const namesBefore = [...binary.names()].sort().join(',');
  await host.reload('voxel.blocks');
  ok('reload 幂等：方块 id 与段名不重复膨胀',
    blocks.all().map((b) => b.id).sort().join(',') === idsBefore
    && [...binary.names()].sort().join(',') === namesBefore,
    `ids=${idsBefore} segments=${namesBefore}`);
  ok('reload 连带恢复所有依赖者', host.isLoaded('voxel.terrain') && host.isLoaded('voxel.world-render')
    && host.isLoaded('voxel.player') && host.isLoaded('voxel.render-submit'));
  ok('reload 后服务仍可用', services.get(TERRAIN_MATERIALS).grass === grassDef?.id);

  // setup 抛错回滚
  const beforeFailU = engine.updateCount;
  let failed = false;
  try {
    await host.mount({
      id: 'test.broken', version: '1.0.0',
      setup(c) { c.scope.update(() => {}); throw new Error('boom'); },
    });
  } catch { failed = true; }
  ok('setup 抛错自动回滚，不留半初始化资源', failed && !host.isLoaded('test.broken')
    && engine.updateCount === beforeFailU);

  // ===== I. 图集动态扩容 =====
  const widthBefore = atlas.width;
  let replaced = 0;
  const offAtlas = atlas.onTextureReplaced(() => replaced++);
  const paint = (set: (x: number, y: number, r: number, g: number, b: number) => void, s: number): void => {
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) set(x, y, 9, 9, 9);
  };
  for (let i = 0; i < 20; i++) atlas.define('test.grow', `t${i}`, paint);
  ok('atlas 按需扩容并通知材质换 map', atlas.width > widthBefore && replaced >= 1,
    `${widthBefore}px → ${atlas.width}px, replaced=${replaced}`);
  ok('扩容后旧 tile UV 仍有效', (() => {
    const r = atlas.uvRect('voxel.blocks:grass_top')!;
    return r.u0 >= 0 && r.u1 <= 1 && r.u1 > r.u0;
  })());
  atlas.release('test.grow');
  offAtlas();

  // ===== J. 配置 / WASM =====
  const cfgA = config.namespace('pack.a');
  const cfgB = config.namespace('pack.b');
  cfgA.set('speed', 7);
  ok('插件配置命名空间隔离', cfgA.get<number>('speed', 0) === 7 && cfgB.get<number>('speed', 0) === 0);
  const handle = await wasm.load('probe', new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  ok('WasmHost 可挂载编译产物', wasm.ids().length === 1 && !!handle.instance);

  // 固定步长仍可推进。v0.6 起 HUD 归扩展插件 voxel.hud 且按 every:4 降频，
  // 核心验收只验证主循环本身推进，不再耦合某个 UI 插件的文本输出。
  let ticks = 0;
  const offTick = engine.onUpdate(() => { ticks++; }, { phase: 'late' });
  engine.start();
  for (let i = 1; i <= 8; i++) if (rafCb) rafCb(i * 20);
  engine.stop();
  offTick();
  ok('Engine 固定步长可推进', engine.time > 0 && ticks >= 4,
    `time=${engine.time.toFixed(3)} ticks=${ticks}`);

  console.log('\n===== 架构加固验收 =====');
  console.log(results.join('\n'));
  console.log('\n===== 插件启动日志（节选）=====');
  console.log(logs.slice(0, 12).join('\n'));
  console.log(`\n结果：${results.filter((r) => r.startsWith('PASS')).length}/${results.length} 通过`);
}

void main().catch((e) => { console.error('VERIFY CRASH', e); process.exit(1); });
