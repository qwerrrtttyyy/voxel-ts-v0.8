import type { TilePainter } from '../../../render/TextureAtlas';
import { spec, v, type BlockVisual, type RGB, type BlockPack } from '../types';

type Put = (x: number, y: number, r: number, g: number, b: number, a?: number) => void;

/**
 * 植物类贴图必须是「大部分透明 + 少量实心像素」的 sprite，
 * 否则一个 1×1 不透明立方体铺在地上会变成一整片噪点地毯。
 * alphaTest(0.42) 会丢弃 alpha 低于阈值的像素。
 */
function sprite(draw: (set: Put, s: number) => void): BlockVisual {
  return {
    style: 'solid', base: [0, 0, 0],
    custom: ((set, s) => {
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) set(x, y, 0, 0, 0, 0);
      }
      draw(set as Put, s);
    }) as TilePainter,
  };
}

const put = (set: Put, x: number, y: number, c: RGB, a = 255): void =>
  set(x, y, c[0], c[1], c[2], a);

/** 细茎 + 小花冠，其余全透明 */
function bloom(color: RGB, seed: number): BlockVisual {
  return sprite((set, s) => {
    const stem: RGB = [70, 140, 60];
    const cx = 7 + (seed % 3) - 1;
    const cy = 6;
    for (let y = cy + 2; y < s; y++) put(set, cx, y, stem);
    put(set, cx - 1, cy + 4, stem);
    put(set, cx + 1, cy + 5, stem);
    const petals: ReadonlyArray<readonly [number, number]> = [
      [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1],
      [1, 1], [-1, -1], [1, -1], [-1, 1],
    ];
    for (const [dx, dy] of petals) put(set, cx + dx, cy + dy, color);
    put(set, cx, cy, [240, 226, 120]);
  });
}

const tallGrass: BlockVisual = sprite((set, s) => {
  for (let y = 3; y < s; y++) {
    const sway = Math.round(Math.sin(y * 0.8 + 1) * 1.2);
    put(set, 6 + sway, y, [90, 158, 62]);
    put(set, 10 - sway, y, [76, 140, 54]);
    if (y % 3 === 0) put(set, 8, y, [108, 170, 72]);
  }
});

const sugarCane: BlockVisual = sprite((set, s) => {
  const c: RGB = [150, 186, 78];
  for (let y = 1; y < s; y++) {
    put(set, 7, y, c);
    put(set, 8, y, [126, 176, 70]);
    if (y % 4 === 0) { put(set, 6, y, [196, 214, 108]); put(set, 9, y, [196, 214, 108]); }
  }
});

const redMushroom: BlockVisual = sprite((set, s) => {
  const stem: RGB = [226, 218, 196];
  for (let y = 9; y < s; y++) { put(set, 7, y, stem); put(set, 8, y, stem); }
  for (let x = 4; x <= 11; x++) {
    put(set, x, 7, [196, 64, 58]);
    if (x >= 5 && x <= 10) put(set, x, 6, [206, 72, 62]);
  }
  put(set, 5, 7, [238, 226, 210]);
  put(set, 9, 6, [238, 226, 210]);
});

/** 植物方块包：花、高草、仙人掌、甘蔗、蘑菇，共 7 种 */
export const PLANT_PACK: BlockPack = {
  id: 'pack.plant',
  label: '植物方块',
  category: 'natural',
  blocks: [
    spec('flower_red', '红花', bloom([214, 62, 54], 110), { opaque: false, solid: false, hardness: 0.2 }),
    spec('flower_yellow', '黄花', bloom([238, 206, 62], 111), { opaque: false, solid: false, hardness: 0.2 }),
    spec('flower_blue', '蓝花', bloom([86, 122, 214], 112), { opaque: false, solid: false, hardness: 0.2 }),
    spec('tall_grass', '高草', tallGrass, { opaque: false, solid: false, hardness: 0.2 }),
    spec('cactus', '仙人掌', v('bark', [62, 132, 58], undefined, 115, {
      faces: {
        top: v('solid', [86, 158, 70], undefined, 116),
        side: v('bark', [62, 132, 58], undefined, 117),
      },
    }), { hardness: 0.8 }),
    spec('sugar_cane', '甘蔗', sugarCane, { opaque: false, solid: false, hardness: 0.2 }),
    spec('mushroom_red', '红蘑菇', redMushroom, { opaque: false, solid: false, hardness: 0.2 }),
  ],
};
