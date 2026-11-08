import * as THREE from 'three';
import { CLOUD_Y } from '../config';

export interface CloudHandle {
  follow(camera: THREE.Camera): void;
  update(dt: number, brightness: number): void;
  setVisible(v: boolean): void;
  dispose(): void;
}

function hash2(x: number, y: number): number {
  let n = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

/** 8×8 周期性格点，保证贴图 repeat 时无缝 */
function noise(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const tx = x - ix, ty = y - iy;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const at = (a: number, b: number): number => hash2(((a % 8) + 8) % 8, ((b % 8) + 8) % 8);
  const a = at(ix, iy), b = at(ix + 1, iy);
  const c = at(ix, iy + 1), d = at(ix + 1, iy + 1);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

function cloudTexture(): THREE.DataTexture {
  const S = 64;
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S * 8, v = y / S * 8;
      const n = noise(u, v) * 0.62 + noise(u * 2, v * 2) * 0.27 + noise(u * 4, v * 4) * 0.11;
      const t = Math.max(0, Math.min(1, (n - 0.46) / 0.26));
      const alpha = t * t * (3 - 2 * t) * 205;
      const i = (y * S + x) * 4;
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = alpha;
    }
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(7, 7);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** 缓慢漂移的半透明云层；夜间自动压暗 */
export function createClouds(scene: THREE.Scene): CloudHandle {
  const tex = cloudTexture();
  const geometry = new THREE.PlaneGeometry(1400, 1400);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, opacity: 0.55, depthWrite: false,
    fog: false, side: THREE.DoubleSide, color: 0xffffff,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = CLOUD_Y;
  mesh.renderOrder = -900;
  scene.add(mesh);

  return {
    follow(camera) {
      mesh.position.x = camera.position.x;
      mesh.position.z = camera.position.z;
    },
    update(dt, brightness) {
      tex.offset.x += dt * 0.0016;
      tex.offset.y += dt * 0.0007;
      material.color.setScalar(0.35 + brightness * 0.65);
      material.opacity = 0.18 + brightness * 0.42;
    },
    setVisible(v) { mesh.visible = v; },
    dispose() {
      scene.remove(mesh);
      geometry.dispose(); material.dispose(); tex.dispose();
    },
  };
}
