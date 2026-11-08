/**
 * 地形生成器接口。
 * 首版是 TS 实现的起伏小丘；将来换成噪声服务 / WASM / 二进制高度图，
 * 只要实现这两个方法即可，World 与 mesher 不受影响。
 */
export interface IGenerator {
  readonly id: string;
  /** 该 (x,z) 列最高非空气方块的 y */
  surfaceY(wx: number, wz: number): number;
  /** 该世界坐标处应放置的方块 id */
  blockAt(wx: number, y: number, wz: number, surface: number): number;
}
