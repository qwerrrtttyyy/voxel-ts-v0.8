import * as THREE from 'three';
import { chunkKeyPair } from '../config';
import type { World } from '../world/World';
import type { IMesher, MeshContext } from '../world/mesher/IMesher';

/**
 * geometry ↔ mesh 的生命周期 owner。
 * 每个 chunk 一个 Mesh（一次 draw call），dirty 时整体替换并 dispose 旧 geometry。
 */
export class ChunkView {
  private readonly meshes = new Map<string, THREE.Mesh>();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly world: World,
    private mesher: IMesher,
    private readonly meshCtx: MeshContext,
    private readonly material: THREE.Material,
  ) {}

  /**
   * 策略热替换。rebuild=false 时只标记脏，由调用方合并到一次批处理里，
   * 避免「同一插件同时换 mesher + generator」触发两遍全量重建。
   */
  setMesher(mesher: IMesher, rebuild = true): void {
    if (mesher === this.mesher) return;
    this.mesher = mesher;
    for (const key of this.world.keys()) this.world.getChunk(...chunkKeyPair(key))!.dirty = true;
    if (rebuild) this.rebuildAll();
  }

  get mesherId(): string { return this.mesher.id; }

  rebuild(key: string): void {
    const [cx, cz] = chunkKeyPair(key);
    const chunk = this.world.getChunk(cx, cz);
    const old = this.meshes.get(key);
    if (old) {
      this.scene.remove(old);
      old.geometry.dispose();
      this.meshes.delete(key);
    }
    if (!chunk) return;

    const data = this.mesher.build(chunk, this.world, this.meshCtx);
    chunk.dirty = false;
    if (data.positions.length === 0) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
    geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geometry.computeBoundingSphere();

    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.position.set(chunk.cx * chunk.size, 0, chunk.cz * chunk.size);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.scene.add(mesh);
    this.meshes.set(key, mesh);
  }

  rebuildAll(): void {
    for (const key of this.world.keys()) this.rebuild(key);
    this.world.clearDirty();
  }

  /** 每帧最多重建 N 个，消费 World 的 dirty 队列（O(k)） */
  flush(max = 4): void {
    for (const key of this.world.takeDirty(max)) this.rebuild(key);
  }

  /**
   * v0.6：按「帧时间预算」自适应重建，替代固定 12 个/帧。
   *
   * 旧策略在复杂地形 / 慢设备上会因一帧硬重建 12 个 chunk 造成明显掉帧；
   * 新策略每帧最多花 budgetMs 毫秒，超时的 chunk 原样留在 dirty 队列里，
   * 下一帧继续。至少重建 1 个，保证队列不会饿死。
   */
  flushBudgeted(budgetMs = 4, max = 64): number {
    const t0 = performance.now();
    let n = 0;
    while (n < max && this.world.pendingDirty > 0) {
      // 先做后判：即便单个 chunk 就超预算，也保证有进展
      if (n > 0 && performance.now() - t0 >= budgetMs) break;
      const [key] = this.world.takeDirty(1);
      if (!key) break;
      this.rebuild(key);
      n++;
    }
    return n;
  }

  get meshCount(): number { return this.meshes.size; }

  setMaterialMap(map: THREE.Texture): void {
    const mat = this.material as THREE.MeshBasicMaterial;
    mat.map = map;
    mat.needsUpdate = true;
  }

  /** v0.3：昼夜循环整体调制地形亮度，不必重建任何 geometry */
  setLight(level: number): void {
    const mat = this.material as THREE.MeshBasicMaterial;
    mat.color.setScalar(Math.max(0.05, Math.min(1.4, level)));
  }

  dispose(): void {
    for (const m of this.meshes.values()) {
      this.scene.remove(m);
      m.geometry.dispose();
    }
    this.meshes.clear();
    this.material.dispose();
  }
}
