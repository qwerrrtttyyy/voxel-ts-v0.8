/* 游戏逻辑专项验收：可复现，不依赖 WebGL */
import * as THREE from 'three';
import { EventBus } from '../src/core/EventBus';
import { Input } from '../src/core/Input';
import { FIXED_STEP, SEA_LEVEL } from '../src/config';
import { TextureAtlas, type TilePainter } from '../src/render/TextureAtlas';
import { AIR_ID, BlockRegistry } from '../src/world/BlockRegistry';
import { World } from '../src/world/World';
import type { IGenerator } from '../src/world/IGenerator';
import { CulledMesher } from '../src/world/mesher/CulledMesher';
import { FirstPersonController } from '../src/player/FirstPersonController';
import { GroundFollowCollision } from '../src/player/ICollision';
import { raycastVoxel } from '../src/player/Raycast';

const results: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  · ' + detail : ''}`);
  if (!cond) process.exitCode = 1;
}

// ---- 最小 DOM ----
function el(): any {
  return { addEventListener() {}, removeEventListener() {}, requestPointerLock() {}, style: {}, width: 800, height: 600 };
}
(globalThis as any).document = {
  getElementById: () => el(), addEventListener() {}, removeEventListener() {}, pointerLockElement: null,
};
(globalThis as any).window = { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1 };

const paint: TilePainter = (set, s) => {
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) set(x, y, 110, 170, 70);
};

function buildWorld() {
  const blocks = new BlockRegistry();
  const events = new EventBus();
  const world = new World(blocks, events);
  const atlas = new TextureAtlas();

  const top = atlas.define('g', 'grass_top', paint);
  const side = atlas.define('g', 'grass_side', paint);
  const dirtTile = atlas.define('g', 'dirt', paint);
  const grass = blocks.define('g', 'grass', {
    opaque: true, solid: true,
    faces: { top, bottom: dirtTile, north: side, south: side, east: side, west: side },
  });
  const dirt = blocks.define('g', 'dirt', { opaque: true, solid: true, all: dirtTile });
  // 非 opaque 但自带贴图：玻璃 / 水这类方块将来必须能渲染自己的面
  const glass = blocks.define('g', 'glass', { opaque: false, solid: true, all: side });

  const gen: IGenerator = {
    id: 'flat-test',
    surfaceY: () => SEA_LEVEL,
    blockAt: (_x, y, _z, s) => y > s ? AIR_ID : y === s ? grass : dirt,
  };
  return { blocks, events, world, atlas, grass, dirt, glass, gen, top, side, dirtTile };
}

function main(): void {
  // ============ 1. 网格几何正确性（画面能不能看见方块）============
  const w1 = buildWorld();
  let regenEvents: Array<{ generatorId: string; chunkCount: number }> = [];
  w1.events.on('world:regenerated', (e) => regenEvents.push(e));
  w1.world.setGenerator(w1.gen);
  w1.world.pregenerate();
  ok('world:regenerated 只发一次且 chunkCount 有效',
    regenEvents.length === 1 && regenEvents[0].chunkCount === 36,
    `events=${regenEvents.length} counts=${regenEvents.map((e) => e.chunkCount).join(',')}`);

  const chunk = w1.world.getChunk(0, 0)!;
  const mesh = new CulledMesher().build(chunk, w1.world, { blocks: w1.blocks, atlas: w1.atlas });
  const pos = new Float32Array(mesh.positions), nrm = new Float32Array(mesh.normals);
  const uv = new Float32Array(mesh.uvs), idx = new Uint32Array(mesh.indices);

  let windingBad = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const ab = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]];
    const ac = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]];
    const cross = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    const dot = cross[0] * nrm[a] + cross[1] * nrm[a + 1] + cross[2] * nrm[a + 2];
    if (dot <= 0) windingBad++;
  }
  ok('三角形绕序与法线一致（FrontSide 下不会整片不可见）', windingBad === 0,
    `${idx.length / 3} 三角形，反向 ${windingBad}`);

  // 侧面 UV：每个面连续 4 顶点。四个面的顶点绕序不同（east/west 是 [底,顶,顶,底]，
  // north/south 是 [底,底,顶,顶]），所以按面分组，比较最低 y 与最高 y 处的 v。
  // v 必须随世界 y 增大，草边才会朝上而不是倒过来。
  let sideFaces = 0, sideWrong = 0;
  const faceCount = nrm.length / 3 / 4;
  for (let f = 0; f < faceCount; f++) {
    if (Math.abs(nrm[f * 4 * 3 + 1]) > 0.5) continue; // 排除 top / bottom
    sideFaces++;
    let minY = Infinity, maxY = -Infinity, vAtMin = 0, vAtMax = 0;
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      const y = pos[i * 3 + 1], v = uv[i * 2 + 1];
      if (y < minY) { minY = y; vAtMin = v; }
      if (y > maxY) { maxY = y; vAtMax = v; }
    }
    if (!(vAtMax > vAtMin)) sideWrong++;
  }
  ok('侧面 UV 的 v 随世界 y 递增（草边朝上）', sideFaces > 0 && sideWrong === 0,
    `侧面 ${sideFaces} 个，方向错误 ${sideWrong}`);

  const topRect = w1.atlas.uvRect(w1.top)!;
  let grassTopOk = false;
  for (let i = 0; i < nrm.length / 3; i++) {
    if (nrm[i * 3 + 1] > 0.5 && uv[i * 2] >= topRect.u0 && uv[i * 2] <= topRect.u1) grassTopOk = true;
  }
  ok('草顶 UV 落在 grass_top tile', grassTopOk);

  ok('非 opaque 方块仍能渲染自己的面（玻璃/水预留）',
    w1.blocks.tileOf(w1.glass, 'top') !== null,
    `glass tile=${String(w1.blocks.tileOf(w1.glass, 'top'))}`);

  // ============ 2. 地面来自实际体素，不是生成器 ============
  const w = buildWorld();
  w.world.setGenerator(w.gen);
  w.world.pregenerate();
  const col = new GroundFollowCollision();
  const ground0 = col.groundAt(w.world, 48.5, 48.5);
  ok('平地脚底高度正确', ground0 === SEA_LEVEL + 1, `ground=${ground0}`);

  const anyWorld = w.world as unknown as { highestSolidY?: (x: number, z: number) => number };
  ok('World 提供 highestSolidY 查询实际体素', typeof anyWorld.highestSolidY === 'function');
  if (anyWorld.highestSolidY) {
    ok('highestSolidY 与实际最高方块一致', anyWorld.highestSolidY.call(w.world, 48, 48) === SEA_LEVEL);
  }

  // 挖掉脚下方块 → 地面应下降
  w.world.setBlock(48, SEA_LEVEL, 48, AIR_ID);
  const groundDug = col.groundAt(w.world, 48.5, 48.5);
  ok('挖掉脚下方块后地面下降（不再浮空）', groundDug === SEA_LEVEL,
    `ground ${ground0} → ${groundDug}`);

  // 放一根高柱 → 地面应上升
  for (let y = SEA_LEVEL; y <= SEA_LEVEL + 4; y++) w.world.setBlock(48, y, 48, w.dirt);
  const groundPillar = col.groundAt(w.world, 48.5, 48.5);
  ok('放置方块后地面上升（不再入地）', groundPillar === SEA_LEVEL + 5,
    `ground=${groundPillar}`);

  // ============ 3. 移动 / 台阶 / 跳跃 ============
  const w2 = buildWorld();
  w2.world.setGenerator(w2.gen);
  w2.world.pregenerate();
  const input = new Input(el());
  const camera = new THREE.PerspectiveCamera(75, 1.4, 0.05, 260);
  const ctrl = new FirstPersonController(camera, input, w2.world, col);
  ctrl.spawn(48.5, 48.5);

  // 方向：yaw=0 时 W 朝 -Z，D 朝 +X
  input.state.forward = true;
  ctrl.update(FIXED_STEP);
  ok('yaw=0 按 W 朝 -Z 前进', ctrl.feet.z < 48.5 && Math.abs(ctrl.feet.x - 48.5) < 1e-6,
    `pos=(${ctrl.feet.x.toFixed(3)}, ${ctrl.feet.z.toFixed(3)})`);
  input.state.forward = false;
  ctrl.spawn(48.5, 48.5);
  input.state.right = true;
  ctrl.update(FIXED_STEP);
  ok('yaw=0 按 D 朝 +X 平移', ctrl.feet.x > 48.5 && Math.abs(ctrl.feet.z - 48.5) < 1e-6,
    `pos=(${ctrl.feet.x.toFixed(3)}, ${ctrl.feet.z.toFixed(3)})`);
  input.state.right = false;

  // 陡坡阻挡：前方筑 5 格高墙，水平移动应被拦住而不是瞬移上去
  ctrl.spawn(48.5, 48.5);
  const wallZ = 47;
  for (let y = SEA_LEVEL + 1; y <= SEA_LEVEL + 5; y++) w2.world.setBlock(48, y, wallZ, w2.dirt);
  input.state.forward = true;
  for (let i = 0; i < 40; i++) ctrl.update(FIXED_STEP); // 足够走到墙前
  input.state.forward = false;
  ok('陡坡/高墙阻挡水平移动（不再无限爬坡）',
    ctrl.feet.y <= SEA_LEVEL + 2 && ctrl.feet.z > wallZ,
    `feet=(${ctrl.feet.x.toFixed(2)}, ${ctrl.feet.y.toFixed(2)}, ${ctrl.feet.z.toFixed(2)})`);

  // 一级台阶应能通过（用干净世界，别让上一个测试的高墙残留）
  const wStep = buildWorld();
  wStep.world.setGenerator(wStep.gen);
  wStep.world.pregenerate();
  const inputStep = new Input(el());
  const ctrlStep = new FirstPersonController(new THREE.PerspectiveCamera(), inputStep, wStep.world, col);
  ctrlStep.spawn(48.5, 48.5);
  // 铺成一个连续平台，玩家登上去后应稳定站在 y=SEA_LEVEL+2，而不是一走就掉回来
  for (const z of [47, 46, 45, 44, 43]) wStep.world.setBlock(48, SEA_LEVEL + 1, z, wStep.dirt);
  inputStep.state.forward = true;
  let maxStepY = ctrlStep.feet.y;
  for (let i = 0; i < 30; i++) { ctrlStep.update(FIXED_STEP); maxStepY = Math.max(maxStepY, ctrlStep.feet.y); }
  inputStep.state.forward = false;
  ok('一级台阶可正常登上并稳定站立',
    maxStepY >= SEA_LEVEL + 2 && Math.abs(ctrlStep.feet.y - (SEA_LEVEL + 2)) < 1e-6 && ctrlStep.feet.z < 47,
    `peak=${maxStepY.toFixed(2)} final=(${ctrlStep.feet.y.toFixed(2)}, ${ctrlStep.feet.z.toFixed(2)})`);

  // 跳跃：上升过程中不能被地面 clamp 掉
  ctrl.spawn(48.5, 48.5);
  input.state.jump = true;
  ctrl.update(FIXED_STEP);
  const jumpY = ctrl.feet.y;
  ok('跳跃有正向上升速度', jumpY > SEA_LEVEL + 1, `y=${jumpY.toFixed(3)}`);
  input.state.jump = false;
  let maxY = jumpY;
  for (let i = 0; i < 90; i++) { ctrl.update(FIXED_STEP); maxY = Math.max(maxY, ctrl.feet.y); }
  ok('跳跃后自然落回地面', Math.abs(ctrl.feet.y - (SEA_LEVEL + 1)) < 1e-6 && maxY > jumpY,
    `peak=${maxY.toFixed(2)} final=${ctrl.feet.y.toFixed(2)}`);
  ok('整段模拟无 NaN / 未掉出世界', Number.isFinite(ctrl.feet.y) && ctrl.feet.y > 0);

  // 世界边缘：一直往前跑也不能走出浮空岛掉进虚空（用干净世界，避开前面的高墙）
  const wEdge = buildWorld();
  wEdge.world.setGenerator(wEdge.gen);
  wEdge.world.pregenerate();
  const edgeInput = new Input(el());
  const edgeCtrl = new FirstPersonController(
    new THREE.PerspectiveCamera(), edgeInput, wEdge.world, col,
  );
  edgeCtrl.spawn(48.5, 48.5);
  edgeInput.state.forward = true;
  for (let i = 0; i < 800; i++) edgeCtrl.update(FIXED_STEP);
  edgeInput.state.forward = false;
  ok('世界边缘阻挡玩家，不会悬在虚空 y=0',
    edgeCtrl.feet.z >= 0 && Math.abs(edgeCtrl.feet.y - (SEA_LEVEL + 1)) < 1e-6,
    `feet=(${edgeCtrl.feet.x.toFixed(2)}, ${edgeCtrl.feet.y.toFixed(2)}, ${edgeCtrl.feet.z.toFixed(2)})`);

  // 跳跃瞬间脚下被放方块：跳跃不能被吞掉
  const w3 = buildWorld();
  w3.world.setGenerator(w3.gen);
  w3.world.pregenerate();
  const input3 = new Input(el());
  const ctrl3 = new FirstPersonController(new THREE.PerspectiveCamera(), input3, w3.world, col);
  ctrl3.spawn(48.5, 48.5);
  w3.world.setBlock(48, SEA_LEVEL + 1, 48, w3.dirt); // 脚边抬高一格
  input3.state.jump = true;
  ctrl3.update(FIXED_STEP);
  ok('跳跃与地形抬升同帧时不被吞掉', ctrl3.feet.y > SEA_LEVEL + 2,
    `y=${ctrl3.feet.y.toFixed(3)}`);
  input3.state.jump = false;

  // yaw 归一化
  ctrl.yaw = Math.PI * 2 + 0.3;
  input.state.lookX = 0;
  ctrl.update(FIXED_STEP);
  ok('yaw 归一化避免长时间游玩后精度下降', Math.abs(ctrl.yaw) <= Math.PI * 2 + 1e-6,
    `yaw=${ctrl.yaw.toFixed(4)}`);

  // ============ 4. 射线拾取 ============
  const solidBlock = w1.grass;
  const inside = raycastVoxel(
    new THREE.Vector3(48.5, SEA_LEVEL + 0.5, 48.5),
    new THREE.Vector3(0, 1, 0), 6, w1.world, w1.blocks,
  );
  ok('射线起点在方块内时命中该方块', !!inside && inside.id === solidBlock,
    `hit=${inside ? `${inside.id}@${inside.x},${inside.y},${inside.z}` : 'null'}`);
  ok('起点在方块内时法线不为全零（M2 放方块需要方向）',
    !!inside && (inside.nx !== 0 || inside.ny !== 0 || inside.nz !== 0),
    inside ? `n=(${inside.nx},${inside.ny},${inside.nz})` : 'null');

  const upHit = raycastVoxel(
    new THREE.Vector3(48.5, SEA_LEVEL + 1.62, 48.5),
    new THREE.Vector3(0, -1, 0), 6, w1.world, w1.blocks,
  );
  ok('向下射线命中草方块且法线为 +Y',
    !!upHit && upHit.y === SEA_LEVEL && upHit.ny === 1,
    upHit ? `y=${upHit.y} n=(${upHit.nx},${upHit.ny},${upHit.nz})` : 'null');

  const skyHit = raycastVoxel(
    new THREE.Vector3(48.5, SEA_LEVEL + 1.62, 48.5),
    new THREE.Vector3(0, 1, 0), 6, w1.world, w1.blocks,
  );
  ok('向天空射线返回 null', skyHit === null);

  // ============ 5. dirty 队列只入已存在的 chunk ============
  const w4 = buildWorld();
  w4.world.setGenerator(w4.gen);
  w4.world.pregenerate();
  w4.world.clearDirty();
  w4.world.setBlock(0, SEA_LEVEL, 0, w4.dirt); // chunk (0,0) 左/下边界
  const pending = w4.world.pendingDirty;
  ok('边界标记不会把不存在的 chunk 塞进重建队列', pending === 1,
    `pending=${pending}`);

  console.log('\n===== 游戏逻辑专项验收 =====');
  console.log(results.join('\n'));
  console.log(`\n结果：${results.filter((r) => r.startsWith('PASS')).length}/${results.length} 通过`);
}

main();
