import { BinaryReader, BinaryWriter, crc32 } from './BinaryBuffer';
import { CHUNK_TAG, LEGACY_CHUNK_TAG, CHUNK_MAGIC } from './ChunkCodec';
import { REGION_TAG } from '../world/RegionCodec';

/** 信封魔数 "MCB0" */
export const ENVELOPE_MAGIC = 0x4d434230;
/** v2：chunk 段迁入独立 tag 区间；v1 存档由内置迁移器自动升级，不再报废 */
export const ENVELOPE_VERSION = 2;

/**
 * v0.6 存档迁移器：把旧版本的段列表转换成下一版本，链式执行直到 ENVELOPE_VERSION。
 * 与「未知 tag 原样保留」互补：前者解决结构升级，后者解决插件数据前向兼容。
 */
export interface EnvelopeMigration {
  readonly from: number;
  readonly to: number;
  readonly label: string;
  apply(entries: EnvelopeEntry[]): EnvelopeEntry[];
}

export interface EnvelopeEntry {
  /** u16，插件私有的段标识 */
  tag: number;
  payload: ArrayBuffer;
}

export interface BinaryHandler<T> {
  tag: number;
  name: string;
  /** 归属插件，用于冲突诊断与校验 */
  owner?: string;
  encode(value: T): ArrayBuffer;
  decode(buf: ArrayBuffer): T;
  /** 可选：插件声明「存档时我要写一段自己的数据」 */
  snapshot?(): T;
}

/**
 * FNV-1a 派生 tag：每个插件用 id 申领自己的命名空间，
 * 主程序完全不认识插件数据也能无损透传（存档 / 网络包 / WASM 共享内存都走这里）。
 */
export function pluginTag(pluginId: string, local: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < pluginId.length; i++) {
    h ^= pluginId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) ^ (local & 0xff)) & 0xffff;
}

/**
 * TLV 二进制信封：
 *   u32 magic | u16 version | u16 count
 *   repeat: u16 tag | u32 len | payload bytes | align4 pad
 * 版本化 + 未知 tag 保留原 bytes，向后兼容靠它。
 */
export class BinaryHub {
  private readonly handlers = new Map<number, BinaryHandler<unknown>>();
  private readonly tagClaims = new Map<number, string>();
  /** owner+local → 已分配的 tag，保证同插件重复申领幂等（reload 安全） */
  private readonly assignments = new Map<string, number>();
  private readonly migrations: EnvelopeMigration[] = [];
  /** 保留段：插件 claimTag 不得占用，避免与 chunk / 未来系统段撞车 */
  private readonly reservedTags = new Set<number>([CHUNK_TAG, LEGACY_CHUNK_TAG, REGION_TAG]);

  /** 内置迁移：v1 的 36 个 chunk 段都挤在 0x0001，v2 起改到独立 tag */
  private readonly builtinMigrations: EnvelopeMigration[] = [{
    from: 1,
    to: 2,
    label: 'chunk 段独立化（0x0001 → 0xf001）',
    apply(entries) {
      return entries.map((e) => {
        if (e.tag !== LEGACY_CHUNK_TAG || e.payload.byteLength < 4) return e;
        const magic = new DataView(e.payload).getUint32(0, true);
        return magic === CHUNK_MAGIC ? { ...e, tag: CHUNK_TAG } : e;
      });
    },
  }];

  /** 注册一段版本迁移；调用方按 from 链式拼接，decode 时自动顺序执行 */
  registerMigration(m: EnvelopeMigration): () => void {
    this.migrations.push(m);
    this.migrations.sort((a, b) => a.from - b.from);
    return () => {
      const i = this.migrations.indexOf(m);
      if (i >= 0) this.migrations.splice(i, 1);
    };
  }

  /** 保留一个系统段 tag（v0.6 起 chunk 段固定占用 0xf001 / 0x0001） */
  reserveTag(tag: number): void { this.reservedTags.add(tag); }

  get migrationLabels(): string[] {
    return [...this.builtinMigrations, ...this.migrations]
      .map((m) => `${m.from}→${m.to} ${m.label}`);
  }

  /**
   * 申领 tag。16 位 FNV 空间存在真实碰撞（实测 2500 个插件名即撞车），
   * 因此冲突时线性探测下一个空位，而不是直接让插件启动失败。
   * 返回实际分配到的 tag，调用方必须使用返回值。
   */
  claimTag(owner: string, local: number): number {
    const key = `${owner}\u0000${local}`;
    const prev = this.assignments.get(key);
    if (prev !== undefined && this.tagClaims.get(prev) === owner) return prev;

    const base = pluginTag(owner, local);
    for (let i = 0; i <= 0xffff; i++) {
      const tag = (base + i) & 0xffff;
      if (this.reservedTags.has(tag)) continue;
      const claimed = this.tagClaims.get(tag);
      if ((claimed === undefined || claimed === owner) && !this.handlers.has(tag)) {
        this.tagClaims.set(tag, owner);
        this.assignments.set(key, tag);
        return tag;
      }
    }
    throw new Error('[BinaryHub] u16 tag space exhausted');
  }

  register<T>(handler: BinaryHandler<T>): () => void {
    const existing = this.handlers.get(handler.tag);
    if (existing) {
      throw new Error(`[BinaryHub] tag 0x${handler.tag.toString(16)} already claimed by ${existing.owner ?? existing.name}`);
    }
    this.handlers.set(handler.tag, handler as BinaryHandler<unknown>);
    if (handler.owner) this.tagClaims.set(handler.tag, handler.owner);
    return () => {
      this.handlers.delete(handler.tag);
      // 卸载时同步释放 tag 认领与分配记录，避免命名空间只增不减。
      if (handler.owner && this.tagClaims.get(handler.tag) === handler.owner) {
        this.tagClaims.delete(handler.tag);
      }
      for (const [k, v] of this.assignments) {
        if (v === handler.tag) this.assignments.delete(k);
      }
    };
  }

  has(tag: number): boolean { return this.handlers.has(tag); }

  names(): string[] {
    return [...this.handlers.values()].map((h) => h.name);
  }

  owners(): string[] {
    return [...new Set([...this.handlers.values()].map((h) => h.owner ?? '<unowned>'))];
  }

  /** v0.8：给深度审批规则的一次性只读快照 */
  inspect(): {
    owners: string[]; issues: string[];
    reservedTags: number[]; claimedTags: number[]; migrationLabels: string[];
  } {
    return {
      owners: this.owners(),
      issues: this.validate(),
      reservedTags: [...this.reservedTags],
      claimedTags: [...this.tagClaims.keys()],
      migrationLabels: this.migrationLabels,
    };
  }

  /** 启动期自检：返回人类可读的问题列表，空数组代表健康 */
  validate(): string[] {
    const issues: string[] = [];
    for (const h of this.handlers.values()) {
      if (!h.owner) issues.push(`${h.name}: 未声明 owner，卸载排查困难`);
      if (typeof h.encode !== 'function' || typeof h.decode !== 'function') {
        issues.push(`${h.name}: encode/decode 缺失`);
      }
    }
    return issues;
  }

  /**
   * 向插件收集「当前要写进存档的私有段」。
   * 主程序不认识段内容，也不需要认识 —— 这就是二进制融合的接缝。
   */
  snapshot(owner?: string): EnvelopeEntry[] {
    const out: EnvelopeEntry[] = [];
    for (const h of this.handlers.values()) {
      if (!h.snapshot) continue;
      if (owner && h.owner !== owner) continue;
      try {
        out.push({ tag: h.tag, payload: h.encode(h.snapshot()) });
      } catch (err) {
        // 单个插件的私有段写失败，不应让整份世界存档导出失败。
        console.error(`[BinaryHub] snapshot failed for ${h.name}`, err);
      }
    }
    return out;
  }

  /** version 仅供测试 / 导出旧格式使用；正式写入一律是当前 ENVELOPE_VERSION */
  encode(entries: readonly EnvelopeEntry[], version = ENVELOPE_VERSION): ArrayBuffer {
    const w = new BinaryWriter();
    w.u32(ENVELOPE_MAGIC).u16(version).u16(entries.length);
    for (const e of entries) {
      const body = new Uint8Array(e.payload);
      w.u16(e.tag).u32(body.byteLength).bytes(body).align4();
    }
    // 尾部 CRC32：旧格式（无尾部）在 decode 时自动跳过，保持向后兼容。
    const body = new Uint8Array(w.finish());
    const out = new Uint8Array(body.length + 4);
    out.set(body);
    new DataView(out.buffer).setUint32(body.length, crc32(body), true);
    return out.buffer;
  }

  decode(buf: ArrayBuffer): EnvelopeEntry[] {
    const r = BinaryReader.from(buf);
    if (r.u32() !== ENVELOPE_MAGIC) throw new Error('[BinaryHub] bad magic');
    const version = r.u16();
    // 新客户端可读旧存档（逐版本迁移）；只有「比自己更新」的版本才拒绝并给出升级提示。
    if (version < 1 || version > ENVELOPE_VERSION) {
      throw new Error(`[BinaryHub] envelope version ${version} not supported (max ${ENVELOPE_VERSION})`);
    }
    const count = r.u16();
    let out: EnvelopeEntry[] = [];
    for (let i = 0; i < count; i++) {
      const tag = r.u16();
      const len = r.u32();
      const payload = r.bytes(len).slice().buffer as ArrayBuffer;
      r.align4();
      out.push({ tag, payload });
    }
    if (r.remaining > 0) {
      if (r.remaining < 4) throw new Error('[BinaryHub] misaligned trailing bytes');
      const expected = r.u32();
      const actual = crc32(new Uint8Array(buf, 0, r.offset - 4));
      if (expected !== actual) throw new Error('[BinaryHub] checksum mismatch');
    }
    if (r.remaining !== 0) throw new Error('[BinaryHub] trailing bytes after checksum');

    // 逐版本迁移：链式找到能把 version 递进到当前版本的迁移器，缺一环就明确报错，
    // 而不是把旧存档当成坏文件丢掉。
    if (version < ENVELOPE_VERSION) {
      const chain = [...this.builtinMigrations, ...this.migrations]
        .sort((a, b) => a.from - b.from || a.to - b.to);
      let current = version;
      while (current < ENVELOPE_VERSION) {
        const m = chain.find((x) => x.from === current && x.to > current && x.to <= ENVELOPE_VERSION);
        if (!m) {
          throw new Error(`[BinaryHub] 缺少 version ${current} 的迁移器，无法读取该存档`);
        }
        out = m.apply(out);
        current = m.to;
      }
    }
    return out;
  }

  /** 认识的段解码成值，不认识的段原样保留 bytes（前向兼容） */
  decodeAll(buf: ArrayBuffer): Array<{ tag: number; name: string; value?: unknown; raw?: Uint8Array }> {
    return this.decode(buf).map((e) => {
      const h = this.handlers.get(e.tag);
      if (!h) return { tag: e.tag, name: `<unknown:0x${e.tag.toString(16)}>`, raw: new Uint8Array(e.payload) };
      return { tag: e.tag, name: h.name, value: h.decode(e.payload) };
    });
  }
}
