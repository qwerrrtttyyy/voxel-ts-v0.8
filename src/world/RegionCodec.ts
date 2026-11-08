import { BinaryReader, BinaryWriter } from '../binary/BinaryBuffer';
import type { RegionSummary } from './RegionManager';

/**
 * v0.6 区域清单段（信封内系统段，与 chunk 段并列）。
 *
 *   u32 'REGN' | u16 version=1 | u16 count
 *   repeat: i32 rx | i32 rz | u16 chunkCount | u16 editedCount | u8 flags(bit0=active) | u8 reserved
 *
 * 段本身不存体素，只做「这个存档覆盖过哪些区域、各有多少改动」的索引：
 * 分区导出 / 按需装载 / 菜单展示都读它，旧存档没有这段也能正常读取。
 */
export const REGION_TAG = 0xf002;
export const REGION_MAGIC = 0x5245474e;
export const REGION_INDEX_VERSION = 1;

export type RegionIndexEntry = Pick<RegionSummary, 'rx' | 'rz' | 'chunkCount' | 'editedCount' | 'active'>;

export function encodeRegionIndex(entries: readonly RegionIndexEntry[]): ArrayBuffer {
  const w = new BinaryWriter();
  w.u32(REGION_MAGIC).u16(REGION_INDEX_VERSION).u16(entries.length);
  for (const e of entries) {
    w.i32(e.rx).i32(e.rz)
      .u16(Math.min(0xffff, e.chunkCount))
      .u16(Math.min(0xffff, e.editedCount))
      .u8(e.active ? 1 : 0)
      .u8(0);
  }
  return w.finish();
}

export function decodeRegionIndex(buf: ArrayBuffer): RegionIndexEntry[] {
  const r = BinaryReader.from(buf);
  if (r.u32() !== REGION_MAGIC) throw new Error('[RegionCodec] bad magic');
  const version = r.u16();
  if (version !== REGION_INDEX_VERSION) {
    throw new Error(`[RegionCodec] unsupported region index version ${version}`);
  }
  const count = r.u16();
  const out: RegionIndexEntry[] = [];
  for (let i = 0; i < count; i++) {
    const rx = r.i32(), rz = r.i32();
    const chunkCount = r.u16(), editedCount = r.u16();
    const active = r.u8() === 1;
    r.u8();
    out.push({ rx, rz, chunkCount, editedCount, active });
  }
  return out;
}
