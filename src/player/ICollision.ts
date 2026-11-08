import * as THREE from 'three';
import type { World } from '../world/World';
import { MAX_STEP_UP } from '../config';

/** 留一点余量，避免正好站在体素边界上反复判定 */
const EDGE_INSET = 0.001;

/**
 * 碰撞策略接口。首版 GroundFollowCollision 做「实际体素地面 + 台阶限制」，
 * M2 换成 AABBCollision（体素 AABB vs 玩家胶囊）时控制器一行不用改。
 */
export interface VerticalResult {
  y: number;
  grounded: boolean;
  hitCeiling: boolean;
}

export interface ICollision {
  readonly id: string;
  /** 就地修改 pos，处理水平阻挡与台阶 */
  move(pos: THREE.Vector3, delta: THREE.Vector3, world: World): void;
  /** 脚底应处的位置（y），必须来自实际体素 */
  groundAt(world: World, x: number, z: number): number;
  /**
   * v0.3 可选扩展：完整 AABB 的垂直解算（头顶碰撞 + 任意高度落地）。
   * 未实现时控制器沿用 v0.2 的「列级贴地」逻辑，保证旧验收脚本零改动。
   */
  resolveVertical?(world: World, pos: THREE.Vector3, deltaY: number): VerticalResult;
}

export class GroundFollowCollision implements ICollision {
  readonly id = 'ground-follow-v1';

  /**
   * 水平移动 + 台阶限制：目标地面比脚底高出超过 MAX_STEP_UP 就回滚这一步，
   * 避免「贴地跟随」把玩家瞬移到任意高的崖顶（首版的真实缺陷）。
   */
  move(pos: THREE.Vector3, delta: THREE.Vector3, world: World): void {
    const oldX = pos.x, oldZ = pos.z;
    // 边界来自世界实际已生成的 chunk（M3 无限地形自动适配），不再硬编码尺寸
    const b = world.bounds;
    pos.x = Math.max(b.minX + EDGE_INSET, Math.min(b.maxX - EDGE_INSET, pos.x + delta.x));
    pos.z = Math.max(b.minZ + EDGE_INSET, Math.min(b.maxZ - EDGE_INSET, pos.z + delta.z));
    // 用「脚下原地面」而非当前脚底 y 作基准：跳跃腾空时也不能飘过高墙，
    // 否则玩家会被随后的地面夹紧逻辑瞬移到崖顶。
    const baseGround = this.groundAt(world, oldX, oldZ);
    const allowed = (x: number, z: number): boolean =>
      this.groundAt(world, x, z) - baseGround <= MAX_STEP_UP;
    if (!allowed(pos.x, pos.z)) {
      // 分轴回退：贴着墙走时仍能沿墙滑动，而不是被完全钉死
      if (allowed(pos.x, oldZ)) pos.z = oldZ;
      else if (allowed(oldX, pos.z)) pos.x = oldX;
      else { pos.x = oldX; pos.z = oldZ; }
    }
  }

  groundAt(world: World, x: number, z: number): number {
    return world.groundY(x, z);
  }
}
