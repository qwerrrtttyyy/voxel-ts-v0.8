import { AUTO_ID_START } from '../config';

export const AIR_ID = 0;

export type FaceName = 'top' | 'bottom' | 'north' | 'south' | 'east' | 'west';

export interface BlockDef {
  readonly id: number;
  /** 命名空间全名，形如 `voxel.blocks:grass` */
  readonly name: string;
  /** 是否完全不透明（决定邻接面能否剔除） */
  readonly opaque: boolean;
  /** 是否参与碰撞 */
  readonly solid: boolean;
  /** 每面取 atlas 里的哪个 tile key；可用 all 简写 */
  readonly faces?: Partial<Record<FaceName, string>>;
  readonly all?: string;
  /** v0.3：自发光方块（顶点色提亮 + 夜里仍然醒目） */
  readonly emissive?: boolean;
  /** v0.3：液体不参与碰撞，也不产生 AO 遮蔽 */
  readonly liquid?: boolean;
  /** v0.3：挖掘耗时倍率，1 = 标准 */
  readonly hardness?: number;
}

export type BlockSpec = Omit<BlockDef, 'id' | 'name'> & { id?: number };

/**
 * 方块是「数据」不是「代码」。
 *
 * 扩展加固：插件不再手写 id（多插件必撞），改用 define(owner, local, spec)
 * 自动分配 + 命名空间；define 幂等，热重载不会重复注册。
 */
export class BlockRegistry {
  private readonly byId = new Map<number, BlockDef>();
  private readonly nameIndex = new Map<string, BlockDef>();
  private readonly owners = new Map<number, string>();
  private readonly freeIds: number[] = [];
  private nextAuto = AUTO_ID_START;
  /** id 释放前的通知：World 借此清理仍引用该 id 的体素数据 */
  private readonly releaseHandlers = new Set<(id: number) => void>();

  constructor() {
    this.register({ id: AIR_ID, name: 'air', opaque: false, solid: false, faces: {} });
  }

  register(def: BlockDef): void {
    if (!Number.isInteger(def.id) || def.id < 0 || def.id > 255) {
      throw new Error(`[Blocks] id must be uint8, got ${def.id}`);
    }
    if (this.byId.has(def.id)) throw new Error(`[Blocks] id ${def.id} already used by ${this.byId.get(def.id)!.name}`);
    if (this.nameIndex.has(def.name)) throw new Error(`[Blocks] name ${def.name} already used`);
    this.byId.set(def.id, def);
    this.nameIndex.set(def.name, def);
  }

  /** 命名空间 + 自动 id；重复调用返回同一 id，热重载安全 */
  define(owner: string, local: string, spec: BlockSpec): number {
    const fullName = `${owner}:${local}`;
    const existing = this.nameIndex.get(fullName);
    if (existing) return existing.id;

    const id = spec.id ?? this.allocateId();
    this.register({
      id, name: fullName, opaque: spec.opaque, solid: spec.solid,
      faces: spec.faces, all: spec.all,
      emissive: spec.emissive, liquid: spec.liquid, hardness: spec.hardness,
    });
    this.owners.set(id, owner);
    return id;
  }

  /** 订阅 id 释放；返回取消订阅函数。必须在删除定义之前通知，订阅者才能读到旧定义 */
  onRelease(fn: (id: number) => void): () => void {
    this.releaseHandlers.add(fn);
    return () => { this.releaseHandlers.delete(fn); };
  }

  /** 卸载插件时释放其方块（scope 自动调用）。先清洗世界数据，再删定义与回收 id */
  release(id: number): void {
    const def = this.byId.get(id);
    if (!def || id === AIR_ID) return;
    for (const fn of [...this.releaseHandlers]) {
      try { fn(id); }
      catch (err) { console.warn('[Blocks] onRelease handler threw', err); }
    }
    this.byId.delete(id);
    this.nameIndex.delete(def.name);
    this.owners.delete(id);
    this.freeIds.push(id);
  }

  byLocal(owner: string, local: string): BlockDef | undefined {
    return this.nameIndex.get(`${owner}:${local}`);
  }

  byName(fullName: string): BlockDef | undefined {
    return this.nameIndex.get(fullName);
  }

  get(id: number): BlockDef {
    return this.byId.get(id) ?? this.byId.get(AIR_ID)!;
  }

  /**
   * 取该面的 tile。是否渲染由「方块自己有没有贴图」决定，不看 opaque ——
   * 否则玻璃 / 水 / 树叶这类非 opaque 方块会整块不可见。
   * opaque 只用于邻接面剔除（见 CulledMesher）。
   */
  tileOf(id: number, face: FaceName): string | null {
    const def = this.byId.get(id);
    if (!def) return null;
    return def.all ?? def.faces?.[face] ?? null;
  }

  labelOf(id: number): string {
    const n = this.get(id).name;
    return n.includes(':') ? n.slice(n.indexOf(':') + 1) : n;
  }

  all(): BlockDef[] {
    return [...this.byId.values()];
  }

  ownerCount(): number {
    return new Set(this.owners.values()).size;
  }

  private allocateId(): number {
    // 升序复用，保证 reload 后同一批方块拿回同一批 id（确定性）
    if (this.freeIds.length > 0) {
      this.freeIds.sort((a, b) => a - b);
      return this.freeIds.shift()!;
    }
    while (this.byId.has(this.nextAuto) && this.nextAuto <= 255) this.nextAuto++;
    if (this.nextAuto > 255) throw new Error('[Blocks] uint8 id space exhausted');
    return this.nextAuto++;
  }
}
