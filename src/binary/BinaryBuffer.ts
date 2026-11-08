/**
 * 零依赖的二进制读写原语，统一小端序。
 * 所有跨插件 / 跨存档 / 跨网络的数据都从这里过，不用 JSON。
 */
export class BinaryWriter {
  private buffer = new ArrayBuffer(256);
  private view = new DataView(this.buffer);
  private offset = 0;

  private ensure(extra: number): void {
    const need = this.offset + extra;
    if (need <= this.buffer.byteLength) return;
    let size = this.buffer.byteLength;
    while (size < need) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(new Uint8Array(this.buffer));
    this.buffer = next;
    this.view = new DataView(next);
  }

  u8(v: number): this { this.ensure(1); this.view.setUint8(this.offset, v); this.offset += 1; return this; }
  i8(v: number): this { this.ensure(1); this.view.setInt8(this.offset, v); this.offset += 1; return this; }
  u16(v: number): this { this.ensure(2); this.view.setUint16(this.offset, v, true); this.offset += 2; return this; }
  i16(v: number): this { this.ensure(2); this.view.setInt16(this.offset, v, true); this.offset += 2; return this; }
  u32(v: number): this { this.ensure(4); this.view.setUint32(this.offset, v >>> 0, true); this.offset += 4; return this; }
  i32(v: number): this { this.ensure(4); this.view.setInt32(this.offset, v, true); this.offset += 4; return this; }
  f32(v: number): this { this.ensure(4); this.view.setFloat32(this.offset, v, true); this.offset += 4; return this; }
  f64(v: number): this { this.ensure(8); this.view.setFloat64(this.offset, v, true); this.offset += 8; return this; }

  bytes(src: Uint8Array): this {
    this.ensure(src.byteLength);
    new Uint8Array(this.buffer, this.offset, src.byteLength).set(src);
    this.offset += src.byteLength;
    return this;
  }

  /** u32 长度 + UTF-8 字节 */
  string(v: string): this {
    const data = new TextEncoder().encode(v);
    this.u32(data.byteLength).bytes(data);
    return this;
  }

  /** 4 字节对齐填充，方便 C / Rust 侧直接映射 */
  align4(): this {
    while (this.offset % 4 !== 0) this.u8(0);
    return this;
  }

  get length(): number { return this.offset; }

  finish(): ArrayBuffer {
    return this.buffer.slice(0, this.offset);
  }
}

export class BinaryReader {
  private pos = 0;

  constructor(private readonly view: DataView) {}

  static from(buf: ArrayBuffer): BinaryReader {
    return new BinaryReader(new DataView(buf));
  }

  get offset(): number { return this.pos; }
  get remaining(): number { return this.view.byteLength - this.pos; }

  private need(n: number): void {
    if (this.pos + n > this.view.byteLength) throw new Error('[BinaryReader] unexpected end of buffer');
  }

  u8(): number { this.need(1); const v = this.view.getUint8(this.pos); this.pos += 1; return v; }
  i8(): number { this.need(1); const v = this.view.getInt8(this.pos); this.pos += 1; return v; }
  u16(): number { this.need(2); const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  i16(): number { this.need(2); const v = this.view.getInt16(this.pos, true); this.pos += 2; return v; }
  u32(): number { this.need(4); const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  i32(): number { this.need(4); const v = this.view.getInt32(this.pos, true); this.pos += 4; return v; }
  f32(): number { this.need(4); const v = this.view.getFloat32(this.pos, true); this.pos += 4; return v; }
  f64(): number { this.need(8); const v = this.view.getFloat64(this.pos, true); this.pos += 8; return v; }

  bytes(n: number): Uint8Array {
    this.need(n);
    const out = new Uint8Array(n);
    out.set(new Uint8Array(this.view.buffer, this.view.byteOffset + this.pos, n));
    this.pos += n;
    return out;
  }

  string(): string {
    const n = this.u32();
    return new TextDecoder().decode(this.bytes(n));
  }

  skip(n: number): this { this.need(n); this.pos += n; return this; }
  /** 读取端对齐也必须校验边界，损坏数据不能让游标悄悄越过缓冲区 */
  align4(): this {
    while (this.pos % 4 !== 0) { this.need(1); this.pos++; }
    return this;
  }
}

/** CRC32（IEEE 802.3），用于信封完整性校验，零依赖 */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let k = 0; k < 8; k++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
