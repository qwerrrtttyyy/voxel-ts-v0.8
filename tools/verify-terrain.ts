/**
 * v0.4 方块库 + 地形流水线验收。
 * 直接调用 `assembleCordisWorld`（与浏览器插件共用同一份装配逻辑），
 * 覆盖：方块规模 / 确定性 / 生物群系 / 洞穴·矿脉·植被 / 热插拔级联与精确回滚。
 */
import { CHUNK_HEIGHT, CHUNK_SIZE, WORLD_CHUNKS } from '../src/config';
import { TextureAtlas } from '../src/render/TextureAtlas';
import { BlockRegistry } from '../src/world/BlockRegistry';
import { packCount, totalBlockCount } from '../src/world/blocks';
import { BIOME_IDS, TerrainSampler } from '../src/world/terrain';
import { assembleCordisWorld } from '../src/world/terrain/assemble';

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

function build(seed = 20261107) {
  const atlas = new TextureAtlas();
  const blocks = new BlockRegistry();
  for (const [name, id] of Object.entries({ ...BUILTIN_MATS, ...BUILTIN_EXTRA })) {
    blocks.register({ id, name, opaque: true, solid: true, faces: {} });
  }
  const world = assembleCordisWorld({
    atlas, blocks, seed, mats: BUILTIN_MATS, extra: BUILTIN_EXTRA,
  });
  return { atlas, blocks, ...world };
}

/** 稀疏扫描世界，避免测试过慢 */
function scan(w: ReturnType<typeof build>): {
  columns: number;
  caves: number;
  ores: number;
  leaves: number;
  water: number;
  heights: number[];
  bedrockOk: boolean;
  surfaceOk: boolean;
} {
  const oreIds = new Set(Object.values(w.library.byPack['pack.ore'] ?? {}));
  const leafIds = new Set(Object.entries(w.library.byPack['pack.wood'] ?? {})
    .filter(([local]) => local.includes('leaves'))
    .map(([, id]) => id));
  const waterId = w.library.id('water');
  const bedrockId = w.library.id('bedrock');
  const result = {
    columns: 0, caves: 0, ores: 0, leaves: 0, water: 0,
    heights: [] as number[], bedrockOk: true, surfaceOk: true,
  };
  const extent = WORLD_CHUNKS * CHUNK_SIZE;
  for (let x = 0; x < extent; x += 3) {
    for (let z = 0; z < extent; z += 3) {
      const sample = w.pipeline.inspect(x, z);
      result.columns++;
      result.heights.push(sample.surface);
      if (bedrockId && sample.blocks[0] !== bedrockId) result.bedrockOk = false;
      if (sample.blocks[sample.surface] === 0) result.surfaceOk = false;
      for (let y = 3; y < sample.surface - 3; y++) if (sample.blocks[y] === 0) result.caves++;
      for (let y = 0; y < CHUNK_HEIGHT; y++) {
        const id = sample.blocks[y];
        if (oreIds.has(id)) result.ores++;
        if (y > sample.surface && (leafIds.has(id) || id === w.library.id('leaves'))) result.leaves++;
        if (id === waterId) result.water++;
      }
    }
  }
  return result;
}

// ------------------------------------------------------------ 规模与装配
test('方块库：10 个包 / 85 个新方块，规模与声明一致', () => {
  eq(packCount, 10);
  eq(totalBlockCount, 85);
  const w = build();
  eq(w.packIds.length, 10);
  eq(w.stageIds.length, 8);
  eq(w.library.byPack['pack.color'] && Object.keys(w.library.byPack['pack.color']).length, 16);
});

test('Cordis 内核：19 个组件全部激活，8 个阶段按 order 排序', () => {
  const w = build();
  eq(w.kernel.enabledIds.length, 19, '组件定义数');
  eq(w.kernel.snapshot().active.length, 19, '激活组件数');
  eq(w.pipeline.stageCount, 8);
  eq(w.pipeline.stageIds[0], 'stage.continent');
  eq(w.pipeline.stageIds[7], 'stage.decorate');
  eq(new Set(w.pipeline.stageIds).size, 8, '阶段 id 应互不重复');
});

test('方块注册：85 个 id 唯一且落在 uint8 存档空间内', () => {
  const w = build();
  const ids: number[] = [];
  for (const [packId, table] of Object.entries(w.library.byPack)) {
    for (const [local, id] of Object.entries(table)) {
      ok(id > 0, `${packId}:${local} 未分配 id`);
      ok(id <= 255, `${packId}:${local} id=${id} 超出 uint8`);
      ok(!!w.blocks.byName(`${packId}:${local}`), `${packId}:${local} 定义缺失`);
      ids.push(id);
    }
  }
  eq(ids.length, 85);
  eq(new Set(ids).size, 85, '存在重复 id');
});

test('程序化贴图：每个方块都有 tile，像素可读取', () => {
  const w = build();
  ok(w.atlas.tileCount >= 85, `tileCount=${w.atlas.tileCount}`);
  ok(w.atlas.tilePixels('pack.ore:iron_ore') !== null);
  ok(w.atlas.tilePixels('pack.wood:spruce_log_top') !== null);
  const px = w.atlas.tilePixels('pack.color:concrete_red');
  ok(px !== null && px.length === 16 * 16 * 4);
});

test('方块库解析：local 名可查，缺失名返回空气而不是崩溃', () => {
  const w = build();
  eq(w.library.total, 99, '85 新方块 + 14 内置方块');
  ok(w.library.id('iron_ore') > 0);
  ok(w.library.id('grass') > 0);
  eq(w.library.id('does_not_exist'), 0);
});

// ------------------------------------------------------------ 生成质量
test('确定性：同 seed 两次装配的列逐字节一致', () => {
  const a = build(777), b = build(777);
  for (const [x, z] of [[10, 10], [48, 48], [80, 20]] as const) {
    eq(a.pipeline.inspect(x, z), b.pipeline.inspect(x, z));
  }
  eq(a.library.total, b.library.total);
});

test('列缓存：首次构建后重复查询不重复生成', () => {
  const w = build();
  w.pipeline.inspect(20, 20);
  const after = w.pipeline.columnCacheSize;
  w.pipeline.surfaceY(20, 20);
  w.pipeline.blockAt(20, 25, 20, 20);
  eq(w.pipeline.columnCacheSize, after);
});

test('地形高度：全部在合法区间内，基岩层与地表层完整', () => {
  const w = build();
  const s = scan(w);
  ok(s.columns > 500, `扫描列数 ${s.columns}`);
  ok(s.heights.every((h) => h >= 3 && h <= CHUNK_HEIGHT - 12), '高度越界');
  ok(s.bedrockOk, '基岩层缺失');
  ok(s.surfaceOk, '地表层缺失');
});

test('地貌完整性：洞穴 / 矿脉 / 树叶 / 水面都真实生成', () => {
  const w = build();
  const s = scan(w);
  ok(s.caves > 0, '未生成任何洞穴');
  ok(s.ores > 0, '未生成任何矿脉');
  ok(s.leaves > 0, '未生成任何树叶');
  ok(s.water > 0, '未生成任何水面');
});

test('生物群系：多种群系在世界内共存', () => {
  const seen = new Set<string>();
  const extent = WORLD_CHUNKS * CHUNK_SIZE;
  const sampler = new TerrainSampler(20261107); // 与列生成同源的采样器
  for (let x = 0; x < extent; x += 2) {
    for (let z = 0; z < extent; z += 2) seen.add(sampler.sample(x, z).biome);
  }
  ok(seen.size >= 5, `群系种类过少：${[...seen].join(',')}`);
  ok([...seen].every((b) => (BIOME_IDS as readonly string[]).includes(b)));
});

test('IGenerator 契约：surfaceY 与 blockAt 自洽', () => {
  const w = build();
  const surface = w.pipeline.surfaceY(48, 48);
  ok(surface > 0 && surface < CHUNK_HEIGHT);
  ok(w.pipeline.blockAt(48, surface, 48, surface) !== 0);
  eq(w.pipeline.blockAt(48, CHUNK_HEIGHT + 5, 48, surface), 0);
  eq(w.pipeline.id, 'cordis-terrain-v1');
});

// ------------------------------------------------------------ Cordis 热插拔
test('热插拔：停用矿物包后方块定义与库解析一起消失', () => {
  const w = build();
  const ironId = w.library.id('iron_ore');
  w.kernel.disable('pack.ore');
  eq(w.blocks.byName('pack.ore:iron_ore'), undefined, '方块定义未释放');
  w.refresh();
  eq(w.library.id('iron_ore'), 0, '方块库仍返回已释放的 id');
  const inspected = w.pipeline.inspect(20, 20);
  ok(!inspected.blocks.includes(ironId), '列缓存未失效，仍引用旧 id');
});

test('恢复精确性：停用矿物包不影响其它方块包', () => {
  const w = build();
  w.kernel.disable('pack.ore');
  w.refresh();
  ok(w.library.id('granite') > 0);
  ok(w.library.id('concrete_red') > 0);
  ok(w.library.id('birch_log') > 0);
  eq(Object.keys(w.library.byPack).length, 10);
});

test('热插拔可逆：重新启用矿物包后 id 与之前一致（确定性复用）', () => {
  const w = build();
  const before = w.library.id('iron_ore');
  w.kernel.disable('pack.ore');
  w.refresh();
  w.kernel.enable('pack.ore');
  w.refresh();
  eq(w.library.id('iron_ore'), before, '重新启用应拿回同一 id');
  ok(w.kernel.isEnabled('pack.ore'));
  eq(w.kernel.snapshot().active.length, 19);
});

test('反应式共效应：停用地层上游，下游阶段级联停用，流水线只剩根', () => {
  const w = build();
  eq(w.pipeline.stageCount, 8);
  w.kernel.disable('stage.biome');
  eq(w.pipeline.stageCount, 1, `下游阶段未级联停用，剩余 ${w.pipeline.stageIds.join(',')}`);
  eq(w.pipeline.stageIds, ['stage.continent']);
  // disable 只注销上游定义；下游是「反应式停用 fiber」，定义仍在 specs 里可随时恢复
  ok(!w.kernel.fiberOf('stage.strata')!.isActive, 'strata fiber 应被反应式停用');
  ok(!w.kernel.fiberOf('stage.decorate')!.isActive, 'decorate fiber 应被级联停用');
});

test('反应式共效应：重新启用上游后 8 个阶段按依赖全部恢复', () => {
  const w = build();
  w.kernel.disable('stage.biome');
  w.kernel.enable('stage.biome');
  eq(w.pipeline.stageCount, 8, '阶段未全部恢复');
  eq(w.pipeline.stageIds[0], 'stage.continent');
  eq(w.pipeline.stageIds[7], 'stage.decorate');
});

test('阶段开关后重新生成的列仍满足高度与地表约束', () => {
  const w = build();
  w.kernel.disable('stage.decorate');
  w.refresh();
  eq(w.pipeline.stageCount, 7);
  const col = w.pipeline.inspect(48, 48);
  ok(col.surface >= 3 && col.surface <= CHUNK_HEIGHT - 12);
  ok(col.blocks[col.surface] !== 0, '地表层缺失');
});

test('全局 dispose：内核回滚后方块与贴图全部释放', () => {
  const w = build();
  const tileCount = w.atlas.tileCount;
  ok(tileCount >= 85);
  w.kernel.dispose();
  eq(w.atlas.tileCount, 0, '贴图未释放');
  eq(w.blocks.byName('pack.ore:iron_ore'), undefined);
  eq(w.blocks.all().length, 15, '只剩 air + 14 个内置方块');
});

test('确定性热插拔：反复开关后终态与初始态观察等价', () => {
  const a = build(999);
  const b = build(999);
  b.kernel.disable('pack.color'); b.refresh();
  b.kernel.disable('stage.vegetation'); b.refresh();
  b.kernel.enable('pack.color'); b.refresh();
  b.kernel.enable('stage.vegetation'); b.refresh();
  eq(a.kernel.snapshot(), b.kernel.snapshot());
  eq(a.library.total, b.library.total);
  eq(a.pipeline.stageIds, b.pipeline.stageIds);
});

console.log(`\n结果：${pass}/${pass + fail} 通过`);
if (fail > 0) process.exit(1);
