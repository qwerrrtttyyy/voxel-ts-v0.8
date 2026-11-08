import { CHUNK_HEIGHT } from '../../config';
import type { BlockLibrary } from '../blocks/types';
import type { Sample, TerrainSampler } from './Sampler';

/**
 * 一列体素的构建上下文。每个阶段只通过 set / get / fill 修改 blocks，
 * 并读取 meta（高度、群系、温湿度）—— 阶段之间不互相调用，只共享这一份数据，
 * 因此可以任意增删、重排、单独开关。
 */
export class ColumnContext {
  readonly blocks: Uint8Array;
  readonly meta: Sample;

  constructor(
    readonly wx: number,
    readonly wz: number,
    readonly lib: BlockLibrary,
    readonly sampler: TerrainSampler,
  ) {
    this.blocks = new Uint8Array(CHUNK_HEIGHT);
    this.meta = sampler.sample(wx, wz);
  }

  get height(): number { return this.meta.height; }
  get seed(): number { return this.sampler.seed; }

  id(local: string): number { return this.lib.id(local); }

  set(y: number, blockId: number): void {
    if (y >= 0 && y < this.blocks.length && blockId !== 0) this.blocks[y] = blockId;
  }

  /** 只在目标格为空时写入：后阶段不能覆盖前阶段已放的结构 */
  setIfAir(y: number, blockId: number): void {
    if (y >= 0 && y < this.blocks.length && this.blocks[y] === 0 && blockId !== 0) {
      this.blocks[y] = blockId;
    }
  }

  clear(y: number): void {
    if (y >= 0 && y < this.blocks.length) this.blocks[y] = 0;
  }

  get(y: number): number {
    return y >= 0 && y < this.blocks.length ? this.blocks[y] : 0;
  }

  fill(from: number, to: number, blockId: number): void {
    const lo = Math.max(0, from), hi = Math.min(this.blocks.length - 1, to);
    for (let y = lo; y <= hi; y++) this.set(y, blockId);
  }
}
