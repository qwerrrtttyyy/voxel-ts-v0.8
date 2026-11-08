import * as THREE from 'three';

interface Particle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number; max: number;
  r: number; g: number; b: number;
}

/** 破坏方块的碎片粒子：固定容量池，一次 draw call，无 per-particle 对象 */
export class BlockParticles {
  private static readonly CAP = 320;

  private readonly positions = new Float32Array(BlockParticles.CAP * 3);
  private readonly colors = new Float32Array(BlockParticles.CAP * 3);
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material = new THREE.PointsMaterial({
    size: 0.19, vertexColors: true, transparent: true, opacity: 0.96,
    depthWrite: false, sizeAttenuation: true, fog: true,
  });
  private readonly points: THREE.Points;
  private readonly pool: Particle[] = [];

  constructor(private readonly scene: THREE.Scene) {
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setDrawRange(0, 0);
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  burst(x: number, y: number, z: number, rgb: readonly [number, number, number], count = 16): void {
    for (let i = 0; i < count; i++) {
      if (this.pool.length >= BlockParticles.CAP) break;
      const life = 0.45 + Math.random() * 0.45;
      this.pool.push({
        x: x + Math.random(), y: y + Math.random(), z: z + Math.random(),
        vx: (Math.random() - 0.5) * 3.4,
        vy: 1.6 + Math.random() * 3.2,
        vz: (Math.random() - 0.5) * 3.4,
        life, max: life,
        r: rgb[0] * (0.78 + Math.random() * 0.35),
        g: rgb[1] * (0.78 + Math.random() * 0.35),
        b: rgb[2] * (0.78 + Math.random() * 0.35),
      });
    }
  }

  update(dt: number): void {
    let w = 0;
    for (let i = 0; i < this.pool.length; i++) {
      const p = this.pool[i];
      p.life -= dt;
      if (p.life <= 0) continue;
      p.vy -= 11 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      const fade = Math.min(1, p.life / (p.max * 0.4));
      this.positions[w * 3] = p.x;
      this.positions[w * 3 + 1] = p.y;
      this.positions[w * 3 + 2] = p.z;
      this.colors[w * 3] = p.r * fade;
      this.colors[w * 3 + 1] = p.g * fade;
      this.colors[w * 3 + 2] = p.b * fade;
      this.pool[w++] = p;
    }
    this.pool.length = w;
    this.geometry.setDrawRange(0, w);
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    this.points.visible = w > 0;
  }

  setVisible(v: boolean): void { this.points.visible = v && this.pool.length > 0; }

  dispose(): void {
    this.scene.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
    this.pool.length = 0;
  }
}
