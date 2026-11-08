/**
 * v0.6 分区系统 + 无限生成专项验收（不依赖 WebGL）。
 *
 * 覆盖：负坐标生成、滑动窗口增删、编辑 chunk 按 region 归档与恢复、
 * 边界跟随、dirty 队列清理、区域索引二进制、整份存档 / 按区导出导入、
 * 流式事件，以及「不开启流式时行为与 v0.5 完全一致」的回归保护。
 */
import { BinaryHub } from '../src/binary/BinaryHub';
import { CHUNK_TAG } from '../src/binary/ChunkCodec';
import {
  REGION_TAG, encodeRegionIndex, decodeRegionIndex,
} from '../src/world/RegionCodec';
import {
  regionCoord, regionKeyOf, regionBounds, windowRegions,
} from '../src/world/RegionManager';
import { EventBus } from '../src/core/EventBus';
import { BlockRegistry } from '../src/world/BlockRegistry';
import { World } from '../src/world/World';
import type { IGenerator } from '../src/world/IGenerator';
import { CHUNK_SIZE, REGION_CHUNKS, SEA_LEVEL, WORLD_CHUNKS } from '../src/config';

let pass = 0, fail = 0;
function test(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`PASS  ${name}`); }
  catch (err) { fail++; console.log(`FAIL  ${name}  · ${err instanceof Error ? err.message : String(err)}`); }
}
function ok(cond: boolean, msg = 'assertion failed'): void { if (!cond) throw new Error(msg); }

const gen: IGenerator = {
  id: 'flat-infinite-v1',
  surfaceY: () => SEA_LEVEL,
  blockAt: (_x, y, _z, s) => (y > s ? 0 : y === s ? 1 : 2),
};

function build(streaming = false, radius = 2) {
  const events = new EventBus();
  const blocks = new BlockRegistry();
  const world = new World(blocks, events);
  world.setGenerator(gen);
  if (streaming) world.enableStreaming({ radius, centerCx: 0, centerCz: 0 });
  world.pregenerate();
  return { world, events, blocks };
}

console.log('\n----- 分区与无限生成 -----');

test('未开启流式时仍是有限 6×6 浮空岛，存档无区域段', () => {
  const { world } = build(false);
  ok(world.keys().length === WORLD_CHUNKS * WORLD_CHUNKS, `chunks=${world.keys().length}`);
  ok(world.streamInfo.enabled === false);
  const env = world.toEnvelope(new BinaryHub());
  ok(!new BinaryHub().decode(env).some((e) => e.tag === REGION_TAG));
});

test('区域划分正确处理负坐标与边界', () => {
  ok(regionCoord(0) === 0 && regionCoord(REGION_CHUNKS - 1) === 0);
  ok(regionCoord(-1) === -1 && regionCoord(-REGION_CHUNKS) === -1);
  ok(regionCoord(-REGION_CHUNKS - 1) === -2, `got ${regionCoord(-REGION_CHUNKS - 1)}`);
  ok(regionKeyOf(-1, -17) === '-1,-2');
  const b = regionBounds(-1, 0);
  ok(b.minX === -REGION_CHUNKS * CHUNK_SIZE && b.maxX === 0);
});

test('窗口覆盖跨负坐标的多个 region', () => {
  const keys = windowRegions(0, 0, REGION_CHUNKS);
  ok(keys.includes('-1,-1') && keys.includes('0,0') && keys.includes('0,1'));
  // 半径 1 的窗口横跨 chunk -1..1，正好落在 (-1,-1)/(0,0) 四个 region 的交界
  ok(windowRegions(0, 0, 1).length === 4 && windowRegions(0, 0, 1).includes('-1,0'));
});

test('无限生成：窗口含负坐标 chunk 且体素正确', () => {
  const { world } = build(true, 2);
  ok(world.keys().length === 25, `chunks=${world.keys().length}`);
  ok(world.keys().includes('-2,-2'), '应生成负坐标 chunk');
  const wx = -2 * CHUNK_SIZE + 3, wz = -2 * CHUNK_SIZE + 4;
  ok(world.getBlock(wx, SEA_LEVEL, wz) === 1, `grass=${world.getBlock(wx, SEA_LEVEL, wz)}`);
  ok(world.getBlock(wx, SEA_LEVEL + 1, wz) === 0);
  ok(world.getBlock(wx, SEA_LEVEL - 1, wz) === 2);
});

test('滑动窗口：中心右移一格，加载新列 / 卸载旧列', () => {
  const { world } = build(true, 2);
  const r = world.updateStreaming(1, 0);
  ok(r.loaded.length === 5 && r.unloaded.length === 5,
    `loaded=${r.loaded.length} unloaded=${r.unloaded.length}`);
  ok(world.keys().includes('3,0') && !world.keys().includes('-2,0'));
  ok(world.keys().length === 25);
});

test('中心不变时窗口更新是 O(1) 空操作', () => {
  const { world } = build(true, 2);
  const r = world.updateStreaming(0, 0);
  ok(r.loaded.length === 0 && r.unloaded.length === 0);
});

test('编辑过的 chunk 卸载后按 region 归档，回来原样恢复', () => {
  const { world } = build(true, 2);
  const wx = -2 * CHUNK_SIZE + 5, wz = -2 * CHUNK_SIZE + 5;
  ok(world.setBlock(wx, SEA_LEVEL + 1, wz, 7));
  ok(world.getBlock(wx, SEA_LEVEL + 1, wz) === 7);
  world.updateStreaming(3, 3); // 把 (-2,-2) 彻底移出窗口
  ok(!world.keys().includes('-2,-2'));
  const info = world.streamInfo;
  ok(info.archived === 1 && info.regions >= 1,
    `archived=${info.archived} regions=${info.regions}`);
  const back = world.updateStreaming(0, 0);
  ok(back.restored === 1, `restored=${back.restored}`);
  ok(world.getBlock(wx, SEA_LEVEL + 1, wz) === 7, '改动必须被恢复');
  ok(world.streamInfo.archived === 0);
});

test('未编辑 chunk 卸载后不归档，回来由生成器确定性重建', () => {
  const { world } = build(true, 2);
  world.updateStreaming(3, 3);
  ok(world.streamInfo.archived === 0, `archived=${world.streamInfo.archived}`);
  const before = world.getBlock(-2 * CHUNK_SIZE + 5, SEA_LEVEL, -2 * CHUNK_SIZE + 5);
  ok(before === 0, '窗口外是空气');
  world.updateStreaming(0, 0);
  ok(world.getBlock(-2 * CHUNK_SIZE + 5, SEA_LEVEL, -2 * CHUNK_SIZE + 5) === 1);
});

test('世界边界跟随窗口，玩家不会被固定边界钉死', () => {
  const { world } = build(true, 2);
  const b0 = world.bounds;
  world.updateStreaming(10, -6);
  const b1 = world.bounds;
  ok(b1.minX > b0.minX && b1.minZ < b0.minZ,
    `${JSON.stringify(b0)} → ${JSON.stringify(b1)}`);
  ok(world.keys().includes('12,-4'));
});

test('卸载的 chunk 不会残留在 dirty 重建队列', () => {
  const { world } = build(true, 2);
  world.updateStreaming(2, 0);
  const keys = new Set(world.keys());
  for (let i = 0; i < 100 && world.pendingDirty > 0; i++) {
    for (const k of world.takeDirty(8)) ok(keys.has(k), `脏 key ${k} 已卸载`);
  }
  ok(world.pendingDirty === 0);
});

test('流式事件：chunk:streamed / region:changed 均发出', () => {
  const { world, events } = build(true, 2);
  let streamed = 0, regions = 0;
  events.on('chunk:streamed', () => { streamed++; });
  events.on('region:changed', () => { regions++; });
  world.updateStreaming(1, 0);
  ok(streamed >= 10, `streamed=${streamed}`);
  ok(regions >= 1, `regions=${regions}`);
});

test('区域索引二进制 round-trip（含负数与 active 标志）', () => {
  const entries = [
    { rx: -1, rz: 0, chunkCount: 3, editedCount: 1, active: true },
    { rx: 0, rz: -2, chunkCount: 0, editedCount: 0, active: false },
  ];
  const decoded = decodeRegionIndex(encodeRegionIndex(entries));
  ok(JSON.stringify(decoded) === JSON.stringify(entries), JSON.stringify(decoded));
});

test('整份存档带区域索引段与归档 chunk，读档后改动不丢', () => {
  const { world } = build(true, 2);
  const wx = -2 * CHUNK_SIZE + 2, wz = -2 * CHUNK_SIZE + 2;
  world.setBlock(wx, SEA_LEVEL + 1, wz, 9);
  world.updateStreaming(4, 4); // 改动 chunk 已归档
  ok(world.streamInfo.archived === 1);

  const hub = new BinaryHub();
  const env = world.toEnvelope(hub);
  const entries = hub.decode(env);
  ok(entries.some((e) => e.tag === REGION_TAG), '缺少区域索引段');
  ok(entries.filter((e) => e.tag === CHUNK_TAG).length === 26,
    `chunk 段=${entries.filter((e) => e.tag === CHUNK_TAG).length}`);

  const fresh = build(true, 2).world;
  const info = fresh.fromEnvelope(hub, env);
  ok(info.chunks === 26, `restored=${info.chunks}`);
  ok(fresh.restoredRegionIndex.length >= 1);
  fresh.updateStreaming(0, 0);
  ok(fresh.getBlock(wx, SEA_LEVEL + 1, wz) === 9, '归档改动在读档后丢失');
});

test('按区域导出 / 合并导入只搬运目标 region', () => {
  const { world } = build(true, 2);
  const hub = new BinaryHub();
  const env = world.toRegionEnvelope(hub, 0, 0);
  const entries = hub.decode(env);
  ok(entries.some((e) => e.tag === REGION_TAG));
  ok(entries.filter((e) => e.tag === CHUNK_TAG).length === 9,
    `region 0,0 应有 3×3=9 个 chunk，实际 ${entries.filter((e) => e.tag === CHUNK_TAG).length}`);

  const other = build(true, 2).world; // 窗口 -2..2，足以容纳 region 0,0 的 0..2
  const r = other.fromRegionEnvelope(hub, env);
  ok(r.chunks === 9 && r.regions.includes('0,0'), JSON.stringify(r));
  ok(r.archived === 0 && other.keys().includes('2,2'), '窗口内的 chunk 应直接可用');
});

test('视距半径变化时立即补齐窗口', () => {
  const { world } = build(true, 1);
  ok(world.keys().length === 9);
  world.setStreamRadius(3);
  ok(world.streamInfo.radius === 3 && world.keys().length === 49,
    `chunks=${world.keys().length}`);
});

test('关闭流式后保留当前窗口，不突然挖空世界', () => {
  const { world } = build(true, 2);
  world.disableStreaming();
  ok(world.streamInfo.enabled === false && world.keys().length === 25);
  ok(world.updateStreaming(9, 9).loaded.length === 0);
});

console.log(`\n结果：${pass}/${pass + fail} 通过`);
if (fail > 0) process.exitCode = 1;
