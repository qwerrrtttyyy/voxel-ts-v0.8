import type { TilePainter } from '../../render/TextureAtlas';

/**
 * 程序化贴图算子库。
 *
 * 设计上把「画什么」拆成两层：
 *   - 16 个原子样式（solid / speckle / strata / brick / …）
 *   - 2 个组合子（tint / mask），可对任意样式再加工
 * 于是新增方块 = 一条数据（样式 + 颜色 + seed），不需要写绘制代码。
 * 所有随机都来自确定性 hash，重建 / 热重载结果逐字节一致。
 */

export type RGB = readonly [number, number, number];

export type BlockStyle =
  | 'solid' | 'speckle' | 'strata' | 'brick' | 'plank' | 'bark' | 'rings'
  | 'cracked' | 'ore' | 'glass' | 'cutout' | 'checker' | 'glow'
  | 'wool' | 'liquid' | 'gradient';

export interface BlockVisual {
  readonly style: BlockStyle;
  readonly base: RGB;
  readonly accent?: RGB;
  readonly seed?: number;
  /** 斑点 / 矿脉 / 镂空密度 0~1 */
  readonly density?: number;
  /** 整体不透明度（255 = 不透明） */
  readonly alpha?: number;
  /** 分面贴图：顶 / 侧 / 底各用一套视觉 */
  readonly faces?: {
    readonly top?: BlockVisual;
    readonly side?: BlockVisual;
    readonly bottom?: BlockVisual;
  };
  /** 组合子加工后的画笔；存在时优先于 style（用于 mask / tint / overlay） */
  readonly custom?: TilePainter;
}

export function hash(x: number, y: number, seed: number): number {
  let n = Math.imul(x + seed * 101, 374761393) + Math.imul(y + seed * 31, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

type Put = (x: number, y: number, r: number, g: number, b: number, a?: number) => void;

function painter(fn: (x: number, y: number, s: number, put: Put) => void): TilePainter {
  return (set, s) => {
    const put: Put = (x, y, r, g, b, a = 255) =>
      set(x, y, clamp(r), clamp(g), clamp(b), clamp(a));
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) fn(x, y, s, put);
    }
  };
}

/** 组合子：把任意样式按权重染向目标色，保持原有 alpha 通道 */
export function tint(inner: TilePainter, color: RGB, weight: number): TilePainter {
  return (set, s) => {
    const buf = new Uint8Array(s * s * 4);
    const capture: Put = (x, y, r, g, b, a = 255) => {
      if (x < 0 || x >= s || y < 0 || y >= s) return;
      const i = (y * s + x) * 4;
      buf[i] = clamp(r); buf[i + 1] = clamp(g); buf[i + 2] = clamp(b); buf[i + 3] = clamp(a);
    };
    inner(capture, s);
    for (let i = 0; i < buf.length; i += 4) {
      set((i / 4) % s, Math.floor(i / 4 / s),
        buf[i] * (1 - weight) + color[0] * weight,
        buf[i + 1] * (1 - weight) + color[1] * weight,
        buf[i + 2] * (1 - weight) + color[2] * weight,
        buf[i + 3]);
    }
  };
}

/** 组合子：按确定性 hash 把一部分像素挖空（低于 alphaTest 会被 discard） */
export function mask(inner: TilePainter, rate: number, seed: number): TilePainter {
  return (set, s) => {
    const capture: Put = (x, y, r, g, b, a = 255) =>
      set(x, y, r, g, b, hash(x, y, seed) < rate ? 0 : a);
    inner(capture, s);
  };
}

/** 组合子：把多个样式按 alpha 顺序叠加（后画的覆盖先画的） */
export function overlay(...layers: TilePainter[]): TilePainter {
  return (set, s) => { for (const layer of layers) layer(set, s); };
}

/** 把一条视觉声明编译成 atlas 画笔 */
export function painterFor(v: BlockVisual): TilePainter {
  if (v.custom) return v.custom;
  const seed = v.seed ?? 1;
  const base = v.base;
  const accent = v.accent ?? [base[0] + 42, base[1] + 42, base[2] + 42] as RGB;
  const density = v.density ?? 0.15;
  const alpha = v.alpha ?? 255;

  switch (v.style) {
    case 'solid':
      return painter((x, y, _s, put) => {
        const n = (hash(x, y, seed) - 0.5) * 15;
        put(x, y, base[0] + n, base[1] + n, base[2] + n, alpha);
      });

    case 'speckle':
      return painter((x, y, _s, put) => {
        const n = (hash(x, y, seed) - 0.5) * 18;
        const blot = hash(x >> 1, y >> 1, seed + 7) > 1 - density;
        const c = blot ? accent : base;
        put(x, y, c[0] + n, c[1] + n, c[2] + n, alpha);
      });

    case 'strata':
      return painter((x, y, _s, put) => {
        const n = (hash(x, y, seed) - 0.5) * 12;
        const band = Math.floor(y / 3) % 2 === 0 ? base : accent;
        put(x, y, band[0] + n, band[1] + n, band[2] + n, alpha);
      });

    case 'brick':
      return painter((x, y, _s, put) => {
        const row = Math.floor(y / 4);
        const mortar = y % 4 === 0 || (x + (row % 2) * 4) % 8 === 0;
        const n = (hash(x, y, seed) - 0.5) * 16;
        const c = mortar ? accent : base;
        put(x, y, c[0] + n, c[1] + n, c[2] + n, alpha);
      });

    case 'plank':
      return painter((x, y, _s, put) => {
        const seam = y % 5 === 0 ? -34 : 0;
        const n = (hash(x, y, seed) - 0.5) * 14;
        put(x, y, base[0] + n + seam, base[1] + n + seam, base[2] + n + seam, alpha);
      });

    case 'bark':
      return painter((x, y, _s, put) => {
        const ring = Math.sin(x * 1.7 + hash(x, 0, seed) * 2) * 9;
        const n = (hash(x, y, seed + 1) - 0.5) * 15;
        put(x, y, base[0] + n + ring, base[1] + n * 0.8 + ring * 0.6, base[2] + n * 0.5, alpha);
      });

    case 'rings':
      return painter((x, y, s, put) => {
        const c = (s - 1) / 2;
        const d = Math.hypot(x - c, y - c);
        const ring = Math.sin(d * 2.6) * 13;
        const n = (hash(x, y, seed) - 0.5) * 12;
        put(x, y, base[0] + ring + n, base[1] + ring + n, base[2] + ring * 0.7 + n, alpha);
      });

    case 'cracked':
      return painter((x, y, _s, put) => {
        const n = (hash(x, y, seed) - 0.5) * 34;
        const crack = hash(x >> 1, y >> 1, seed + 3) > 0.84 ? -30 : 0;
        put(x, y, base[0] + n + crack, base[1] + n + crack, base[2] + n + crack, alpha);
      });

    case 'ore':
      return painter((x, y, _s, put) => {
        const n = (hash(x, y, seed) - 0.5) * 22;
        const gem = hash(x >> 1, y >> 1, seed + 11) > 1 - density;
        const c = gem ? accent : base;
        put(x, y, c[0] + n, c[1] + n, c[2] + n, alpha);
      });

    case 'glass':
      return painter((x, y, s, put) => {
        const border = x === 0 || y === 0 || x === s - 1 || y === s - 1;
        const shine = (x + y) % 7 === 0 || (x - y + s) % 9 === 0;
        if (border) put(x, y, accent[0], accent[1], accent[2], 255);
        else if (shine) put(x, y, base[0] + 28, base[1] + 28, base[2] + 28, 210);
        else put(x, y, base[0], base[1], base[2], 34);
      });

    case 'cutout':
      return painter((x, y, _s, put) => {
        const n = (hash(x, y, seed) - 0.5) * 44;
        const a = hash(x, y, seed + 5) < density ? 0 : alpha;
        put(x, y, base[0] + n, base[1] + n, base[2] + n, a);
      });

    case 'checker':
      return painter((x, y, _s, put) => {
        const c = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0 ? base : accent;
        const n = (hash(x, y, seed) - 0.5) * 10;
        put(x, y, c[0] + n, c[1] + n, c[2] + n, alpha);
      });

    case 'glow':
      return painter((x, y, _s, put) => {
        const n = (hash(x, y, seed) - 0.5) * 30;
        const vein = hash(x >> 1, y >> 1, seed + 9) > 0.7 ? 34 : 0;
        put(x, y, base[0] + n, base[1] + n + vein * 0.3, base[2] + n + vein, alpha);
      });

    case 'wool':
      return painter((x, y, _s, put) => {
        const n = (hash(x, y, seed) - 0.5) * 20 + Math.sin(y * 3.1) * 4;
        put(x, y, base[0] + n, base[1] + n, base[2] + n, alpha);
      });

    case 'liquid':
      return painter((x, y, _s, put) => {
        const wave = Math.sin(x * 0.85 + y * 0.4) * 12 + Math.sin(y * 1.3 - x * 0.2) * 7;
        const n = (hash(x, y, seed) - 0.5) * 10;
        put(x, y, base[0] + wave + n, base[1] + wave + n, base[2] + wave * 0.5 + n, alpha);
      });

    case 'gradient':
      return painter((x, y, s, put) => {
        const t = y / (s - 1);
        const n = (hash(x, y, seed) - 0.5) * 10;
        put(x, y,
          base[0] * (1 - t) + accent[0] * t + n,
          base[1] * (1 - t) + accent[1] * t + n,
          base[2] * (1 - t) + accent[2] * t + n, alpha);
      });

    default:
      return painter((x, y, _s, put) => put(x, y, base[0], base[1], base[2], alpha));
  }
}
