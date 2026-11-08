import { BinaryReader, BinaryWriter } from './BinaryBuffer';

/**
 * Chunk 二进制格式 v1（为「以后融合二进制」专门定的第一份协议）
 *
 *   u32  'CHNK'
 *   u16  version = 1
 *   i32  cx | i32 cz
 *   u16  size | u16 height
 *   u16  paletteCount | u16 reserved(=0, v2 起改 16bit 方块 id)
 *   paletteCount × u16  方块 id 表（当前未启用，占位）
 *   u32  voxelLen
 *   u8[] voxelLen  行主序 (y * size + z) * size + x
 *
 * 只依赖结构类型，不 import Chunk 类，避免运行时循环依赖。
 */
export const CHUNK_MAGIC = 0x43484e4b;
export const CHUNK_VERSION = 1;
/**
 * v0.6：chunk 段改用高位独立 tag，不再占用插件可申领的低位空间。
 * 旧存档里的 0x0001 由 BinaryHub 的内置迁移器识别并改写（见 LEGACY_CHUNK_TAG）。
 */
export const CHUNK_TAG = 0xf001;
export const LEGACY_CHUNK_TAG = 0x0001;

export interface ChunkLike {
  readonly cx: number;
  readonly cz: number;
  readonly size: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export interface ChunkBinary {
  cx: number;
  cz: number;
  size: number;
  height: number;
  palette: number[];
  voxels: Uint8Array;
}

export function encodeChunk(chunk: ChunkLike): ArrayBuffer {
  const w = new BinaryWriter();
  w.u32(CHUNK_MAGIC)
    .u16(CHUNK_VERSION)
    .i32(chunk.cx).i32(chunk.cz)
    .u16(chunk.size).u16(chunk.height)
    .u16(0).u16(0)
    .u32(chunk.data.byteLength)
    .bytes(chunk.data);
  return w.finish();
}

export function decodeChunk(buf: ArrayBuffer): ChunkBinary {
  const r = BinaryReader.from(buf);
  if (r.u32() !== CHUNK_MAGIC) throw new Error('[ChunkCodec] bad magic');
  const version = r.u16();
  if (version !== CHUNK_VERSION) throw new Error(`[ChunkCodec] unsupported chunk version ${version}`);
  const cx = r.i32(), cz = r.i32();
  const size = r.u16(), height = r.u16();
  const paletteCount = r.u16();
  r.u16(); // reserved
  const palette: number[] = [];
  for (let i = 0; i < paletteCount; i++) palette.push(r.u16());
  const len = r.u32();
  if (len !== size * height * size) throw new Error('[ChunkCodec] voxel length mismatch');
  return { cx, cz, size, height, palette, voxels: r.bytes(len) };
}
