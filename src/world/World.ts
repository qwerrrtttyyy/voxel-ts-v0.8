import type { EventBus } from '../core/EventBus';
import type { ChunkDirtyEvent } from '../core/EventMap';
import type { BinaryHub } from '../binary/BinaryHub';
import { CHUNK_TAG, decodeChunk, type ChunkBinary } from '../binary/ChunkCodec';
import {
  chunkKey, chunkKeyPair, toChunkCoord, toLocalCoord, VOID_GROUND_Y,
  WORLD_CHUNKS, CHUNK_SIZE, CHUNK_HEIGHT, DEFAULT_STREAM_RADIUS,
} from '../config';
import { AIR_ID, type BlockRegistry } from './BlockRegistry';
import { Chunk } from './Chunk';
import type { IGenerator } from './IGenerator';
import {
  RegionManager, regionCoord, regionKeyOf, windowRegions, type RegionSummary,
} from './RegionManager';
import {
  REGION_TAG, encodeRegionIndex, decodeRegionIndex, type RegionIndexEntry,
} from './RegionCodec';

export interface StreamingConfig {
  /** 加载窗口半径（chunk 数），常驻 (2r+1)² 个 chunk */
  radius?: number;
  centerCx?: number;
  centerCz?: number;
}

export interface StreamResult {
  loaded: string[];
  unloaded: string[];
  regions: string[];
  restored: number;
  /** v0.7：本次之后窗口里还缺多少 chunk（分帧加载用；0 表示已铺满） */
  pending: number;
}

export interface StreamInfo {
  enabled: boolean;
  radius: number;
  centerCx: number;
  centerCz: number;
  windowChunks: number;
  loadedChunks: number;
  regions: number;
  archived: number;
  edited: number;
}

/**
 * chunk 容器 + 世界坐标换算 + 读写广播。
 * 只存数字，不存任何 Mesh；渲染层消费 dirty 队列自己重建。
 *
 * 扩展加固：dirty 改为去重队列，ChunkView.flush 是 O(k) 而不是每帧遍历全部 chunk。
 *
 * v0.6 分区 + 无限生成：
 *  - 默认保持「有限 6×6 浮空岛」语义，所有既有验收零改动通过
 *  - `enableStreaming()` 后按玩家所在 chunk 维护滑动窗口，负坐标可无限生成
 *  - 窗口外被编辑过的 chunk 按 region 归档，再次进入时恢复，不丢建造也不吃内存
 *  - 存档额外写一份 region 索引段，支持按区域导出 / 合并导入
 */
export class World {
  private readonly chunks = new Map<string, Chunk>();
  private readonly dirtyQueue: string[] = [];
  private readonly dirtySet = new Set<string>();
  private generator: IGenerator | null = null;

  // ---- v0.6 流式世界状态 ----
  private streamingOn = false;
  private radius = DEFAULT_STREAM_RADIUS;
  private centerCx = 3;
  private centerCz = 3;
  private readonly regionMgr = new RegionManager();
  /** 当前活跃 chunk 中被玩家改过的（卸载时要归档） */
  private readonly edited = new Set<string>();
  private restoredIndex: RegionIndexEntry[] = [];

  constructor(
    private readonly blocks: BlockRegistry,
    private readonly events: EventBus,
  ) {
    // 方块定义被插件卸载前，先清洗世界里仍引用该 id 的体素，
    // 避免「定义消失 → id 被复用 → 旧地形静默变成新方块」。
    blocks.onRelease((id) => this.purgeBlock(id));
  }

  /** 只换生成器 + 清空，不发事件；真正生成完由 pregenerate 广播一次 */
  setGenerator(gen: IGenerator): void {
    this.generator = gen;
    this.chunks.clear();
    this.clearDirty();
    // 换生成器 = 换世界：旧的分区归档与编辑标记必须一起作废
    this.regionMgr.clear();
    this.edited.clear();
    this.restoredIndex = [];
  }

  get generatorId(): string {
    return this.generator?.id ?? 'none';
  }

  /** 首版有限世界：一次性生成 WORLD_CHUNKS × WORLD_CHUNKS 个 chunk；流式模式改为按窗口生成 */
  pregenerate(): void {
    if (!this.generator) throw new Error('[World] no generator set');
    if (this.streamingOn) {
      this.updateStreaming(this.centerCx, this.centerCz, true);
    } else {
      for (let cx = 0; cx < WORLD_CHUNKS; cx++) {
        for (let cz = 0; cz < WORLD_CHUNKS; cz++) this.ensureChunk(cx, cz, false);
      }
    }
    this.events.emit('world:regenerated', {
      generatorId: this.generator.id, chunkCount: this.chunks.size,
    });
  }

  /** 任意整数 chunk 坐标都能生成（负坐标走 floor + 局部坐标修正，已支持） */
  ensureChunk(cx: number, cz: number, emit = true): Chunk {
    const key = chunkKey(cx, cz);
    const existing = this.chunks.get(key);
    if (existing) return existing;

    if (!this.generator) throw new Error('[World] no generator set');
    const chunk = new Chunk(cx, cz);
    const gen = this.generator;
    const originX = cx * chunk.size;
    const originZ = cz * chunk.size;

    for (let z = 0; z < chunk.size; z++) {
      for (let x = 0; x < chunk.size; x++) {
        const wx = originX + x;
        const wz = originZ + z;
        const surface = gen.surfaceY(wx, wz);
        for (let y = 0; y < chunk.height; y++) {
          const id = gen.blockAt(wx, y, wz, surface);
          if (id !== AIR_ID) chunk.data[chunk.index(x, y, z)] = id;
        }
      }
    }
    chunk.dirty = true;
    this.chunks.set(key, chunk);
    this.enqueueDirty(key);
    if (emit) this.events.emit('chunk:dirty', { key, cx, cz, reason: 'generated' });
    return chunk;
  }

  // ============================================================ 分区 + 流式窗口

  get streamInfo(): StreamInfo {
    return {
      enabled: this.streamingOn,
      radius: this.radius,
      centerCx: this.centerCx,
      centerCz: this.centerCz,
      windowChunks: (2 * this.radius + 1) ** 2,
      loadedChunks: this.chunks.size,
      regions: this.regionMgr.regionCount,
      archived: this.regionMgr.archivedCount,
      edited: this.edited.size,
    };
  }

  get regionIndex(): RegionSummary[] {
    const active = new Set(windowRegions(this.centerCx, this.centerCz, this.radius));
    return this.regionMgr.index(this.chunks, this.edited, active);
  }

  get restoredRegionIndex(): readonly RegionIndexEntry[] { return this.restoredIndex; }

  enableStreaming(cfg: StreamingConfig = {}): void {
    this.streamingOn = true;
    // 重复调用（例如「新世界」只重置中心）不应把视距设置打回默认值
    if (cfg.radius !== undefined) {
      this.radius = Math.max(1, Math.min(12, Math.floor(cfg.radius)));
    }
    this.centerCx = cfg.centerCx ?? this.centerCx;
    this.centerCz = cfg.centerCz ?? this.centerCz;
  }

  disableStreaming(): void { this.streamingOn = false; }

  /** 设置面板改视距时即时调整窗口并补齐，不必等玩家移动 */
  setStreamRadius(radius: number): void {
    const next = Math.max(1, Math.min(12, Math.floor(radius)));
    if (next === this.radius) return;
    this.radius = next;
    this.updateStreaming(this.centerCx, this.centerCz, true);
  }

  private windowKeys(cx: number, cz: number, radius: number): Array<[number, number, string]> {
    const out: Array<[number, number, string]> = [];
    for (let x = cx - radius; x <= cx + radius; x++) {
      for (let z = cz - radius; z <= cz + radius; z++) out.push([x, z, chunkKey(x, z)]);
    }
    return out;
  }

  private missingCount(cx: number, cz: number): number {
    let n = 0;
    for (const [, , key] of this.windowKeys(cx, cz, this.radius)) {
      if (!this.chunks.has(key)) n++;
    }
    return n;
  }

  /**
   * 把窗口滑到以 (cx,cz) 为中心：卸载窗口外、加载窗口内。
   * 中心没变且窗口已铺满时 O(1) 直接返回，适合挂在主循环里低频调用。
   *
   * v0.7 `maxLoad`：真 3D 地形生成比 2D 高度图贵，滑动窗口时每帧只生成
   * 有限个 chunk（按距玩家由近到远），把开销摊到多帧，脚下优先出现。
   * 默认 Infinity 保持原有「一次铺满」语义，所有既有验收零改动。
   */
  updateStreaming(
    cx: number, cz: number, force = false, maxLoad = Infinity,
  ): StreamResult {
    const empty: StreamResult = {
      loaded: [], unloaded: [], regions: [], restored: 0, pending: 0,
    };
    if (!this.streamingOn) return empty;
    if (!force && cx === this.centerCx && cz === this.centerCz
      && this.missingCount(cx, cz) === 0) return empty;
    this.centerCx = cx;
    this.centerCz = cz;

    const window = this.windowKeys(cx, cz, this.radius);
    const wanted = new Set(window.map(([, , key]) => key));
    const unloaded: string[] = [];

    for (const [key, c] of [...this.chunks]) {
      if (wanted.has(key)) continue;
      if (this.edited.has(key)) this.regionMgr.archive(c.cx, c.cz, c);
      this.edited.delete(key);
      this.chunks.delete(key);
      unloaded.push(key);
      this.events.emit('chunk:streamed', {
        key, cx: c.cx, cz: c.cz, action: 'unloaded', restored: false,
      });
    }
    if (unloaded.length) {
      const drop = new Set(unloaded);
      const kept = this.dirtyQueue.filter((k) => !drop.has(k));
      this.dirtyQueue.splice(0, this.dirtyQueue.length, ...kept);
      for (const k of drop) this.dirtySet.delete(k);
    }

    const missing = window
      .filter(([, , key]) => !this.chunks.has(key))
      .sort((a, b) =>
        (Math.max(Math.abs(a[0] - cx), Math.abs(a[1] - cz))
          - Math.max(Math.abs(b[0] - cx), Math.abs(b[1] - cz)))
        || a[2].localeCompare(b[2]));
    const toLoad = missing.slice(0, Math.max(0, Math.floor(maxLoad)));
    const pending = missing.length - toLoad.length;

    const loaded: string[] = [];
    let restored = 0;
    for (const [x, z, key] of toLoad) {
      const archived = this.regionMgr.take(x, z);
      if (archived) {
        archived.dirty = true;
        this.chunks.set(key, archived);
        this.edited.add(key);
        this.enqueueDirty(key);
        restored++;
      } else {
        this.ensureChunk(x, z, false);
      }
      loaded.push(key);
      this.events.emit('chunk:streamed', {
        key, cx: x, cz: z, action: 'loaded', restored: !!archived,
      });
    }

    // 新 chunk 的方块会改变相邻 chunk 的面剔除结果，四邻必须一起重建。
    // 去重队列保证「整窗加载」只让每个 chunk 重建一次。
    for (const key of loaded) {
      const [x, z] = chunkKeyPair(key);
      for (const [nx, nz] of [[x - 1, z], [x + 1, z], [x, z - 1], [x, z + 1]] as const) {
        if (this.chunks.has(chunkKey(nx, nz))) this.markDirty(nx, nz, 'remesh');
      }
    }

    const regions = windowRegions(cx, cz, this.radius);
    if (loaded.length || unloaded.length) {
      const idx = this.regionIndex;
      for (const key of regions) {
        const s = idx.find((e) => e.key === key);
        const [rx, rz] = key.split(',').map(Number);
        this.events.emit('region:changed', {
          key, rx, rz, action: 'activated',
          chunkCount: s?.chunkCount ?? 0, editedCount: s?.editedCount ?? 0,
        });
      }
    }
    return { loaded, unloaded, regions, restored, pending };
  }

  getChunk(cx: number, cz: number): Chunk | undefined {
    return this.chunks.get(chunkKey(cx, cz));
  }

  keys(): string[] { return [...this.chunks.keys()]; }

  forEach(fn: (chunk: Chunk) => void): void {
    for (const c of this.chunks.values()) fn(c);
  }

  /** 世界外一律视为空气 —— 未加载的流式 chunk 同样是空气 */
  getBlock(wx: number, wy: number, wz: number): number {
    if (wy < 0) return AIR_ID;
    const c = this.chunks.get(chunkKey(toChunkCoord(wx), toChunkCoord(wz)));
    if (!c) return AIR_ID;
    if (wy >= c.height) return AIR_ID;
    return c.get(toLocalCoord(wx), wy, toLocalCoord(wz));
  }

  setBlock(wx: number, wy: number, wz: number, id: number): boolean {
    const cx = toChunkCoord(wx), cz = toChunkCoord(wz);
    const key = chunkKey(cx, cz);
    const c = this.chunks.get(key);
    if (!c || wy < 0 || wy >= c.height) return false;
    const oldId = c.get(toLocalCoord(wx), wy, toLocalCoord(wz));
    if (!c.set(toLocalCoord(wx), wy, toLocalCoord(wz), id)) return false;

    this.edited.add(key);
    this.events.emit('block:changed', { x: wx, y: wy, z: wz, oldId, newId: id });
    this.markDirty(cx, cz, 'edited');
    // 改到 chunk 边界时，邻居的剔除结果也变了
    const lx = toLocalCoord(wx), lz = toLocalCoord(wz);
    if (lx === 0) this.markDirty(cx - 1, cz, 'neighbor');
    if (lx === c.size - 1) this.markDirty(cx + 1, cz, 'neighbor');
    if (lz === 0) this.markDirty(cx, cz - 1, 'neighbor');
    if (lz === c.size - 1) this.markDirty(cx, cz + 1, 'neighbor');
    return true;
  }

  private markDirty(cx: number, cz: number, reason: ChunkDirtyEvent['reason']): void {
    const key = chunkKey(cx, cz);
    const c = this.chunks.get(key);
    if (!c) return; // 世界边界外的邻居不存在，别把空 key 塞进重建队列
    c.dirty = true;
    this.enqueueDirty(key);
    this.events.emit('chunk:dirty', { key, cx, cz, reason });
  }

  private enqueueDirty(key: string): void {
    if (this.dirtySet.has(key)) return;
    this.dirtySet.add(key);
    this.dirtyQueue.push(key);
  }

  /** 渲染层每帧调用：只取最多 max 个待重建 chunk，O(k) */
  takeDirty(max: number): string[] {
    const out: string[] = [];
    while (out.length < max && this.dirtyQueue.length > 0) {
      const key = this.dirtyQueue.shift()!;
      this.dirtySet.delete(key);
      out.push(key);
    }
    return out;
  }

  get pendingDirty(): number { return this.dirtyQueue.length; }

  clearDirty(): void {
    this.dirtyQueue.length = 0;
    this.dirtySet.clear();
    for (const c of this.chunks.values()) c.dirty = false;
  }

  /** 生成器给的理论地表（调试 / 生成器自检用），碰撞不要用它 */
  surfaceY(wx: number, wz: number): number {
    return this.generator ? this.generator.surfaceY(wx, wz) : 0;
  }

  /**
   * 实际体素里该列最高的「可站立」方块 y；没有返回 -1。
   * 挖 / 放方块后立刻生效，是碰撞与拾取的唯一地面真值来源。
   */
  highestSolidY(wx: number, wz: number): number {
    const c = this.chunks.get(chunkKey(toChunkCoord(wx), toChunkCoord(wz)));
    if (!c) return -1;
    const lx = toLocalCoord(wx), lz = toLocalCoord(wz);
    for (let y = c.height - 1; y >= 0; y--) {
      const id = c.get(lx, y, lz);
      if (id !== AIR_ID && this.blocks.get(id).solid) return y;
    }
    return -1;
  }

  /** 脚底应处的 y；虚空列返回 VOID_GROUND_Y 防止掉进 -∞ */
  groundY(wx: number, wz: number): number {
    const y = this.highestSolidY(Math.floor(wx), Math.floor(wz));
    return y < 0 ? VOID_GROUND_Y : y + 1;
  }

  isOpaque(id: number): boolean {
    return this.blocks.get(id).opaque;
  }

  /** AABB 碰撞用：该 id 是否参与实体碰撞（空气 / 水 / 装饰物返回 false） */
  isSolid(id: number): boolean {
    return this.blocks.get(id).solid;
  }

  // ============================================================ 存档 / 分区导出

  /** 整份世界 → 一个 TLV 信封（未知插件段可共存） */
  toEnvelope(binary: BinaryHub, extra: Parameters<BinaryHub['encode']>[0] = []): ArrayBuffer {
    const chunks = [...this.chunks.values()].map((c) => ({ tag: CHUNK_TAG, payload: c.toBinary() }));
    const entries = [...extra, ...chunks];
    if (this.streamingOn) {
      // 已滑出窗口的「玩家改动」不能丢：一并写进存档，回来时按 region 恢复
      for (const [, c] of this.regionMgr.archivedChunks()) {
        entries.push({ tag: CHUNK_TAG, payload: c.toBinary() });
      }
      entries.push({ tag: REGION_TAG, payload: encodeRegionIndex(this.regionIndex) });
    }
    return binary.encode(entries);
  }

  /** 只导出一个 region 的 chunk 段 + 索引段，用于分块备份 / 传输 */
  toRegionEnvelope(
    binary: BinaryHub,
    rx: number,
    rz: number,
    extra: Parameters<BinaryHub['encode']>[0] = [],
  ): ArrayBuffer {
    const inRegion = (c: Chunk): boolean =>
      regionCoord(c.cx) === rx && regionCoord(c.cz) === rz;
    const chunks = [
      ...[...this.chunks.values()].filter(inRegion),
      ...this.regionMgr.chunksIn(rx, rz),
    ];
    const index = this.regionIndex.filter((s) => s.rx === rx && s.rz === rz);
    return binary.encode([
      ...extra,
      { tag: REGION_TAG, payload: encodeRegionIndex(index) },
      ...chunks.map((c) => ({ tag: CHUNK_TAG, payload: c.toBinary() })),
    ]);
  }

  /** 把一个 region 信封合并回当前世界（窗口外的 chunk 自动归档） */
  fromRegionEnvelope(binary: BinaryHub, buf: ArrayBuffer): {
    chunks: number; archived: number; regions: string[];
  } {
    const entries = binary.decode(buf);
    const wanted = new Set(this.windowKeys(this.centerCx, this.centerCz, this.radius).map(([, , k]) => k));
    let chunks = 0, archived = 0;
    for (const e of entries) {
      if (e.tag === REGION_TAG) {
        for (const item of decodeRegionIndex(e.payload)) this.regionMgr.note(item.rx, item.rz);
        continue;
      }
      if (e.tag !== CHUNK_TAG) continue;
      const c = this.decodeChunkSegment(e.payload);
      const key = chunkKey(c.cx, c.cz);
      if (this.streamingOn && !wanted.has(key)) {
        this.regionMgr.archive(c.cx, c.cz, c);
        archived++;
      } else {
        c.dirty = true;
        this.chunks.set(key, c);
        this.edited.add(key);
        this.enqueueDirty(key);
      }
      chunks++;
    }
    const regions = [...new Set(entries
      .filter((e) => e.tag === REGION_TAG)
      .flatMap((e) => decodeRegionIndex(e.payload).map((i) => `${i.rx},${i.rz}`)))];
    return { chunks, archived, regions };
  }

  private decodeChunkSegment(payload: ArrayBuffer): Chunk {
    const d: ChunkBinary = decodeChunk(payload);
    // 世界坐标换算固定用全局 CHUNK_SIZE/CHUNK_HEIGHT；尺寸不同的存档必须显式拒绝，
    // 否则会读出一份「看着有数据、实际全部错位」的世界。
    if (d.size !== CHUNK_SIZE || d.height !== CHUNK_HEIGHT) {
      throw new Error(
        `[World] chunk ${d.cx},${d.cz} 尺寸 ${d.size}×${d.height} 与当前配置 ` +
        `${CHUNK_SIZE}×${CHUNK_HEIGHT} 不符，拒绝装载`,
      );
    }
    const c = new Chunk(d.cx, d.cz, d.size, d.height);
    c.data.set(d.voxels.subarray(0, c.data.length));
    return c;
  }

  /**
   * 存档装载：信封 → 重建全部 chunk。未知插件段原样跳过并计数，
   * 交给插件自己按 tag 解析（前向兼容）。
   *
   * 流式模式下，窗口外的 chunk 归档到对应 region，玩家走近时自动恢复；
   * 有限模式保持 v0.6 之前的原样行为。
   */
  fromEnvelope(binary: BinaryHub, buf: ArrayBuffer): { chunks: number; segments: number; unknown: number } {
    const entries = binary.decode(buf);
    const chunkEntries = entries.filter((e) => e.tag === CHUNK_TAG);
    if (chunkEntries.length === 0) throw new Error('[World] envelope contains no chunk segments');
    const unknown = entries.filter(
      (e) => e.tag !== CHUNK_TAG && e.tag !== REGION_TAG,
    ).length;

    if (this.streamingOn) {
      this.restoredIndex = entries
        .filter((e) => e.tag === REGION_TAG)
        .flatMap((e) => decodeRegionIndex(e.payload));
      for (const item of this.restoredIndex) this.regionMgr.note(item.rx, item.rz);

      this.chunks.clear();
      this.edited.clear();
      this.regionMgr.clear();
      this.clearDirty();
      // note() 登记的空 region 会被 clear 抹掉，重新登记一次
      for (const item of this.restoredIndex) this.regionMgr.note(item.rx, item.rz);

      const wanted = new Set(this.windowKeys(this.centerCx, this.centerCz, this.radius).map(([, , k]) => k));
      for (const e of chunkEntries) {
        const c = this.decodeChunkSegment(e.payload);
        const key = chunkKey(c.cx, c.cz);
        if (wanted.has(key)) {
          c.dirty = true;
          this.chunks.set(key, c);
          this.edited.add(key);
          this.enqueueDirty(key);
        } else {
          this.regionMgr.archive(c.cx, c.cz, c);
        }
      }
      // 补齐窗口里存档没有覆盖的 chunk（确定性生成）
      this.updateStreaming(this.centerCx, this.centerCz, true);
      // v0.8：事件里的 chunkCount 统一表示「当前活跃 chunk 数」，与有限分支一致；
      // 返回值仍保留存档段数，供验收 / 日志观察读档规模。
      this.events.emit('world:loaded', {
        chunkCount: this.chunks.size, segmentCount: entries.length, unknownSegments: unknown,
      });
      return { chunks: chunkEntries.length, segments: entries.length, unknown };
    }

    const next = new Map<string, Chunk>();
    for (const e of chunkEntries) {
      const c = this.decodeChunkSegment(e.payload);
      next.set(chunkKey(c.cx, c.cz), c);
    }
    if (next.size === 0) throw new Error('[World] envelope contains no chunk segments');

    this.chunks.clear();
    for (const [k, c] of next) this.chunks.set(k, c);
    this.clearDirty();
    for (const key of next.keys()) {
      const [cx, cz] = chunkKeyPair(key);
      this.markDirty(cx, cz, 'generated');
    }
    this.events.emit('world:loaded', {
      chunkCount: next.size, segmentCount: entries.length, unknownSegments: unknown,
    });
    return { chunks: next.size, segments: entries.length, unknown };
  }

  /**
   * 方块定义被释放前调用：把世界里残留的该 id 全部清成空气并标脏，
   * 否则旧体素会在 id 被新插件复用时「幽灵替换」成另一个方块。
   */
  purgeBlock(id: number): void {
    for (const [key, c] of this.chunks) {
      let changed = false;
      for (let i = 0; i < c.data.length; i++) {
        if (c.data[i] === id) { c.data[i] = AIR_ID; changed = true; }
      }
      if (changed) {
        const [cx, cz] = chunkKeyPair(key);
        this.markDirty(cx, cz, 'edited');
      }
    }
  }

  /** 实际已生成 chunk 的世界边界；流式模式下即当前窗口，天然跟随玩家 */
  get bounds(): { minX: number; maxX: number; minZ: number; maxZ: number } {
    let minCx = Infinity, maxCx = -Infinity, minCz = Infinity, maxCz = -Infinity;
    for (const c of this.chunks.values()) {
      if (c.cx < minCx) minCx = c.cx;
      if (c.cx > maxCx) maxCx = c.cx;
      if (c.cz < minCz) minCz = c.cz;
      if (c.cz > maxCz) maxCz = c.cz;
    }
    if (!Number.isFinite(minCx)) return { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
    return {
      minX: minCx * CHUNK_SIZE,
      maxX: (maxCx + 1) * CHUNK_SIZE,
      minZ: minCz * CHUNK_SIZE,
      maxZ: (maxCz + 1) * CHUNK_SIZE,
    };
  }
}
