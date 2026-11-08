import * as THREE from 'three';
import { FOG_FAR, FOG_NEAR } from '../config';
import type { SkyPalette } from '../core/DayCycle';

export interface SkyHandle {
  readonly mesh: THREE.Mesh;
  /** 天空球跟随相机，避免玩家走出球面 */
  follow(camera: THREE.Camera): void;
  /** v0.3：昼夜配色 / 太阳方向 / 夜晚权重 */
  apply(palette: SkyPalette): void;
  /** 供星空闪烁使用 */
  setTime(t: number): void;
  dispose(): void;
}

const vertexShader = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    // 把天空钉在远平面：菜单环绕相机可能远离球心，若按真实深度渲染，
    // 球面远侧会越过 camera.far 被裁掉，露出黑色 clear color（低分段球的折线黑洞）。
    // z = w 使 NDC 深度恒为 1，配合 depthTest:false 与最先绘制，天空永远完整覆盖。
    gl_Position.z = gl_Position.w;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  uniform vec3 uBottom;
  uniform vec3 uSunDir;
  uniform float uNight;
  uniform float uWarmth;
  uniform float uTime;
  varying vec3 vDir;

  float hash13(vec3 p) {
    return fract(sin(dot(p, vec3(12.9898, 78.233, 45.164))) * 43758.5453);
  }

  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    vec3 col = h > 0.0
      ? mix(uHorizon, uTop, pow(clamp(h, 0.0, 1.0), 0.55))
      : mix(uHorizon, uBottom, clamp(-h * 2.0, 0.0, 1.0));

    vec3 sunDir = normalize(uSunDir);
    float sd = max(dot(d, sunDir), 0.0);

    // 太阳 + 光晕（白天）
    float sun  = pow(sd, 220.0) * 1.55;
    float halo = pow(sd, 9.0) * 0.20;
    col += vec3(1.0, 0.94, 0.78) * (sun + halo) * (1.0 - uNight * 0.92);

    // 日出 / 日落的地平线暖辉
    float glow = pow(1.0 - clamp(abs(h), 0.0, 1.0), 11.0) * uWarmth;
    col += vec3(1.0, 0.42, 0.20) * glow * 0.42;

    // 月亮（与太阳对跖）
    float md = max(dot(d, -sunDir), 0.0);
    float moon = pow(md, 1200.0) * 1.35 * uNight;
    float moonHalo = pow(md, 46.0) * 0.10 * uNight;
    col += vec3(0.84, 0.90, 1.0) * (moon + moonHalo);

    // 星空：方向量化成格子后 hash，只在上半球且随夜晚权重淡入
    vec3 cell = floor(d * 240.0);
    float star = step(0.9972, hash13(cell)) * uNight * smoothstep(-0.02, 0.28, h);
    float twinkle = 0.68 + 0.32 * sin(uTime * 2.2 + hash13(cell + 7.0) * 42.0);
    col += vec3(0.90, 0.95, 1.0) * star * twinkle;

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** 渐变天空球 + 昼夜日月 + 星空 + 与地平线同色的雾；不用任何贴图 */
export function createSky(scene: THREE.Scene): SkyHandle {
  const uniforms = {
    uTop: { value: new THREE.Color(0x2f6fd0) },
    uHorizon: { value: new THREE.Color(0xbfe3ff) },
    uBottom: { value: new THREE.Color(0x8fb9d9) },
    uSunDir: { value: new THREE.Vector3(0.55, 0.62, -0.55).normalize() },
    uNight: { value: 0 },
    uWarmth: { value: 0 },
    uTime: { value: 0 },
  };

  const geometry = new THREE.SphereGeometry(220, 32, 20);
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false, // 深度恒为 1，交给 renderOrder 保证最先绘制，不受地形深度影响
    fog: false,
    uniforms,
    vertexShader,
    fragmentShader,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  scene.add(mesh);

  const fog = new THREE.Fog(0xbfe3ff, FOG_NEAR, FOG_FAR);
  scene.fog = fog;

  return {
    mesh,
    follow(camera) { mesh.position.copy(camera.position); },
    apply(p) {
      uniforms.uTop.value.setHex(p.top);
      uniforms.uHorizon.value.setHex(p.horizon);
      uniforms.uBottom.value.setHex(p.bottom);
      uniforms.uSunDir.value.set(p.sun.x, p.sun.y, p.sun.z);
      uniforms.uNight.value = p.night;
      uniforms.uWarmth.value = p.warmth;
      fog.color.setHex(p.fog);
    },
    setTime(t) { uniforms.uTime.value = t; },
    dispose() {
      scene.remove(mesh);
      scene.fog = null;
      geometry.dispose();
      material.dispose();
    },
  };
}
