import { CHUNK_HEIGHT, CHUNK_SIZE } from '../config';
import { decodeChunk, encodeChunk, type ChunkBinary } from '../binary/ChunkCodec';
import { AIR_ID } from './BlockRegistry';

/**
 * 纯数据体素容器：一个扁平 Uint8Array，零 Three.js 对象。
 * 它本身就是二进制友好的 —— encodeChunk 只是加个 header。
 */
export class Chunk {
  readonly data: Uint8Array;
  /** 网格是否需要重建 */
  dirty = true;

  constructor(
    readonly cx: number,
    readonly cz: number,
    readonly size: number = CHUNK_SIZE,
    readonly height: number = CHUNK_HEIGHT,
  ) {
    this.data = new Uint8Array(size * height * size);
  }

  index(x: number, y: number, z: number): number {
    return (y * this.size + z) * this.size + x;
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && x < this.size && z >= 0 && z < this.size && y >= 0 && y < this.height;
  }

  get(x: number, y: number, z: number): number {
    if (!this.inBounds(x, y, z)) return AIR_ID;
    return this.data[this.index(x, y, z)];
  }

  set(x: number, y: number, z: number, id: number): boolean {
    if (!this.inBounds(x, y, z)) return false;
    const i = this.index(x, y, z);
    if (this.data[i] === id) return false;
    this.data[i] = id;
    this.dirty = true;
    return true;
  }

  toBinary(): ArrayBuffer {
    return encodeChunk(this);
  }

  static fromBinary(buf: ArrayBuffer): Chunk {
    const d: ChunkBinary = decodeChunk(buf);
    const c = new Chunk(d.cx, d.cz, d.size, d.height);
    c.data.set(d.voxels);
    c.dirty = true;
    return c;
  }
}
