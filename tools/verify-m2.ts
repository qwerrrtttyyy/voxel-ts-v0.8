/* v0.3 / M2 / M4 专项验收：可复现，不依赖 WebGL */
import * as THREE from 'three';
import { BinaryHub } from '../src/binary/BinaryHub';
import { ConfigStore } from '../src/core/ConfigStore';
import { DayCycle } from '../src/core/DayCycle';
import { EventBus } from '../src/core/EventBus';
import { Engine } from '../src/core/Engine';
import { GameState, DEFAULT_SETTINGS } from '../src/core/GameState';
import { Input } from '../src/core/Input';
import { Inventory } from '../src/core/Inventory';
import { PluginCatalog } from '../src/core/PluginCatalog';
import { PluginHost } from '../src/core/PluginHost';
import { ServiceRegistry } from '../src/core/ServiceRegistry';
import { Ui } from '../src/core/Ui';
import type { IPluginHost, Plugin, PluginContext } from '../src/core/types';
import { FIXED_STEP, SEA_LEVEL } from '../src/config';
import { AABBCollision } from '../src/player/AABBCollision';
import { raycastVoxel } from '../src/player/Raycast';
import { TextureAtlas, type TilePainter } from '../src/render/TextureAtlas';
import { AIR_ID, BlockRegistry } from '../src/world/BlockRegistry';
import { Chunk } from '../src/world/Chunk';
import { World } from '../src/world/World';
import type { IGenerator } from '../src/world/IGenerator';
import { CulledMesher } from '../src/world/mesher/CulledMesher';
import { SaveStore } from '../src/core/SaveStore';

const results: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  · ' + detail : ''}`);
  if (!cond) process.exitCode = 1;
}

// ---- 最小 DOM ----
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
  querySelectorAll: () => [],
};
(globalThis as any).window = {
  addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1,
  innerWidth: 1280, innerHeight: 800, setInterval: () => 0, clearInterval() {},
  setTimeout: () => 0, clearTimeout() {},
};

const paint: TilePainter = (set, s) => {
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) set(x, y, 110, 170, 70);
};

function buildWorld() {
  const blocks = new BlockRegistry();
  const events = new EventBus();
  const world = new World(blocks, events);
  const atlas = new TextureAtlas();
  const tile = atlas.define('g', 't', paint);
  const grass = blocks.define('g', 'grass', { opaque: true, solid: true, all: tile });
  const dirt = blocks.define('g', 'dirt', { opaque: true, solid: true, all: tile });
  const gen: IGenerator = {
    id: 'flat-m2',
    surfaceY: () => SEA_LEVEL,
    blockAt: (_x, y, _z, s) => y > s ? AIR_ID : y === s ? grass : dirt,
  };
  world.setGenerator(gen);
  world.pregenerate();
  return { blocks, events, world, atlas, grass, dirt, gen, tile };
}

function main(): void {
  // ============ 1. 昼夜循环 ============
  const cycle = new DayCycle();
  cycle.setPhase(0);
  ok('日出 06:00 且地平线暖辉最强', cycle.clock() === '06:00' && cycle.palette().warmth > 0.9);
  cycle.setPhase(0.25);
  ok('正午 12:00 且地形亮度为 1.0', cycle.clock() === '12:00' && Math.abs(cycle.palette().ambient - 1) < 0.01);
  cycle.setPhase(0.75);
  ok('午夜 00:00 且亮度压暗 / 星空权重为 1',
    cycle.clock() === '00:00' && cycle.palette().ambient < 0.35 && cycle.palette().night > 0.9,
    `ambient=${cycle.palette().ambient.toFixed(2)} night=${cycle.palette().night.toFixed(2)}`);
  cycle.speed = 1;
  cycle.update(0.25);
  ok('相位推进并回绕到 0（不越界）', Math.abs(cycle.phase) < 1e-9, `phase=${cycle.phase}`);

  // ============ 2. AABB 碰撞（M2） ============
  const w = buildWorld();
  const col = new AABBCollision();
  ok('首次 groundAt 回退到整列最高实体（不会把玩家拉进地下）',
    col.groundAt(w.world, 48.5, 48.5) === SEA_LEVEL + 1);

  const feet = new THREE.Vector3(48.5, SEA_LEVEL + 1, 48.5);
  col.move(feet, new THREE.Vector3(0.3, 0, 0), w.world);
  ok('AABB 平地可自由水平移动', feet.x > 48.5 && Math.abs(feet.y - (SEA_LEVEL + 1)) < 1e-9,
    `x=${feet.x.toFixed(2)} y=${feet.y.toFixed(2)}`);

  // 头顶方块：跳起必须被挡住
  w.world.setBlock(48, SEA_LEVEL + 3, 48, w.dirt);
  const head = col.resolveVertical(w.world, feet.clone(), 0.9);
  ok('上升撞到头顶方块时返回 hitCeiling 且不穿透',
    head.hitCeiling && head.y < SEA_LEVEL + 2, `y=${head.y.toFixed(2)} ceiling=${head.hitCeiling}`);
  w.world.setBlock(48, SEA_LEVEL + 3, 48, AIR_ID);

  // 悬空平台：地面来自玩家当前高度向下扫描，不是整列最高
  for (let y = 0; y < 24; y++) w.world.setBlock(40, y, 40, AIR_ID);
  w.world.setBlock(40, 20, 40, w.dirt);
  const above = new THREE.Vector3(40.5, 25, 40.5);
  col.move(above, new THREE.Vector3(0, 0, 0), w.world);
  const platformGround = col.groundAt(w.world, 40.5, 40.5);
  ok('悬空平台按玩家高度解算地面（不被上方 / 下方无关方块干扰）',
    Math.abs(platformGround - 21) < 0.01, `ground=${platformGround}`);

  // 洞穴：玩家上方有盖板时，脚下地面仍是洞底
  w.world.setBlock(40, 28, 40, w.dirt);
  const inCave = new THREE.Vector3(40.5, 21, 40.5);
  col.move(inCave, new THREE.Vector3(0, 0, 0), w.world);
  const caveGround = col.groundAt(w.world, 40.5, 40.5);
  ok('洞穴上方的盖板不会把玩家吸上去', Math.abs(caveGround - 21) < 0.01, `ground=${caveGround}`);

  // 高墙阻挡 + 沿墙滑动
  const w2 = buildWorld();
  for (let y = SEA_LEVEL + 1; y <= SEA_LEVEL + 4; y++) w2.world.setBlock(48, y, 47, w2.dirt);
  const wall = new THREE.Vector3(48.5, SEA_LEVEL + 1, 48.5);
  for (let i = 0; i < 40; i++) col.move(wall, new THREE.Vector3(0, 0, -0.12), w2.world);
  ok('AABB 高墙阻挡水平移动（不能穿墙 / 不能爬上去）',
    wall.z > 47 && wall.y <= SEA_LEVEL + 2, `pos=(${wall.x.toFixed(2)},${wall.y.toFixed(2)},${wall.z.toFixed(2)})`);
  const zBefore = wall.z;
  col.move(wall, new THREE.Vector3(0.12, 0, -0.12), w2.world);
  ok('被墙挡住时另一轴仍可滑动', wall.x > 48.5 && Math.abs(wall.z - zBefore) < 1e-6,
    `x=${wall.x.toFixed(2)} z=${wall.z.toFixed(2)}`);

  // ============ 3. 挖 / 放的底层链路（M2） ============
  const w3 = buildWorld();
  const cam = new THREE.Vector3(48.5, SEA_LEVEL + 1.62, 48.5);
  const down = new THREE.Vector3(0, -1, 0);
  const hit = raycastVoxel(cam, down, 6, w3.world, w3.blocks);
  ok('准星向下射线命中草方块且法线 +Y', !!hit && hit.y === SEA_LEVEL && hit.ny === 1);
  if (hit) {
    w3.world.setBlock(hit.x, hit.y, hit.z, AIR_ID);
    const next = raycastVoxel(cam, down, 6, w3.world, w3.blocks);
    ok('挖掉命中方块后射线落到下一层（地面真值随之下降）',
      !!next && next.y === SEA_LEVEL - 1 && w3.world.groundY(48, 48) === SEA_LEVEL);

    const px = hit.x + hit.nx, py = hit.y + hit.ny, pz = hit.z + hit.nz;
    ok('放置坐标由命中面法线推出且目标格为空气',
      py === SEA_LEVEL + 1 && w3.world.getBlock(px, py, pz) === AIR_ID);
    w3.world.setBlock(px, py, pz, w3.dirt);
    ok('放置后方块写入世界且地面上升', w3.world.getBlock(px, py, pz) === w3.dirt
      && w3.world.groundY(48, 48) === SEA_LEVEL + 2);
  }

  // 玩家身体重叠判定（InteractionPlugin 的同款逻辑）
  const overlaps = (x: number, y: number, z: number): boolean => {
    const f = new THREE.Vector3(48.5, SEA_LEVEL + 1, 48.5);
    return x < f.x + 0.3 && x + 1 > f.x - 0.3
      && y < f.y + 1.8 && y + 1 > f.y
      && z < f.z + 0.3 && z + 1 > f.z - 0.3;
  };
  ok('禁止把方块塞进玩家身体（相邻格允许、身体格拒绝）',
    overlaps(48, SEA_LEVEL + 1, 48) && !overlaps(48, SEA_LEVEL + 3, 48));

  // ============ 4. 顶点 AO ============
  const w4 = buildWorld();
  // 纯平地上没有任何遮挡，AO 全为 1 级是正确行为；这里立一根 2×2 柱子制造凹角，
  // 让相邻顶面 / 柱子侧面的顶点采样到 side / corner 遮挡。
  for (let dx = 0; dx < 2; dx++) {
    for (let dz = 0; dz < 2; dz++) w4.world.setBlock(5 + dx, SEA_LEVEL + 1, 5 + dz, w4.dirt);
  }
  const chunk = w4.world.getChunk(0, 0)!;
  const ctxMesh = { blocks: w4.blocks, atlas: w4.atlas };
  const withAO = new CulledMesher().build(chunk, w4.world, { ...ctxMesh, ao: () => true });
  const noAO = new CulledMesher().build(chunk, w4.world, { ...ctxMesh, ao: () => false });
  const distinct = new Set(Array.from(withAO.colors)).size;
  const distinctNo = new Set(Array.from(noAO.colors)).size;
  ok('AO 产生多级顶点亮度（可运行时关闭）', distinct > distinctNo && distinctNo > 0,
    `withAO=${distinct} 级 / noAO=${distinctNo} 级`);
  ok('AO 不改变几何规模（只改顶点色）',
    withAO.positions.length === noAO.positions.length && withAO.indices.length === noAO.indices.length);

  // ============ 5. 物品栏自动收集插件方块 ============
  const inv = new Inventory();
  const bx = new BlockRegistry();
  const ax = new TextureAtlas();
  const t = ax.define('p', 'tile', paint);
  const g = bx.define('p', 'grass', { opaque: true, solid: true, all: t });
  const d = bx.define('p', 'dirt', { opaque: true, solid: true, all: t });
  const glass = bx.define('p', 'glass', { opaque: false, solid: true, all: t });
  inv.rebuild(bx);
  ok('物品栏自动收集所有带贴图的方块', inv.total === 3 && inv.pageCount === 1);
  inv.select(2);
  ok('数字键选择槽位生效', inv.current()?.blockId === glass);
  bx.release(glass);
  inv.rebuild(bx);
  ok('插件卸载释放方块后物品栏自动缩回', inv.total === 2 && inv.current()?.blockId !== glass,
    `total=${inv.total}`);
  void g; void d;

  // ============ 6. 存档仓库 ============
  void (async () => {
    const store = new SaveStore();
    ok('Node 环境自动降级为内存后端', store.backend === 'memory');
    const payload = new Uint8Array([1, 2, 3, 4, 5]).buffer;
    await store.write(1, '测试世界', payload);
    const list = await store.list();
    const back = await store.read(1);
    ok('存档写入 / 列举 / 读回一致',
      list.length === 1 && list[0].name === '测试世界' && !!back
      && new Uint8Array(back!).every((v, i) => v === i + 1));
    await store.remove(1);
    ok('删除存档后读取返回 null', (await store.read(1)) === null);

    // 存档二进制信封往返（含插件私有段）
    const w5 = buildWorld();
    const hub = new BinaryHub();
    const env = w5.world.toEnvelope(hub, hub.snapshot());
    const info = w5.world.fromEnvelope(hub, env);
    const a = w5.world.getChunk(0, 0)!;
    const b = Chunk.fromBinary(a.toBinary());
    ok('世界信封往返后体素逐字节一致',
      info.chunks === 36 && a.data.every((v, i) => v === b.data[i]),
      `chunks=${info.chunks} segments=${info.segments}`);

    // ============ 7. 运行时插件清单与热插拔 ============
    const events = new EventBus();
    const engine = new Engine(FIXED_STEP);
    const services = new ServiceRegistry();
    const config = new ConfigStore();
    const blocks = new BlockRegistry();
    const atlas = new TextureAtlas();
    const binary = new BinaryHub();
    const deps = { events, engine, services, config, blocks, atlas, binary };
    let ctx!: PluginContext;
    const host = new PluginHost(() => ctx, deps);
    ctx = {
      scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(),
      renderer: {} as never, events, input: new Input(el()), engine, ui: new Ui(),
      blocks, world: new World(blocks, events), atlas, binary,
      wasm: null as never, services, config,
      scope: null as never, pluginId: 'core', cfg: config.namespace('core'),
      host: host as IPluginHost,
      capabilities: (n: string) => host.capabilities(n),
      log: () => {},
    };
    const cfg = config.namespace('catalog-test');
    const catalog = new PluginCatalog(host as IPluginHost, cfg, () => {});
    const mk = (id: string, dependencies: string[] = [], provides: string[] = []): Plugin => ({
      id, version: '1.0.0', dependencies, provides,
      setup(c) { c.scope.update(() => {}); },
    });
    catalog.register([
      mk('t.c', ['cap:capB']), mk('t.a', [], ['capA']), mk('t.b', ['cap:capA'], ['capB']),
    ], 'extension');
    await catalog.boot();
    ok('PluginCatalog 按 cap: 能力拓扑装配',
      host.loadedIds().join(',') === 't.a,t.b,t.c', host.loadedIds().join(' → '));
    ok('清单统计与加载状态一致', catalog.stats.loaded === 3 && catalog.stats.total === 3);

    await catalog.setEnabled('t.b', false);
    ok('禁用插件触发宿主热卸载，并把被级联的依赖者开关同步下来',
      !host.isLoaded('t.b') && !host.isLoaded('t.c') && catalog.get('t.c')?.enabled === false,
      `loaded=${host.loadedIds().join(',')}`);
    ok('启用状态已持久化', cfg.get<Record<string, boolean>>('enabled', {})['t.b'] === false);

    await catalog.setEnabled('t.b', true);
    await catalog.setEnabled('t.c', true);
    ok('重新启用按拓扑顺序装回（依赖先于依赖者）',
      host.loadedIds().join(',') === 't.a,t.b,t.c', host.loadedIds().join(' → '));

    await catalog.reload('t.a');
    ok('单插件重载后清单仍自洽', host.isLoaded('t.a') && catalog.stats.loaded === 3);

    ok('GameState 默认设置可持久化且模式切换生效', (() => {
      const gs = new GameState(config.namespace('game-test'));
      gs.setMode('survival');
      gs.setFlying(true);
      const other = new GameState(config.namespace('game-test'));
      return other.mode === 'survival' && !gs.flying && DEFAULT_SETTINGS.mode === 'creative';
    })());

    console.log('\n===== v0.3 / M2 / M4 专项验收 =====');
    console.log(results.join('\n'));
    console.log(`\n结果：${results.filter((r) => r.startsWith('PASS')).length}/${results.length} 通过`);
  })();
}

main();
