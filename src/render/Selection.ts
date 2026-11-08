import * as THREE from 'three';
import type { VoxelHit } from '../player/Raycast';

export interface SelectionHandle {
  readonly group: THREE.Group;
  setHit(hit: VoxelHit | null): void;
  /** 破坏 / 放置时的一次视觉反馈 */
  pulse(kind?: 'break' | 'place'): void;
  update(dt: number): void;
  dispose(): void;
}

/** 准星选中方块的双层描边 + 半透明闪烁层 */
export function createSelection(scene: THREE.Scene): SelectionHandle {
  const group = new THREE.Group();
  group.visible = false;

  const box = new THREE.BoxGeometry(1.006, 1.006, 1.006);
  const edges = new THREE.EdgesGeometry(box);
  const darkMat = new THREE.LineBasicMaterial({ color: 0x0a1410, transparent: true, opacity: 0.92, depthTest: true });
  const lightMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.92, depthTest: true });
  const dark = new THREE.LineSegments(edges, darkMat);
  const light = new THREE.LineSegments(edges, lightMat);
  dark.scale.setScalar(1.006);
  light.scale.setScalar(1.0);
  group.add(dark, light);

  const flashGeo = new THREE.BoxGeometry(1.012, 1.012, 1.012);
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, fog: false,
  });
  const flash = new THREE.Mesh(flashGeo, flashMat);
  group.add(flash);

  scene.add(group);
  let energy = 0;
  let flashColor = 0xffffff;

  return {
    group,
    setHit(hit) {
      if (!hit) { group.visible = false; return; }
      group.visible = true;
      group.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    },
    pulse(kind = 'break') {
      energy = 1;
      flashColor = kind === 'place' ? 0x9cf07a : 0xffffff;
      flashMat.color.setHex(flashColor);
    },
    update(dt) {
      if (energy <= 0) return;
      energy = Math.max(0, energy - dt * 4.5);
      flashMat.opacity = energy * 0.34;
      const s = 1 + energy * 0.07;
      flash.scale.setScalar(s);
      lightMat.opacity = 0.92;
      darkMat.opacity = 0.92 * (1 - energy * 0.4);
    },
    dispose() {
      scene.remove(group);
      box.dispose(); edges.dispose(); flashGeo.dispose();
      darkMat.dispose(); lightMat.dispose(); flashMat.dispose();
    },
  };
}
