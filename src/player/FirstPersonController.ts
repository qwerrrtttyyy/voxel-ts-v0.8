import * as THREE from 'three';
import type { PerspectiveCamera } from 'three';
import type { Input } from '../core/Input';
import type { World } from '../world/World';
import {
  EYE_HEIGHT, GRAVITY, JUMP_SPEED, MOUSE_SENSITIVITY,
  SPRINT_MULTIPLIER, WALK_SPEED,
} from '../config';
import type { ICollision } from './ICollision';

const TWO_PI = Math.PI * 2;

/**
 * 自写第一人称控制器（不依赖 PointerLockControls）。
 * 输入层只给意图；碰撞走 ICollision 接口；相机是唯一被写的东西。
 */
export class FirstPersonController {
  yaw = 0;
  pitch = 0;
  /** 脚底位置 */
  readonly feet = new THREE.Vector3();

  private velocityY = 0;
  private grounded = false;
  private readonly delta = new THREE.Vector3();
  /** v0.6：上一次逻辑帧的视角，供渲染阶段做插值，消除低帧率下的视角滞后 */
  private prevYaw = 0;
  private prevPitch = 0;

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly input: Input,
    private readonly world: World,
    private collision: ICollision,
  ) {
    this.camera.rotation.order = 'YXZ';
  }

  /** 策略热替换：第三方 provide 新 ICollision 时由 PlayerPlugin 调用 */
  setCollision(collision: ICollision): void {
    this.collision = collision;
    this.feet.y = collision.groundAt(this.world, this.feet.x, this.feet.z);
    this.velocityY = 0;
    this.grounded = true;
    this.prevYaw = this.yaw; this.prevPitch = this.pitch;
    this.applyCamera();
  }

  get collisionId(): string { return this.collision.id; }
  get onGround(): boolean { return this.grounded; }
  get verticalSpeed(): number { return this.velocityY; }

  spawn(x: number, z: number): void {
    this.feet.set(x, this.collision.groundAt(this.world, x, z), z);
    this.velocityY = 0;
    this.grounded = true;
    this.prevYaw = this.yaw; this.prevPitch = this.pitch;
    this.applyCamera();
  }

  /**
   * v0.6 渲染插值：逻辑帧之间按 alpha 过渡到当前视角。
   * 只改相机旋转，位置仍由 update 写；yaw 归一化跨 ±π 时走最短弧，
   * 避免插值瞬间反向转一圈。
   */
  render(alpha: number): void {
    const a = Math.max(0, Math.min(1, alpha));
    let d = (this.yaw - this.prevYaw) % TWO_PI;
    if (d > Math.PI) d -= TWO_PI;
    if (d < -Math.PI) d += TWO_PI;
    this.camera.rotation.set(
      this.prevPitch + (this.pitch - this.prevPitch) * a,
      this.prevYaw + d * a,
      0,
    );
  }

  update(dt: number): void {
    this.prevYaw = this.yaw;
    this.prevPitch = this.pitch;
    const look = this.input.consumeLook();
    const sens = MOUSE_SENSITIVITY * (this.input.sensitivity ?? 1);
    this.yaw -= look.x * sens;
    // 归一化到 (-π, π]，避免连续转几小时后浮点精度下降
    this.yaw = ((this.yaw + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
    this.pitch -= look.y * sens;
    const limit = Math.PI / 2 - 0.01;
    this.pitch = Math.max(-limit, Math.min(limit, this.pitch));

    const s = this.input.state;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    // 相机默认看向 -Z：yaw 旋转后 forward = (-sin, 0, -cos)
    const fx = -sin, fz = -cos;
    const rx = cos, rz = -sin;

    let mx = 0, mz = 0;
    if (s.forward) { mx += fx; mz += fz; }
    if (s.back) { mx -= fx; mz -= fz; }
    if (s.right) { mx += rx; mz += rz; }
    if (s.left) { mx -= rx; mz -= rz; }

    const len = Math.hypot(mx, mz);
    const speed = WALK_SPEED * (s.sprint ? SPRINT_MULTIPLIER : 1);
    if (len > 0) {
      this.delta.set((mx / len) * speed * dt, 0, (mz / len) * speed * dt);
      this.collision.move(this.feet, this.delta, this.world);
    }

    // v0.3 创造模式飞行：无重力，Space 上升 / Ctrl 下降，双击 Space 切换
    if (s.flying) {
      const vertical = (s.jump ? 1 : 0) - (s.down ? 1 : 0);
      this.velocityY = 0;
      const ground = this.collision.groundAt(this.world, this.feet.x, this.feet.z);
      this.feet.y = Math.max(ground, this.feet.y + vertical * speed * dt);
      this.grounded = false;
      this.applyCamera();
      return;
    }

    const ground = this.collision.groundAt(this.world, this.feet.x, this.feet.z);

    // 脚下被放方块 / 登上一格台阶时，先把脚抬出方块再处理跳跃，
    // 否则跳跃会被随后的落地 clamp 吞掉（首版真实缺陷）。
    if (ground > this.feet.y) {
      this.feet.y = ground;
      if (this.velocityY < 0) this.velocityY = 0;
      this.grounded = true;
    }

    if (this.grounded && s.jump) {
      this.velocityY = JUMP_SPEED;
      this.grounded = false;
    }

    this.velocityY -= GRAVITY * dt;
    const dy = this.velocityY * dt;

    if (this.collision.resolveVertical) {
      // M2 完整 AABB：头顶碰撞 + 任意高度落地（洞穴 / 悬空平台真实存在）
      const r = this.collision.resolveVertical(this.world, this.feet, dy);
      this.feet.y = r.y;
      this.grounded = r.grounded;
      if (r.grounded || r.hitCeiling) this.velocityY = 0;
    } else {
      // v0.2 列级贴地：只有下落时才落地，上升途中不被地面 clamp 吞掉
      const nextY = this.feet.y + dy;
      if (this.velocityY <= 0 && nextY <= ground) {
        this.feet.y = ground;
        this.velocityY = 0;
        this.grounded = true;
      } else {
        this.feet.y = nextY;
        this.grounded = false;
      }
    }

    this.applyCamera();
  }

  private applyCamera(): void {
    this.camera.rotation.set(this.pitch, this.yaw, 0);
    this.camera.position.set(this.feet.x, this.feet.y + EYE_HEIGHT, this.feet.z);
  }
}
