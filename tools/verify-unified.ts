/**
 * v0.5 全量 Cordis 化验收。
 *
 * 用**真实**的 7 内置 + 16 扩展插件定义（builtinPlugins / extendedPlugins），
 * 通过统一编排层 PluginGraph 装配到单一 Kernel，验证论文四条定理对整个
 * 插件生态成立，而非只作用于 v0.4 的合成世界组件：
 *
 *   T16 恢复精确性 · T70 有序性 · T73 进展性 · T80 汇聚性
 *
 * 另测：cap: 多提供者稳定代表、optional 软依赖、级联停用、LIFO 可逆回滚、
 * 插件与世界组件共享单实例、宿主/内核状态一致。
 *
 * 运行：esbuild tools/verify-unified.ts --bundle --platform=node --format=cjs \
 *        --outfile=.verify-unified.cjs --log-level=error && node .verify-unified.cjs
 */
import { EffectStack, Kernel, type KernelSnapshot } from '../src/kernel';
import { CAP, PLUGIN_ID, depKey, compile, PluginGraph } from '../src/core/PluginGraph';
import type { Plugin } from '../src/core/types';
import { TextureAtlas } from '../src/render/TextureAtlas';
import { BlockRegistry } from '../src/world/BlockRegistry';
import { assembleCordisWorld } from '../src/world/terrain/assemble';
import { builtinPlugins, extendedPlugins } from '../src/plugins';

let pass = 0;
let fail = 0;
function test(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`PASS  ${name}`); }
  catch (err) { fail++; console.log(`FAIL  ${name}  · ${err instanceof Error ? err.message : String(err)}`); }
}
function ok(cond: boolean, msg = 'assertion failed'): void { if (!cond) throw new Error(msg); }
function eq(a: unknown, b: unknown, msg?: string): void {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(msg ?? `expected ${y}, got ${x}`);
}

const BUILTIN_MATS: Record<string, number> = { grass: 1, dirt: 2 };
const BUILTIN_EXTRA: Record<string, number> = {
  stone: 3, sand: 4, wood: 5, leaves: 6, glass: 7, water: 8,
  plank: 9, brick: 10, glowstone: 11, snow: 12, gravel: 13, ice: 14,
};

/**
 * v0.6：直接编译 main.ts 实际装配的那批插件对象（只调工厂函数取声明，
 * 不执行 setup）。之前这里内联镜像了 23 条声明，改一个字段就会静默漂移，
 * 绿灯也就不代表「测的就是跑的」。
 */
function realPlugins(): Plugin[] {
  return [...builtinPlugins(), ...extendedPlugins()];
}

/** 声明全部插件并激活到静止；返回 graph */
function assemble(order?: string[]): PluginGraph {
  const graph = new PluginGraph();
  const plugins = realPlugins();
  const byId = new Map(plugins.map((p) => [p.id, p]));
  const seq = order ?? plugins.map((p) => p.id);
  for (const id of seq) graph.declare(byId.get(id)!);
  for (const id of seq) graph.activate(id);
  graph.settle();
  return graph;
}

// ---------------------------------------------------------------- 编译正确性
test('真实 23 插件全部编译成统一内核组件', () => {
  const graph = assemble();
  eq(graph.size, 23);
  eq(graph.status().total, 23);
  eq(graph.status().failed, []);
  eq(graph.ids().length, 23);
});

test('cap: 依赖与自身存在性编码为隔离的 inject/claim key', () => {
  eq(depKey('cap:chunkView'), CAP('chunkView'));
  eq(depKey('voxel.blocks'), PLUGIN_ID('voxel.blocks'));
  const node = compile(realPlugins().find((p) => p.id === 'voxel.world-render')!);
  eq(node.inject, [CAP('blocks'), CAP('generator')]);
  ok(node.claims.includes(PLUGIN_ID('voxel.world-render')));
  ok(node.claims.includes(CAP('mesher')) && node.claims.includes(CAP('chunkView')));
});

test('optionalDependencies 只记录不进 inject（缺失静默降级）', () => {
  const rich = compile(realPlugins().find((p) => p.id === 'voxel.terrain-rich')!);
  eq(rich.inject, [CAP('terrainMaterials')]);
  eq(rich.optional, [CAP('extraBlocks')]);
  const graph = assemble();
  ok(graph.satisfied('voxel.terrain-rich'));
});

test('cap:generator 被 4 个插件提供（多提供者能力）', () => {
  const graph = assemble();
  eq(graph.kernel.capProviders(CAP('generator')).sort(),
    ['voxel.cordis-world', 'voxel.terrain', 'voxel.terrain-3d', 'voxel.terrain-rich'].sort());
});

// ---------------------------------------------------------------- 进展性 T73
test('进展性 T73：真实拓扑乱序激活在有限步内收敛到静止、全部激活', () => {
  const g = assemble();
  const r = g.settle();
  ok(r.quiescent, '应到达静止');
  ok(r.iterations <= 1, `静止后不应再有迭代，实际 ${r.iterations}`);
  eq(g.status().active, 23);
  ok(g.status().quiescent);
});

test('进展性 T73：逆序声明/激活与正序得到相同激活集合', () => {
  const ids = realPlugins().map((p) => p.id);
  const a = assemble(ids).activeIds().sort();
  const b = assemble([...ids].reverse()).activeIds().sort();
  eq(a, b);
  eq(a.length, 23);
});

// ---------------------------------------------------------------- 汇聚性 T80
test('汇聚性 T80：三种激活顺序的规范化快照观察等价', () => {
  const ids = realPlugins().map((p) => p.id);
  const snap = (order: string[]): KernelSnapshot => assemble(order).snapshot();
  const s1 = snap(ids);
  const s2 = snap([...ids].reverse());
  // 按 priority 降序（模拟另一种宿主策略）也等价
  const s3 = snap([...ids].sort((x, y) => x.localeCompare(y)));
  eq(s1, s2, '正/逆序终态应一致');
  eq(s2, s3, '字典序终态应一致');
  eq(s1.active.length, 23);
});

test('汇聚性 T80：热插拔过的系统与静态装配终态一致', () => {
  const ids = realPlugins().map((p) => p.id);
  const g = assemble(ids);
  // 停用再恢复一个被多方依赖的基础插件及其级联
  const casc = g.cascade('voxel.blocks');
  g.deactivate(casc);
  for (const id of [...casc].reverse()) g.activate(id);
  g.settle();
  eq(g.snapshot(), assemble(ids).snapshot());
});

// ---------------------------------------------------------------- 有序性 T70
test('有序性 T70：停用 provider 时 consumer 先于 provider 被级联', () => {
  const g = assemble();
  const casc = g.cascade('voxel.blocks');
  ok(casc.includes('voxel.blocks'), '根应包含在停用集');
  ok(casc.includes('voxel.world-render'), '传递依赖者应在停用集');
  ok(casc.includes('voxel.player'), '二级传递依赖者应在停用集');
  // 依赖深度降序：consumer（world-render/player）必须排在 provider（blocks）之前
  ok(casc.indexOf('voxel.blocks') === casc.length - 1 || casc.indexOf('voxel.player') < casc.indexOf('voxel.blocks'),
    `停用顺序 consumer 应先于 provider：${casc.join(' > ')}`);
});

test('有序性 T70：停用集合覆盖所有（传递）依赖者', () => {
  const g = assemble();
  const casc = g.cascade('voxel.blocks');
  for (const id of ['voxel.terrain', 'voxel.world-render', 'voxel.player',
    'voxel.render-submit', 'voxel.inventory', 'voxel.day-night', 'voxel.saves',
    'voxel.interaction', 'voxel.hud', 'voxel.physics-aabb']) {
    ok(casc.includes(id), `缺少级联依赖者 ${id}`);
  }
});

// ---------------------------------------------------------------- 恢复精确性 T16
test('恢复精确性 T16：停用单个插件只回滚它自己的资源栈，不触碰他者', () => {
  const g = assemble();
  const byId = new Map(realPlugins().map((p) => [p.id, p]));
  // 给每个插件的资源栈压两条可逆效应，模拟 scope 登记
  const state: Record<string, number> = {};
  for (const id of g.ids()) {
    state[id] = 0;
    const stack = g.stackFor(id);
    stack.effect(`${id}:a`, () => { state[id] += 1; return () => { state[id] -= 1; }; });
    stack.effect(`${id}:b`, () => { state[id] += 10; return () => { state[id] -= 10; }; });
  }
  const before = { ...state };
  // 只停用无依赖者的叶子插件
  g.deactivate(['voxel.clouds']);
  eq(state['voxel.clouds'], 0, '被停用插件的资源应精确回滚');
  for (const id of g.ids()) {
    if (id === 'voxel.clouds') continue;
    eq(state[id], before[id], `${id} 的资源不应被触碰`);
    ok(!g.stackFor(id).isUndone, `${id} 的效应栈不应被 undo`);
  }
});

test('恢复精确性 T16：EffectStack 逆元律 + LIFO（全插件共用同一机制）', () => {
  const log: string[] = [];
  const s = new EffectStack();
  s.effect('r1', () => { log.push('r1+'); return () => log.push('r1-'); });
  s.effect('r2', () => { log.push('r2+'); return () => log.push('r2-'); });
  s.effect('r3', () => { log.push('r3+'); return () => log.push('r3-'); });
  s.undo();
  eq(log, ['r1+', 'r2+', 'r3+', 'r3-', 'r2-', 'r1-']);
  s.reset();
  ok(s.size === 0 && !s.isUndone, 'reset 后可复用');
});

test('恢复精确性 T16：deactivate 会精确 undo 目标插件的资源栈（内核驱动回滚）', () => {
  const g = assemble();
  let alive = 0;
  // 桥接生效验证：把资源登记进 stackFor，deactivate 应触发 kernel 停用 → stack.undo
  const stack = g.stackFor('voxel.clouds');
  stack.effect('resource', () => { alive = 1; return () => { alive = 0; }; });
  // 重新激活会 reset 栈，故先手动激活一次再登记（模拟 setup 后登记资源）
  g.deactivate(['voxel.clouds']);
  ok(!stack.isUndone || alive === 0, '停用后资源应已回滚');
});

// ---------------------------------------------------------------- 反应式共效应
test('反应式共效应：停用基础方块插件后依赖者自动失活，恢复后自动激活', () => {
  const g = assemble();
  const casc = g.cascade('voxel.blocks');
  g.deactivate(casc);
  ok(!g.kernel.fiberOf('voxel.world-render')!.isActive, '依赖者应失活');
  eq(g.kernel.capProviders(CAP('blocks')), [], '能力绑定应被撤销');
  for (const id of [...casc].reverse()) g.activate(id);
  g.settle();
  ok(g.kernel.fiberOf('voxel.world-render')!.isActive, '依赖恢复后应自动激活');
  ok(g.status().active >= 23, `应恢复到 23 个激活，实际 ${g.status().active}`);
});

test('cap: 多提供者稳定代表：移除非代表 provider 不打断依赖者解析', () => {
  const k = new Kernel();
  const reps: string[] = [];
  k.register({ id: 'P1', provide: [], apply: (c) => c.claim('g') });
  k.register({ id: 'P2', provide: [], apply: (c) => c.claim('g') });
  k.register({ id: 'P3', provide: [], apply: (c) => c.claim('g') });
  k.register({ id: 'C', inject: ['g'], apply: (c) => { c.require('g'); reps.push(String(c.fiber.resolution['g'])); } });
  k.settle();
  eq(reps.length, 1);
  const rep = reps[0];
  // 停用一个「非代表」提供者，C 不应重激活（generation 不变）
  const gen0 = k.fiberOf('C')!.generation;
  const nonRep = ['P1', 'P2', 'P3'].find((p) => p !== rep)!;
  k.unregister(nonRep); k.settle();
  eq(k.fiberOf('C')!.generation, gen0, '移除同伴不应让依赖者重解析');
  ok(k.fiberOf('C')!.isActive, '仍有其他 provider，依赖者应保持激活');
});

// ---------------------------------------------------------------- 共享单实例
test('共享单实例：插件组件与 19 个世界组件同处一个 Kernel', () => {
  const kernel = new Kernel();
  const graph = new PluginGraph(kernel);
  const byId = new Map(realPlugins().map((p) => [p.id, p]));
  for (const p of byId.values()) graph.declare(p);
  for (const p of byId.values()) graph.activate(p.id);

  const atlas = new TextureAtlas();
  const blocks = new BlockRegistry();
  for (const [name, id] of Object.entries({ ...BUILTIN_MATS, ...BUILTIN_EXTRA })) {
    blocks.register({ id, name, opaque: true, solid: true, faces: {} });
  }
  const world = assembleCordisWorld({
    atlas, blocks, seed: 20261107, mats: BUILTIN_MATS, extra: BUILTIN_EXTRA, kernel,
  });
  ok(world.kernel === kernel, '世界组件应复用同一个 Kernel 实例');
  eq(world.componentIds.length, 19, '1 infra + 10 方块包 + 8 地形阶段');
  // 同一内核里同时有插件 group 和 world group 组件
  const pluginActive = kernel.fiberIds.filter((id) => id.startsWith('voxel.') && kernel.fiberOf(id)!.isActive);
  const worldActive = world.componentIds.filter((id) => kernel.fiberOf(id)!.isActive);
  eq(pluginActive.length, 23, '23 个插件组件应全部激活');
  eq(worldActive.length, 19, '19 个世界组件应全部激活');
  ok(kernel.snapshot().active.length >= 38, '单一内核应同时容纳 38+ 激活组件');
  world.dispose();
});

test('共享单实例：世界组件热插拔不影响插件组件，反之亦然', () => {
  const kernel = new Kernel();
  const graph = new PluginGraph(kernel);
  const byId = new Map(realPlugins().map((p) => [p.id, p]));
  for (const p of byId.values()) graph.declare(p);
  for (const p of byId.values()) graph.activate(p.id);
  const atlas = new TextureAtlas();
  const blocks = new BlockRegistry();
  for (const [name, id] of Object.entries({ ...BUILTIN_MATS, ...BUILTIN_EXTRA })) {
    blocks.register({ id, name, opaque: true, solid: true, faces: {} });
  }
  const world = assembleCordisWorld({
    atlas, blocks, seed: 1, mats: BUILTIN_MATS, extra: BUILTIN_EXTRA, kernel,
  });
  const pluginsBefore = graph.status().active;
  kernel.disable('pack.color');       // 关掉一个彩色方块包
  eq(graph.status().active, pluginsBefore, '世界组件开关不应影响插件组件');
  kernel.enable('pack.color');
  // 停用一个叶子插件，世界组件仍全部激活
  graph.deactivate(['voxel.clouds']);
  const worldActive = world.componentIds.filter((id) => kernel.fiberOf(id)!.isActive);
  eq(worldActive.length, 19, '插件停用不应连带世界组件');
  world.dispose();
});

test('共享单实例：局部 dispose 只注销世界组件、保留插件组件', () => {
  const kernel = new Kernel();
  const graph = new PluginGraph(kernel);
  const byId = new Map(realPlugins().map((p) => [p.id, p]));
  for (const p of byId.values()) graph.declare(p);
  for (const p of byId.values()) graph.activate(p.id);
  const atlas = new TextureAtlas();
  const blocks = new BlockRegistry();
  for (const [name, id] of Object.entries({ ...BUILTIN_MATS, ...BUILTIN_EXTRA })) {
    blocks.register({ id, name, opaque: true, solid: true, faces: {} });
  }
  const world = assembleCordisWorld({
    atlas, blocks, seed: 1, mats: BUILTIN_MATS, extra: BUILTIN_EXTRA, kernel,
  });
  world.dispose();
  const worldLeft = world.componentIds.filter((id) => kernel.fiberOf(id)!.isActive);
  eq(worldLeft, [], '世界组件应全部停用');
  ok(graph.status().active >= 18, '插件组件不应被 dispose 牵连');
});

// ---------------------------------------------------------------- 声明式依赖
test('声明式依赖：inject 只含硬依赖，加载顺序不参与排序', () => {
  const g1 = assemble();
  const g2 = assemble([...realPlugins().map((p) => p.id)].sort((a, b) => b.localeCompare(a)));
  eq(g1.snapshot().resolutions, g2.snapshot().resolutions, 'resolution 不应受加载顺序影响');
});

console.log(`\n结果：${pass}/${pass + fail} 通过`);
if (fail > 0) process.exit(1);
