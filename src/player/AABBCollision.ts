import * as THREE from 'three';
import {
  CHUNK_HEIGHT, MAX_STEP_UP, PLAYER_HEIGHT, PLAYER_RADIUS, VOID_GROUND_Y,
} from '../config';
// VOID_GROUND_Y 仍作为「虚空列」的兜底脚底高度
import type { World } from '../world/World';
import type { ICollision, VerticalResult } from './ICollision';

const EPS = 0.001;

/**
 * M2：真正的玩家 AABB（0.6 × 1.8 × 0.6）vs 体素盒碰撞。
 *
 * 与 v0.2 GroundFollowCollision 的区别：
 * - 头顶有方块时跳不起来；洞穴、悬空平台、桥下空间在物理上真实存在
 * - 水平移动按轴解算，被墙挡住时另一轴仍可滑动，可自动登 1 格台阶
 * - 地面从「玩家当前高度向下」扫描，不再把整列最高方块当唯一地面
 *
 * 通过 COLLISION 服务以更高 priority 顶替内置实现，控制器一行未改。
 */
export class AABBCollision implements ICollision {
  readonly id = 'aabb-v2';
  /**
   * move / resolveVertical 都会刷新，groundAt 以它为扫描上界。
   * -1 表示尚未发生过移动：控制器 setCollision 时会先问一次地面，
   * 此时必须退回「整列最高实体」，否则玩家会被瞬移到地下 y≈1。
   */
  private lastY = -1;

  move(pos: THREE.Vector3, delta: THREE.Vector3, world: World): void {
    this.lastY = pos.y;
    const b = world.bounds;
    this.tryAxis(pos, 'x', delta.x, world, b.minX, b.maxX);
    this.tryAxis(pos, 'z', delta.z, world, b.minZ, b.maxZ);
  }

  private tryAxis(
    pos: THREE.Vector3, axis: 'x' | 'z', d: number,
    world: World, min: number, max: number,
  ): void {
    if (Math.abs(d) < 1e-9) return;
    const old = pos[axis];
    let next = old + d;
    // 有限世界边缘：浮空岛外是虚空，用玩家半宽留出余量
    next = Math.max(min + PLAYER_RADIUS + EPS, Math.min(max - PLAYER_RADIUS - EPS, next));
    const nx = axis === 'x' ? next : pos.x;
    const nz = axis === 'z' ? next : pos.z;

    if (!this.overlaps(world, nx, pos.y, nz)) { pos[axis] = next; return; }

    // 自动登 1 格台阶：抬升后当前位置与目标位置都必须无碰撞
    const stepY = Math.floor(pos.y + EPS) + 1;
    if (stepY - pos.y <= MAX_STEP_UP + EPS
      && !this.overlaps(world, nx, stepY, nz)
      && !this.overlaps(world, pos.x, stepY, pos.z)) {
      pos[axis] = next;
      pos.y = stepY;
      this.lastY = stepY;
      return;
    }
    // 被挡住就保持原坐标；另一轴独立解算，所以贴墙仍能滑动
    pos[axis] = old;
  }

  /** 玩家盒与任何 solid 体素是否重叠 */
  private overlaps(world: World, x: number, y: number, z: number): boolean {
    const r = PLAYER_RADIUS - EPS;
    const minX = Math.floor(x - r), maxX = Math.floor(x + r);
    const minZ = Math.floor(z - r), maxZ = Math.floor(z + r);
    const minY = Math.floor(y + EPS), maxY = Math.floor(y + PLAYER_HEIGHT - EPS);
    for (let yy = minY; yy <= maxY; yy++) {
      for (let zz = minZ; zz <= maxZ; zz++) {
        for (let xx = minX; xx <= maxX; xx++) {
          if (world.isSolid(world.getBlock(xx, yy, zz))) return true;
        }
      }
    }
    return false;
  }

  private columnSolid(world: World, x: number, y: number, z: number): boolean {
    const r = PLAYER_RADIUS - EPS;
    for (const dx of [-r, r]) {
      for (const dz of [-r, r]) {
        if (world.isSolid(world.getBlock(Math.floor(x + dx), y, Math.floor(z + dz)))) return true;
      }
    }
    return false;
  }

  /** 从玩家当前高度向下找第一个可站立面，且不允许一次抬升超过 MAX_STEP_UP */
  groundAt(world: World, x: number, z: number): number {
    if (this.lastY < 0) return world.groundY(x, z);
    const start = Math.min(CHUNK_HEIGHT - 1, Math.floor(this.lastY + 0.5));
    for (let y = start; y >= 0; y--) {
      if (this.columnSolid(world, x, y, z)) {
        return Math.min(y + 1, this.lastY + MAX_STEP_UP);
      }
    }
    return VOID_GROUND_Y;
  }

  resolveVertical(world: World, pos: THREE.Vector3, deltaY: number): VerticalResult {
    this.lastY = pos.y;
    if (Math.abs(deltaY) < 1e-9) return { y: pos.y, grounded: false, hitCeiling: false };
    const nextY = pos.y + deltaY;
    if (!this.overlaps(world, pos.x, nextY, pos.z)) {
      return { y: nextY, grounded: false, hitCeiling: false };
    }
    if (deltaY < 0) {
      const g = this.groundAt(world, pos.x, pos.z);
      return { y: Math.max(g, nextY), grounded: true, hitCeiling: false };
    }
    // 上升撞头：二分收敛到贴着天花板的最大不重叠高度
    let lo = pos.y, hi = nextY;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      if (this.overlaps(world, pos.x, mid, pos.z)) hi = mid;
      else lo = mid;
    }
    return { y: lo, grounded: false, hitCeiling: true };
  }
}
