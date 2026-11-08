import { DAY_LENGTH } from '../config';

export interface SkyPalette {
  top: number;
  horizon: number;
  bottom: number;
  fog: number;
  /** 地形材质整体亮度（0~1） */
  ambient: number;
  /** 夜晚权重 0~1，用于星空 / 月亮强度 */
  night: number;
  /** 日出日落暖色权重 0~1 */
  warmth: number;
  sun: { x: number; y: number; z: number };
}

interface Keyframe {
  at: number;
  top: number;
  horizon: number;
  bottom: number;
  ambient: number;
  night: number;
  warmth: number;
}

/** 四个关键帧：日出 / 正午 / 日落 / 午夜。颜色用 0xRRGGBB 便于线性插值 */
const KEYS: readonly Keyframe[] = [
  { at: 0.00, top: 0x3d6ea8, horizon: 0xffb27a, bottom: 0xd79a6c, ambient: 0.72, night: 0.15, warmth: 1.0 },
  { at: 0.25, top: 0x2f6fd0, horizon: 0xbfe3ff, bottom: 0x8fb9d9, ambient: 1.00, night: 0.00, warmth: 0.0 },
  { at: 0.50, top: 0x38558f, horizon: 0xff8f63, bottom: 0xb8705a, ambient: 0.74, night: 0.14, warmth: 0.95 },
  { at: 0.75, top: 0x070d20, horizon: 0x1c2b4d, bottom: 0x0b152b, ambient: 0.28, night: 1.00, warmth: 0.0 },
];

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

function mixColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(lerp(ar, br, t)) << 16)
    | (Math.round(lerp(ag, bg, t)) << 8)
    | Math.round(lerp(ab, bb, t));
}

/** 昼夜循环：纯数据，无 Three.js 依赖，Node 侧可直接验收 */
export class DayCycle {
  /** 0=日出 0.25=正午 0.5=日落 0.75=午夜 */
  phase = 0.28;
  enabled = true;
  /** 每秒推进的相位；1 表示现实 DAY_LENGTH 秒走完一天 */
  speed = 1 / DAY_LENGTH;

  update(dt: number, timeScale = 1): void {
    if (!this.enabled) return;
    this.phase = (this.phase + dt * this.speed * timeScale + 1) % 1;
  }

  setPhase(p: number): void { this.phase = ((p % 1) + 1) % 1; }

  /** 24 小时制的 HH:MM，phase=0 定为 06:00 */
  clock(): string {
    const hours = (this.phase * 24 + 6) % 24;
    const h = Math.floor(hours);
    const m = Math.floor((hours - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  get daylight(): number { return this.palette().ambient; }

  palette(): SkyPalette {
    const p = this.phase;
    let i = 0;
    for (let k = 0; k < KEYS.length; k++) if (p >= KEYS[k].at) i = k;
    const a = KEYS[i];
    const b = KEYS[(i + 1) % KEYS.length];
    const bAt = i + 1 < KEYS.length ? b.at : 1;
    const t = Math.max(0, Math.min(1, (p - a.at) / (bAt - a.at)));
    // 关键帧之间用 smoothstep，避免正午→日落颜色突变
    const s = t * t * (3 - 2 * t);

    const angle = p * Math.PI * 2;
    const sx = Math.cos(angle) * 0.82;
    const sy = Math.sin(angle);
    const sz = -0.48;
    const len = Math.hypot(sx, sy, sz) || 1;

    return {
      top: mixColor(a.top, b.top, s),
      horizon: mixColor(a.horizon, b.horizon, s),
      bottom: mixColor(a.bottom, b.bottom, s),
      fog: mixColor(a.horizon, b.horizon, s),
      ambient: lerp(a.ambient, b.ambient, s),
      night: lerp(a.night, b.night, s),
      warmth: lerp(a.warmth, b.warmth, s),
      sun: { x: sx / len, y: sy / len, z: sz / len },
    };
  }
}
