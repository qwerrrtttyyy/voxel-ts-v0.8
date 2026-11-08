/**
 * v0.7 真 3D 地形专项验收（Node，不需要 WebGL）。
 *
 * 核心命题：地形不再是「2D 高度图按列填满」。用密度场产出悬垂岩板、
 * 浮空岛、连续洞穴管道、立体矿脉，并证明确定性 / 跨 chunk 连续 / 负坐标 /
 * 存档往返 / 分帧加载 / 插件可回退。
 */
import { BinaryHub } from '../src/binary/BinaryHub';
import { CHUNK_TAG } from '../src/binary/ChunkCodec';
import { EventBus } from '../src/core/EventBus';
import { ServiceRegistry } from '../src/core/ServiceRegistry';
import { GENERATOR } from '../src/core/tokens';
import { CHUNK_HEIGHT, CHUNK_SIZE, SEA_LEVEL } from '../src/config';
import { BlockRegistry } from '../src/world/BlockRegistry';
import { World } from '../src/world/World';
import type { IGenerator } from '../src/world/IGenerator';
import { DensityField3D } from '../src/world/terrain/Density3D';
import { createTerrain3D, resolveIds, type Generator3DIds } from '../src/world/terrain/Generator3D';
import { TerrainSampler } from '../src/world/terrain/Sampler';
import { extendedPlugins } from '../src/plugins';

let pass = 0, fail = 0;
function test(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`PASS  ${name}`); }
  catch (err) { fail++; console.log(`FAIL  ${name}  · ${err instanceof Error ? err.message : String(err)}`); }
}
function ok(cond: boolean, msg = 'assertion failed'): void { if (!cond) throw new Error(msg); }
const IDS: Generator3DIds = {
  grass: 1, dirt: 2, stone: 3, sand: 4, water: 5, bedrock: 6, snow: 7,
  cobble: 8, wood: 9, leaves: 10, ores: [11, 12, 13, 14, 15],
};
const NO_VEG: Generator3DIds = { ...IDS, wood: 0, leaves: 0, water: 0 };
const ORE = (v: number): boolean => v >= 11 && v <= 15;

/** 在一片采样区域里统计 3D 结构特征 */
function survey(gen: ReturnType<typeof createTerrain3D>) {
  let floating = 0, caves = 0, nonmono = 0, overhang = 0, oreClusters = 0;
  let firstFloating = '', firstCave = '';
  for (let x = -96; x <= 96; x += 3) {
    for (let z = -96; z <= 96; z += 3) {
      const c = gen.inspect(x, z);
      if (c.highest > c.surface + 4) {
        floating++;
        if (!firstFloating) firstFloating = `(${x},${z})`;
      }
      let sawAir = false, sawSolidAfterAir = false;
      for (let y = 2; y < CHUNK_HEIGHT; y++) {
        const v = c.blocks[y];
        if (v !== 0) {
          if (sawAir) sawSolidAfterAir = true;
          if (y > 2 && y < c.surface - 2 && c.blocks[y - 1] === 0) overhang++;
          if (ORE(v) && (ORE(c.blocks[y - 1]) || (y > 0 && ORE(gen.blockAt(x + 1, y, z, 0))))) {
            oreClusters++;
          }
        } else {
          sawAir = true;
          if (y >= 2 && y < c.surface - 3 && c.blocks[y + 1] !== 0) {
            caves++;
            if (!firstCave) firstCave = `(${x},${z},y=${y})`;
          }
        }
      }
      if (sawSolidAfterAir) nonmono++;
    }
  }
  return { floating, caves, nonmono, overhang, oreClusters, firstFloating, firstCave };
}

console.log('\n----- 真 3D 地形生成 -----');

test('密度场确定性：同 seed 逐字节一致，不同 seed 不同', () => {
  const a = createTerrain3D({ seed: 777 }, IDS);
  const b = createTerrain3D({ seed: 777 }, IDS);
  const c = createTerrain3D({ seed: 778 }, IDS);
  let diff = 0;
  for (let x = -20; x <= 20; x += 2) {
    for (let z = -20; z <= 20; z += 2) {
      const ca = a.inspect(x, z), cb = b.inspect(x, z), cc = c.inspect(x, z);
      ok(JSON.stringify(ca) === JSON.stringify(cb), `(${x},${z}) 同 seed 结果漂移`);
      if (JSON.stringify(ca) !== JSON.stringify(cc)) diff++;
    }
  }
  ok(diff > 100, `不同 seed 应产生明显不同地形，实际 ${diff} 列不同`);
});

test('缓存淘汰 / 重置后重算仍逐字节一致', () => {
  const gen = createTerrain3D({}, IDS);
  const before = gen.inspect(-37, 51);
  gen.resetCache();
  ok(JSON.stringify(gen.inspect(-37, 51)) === JSON.stringify(before));
  gen.field.surface(-37, 51); // 2D 骨架缓存也走一遍
  gen.resetCache();
  ok(JSON.stringify(gen.inspect(-37, 51)) === JSON.stringify(before));
});

test('负坐标：密度与体素正确，不串到正坐标', () => {
  const gen = createTerrain3D({}, IDS);
  ok(gen.surfaceY(-100, -100) >= 3 && gen.surfaceY(-100, -100) <= CHUNK_HEIGHT - 12);
  ok(JSON.stringify(gen.inspect(-100, -100)) !== JSON.stringify(gen.inspect(100, 100)));
  ok(gen.blockAt(-100, -1, -100, 0) === 0, 'y<0 必须是空气');
  ok(gen.blockAt(-100, CHUNK_HEIGHT, -100, 0) === 0, '超出高度必须是空气');
});

test('TerrainSampler 字符串键修复：(-1,100003) 不再覆盖 (0,0)', () => {
  const s = new TerrainSampler(4242);
  const a = s.sample(0, 0);
  const b = s.sample(-1, 100003);
  ok(s.sample(0, 0) === a, '(0,0) 缓存被负坐标串改');
  ok(s.sample(-1, 100003) === b);
});

test('密度场在相邻整数坐标上连续（差值有界）', () => {
  const f = new DensityField3D();
  let maxDelta = 0;
  for (let x = -30; x <= 30; x += 3) {
    for (let z = -30; z <= 30; z += 3) {
      for (let y = 4; y < 40; y += 3) {
        const d = f.density(x, y, z);
        maxDelta = Math.max(maxDelta,
          Math.abs(f.density(x + 1, y, z) - d),
          Math.abs(f.density(x, y + 1, z) - d),
          Math.abs(f.density(x, y, z + 1) - d));
      }
    }
  }
  ok(Number.isFinite(maxDelta) && maxDelta < 12, `maxDelta=${maxDelta.toFixed(2)}`);
});

test('2D 骨架高度有界，且地表层 (y=surface) 永远可站立', () => {
  const gen = createTerrain3D({}, NO_VEG);
  for (let x = -40; x <= 40; x += 5) {
    for (let z = -40; z <= 40; z += 5) {
      const c = gen.inspect(x, z);
      ok(c.surface >= 3 && c.surface <= CHUNK_HEIGHT - 12, `surface=${c.surface}`);
      ok(c.blocks[c.surface] !== 0, `(${x},${z}) 地表破洞`);
      ok(c.blocks[0] !== 0 && c.blocks[1] !== 0, '基岩层必须存在');
    }
  }
});

const real = createTerrain3D({}, IDS);
const s = survey(real);

test('真 3D 特征①：存在与地表不连通的浮空岛', () => {
  ok(s.floating > 100, `浮岛列=${s.floating}（示例 ${s.firstFloating}）`);
  // 浮岛下方必须是空气，才能证明不是高度图抬高了整列
  const [fx, fz] = s.firstFloating.replace(/[()]/g, '').split(',').map(Number);
  const c = real.inspect(fx, fz);
  let gap = false;
  for (let y = c.surface + 1; y < c.highest; y++) if (c.blocks[y] === 0) { gap = true; break; }
  ok(gap, '浮岛与地表之间必须有空气间隔');
});

test('真 3D 特征②：存在 solid→air→solid 非单调列（高度图不可能）', () => {
  ok(s.nonmono > 200, `非单调列=${s.nonmono}`);
});

test('真 3D 特征③：存在带顶盖的地下洞穴', () => {
  ok(s.caves > 100, `带顶盖空腔=${s.caves}（示例 ${s.firstCave}）`);
});

test('真 3D 特征④：存在悬垂（上方固体、下方空气）', () => {
  ok(s.overhang > 100, `悬垂体素=${s.overhang}`);
});

test('真 3D 特征⑤：矿脉是跨体素的连续团块，不是逐格 hash', () => {
  ok(s.oreClusters > 30, `相邻矿对=${s.oreClusters}`);
});

test('关闭全部 3D 项后退化为严格 2D 单调列（可回退性）', () => {
  const flat = createTerrain3D({ relief: 0, caves: 0, islands: 0, ores: 0 }, NO_VEG);
  const f = survey(flat);
  ok(f.floating === 0, `仍有浮岛 ${f.floating}`);
  ok(f.caves === 0, `仍有洞穴 ${f.caves}`);
  for (let x = -30; x <= 30; x += 6) {
    for (let z = -30; z <= 30; z += 6) {
      const c = flat.inspect(x, z);
      let seenAir = false;
      for (let y = 2; y < CHUNK_HEIGHT; y++) {
        const solid = c.blocks[y] !== 0;
        if (!solid) seenAir = true;
        else ok(!seenAir, `(${x},${z}) y=${y} 出现了 solid→air→solid`);
      }
    }
  }
});

test('洞穴密度参数确实改变地下空腔数量', () => {
  const noCave = survey(createTerrain3D({ caves: 0 }, NO_VEG));
  const many = survey(createTerrain3D({ caves: 1 }, NO_VEG));
  ok(many.caves > noCave.caves * 3 + 50, `caves=0:${noCave.caves} caves=1:${many.caves}`);
});

test('浮岛密度参数确实改变浮岛数量', () => {
  // 岩板（relief）也能在地表上方造出局部凸岩，因此一并关闭才是纯 2D 基线
  const none = survey(createTerrain3D({ islands: 0, relief: 0 }, NO_VEG));
  ok(none.floating === 0 && s.floating > 100, `纯2D:${none.floating} islands=1:${s.floating}`);
});

test('矿脉密度参数为 0 时完全无矿', () => {
  const g = createTerrain3D({ ores: 0 }, NO_VEG);
  let n = 0;
  for (let x = -40; x <= 40; x += 4) {
    for (let z = -40; z <= 40; z += 4) {
      for (const v of g.inspect(x, z).blocks) if (ORE(v)) n++;
    }
  }
  ok(n === 0, `ores=0 仍出现 ${n} 个矿石`);
});

test('resolveIds 在方块库缺失时能从注册表按 local 名降级解析', () => {
  const blocks = new BlockRegistry();
  const grass = blocks.define('probe', 'grass', { opaque: true, solid: true });
  const stone = blocks.define('probe', 'stone', { opaque: true, solid: true });
  const ids = resolveIds({ blocks });
  ok(ids.grass === grass && ids.stone === stone, JSON.stringify(ids));
});

test('GENERATOR 服务：3D 以 priority 30 顶掉 2D 流水线，卸载后自动回退', () => {
  const reg = new ServiceRegistry();
  const p2 = { id: 'cordis-terrain-v1', surfaceY: () => 0, blockAt: () => 0 } as IGenerator;
  const p3 = { id: 'density3d-v1', surfaceY: () => 0, blockAt: () => 0 } as IGenerator;
  const off2 = reg.provide(GENERATOR, p2, { priority: 20 });
  const off3 = reg.provide(GENERATOR, p3, { priority: 30 });
  ok(reg.get(GENERATOR) === p3, '未切换到 3D');
  off3();
  ok(reg.get(GENERATOR) === p2, '卸载 3D 后未回退到 2D 流水线');
  off2();
  ok(reg.tryGet(GENERATOR) === undefined);
});

test('真实插件清单包含 3D 插件且声明 generator 能力', () => {
  const p = extendedPlugins().find((x) => x.id === 'voxel.terrain-3d');
  ok(!!p, '扩展清单缺少 voxel.terrain-3d');
  ok(!!p!.provides?.includes('generator'), '未声明 generator 能力');
  ok((p!.optionalDependencies ?? []).includes('cap:blockLibrary'));
});

test('World 集成：3D 生成器 + 无限窗口 + 负坐标 chunk 体素一致', () => {
  const gen = createTerrain3D({}, IDS);
  const world = new World(new BlockRegistry(), new EventBus());
  world.setGenerator(gen);
  world.enableStreaming({ radius: 2, centerCx: 0, centerCz: 0 });
  world.pregenerate();
  ok(world.keys().length === 25, `chunks=${world.keys().length}`);
  ok(world.keys().includes('-2,-2'), '负坐标 chunk 未生成');
  for (const [x, z, y] of [[3, 4, 20], [-1, -1, 8], [-30, -30, 25], [31, 31, 12]] as const) {
    ok(world.getBlock(x, y, z) === gen.blockAt(x, y, z, 0),
      `(${x},${y},${z}) 世界体素与生成器不一致`);
  }
});

test('流式跨 chunk 连续：同一世界坐标不因 chunk 边界而不同', () => {
  const gen = createTerrain3D({}, IDS);
  const world = new World(new BlockRegistry(), new EventBus());
  world.setGenerator(gen);
  world.enableStreaming({ radius: 1, centerCx: 0, centerCz: 0 });
  world.pregenerate();
  const before = gen.blockAt(-1, 20, 0, 0);
  ok(world.getBlock(-1, 20, 0) === before);
  world.updateStreaming(1, 0);
  gen.resetCache(); // 清掉列缓存，模拟「换一批 chunk 后重算」
  ok(gen.blockAt(-1, 20, 0, 0) === before, '重算结果漂移');
  ok(world.getBlock(16, 20, 0) === gen.blockAt(16, 20, 0, 0));
});

test('3D 世界存档往返：体素逐字节一致', () => {
  const hub = new BinaryHub();
  const gen = createTerrain3D({}, IDS);
  const world = new World(new BlockRegistry(), new EventBus());
  world.setGenerator(gen);
  world.enableStreaming({ radius: 1, centerCx: 0, centerCz: 0 });
  world.pregenerate();
  world.setBlock(3, 20, 3, 7);
  const env = world.toEnvelope(hub);
  const entries = hub.decode(env);
  ok(entries.filter((e) => e.tag === CHUNK_TAG).length === 9, 'chunk 段数量不对');

  const fresh = new World(new BlockRegistry(), new EventBus());
  fresh.setGenerator(createTerrain3D({}, IDS));
  fresh.enableStreaming({ radius: 1, centerCx: 0, centerCz: 0 });
  fresh.pregenerate();
  const info = fresh.fromEnvelope(hub, env);
  ok(info.chunks === 9, `restored=${info.chunks}`);
  for (const c of [0, 1, -1]) {
    for (const [x, y, z] of [[c * CHUNK_SIZE + 2, 20, 3], [3, 5, 3]] as const) {
      ok(fresh.getBlock(x, y, z) === world.getBlock(x, y, z),
        `(${x},${y},${z}) 读档后不一致`);
    }
  }
  ok(fresh.getBlock(3, 20, 3) === 7, '玩家改动在读档后丢失');
});

test('分帧加载：maxLoad 限制生效，多帧最终铺满且脚下优先', () => {
  const world = new World(new BlockRegistry(), new EventBus());
  world.setGenerator(createTerrain3D({}, IDS));
  world.enableStreaming({ radius: 3, centerCx: 0, centerCz: 0 });
  const r1 = world.updateStreaming(0, 0, true, 3);
  ok(r1.loaded.length === 3 && r1.pending === 46, `loaded=${r1.loaded.length} pending=${r1.pending}`);
  ok(r1.loaded.includes('0,0'), '中心 chunk 未优先加载');
  let guard = 0, pending = r1.pending;
  while (pending > 0 && guard++ < 60) {
    pending = world.updateStreaming(0, 0, false, 7).pending;
  }
  ok(pending === 0 && world.keys().length === 49,
    `pending=${pending} chunks=${world.keys().length} guard=${guard}`);
});

test('性能：81 个 chunk 等价列数的生成耗时在预算内', () => {
  const gen = createTerrain3D({}, IDS);
  const t0 = performance.now();
  for (let cx = -4; cx <= 4; cx++) {
    for (let cz = -4; cz <= 4; cz++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
          gen.blockAt(cx * CHUNK_SIZE + x, 20, cz * CHUNK_SIZE + z, 0);
        }
      }
    }
  }
  const ms = performance.now() - t0;
  ok(ms < 3000, `81 chunks 耗时 ${ms.toFixed(0)}ms 超出预算`);
  console.log(`      ↳ 实测 ${ms.toFixed(0)}ms / 20736 列 (${(ms / 20736 * 1000).toFixed(1)}us/列)`);
});

test('SEA_LEVEL 以下低洼会积水，深层洞穴不被灌满', () => {
  const gen = createTerrain3D({}, IDS);
  let water = 0, deepAir = 0;
  for (let x = -60; x <= 60; x += 4) {
    for (let z = -60; z <= 60; z += 4) {
      const c = gen.inspect(x, z);
      for (let y = 2; y < c.surface - 3; y++) if (c.blocks[y] === 0) deepAir++;
      for (let y = 0; y <= SEA_LEVEL; y++) if (c.blocks[y] === IDS.water) water++;
    }
  }
  ok(water > 0 && deepAir > 0, `water=${water} deepAir=${deepAir}`);
});

console.log(`\n结果：${pass}/${pass + fail} 通过`);
if (fail > 0) process.exitCode = 1;
