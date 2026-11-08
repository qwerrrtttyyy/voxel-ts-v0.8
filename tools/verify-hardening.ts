/**
 * v0.6 加固与体验优化专项验收（不依赖 WebGL）。
 *
 * 覆盖：运行时插件沙箱、存档版本迁移与尺寸校验、保留 tag、
 * service:changed 事件、插件生命周期 phase、依赖闭包补齐、软依赖通知、
 * SaveStore 降级一致性、WasmHost 释放、视角插值。
 */
import * as THREE from 'three';
import { BinaryHub, ENVELOPE_VERSION } from '../src/binary/BinaryHub';
import { CHUNK_TAG, LEGACY_CHUNK_TAG, encodeChunk } from '../src/binary/ChunkCodec';
import { WasmHost } from '../src/binary/WasmHost';
import { ConfigStore } from '../src/core/ConfigStore';
import { Engine } from '../src/core/Engine';
import { EventBus } from '../src/core/EventBus';
import { Input } from '../src/core/Input';
import { PluginGraph } from '../src/core/PluginGraph';
import { PluginHost } from '../src/core/PluginHost';
import { PluginScope } from '../src/core/PluginScope';
import { ServiceRegistry, ServiceToken } from '../src/core/ServiceRegistry';
import { createSandboxedPlugin, createSandboxContext, validateCapabilities } from '../src/core/Sandbox';
import { Ui } from '../src/core/Ui';
import type { IPluginHost, Plugin, PluginContext } from '../src/core/types';
import { MESHER } from '../src/core/tokens';
import { SaveStore } from '../src/core/SaveStore';
import { SEA_LEVEL } from '../src/config';
import { ChunkView } from '../src/render/ChunkView';
import type { IGenerator } from '../src/world/IGenerator';
import { FirstPersonController } from '../src/player/FirstPersonController';
import { GroundFollowCollision } from '../src/player/ICollision';
import { TextureAtlas, type TilePainter } from '../src/render/TextureAtlas';
import { BlockRegistry } from '../src/world/BlockRegistry';
import { Chunk } from '../src/world/Chunk';
import { World } from '../src/world/World';

let pass = 0, fail = 0;
function report(name: string, err?: unknown): void {
  if (err === undefined) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  · ${err instanceof Error ? err.message : String(err)}`); }
}
function test(name: string, fn: () => void): void {
  try { fn(); report(name); } catch (err) { report(name, err); }
}
async function atest(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); report(name); } catch (err) { report(name, err); }
}
function ok(cond: boolean, msg = 'assertion failed'): void { if (!cond) throw new Error(msg); }
function throws(fn: () => unknown, contains = ''): void {
  let err = '';
  try { fn(); } catch (e) { err = e instanceof Error ? e.message : String(e); }
  ok(err !== '', '期望抛错但没有');
  if (contains) ok(err.includes(contains), `错误信息不含 "${contains}"：${err}`);
}

// ---- 最小 DOM / 渲染器 ----
function el(): any {
  return {
    id: '', textContent: '', innerHTML: '', value: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {}, requestPointerLock() {},
    appendChild() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    style: {}, width: 800, height: 600,
  };
}
(globalThis as any).document = {
  getElementById: () => el(), createElement: () => el(),
  addEventListener() {}, removeEventListener() {}, pointerLockElement: null,
};
(globalThis as any).window = {
  addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1,
  innerWidth: 1280, innerHeight: 800, setTimeout: () => 0,
};
let raf: ((t: number) => void) | null = null;
(globalThis as any).requestAnimationFrame = (cb: (t: number) => void): number => { raf = cb; return 1; };
(globalThis as any).cancelAnimationFrame = (): void => { raf = null; };
const paint: TilePainter = (set, s) => {
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) set(x, y, 120, 180, 90);
};

const events = new EventBus();
const engine = new Engine(1 / 60);
const services = new ServiceRegistry(events);
const config = new ConfigStore();
const blocks = new BlockRegistry();
const atlas = new TextureAtlas();
const binary = new BinaryHub();
const world = new World(blocks, events);
const wasm = new WasmHost();
const deps = { events, engine, services, config, blocks, atlas, binary };

const fakeRenderer = { render() {}, setPixelRatio() {}, setSize() {}, dispose() {} } as unknown as THREE.WebGLRenderer;
const scope = new PluginScope('remote.test', deps);
const stubHost: IPluginHost = {
  use() {}, useMany() {}, async mount() {}, async unmount() {},
  async reload() {}, async enable() {}, async disable() {},
  isLoaded: () => false, loadedIds: () => [], list: () => [],
  capabilities: () => [], impactOf: () => [],
};
const baseCtx = {
  scene: new THREE.Scene(),
  camera: new THREE.PerspectiveCamera(),
  renderer: fakeRenderer,
  events, input: new Input(el()), engine, ui: new Ui(),
  blocks, world, atlas, binary, wasm, services, config,
  scope, pluginId: 'remote.test', cfg: config.namespace('remote.test'),
  host: stubHost,
  capabilities: () => [],
  log: () => {},
} as unknown as PluginContext;

// ============================================================ 1. 运行时插件沙箱
console.log('\n----- 运行时插件沙箱 -----');

test('未声明能力时 host.mutate 被拒绝', () => {
  const c = createSandboxContext(baseCtx, 'remote.a');
  throws(() => c.host.unmount('voxel.blocks'), 'host.mutate');
});

test('未声明能力时 services.provide 被拒绝', () => {
  const c = createSandboxContext(baseCtx, 'remote.a');
  throws(() => c.services.provide(new ServiceToken<number>('x.y'), 1), 'services.provide');
});

test('未声明能力时 world.write 被拒绝', () => {
  const c = createSandboxContext(baseCtx, 'remote.a');
  throws(() => c.world.setBlock(0, 0, 0, 1), 'world.write');
});

test('未声明能力时 scene / renderer / wasm 均不可访问', () => {
  const c = createSandboxContext(baseCtx, 'remote.a');
  throws(() => c.scene, 'scene');
  throws(() => c.renderer, 'renderer');
  throws(() => c.wasm, 'wasm');
});

test('未声明能力时读取只读服务与世界数据正常', () => {
  const c = createSandboxContext(baseCtx, 'remote.a');
  ok(c.services.tokens().length === 0);
  ok(typeof c.world.getBlock === 'function' && c.world.getBlock(0, 0, 0) === 0);
  ok(c.engine.errorCount === 0);
});

test('申请未知能力在安装期即被拒绝', () => {
  throws(() => createSandboxContext(baseCtx, 'remote.a', ['godmode']), '未知能力');
});

test('显式声明 renderer 后放行，未声明的其余能力仍受限', () => {
  const c = createSandboxContext(baseCtx, 'remote.a', ['renderer']);
  ok(c.renderer === fakeRenderer);
  throws(() => c.host.unmount('x'), 'host.mutate');
});

test('即便申请 services.provide 也不能替换核心策略', () => {
  const c = createSandboxContext(baseCtx, 'remote.a', ['services.provide']);
  throws(() => c.services.provide(MESHER, { id: 'evil', build: () => ({}) } as never), '不能替换核心服务');
});

test('scope.service 默认禁止远程插件注册服务', () => {
  const c = createSandboxContext(baseCtx, 'remote.a');
  throws(() => c.scope.service(new ServiceToken<number>('x.y'), 1), 'services.provide');
});

test('scope.emit 伪造核心事件被拒，安全事件放行', () => {
  const c = createSandboxContext(baseCtx, 'remote.a');
  throws(() => c.scope.emit('world:regenerated', { generatorId: 'x', chunkCount: 0 }), '不能广播核心事件');
  c.scope.emit('game:toast', { text: 'hello', kind: 'info' });
});

test('命名空间资源（tile / block / binary 段）仍可正常注册并自动清理', () => {
  const localScope = new PluginScope('remote.res', deps);
  const c = createSandboxContext({ ...baseCtx, scope: localScope } as PluginContext, 'remote.res');
  const tile = c.scope.tile('glow', paint);
  const id = c.scope.block('glow', { opaque: false, solid: true, emissive: true, all: tile });
  const tag = c.scope.binary(0, {
    name: 'remote.res/meta',
    encode: () => new ArrayBuffer(0), decode: () => null,
  });
  ok(id >= 64 && tile.includes('remote.res') && tag >= 0);
  ok(localScope.resourceCount === 3, `resources=${localScope.resourceCount}`);
  localScope.dispose();
  ok(blocks.byName('remote.res:glow') === undefined, '卸载后方块定义应回落');
});

test('createSandboxedPlugin 只替换 setup 的上下文，声明字段原样保留', () => {
  let seen: unknown = null;
  const raw: Plugin = {
    id: 'remote.demo', version: '1.0.0', provides: ['demo'],
    dependencies: ['cap:blocks'], priority: 7,
    meta: { label: 'D', description: 'demo', category: 'remote' },
    setup(c) { seen = c; },
  };
  const wrapped = createSandboxedPlugin(raw, 'https://example.com/p.js');
  ok(wrapped.id === raw.id && wrapped.provides === raw.provides && wrapped.priority === 7);
  ok((wrapped.meta?.description ?? '').includes('受限沙箱'));
  wrapped.setup(baseCtx);
  ok(!!seen && seen !== baseCtx, 'setup 应拿到沙箱视图');
  const sandboxHost = (seen as PluginContext).host;
  throws(() => sandboxHost.unmount('voxel.blocks'), 'host.mutate');
});

test('访问未开放的上下文字段会抛明确错误而不是给 undefined', () => {
  const c = createSandboxContext(baseCtx, 'remote.a');
  throws(() => (c as unknown as Record<string, unknown>).notAField, '未开放');
});

// ============================================================ 2. 存档迁移与完整性
console.log('\n----- 存档迁移与完整性 -----');

test('v1 存档经内置迁移器升级，chunk 段 0x0001 → 0xf001', () => {
  const hub = new BinaryHub();
  const c = new Chunk(0, 0);
  const payload = encodeChunk(c);
  const v1 = hub.encode([{ tag: LEGACY_CHUNK_TAG, payload }], 1);
  const entries = hub.decode(v1);
  ok(entries.length === 1 && entries[0].tag === CHUNK_TAG, `tag=0x${entries[0].tag.toString(16)}`);
  ok(hub.migrationLabels.some((l) => l.includes('1→2')));
});

test('未来版本明确拒绝，不静默误读', () => {
  const hub = new BinaryHub();
  const buf = hub.encode([], ENVELOPE_VERSION + 1);
  throws(() => hub.decode(buf), 'not supported');
});

test('自定义迁移器可注册、注销，且与内置迁移共存', () => {
  const hub = new BinaryHub();
  const off = hub.registerMigration({ from: 2, to: 3, label: 'probe', apply: (e) => e });
  ok(hub.migrationLabels.length >= 2 && hub.migrationLabels.some((l) => l.includes('probe')));
  off();
  ok(!hub.migrationLabels.some((l) => l.includes('probe')));
});

test('CRC32 能检出 body 篡改', () => {
  const hub = new BinaryHub();
  const buf = hub.encode([{ tag: 0x1234, payload: new Uint8Array([1, 2, 3, 4]).buffer as ArrayBuffer }]);
  const copy = buf.slice(0);
  new Uint8Array(copy)[8] ^= 0x01;
  throws(() => hub.decode(copy), 'checksum mismatch');
});

test('claimTag 永不占用系统保留段', () => {
  const hub = new BinaryHub();
  for (let i = 0; i < 600; i++) {
    const tag = hub.claimTag(`probe.plugin.${i}`, 0);
    ok(tag !== CHUNK_TAG && tag !== LEGACY_CHUNK_TAG, `tag=0x${tag.toString(16)}`);
  }
});

test('fromEnvelope 拒绝与当前 CHUNK_SIZE 不符的存档', () => {
  const hub = new BinaryHub();
  const payload = encodeChunk({
    cx: 0, cz: 0, size: 8, height: 8, data: new Uint8Array(8 * 8 * 8),
  });
  const buf = hub.encode([{ tag: CHUNK_TAG, payload }]);
  throws(() => world.fromEnvelope(hub, buf), '尺寸');
});

test('ServiceRegistry 真正发出 service:changed 且按值去重', () => {
  const bus = new EventBus();
  let provided = 0, removed = 0;
  bus.on('service:changed', (e) => { if (e.action === 'provided') provided++; else removed++; });
  const reg = new ServiceRegistry(bus);
  const T = new ServiceToken<number>('probe.token');
  const off1 = reg.provide(T, 1);
  const off2 = reg.provide(T, 1); // 同值重复注册不应再广播
  ok(provided === 1, `provided=${provided}`);
  off1(); // 还有一份同值实现，生效值未变，也不应广播
  off2(); // 最后一份移除后生效值变为 undefined，才广播 removed
  ok(removed === 1, `removed=${removed}`);
});

// ============================================================ 3. 宿主语义
console.log('\n----- 插件宿主语义 -----');

const hostEvents = new EventBus();
let realHost!: PluginHost;
const hostCtx = { ...baseCtx, events: hostEvents } as PluginContext;
realHost = new PluginHost(() => hostCtx, deps, new PluginGraph());
(hostCtx as unknown as { host: IPluginHost }).host = realHost;

void (async () => {
  const phases: string[] = [];
  hostEvents.on('plugin:loaded', (e) => phases.push(e.phase));

  await atest('mount 自动补齐未加载的依赖闭包', async () => {
    realHost.use({ id: 't.dep', version: '1', provides: ['d'], setup() {} });
    await realHost.mount({ id: 't.child', version: '1', dependencies: ['cap:d'], setup() {} });
    ok(realHost.isLoaded('t.dep') && realHost.isLoaded('t.child'));
  });

  await atest('生命周期事件完整发出 loaded / enabled / reloaded', async () => {
    phases.length = 0;
    await realHost.mount({ id: 't.life', version: '1', setup() {} });
    await realHost.disable('t.life');
    await realHost.enable('t.life');
    await realHost.reload('t.life');
    ok(phases.join(',') === 'loaded,enabled,reloaded', phases.join(','));
  });

  await atest('enable / disable 返回类型对称且同步清理状态', async () => {
    await realHost.disable('t.life');
    ok(!realHost.isLoaded('t.life'));
    const p = realHost.enable('t.life');
    ok(p instanceof Promise);
    await p;
    ok(realHost.isLoaded('t.life'));
  });

  await atest('optional 依赖者收到 service:changed 而非被静默遗留旧引用', async () => {
    let soft = 0;
    hostEvents.on('service:changed', (e) => {
      if (e.action === 'removed' && e.tokenId === 'plugin.id:t.dep2') soft++;
    });
    realHost.use({ id: 't.dep2', version: '1', provides: ['d2'], setup() {} });
    await realHost.mount({ id: 't.soft', version: '1', optionalDependencies: ['cap:d2'], setup() {} });
    ok(realHost.isLoaded('t.dep2'));
    await realHost.unmount('t.dep2');
    ok(soft >= 1, `soft=${soft}`);
    ok(realHost.isLoaded('t.soft'), '软依赖者不应被卸载');
  });

  // ======================================================== 4. 资源与手感
  console.log('\n----- 资源释放与视角手感 -----');

  await atest('WasmHost 支持 unload / dispose，不再只增不减', async () => {
    const wh = new WasmHost();
    const empty = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]).buffer as ArrayBuffer;
    await wh.load('m1', empty);
    await wh.load('m2', empty);
    ok(wh.ids().length === 2);
    ok(wh.unload('m1') && !wh.unload('m1'));
    wh.dispose();
    ok(wh.ids().length === 0);
  });

  await atest('SaveStore 事务失败降级后 写/读/列 走同一后端', async () => {
    (globalThis as any).indexedDB = {
      open() {
        const req: any = {
          result: {
            objectStoreNames: { contains: () => true },
            transaction() { throw new Error('tx boom'); },
          },
        };
        setTimeout(() => req.onsuccess?.(), 0);
        return req;
      },
    };
    const store = new SaveStore();
    const buf = new Uint8Array([9, 8, 7]).buffer as ArrayBuffer;
    const meta = await store.write(2, '降级槽位', buf);
    const read = await store.read(2);
    const list = await store.list();
    ok(!!read && new Uint8Array(read)[0] === 9, '读应返回内存里的数据');
    ok(list.some((m) => m.slot === 2 && m.bytes === meta.bytes), '列表应包含降级槽位');
    await store.remove(2);
    ok((await store.read(2)) === null);
    delete (globalThis as any).indexedDB;
  });

  await atest('视角插值：render(0) 取上一逻辑帧、render(1) 取当前帧', () => {
    const cam = new THREE.PerspectiveCamera();
    const inp = new Input(el());
    const w = new World(new BlockRegistry(), new EventBus());
    const ctrl = new FirstPersonController(cam, inp, w, new GroundFollowCollision());
    ctrl.spawn(2, 2);
    ok(Math.abs(cam.rotation.y - ctrl.yaw) < 1e-9);
    inp.state.lookX = 100;
    ctrl.update(1 / 60);
    const target = ctrl.yaw;
    ok(Math.abs(target) > 1e-3, '鼠标位移应改变 yaw');
    ctrl.render(0);
    ok(Math.abs(cam.rotation.y) < 1e-9, `alpha=0 应为上一帧，实为 ${cam.rotation.y}`);
    ctrl.render(1);
    ok(Math.abs(cam.rotation.y - target) < 1e-9, `alpha=1 应为当前帧，实为 ${cam.rotation.y}`);
  });

  // ======================================================== 5. 插件机性能与可观测性
  console.log('\n----- 插件机性能与可观测性 -----');

  test('Engine every 降频，累计 dt 完整透传给低频回调', () => {
    const e = new Engine(1 / 60);
    let calls = 0, sumDt = 0;
    e.onUpdate((dt) => { calls++; sumDt += dt; }, { every: 4, label: 'probe:lowfreq' });
    e.start();
    for (let i = 1; i <= 12; i++) if (raf) raf(i * (1000 / 60));
    e.stop();
    // 每帧恰好推进一个固定步；12 帧里首帧建立时基，其余 11 步；every:4 触发 2 次
    ok(calls === 2, `calls=${calls}`);
    ok(Math.abs(sumDt - 8 / 60) < 1e-6, `sumDt=${sumDt}`);
  });

  test('Engine 回调画像按 label 聚合，可 reset', () => {
    const e = new Engine(1 / 60);
    e.onUpdate(() => {}, { label: 'plugin.a:update' });
    e.onRender(() => {}, { label: 'plugin.b:render' });
    e.start();
    for (let i = 1; i <= 4; i++) if (raf) raf(i * 20);
    e.stop();
    const stats = e.callbackStats;
    ok(stats.length === 2 && stats.every((s) => s.calls > 0 && s.totalMs >= 0),
      `stats=${JSON.stringify(stats)}`);
    e.resetStats();
    ok(e.callbackStats.length === 0);
  });

  test('Engine 注销后快照刷新，回调不再执行', () => {
    const e = new Engine(1 / 60);
    let n = 0;
    const off = e.onUpdate(() => { n++; }, { label: 'probe:unregister' });
    e.start();
    for (let i = 1; i <= 4; i++) if (raf) raf(i * 20);
    const beforeOff = n;
    off();
    for (let i = 5; i <= 8; i++) if (raf) raf(i * 20);
    e.stop();
    ok(beforeOff > 0 && n === beforeOff,
      `off 前 ${beforeOff} 次，off 后累计 ${n} 次`);
  });

  test('ChunkView 时间预算重建超时的 chunk 留在队列里', () => {
    const ev = new EventBus();
    const bl = new BlockRegistry();
    const w = new World(bl, ev);
    const gen: IGenerator = {
      id: 'flat-probe',
      surfaceY: () => SEA_LEVEL,
      blockAt: (_x, y, _z, s) => (y > s ? 0 : y === s ? 1 : 2),
    };
    w.setGenerator(gen);
    w.pregenerate();
    w.clearDirty();
    for (let cx = 0; cx < 4; cx++) w.setBlock(cx * 16, SEA_LEVEL, 0, 2);
    const before = w.pendingDirty;
    const empty = {
      positions: new Float32Array(0), normals: new Float32Array(0),
      uvs: new Float32Array(0), colors: new Float32Array(0), indices: new Uint16Array(0),
    };
    const mesher = { id: 'empty-probe', build: () => empty };
    const view = new ChunkView(
      new THREE.Scene(), w, mesher as never,
      { blocks: bl, atlas, ao: () => false } as never,
      new THREE.MeshBasicMaterial(),
    );
    const n = view.flushBudgeted(0, 8);
    ok(before >= 4, `before=${before}`);
    ok(n >= 1 && w.pendingDirty === before - n,
      `n=${n} remain=${w.pendingDirty} before=${before}`);
    view.dispose();
  });

  test('安装期校验能力声明，拼错当场报错', () => {
    // @ts-expect-error 故意构造非法能力声明：编译期就该被 PrivilegedCapability 联合拦下
    const bad: Plugin = { id: 'remote.bad', version: '1', setup() {}, requiredCapabilities: ['godmode'] };
    throws(() => validateCapabilities(bad), '未知能力');
    const good: Plugin = { id: 'remote.ok', version: '1', setup() {}, requiredCapabilities: ['renderer', 'world.write'] };
    ok(validateCapabilities(good).length === 2);
  });

  await atest('impactOf 预览硬依赖级联，不计入 optional 依赖者', async () => {
    const impact = realHost.impactOf('t.dep');
    ok(impact.includes('t.child'), `impact=${impact.join(',')}`);
    ok(!impact.includes('t.dep'), '不含自身');
    ok(!impact.includes('t.soft'), 'optional 依赖者不应被连带停用');
  });

  console.log(`\n结果：${pass}/${pass + fail} 通过`);
  if (fail > 0) process.exitCode = 1;
})();
