import { EXTRA_BLOCKS, type ExtraBlocks } from '../core/tokens';
import type { Plugin } from '../core/types';
import type { TilePainter } from '../render/TextureAtlas';

/** 确定性 hash：贴图不依赖 Math.random，重建结果完全一致 */
function h(x: number, y: number, seed: number): number {
  let n = Math.imul(x + seed * 101, 374761393) + Math.imul(y + seed * 31, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

type RGB = readonly [number, number, number];

/** 基础噪点材质 */
function grain(base: RGB, amp: number, seed: number, alpha?: (x: number, y: number) => number): TilePainter {
  return (set, s) => {
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const n = (h(x, y, seed) - 0.5) * amp;
        set(x, y, base[0] + n, base[1] + n * 0.9, base[2] + n * 0.8, alpha ? alpha(x, y) : 255);
      }
    }
  };
}

const stone: TilePainter = (set, s) => {
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const n = (h(x, y, 11) - 0.5) * 40;
    const crack = (h(x >> 1, y >> 1, 12) > 0.86) ? -26 : 0;
    set(x, y, 128 + n + crack, 130 + n + crack, 134 + n + crack);
  }
};

const sand: TilePainter = (set, s) => {
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const n = (h(x, y, 21) - 0.5) * 22;
    const dot = h(x, y, 22) > 0.93 ? -18 : 0;
    set(x, y, 224 + n + dot, 208 + n + dot, 156 + n * 0.7 + dot);
  }
};

const woodSide: TilePainter = (set, s) => {
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const ring = Math.sin(x * 1.7 + h(x, 0, 31) * 2) * 9;
    const n = (h(x, y, 32) - 0.5) * 16;
    set(x, y, 126 + n + ring, 88 + n * 0.8 + ring * 0.6, 52 + n * 0.5);
  }
};

const woodTop: TilePainter = (set, s) => {
  const c = (s - 1) / 2;
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const d = Math.hypot(x - c, y - c);
    const ring = Math.sin(d * 2.6) * 13;
    const n = (h(x, y, 33) - 0.5) * 12;
    set(x, y, 166 + ring + n, 126 + ring + n, 74 + ring * 0.7 + n);
  }
};

const leaves: TilePainter = (set, s) => {
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const n = (h(x, y, 41) - 0.5) * 46;
    // 镂空像素交给材质 alphaTest 丢弃，树叶不再是一整块绿板
    const a = h(x, y, 42) > 0.86 ? 0 : 255;
    set(x, y, 54 + n, 132 + n, 48 + n * 0.7, a);
  }
};

const glass: TilePainter = (set, s) => {
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const border = x === 0 || y === 0 || x === s - 1 || y === s - 1;
    const shine = (x + y) % 7 === 0 || (x - y + s) % 9 === 0;
    if (border) set(x, y, 196, 232, 244, 255);
    else if (shine) set(x, y, 224, 248, 255, 210);
    else set(x, y, 170, 214, 232, 34); // 低于 alphaTest 阈值 → 真透明
  }
};

const water: TilePainter = (set, s) => {
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const wave = Math.sin(x * 0.85 + y * 0.4) * 12 + Math.sin(y * 1.3 - x * 0.2) * 7;
    const n = (h(x, y, 51) - 0.5) * 12;
    set(x, y, 48 + wave + n, 116 + wave + n, 196 + wave * 0.5 + n);
  }
};

const plank: TilePainter = (set, s) => {
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const seam = y % 5 === 0 ? -34 : 0;
    const n = (h(x, y, 61) - 0.5) * 16;
    set(x, y, 178 + n + seam, 138 + n + seam, 78 + n * 0.6 + seam);
  }
};

const brick: TilePainter = (set, s) => {
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const row = Math.floor(y / 4);
    const mortar = y % 4 === 0 || (x + (row % 2) * 4) % 8 === 0;
    const n = (h(x, y, 71) - 0.5) * 18;
    set(x, y, mortar ? 196 + n : 158 + n, mortar ? 186 + n : 76 + n, mortar ? 172 + n : 62 + n);
  }
};

const glow: TilePainter = (set, s) => {
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const n = (h(x, y, 81) - 0.5) * 34;
    const vein = h(x >> 1, y >> 1, 82) > 0.7 ? 34 : 0;
    set(x, y, 246 + n, 206 + n + vein * 0.3, 104 + n + vein);
  }
};

const snow = grain([238, 246, 252], 16, 91);
const gravel = grain([126, 122, 118], 52, 92);

/**
 * v0.3 扩展方块包：12 种程序化方块与贴图。
 * 全部由插件声明，关掉它地形会自动降级回「只有草和泥土」，
 * 物品栏也会自动缩回 —— 这是插件式玩法的直接体现。
 */
export function blocksExtraPlugin(): Plugin {
  return {
    id: 'voxel.blocks-extra',
    version: '0.3.0',
    meta: {
      label: '扩展方块包', category: 'world', author: 'voxel-ts', badge: 'BK',
      description: '石 / 沙 / 原木 / 树叶 / 玻璃 / 水 / 木板 / 砖 / 发光石等 12 种方块与程序化贴图',
    },
    provides: ['extraBlocks'],
    dependencies: ['cap:blocks'],
    priority: -28,

    setup(ctx): void {
      const { scope } = ctx;
      const t = {
        stone: scope.tile('stone', stone),
        sand: scope.tile('sand', sand),
        woodSide: scope.tile('wood_side', woodSide),
        woodTop: scope.tile('wood_top', woodTop),
        leaves: scope.tile('leaves', leaves),
        glass: scope.tile('glass', glass),
        water: scope.tile('water', water),
        plank: scope.tile('plank', plank),
        brick: scope.tile('brick', brick),
        glow: scope.tile('glowstone', glow),
        snow: scope.tile('snow', snow),
        gravel: scope.tile('gravel', gravel),
      };

      const ids: ExtraBlocks = {
        stone: scope.block('stone', { opaque: true, solid: true, all: t.stone, hardness: 1.5 }),
        sand: scope.block('sand', { opaque: true, solid: true, all: t.sand }),
        wood: scope.block('wood', {
          opaque: true, solid: true,
          faces: {
            top: t.woodTop, bottom: t.woodTop, north: t.woodSide,
            south: t.woodSide, east: t.woodSide, west: t.woodSide,
          },
        }),
        leaves: scope.block('leaves', { opaque: false, solid: false, all: t.leaves, hardness: 0.4 }),
        glass: scope.block('glass', { opaque: false, solid: true, all: t.glass }),
        water: scope.block('water', { opaque: true, solid: false, liquid: true, all: t.water }),
        plank: scope.block('plank', { opaque: true, solid: true, all: t.plank }),
        brick: scope.block('brick', { opaque: true, solid: true, all: t.brick }),
        glowstone: scope.block('glowstone', { opaque: true, solid: true, emissive: true, all: t.glow }),
        snow: scope.block('snow', { opaque: true, solid: true, all: t.snow }),
        gravel: scope.block('gravel', { opaque: true, solid: true, all: t.gravel }),
        ice: scope.block('ice', { opaque: false, solid: true, all: t.glass }),
      };

      scope.service(EXTRA_BLOCKS, ids, { priority: 0 });
      ctx.log(`extra blocks: ${Object.keys(ids).length} types / ${ctx.atlas.tileCount} tiles`);
    },
  };
}
