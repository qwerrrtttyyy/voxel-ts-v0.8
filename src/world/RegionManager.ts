import { CHUNK_SIZE, REGION_CHUNKS, chunkKey, chunkKeyPair } from '../config';
import type { Chunk } from './Chunk';

/**
 * v0.6 分区系统：把无限世界的 chunk 按 region 归档。
 *
 * 一个 region = REGION_CHUNKS × REGION_CHUNKS 个 chunk（默认 16×16 = 256 方块见方），
 * 用 floor(cx / REGION_CHUNKS) 划区，负坐标同样正确。
 *
 * 这里只存「被玩家改过、但已随窗口卸载」的 chunk —— 未改动的 chunk 由确定性
 * 生成器在再次进入窗口时原样重算，不必落盘。这既让无限世界来回走动不丢建造，
 * 又不会让内存随探索距离无限膨胀。
 */
export interface RegionSummary {
  key: string;
  rx: number;
  rz: number;
  /** 该 region 内已知（活跃 + 归档）的 chunk 数 */
  chunkCount: number;
  /** 其中被编辑过的 chunk 数 */
  editedCount: number;
  /** 是否位于当前加载窗口覆盖的 region 内 */
  active: boolean;
}

interface RegionRecord {
  rx: number;
  rz: number;
  chunks: Map<string, Chunk>;
  touched: number;
}

export function regionCoord(chunkCoord: number): number {
  return Math.floor(chunkCoord / REGION_CHUNKS);
}

export function regionKeyOf(cx: number, cz: number): string {
  return `${regionCoord(cx)},${regionCoord(cz)}`;
}

export function regionBounds(rx: number, rz: number): {
  minX: number; maxX: number; minZ: number; maxZ: number;
} {
  const size = REGION_CHUNKS * CHUNK_SIZE;
  return {
    minX: rx * size, maxX: (rx + 1) * size,
    minZ: rz * size, maxZ: (rz + 1) * size,
  };
}

/** 窗口（中心 cx,cz + 半径 radius）覆盖到的全部 region key */
export function windowRegions(cx: number, cz: number, radius: number): string[] {
  const out = new Set<string>();
  const r0 = regionCoord(cx - radius), r1 = regionCoord(cx + radius);
  const s0 = regionCoord(cz - radius), s1 = regionCoord(cz + radius);
  for (let rx = r0; rx <= r1; rx++) {
    for (let rz = s0; rz <= s1; rz++) out.add(`${rx},${rz}`);
  }
  return [...out];
}

export class RegionManager {
  private readonly regions = new Map<string, RegionRecord>();
  private seq = 0;

  private record(cx: number, cz: number): RegionRecord {
    const key = regionKeyOf(cx, cz);
    let rec = this.regions.get(key);
    if (!rec) {
      rec = { rx: regionCoord(cx), rz: regionCoord(cz), chunks: new Map(), touched: ++this.seq };
      this.regions.set(key, rec);
    }
    return rec;
  }

  /** 归档一个已编辑 chunk；同坐标重复归档直接覆盖 */
  archive(cx: number, cz: number, chunk: Chunk): void {
    this.record(cx, cz).chunks.set(chunkKey(cx, cz), chunk);
  }

  /** 取回并移除归档；返回 undefined 表示该坐标从未被改过 */
  take(cx: number, cz: number): Chunk | undefined {
    const key = regionKeyOf(cx, cz);
    const rec = this.regions.get(key);
    const chunk = rec?.chunks.get(chunkKey(cx, cz));
    if (chunk && rec) {
      rec.chunks.delete(chunkKey(cx, cz));
      if (rec.chunks.size === 0) this.regions.delete(key);
    }
    return chunk;
  }

  has(cx: number, cz: number): boolean {
    return !!this.regions.get(regionKeyOf(cx, cz))?.chunks.has(chunkKey(cx, cz));
  }

  get archivedCount(): number {
    let n = 0;
    for (const r of this.regions.values()) n += r.chunks.size;
    return n;
  }

  get regionCount(): number { return this.regions.size; }

  /** 全部归档 chunk，供整份存档导出 */
  archivedChunks(): Array<[string, Chunk]> {
    const out: Array<[string, Chunk]> = [];
    for (const r of this.regions.values()) for (const [k, c] of r.chunks) out.push([k, c]);
    return out;
  }

  /** 某个 region 的全部归档 chunk，供「按区导出」 */
  chunksIn(rx: number, rz: number): Chunk[] {
    return [...(this.regions.get(`${rx},${rz}`)?.chunks.values() ?? [])];
  }

  /** 从存档的区域清单里登记「已知但当前无 chunk 数据」的 region */
  note(rx: number, rz: number): void {
    const key = `${rx},${rz}`;
    if (!this.regions.has(key)) {
      this.regions.set(key, { rx, rz, chunks: new Map(), touched: ++this.seq });
    }
  }

  keys(): string[] { return [...this.regions.keys()]; }

  clear(): void { this.regions.clear(); this.seq = 0; }

  /** 把「活跃 chunk 摘要」和归档摘要合并成一份区域索引 */
  index(active: ReadonlyMap<string, Chunk>, edited: ReadonlySet<string>, activeKeys: ReadonlySet<string>): RegionSummary[] {
    const map = new Map<string, RegionSummary>();
    const bump = (cx: number, cz: number, isEdited: boolean, isActive: boolean): void => {
      const key = regionKeyOf(cx, cz);
      let s = map.get(key);
      if (!s) {
        s = { key, rx: regionCoord(cx), rz: regionCoord(cz), chunkCount: 0, editedCount: 0, active: false };
        map.set(key, s);
      }
      s.chunkCount++;
      if (isEdited) s.editedCount++;
      if (isActive) s.active = true;
    };
    for (const [key, c] of active) {
      const [cx, cz] = chunkKeyPair(key);
      bump(cx, cz, edited.has(key), activeKeys.has(regionKeyOf(cx, cz)));
    }
    for (const [key, c] of this.archivedChunks()) {
      const [cx, cz] = chunkKeyPair(key);
      void c;
      bump(cx, cz, true, false);
    }
    for (const key of this.keys()) {
      if (map.has(key)) continue;
      const [rx, rz] = key.split(',').map(Number);
      map.set(key, { key, rx, rz, chunkCount: 0, editedCount: 0, active: activeKeys.has(key) });
    }
    return [...map.values()].sort((a, b) => a.rx - b.rx || a.rz - b.rz || a.key.localeCompare(b.key));
  }
}
