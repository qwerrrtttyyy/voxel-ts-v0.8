import * as THREE from 'three';
import { AIR_ID, type BlockRegistry } from '../world/BlockRegistry';
import type { World } from '../world/World';

export interface VoxelHit {
  x: number; y: number; z: number;
  id: number;
  /** 命中面的法线，用于「放在哪一面」 */
  nx: number; ny: number; nz: number;
  distance: number;
  /** 射线起点就在实心方块内：M2 放方块时应禁止往玩家身体里塞 */
  fromInside: boolean;
}

/**
 * Amanatides & Woo 体素 DDA 射线。
 * 首版只给 HUD 显示准星目标；M2 挖/放直接复用它的 nx/ny/nz。
 */
export function raycastVoxel(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  maxDist: number,
  world: World,
  blocks: BlockRegistry,
): VoxelHit | null {
  const d = direction.clone().normalize();
  let x = Math.floor(origin.x);
  let y = Math.floor(origin.y);
  let z = Math.floor(origin.z);

  const sx = Math.sign(d.x), sy = Math.sign(d.y), sz = Math.sign(d.z);
  const ax = Math.abs(d.x), ay = Math.abs(d.y), az = Math.abs(d.z);
  const tdx = ax === 0 ? Infinity : 1 / ax;
  const tdy = ay === 0 ? Infinity : 1 / ay;
  const tdz = az === 0 ? Infinity : 1 / az;

  let tx = ax === 0 ? Infinity : ((sx > 0 ? x + 1 - origin.x : origin.x - x) / ax);
  let ty = ay === 0 ? Infinity : ((sy > 0 ? y + 1 - origin.y : origin.y - y) / ay);
  let tz = az === 0 ? Infinity : ((sz > 0 ? z + 1 - origin.z : origin.z - z) / az);

  // 起点在方块内时要给一个确定法线，不能全零 —— 否则 M2 无法判断放置方向
  let nx = 0, ny = -1, nz = 0;
  let t = 0;

  // 命中条件只看「是否非空气」：opaque 只用于渲染剔除，不该让玻璃 / 水 / 树叶无法拾取。
  // blocks 参数保留以兼容既有调用方与未来的方块属性扩展。
  void blocks;
  for (let i = 0; i < 512; i++) {
    const id = world.getBlock(x, y, z);
    if (id !== AIR_ID) {
      return { x, y, z, id, nx, ny, nz, distance: t, fromInside: i === 0 };
    }

    if (tx <= ty && tx <= tz) {
      x += sx; t = tx; tx += tdx; nx = -sx; ny = 0; nz = 0;
    } else if (ty <= tz) {
      y += sy; t = ty; ty += tdy; nx = 0; ny = -sy; nz = 0;
    } else {
      z += sz; t = tz; tz += tdz; nx = 0; ny = 0; nz = -sz;
    }
    if (t > maxDist || !Number.isFinite(t)) return null;
  }
  return null;
}
