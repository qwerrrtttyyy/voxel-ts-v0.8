import { HOTBAR_SLOTS } from '../config';
import { AIR_ID, type BlockDef, type BlockRegistry } from '../world/BlockRegistry';

export interface HotbarItem {
  blockId: number;
  label: string;
  /** atlas 里的 tile key，用于绘制槽位图标；没有贴图则为 null */
  tileKey: string | null;
  owner: string;
  /** 发光方块在快捷栏里带高亮边框 */
  emissive: boolean;
}

/**
 * 快捷栏不从任何硬编码清单读取，而是直接扫描 BlockRegistry：
 * 任何插件（包括运行时从 URL 装进来的第三方插件）注册的新方块会自动出现在物品栏里。
 * 这就是「玩法由插件定义」的落点。
 */
export class Inventory {
  private items: HotbarItem[] = [];
  selected = 0;
  page = 0;

  private readonly listeners = new Set<() => void>();

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(): void {
    for (const fn of [...this.listeners]) {
      try { fn(); } catch { /* 订阅者隔离 */ }
    }
  }

  /** 重新收集可放置方块；卸载插件后调用即可让物品栏自动缩回 */
  rebuild(blocks: BlockRegistry): void {
    const prevId = this.current()?.blockId;
    const out: HotbarItem[] = [];
    for (const def of blocks.all()) {
      if (def.id === AIR_ID) continue;
      if (!this.tileOf(def)) continue;
      const n = def.name;
      out.push({
        blockId: def.id,
        label: n.includes(':') ? n.slice(n.indexOf(':') + 1) : n,
        tileKey: this.tileOf(def),
        owner: n.includes(':') ? n.slice(0, n.indexOf(':')) : 'core',
        emissive: !!def.emissive,
      });
    }
    out.sort((a, b) => a.blockId - b.blockId);
    this.items = out;
    // 尽量保住玩家上次选中的方块
    const keep = prevId === undefined ? -1 : out.findIndex((i) => i.blockId === prevId);
    this.selected = keep >= 0 ? keep % HOTBAR_SLOTS : 0;
    this.page = keep >= 0 ? Math.floor(keep / HOTBAR_SLOTS) : 0;
    this.clamp();
    this.emit();
  }

  private tileOf(def: BlockDef): string | null {
    return def.all ?? def.faces?.top ?? def.faces?.north ?? def.faces?.south
      ?? def.faces?.east ?? def.faces?.west ?? def.faces?.bottom ?? null;
  }

  get all(): readonly HotbarItem[] { return this.items; }
  get pageCount(): number { return Math.max(1, Math.ceil(this.items.length / HOTBAR_SLOTS)); }
  get total(): number { return this.items.length; }

  /** 当前页的 9 个槽位（不足补 null） */
  slots(): Array<HotbarItem | null> {
    const out: Array<HotbarItem | null> = [];
    for (let i = 0; i < HOTBAR_SLOTS; i++) out.push(this.items[this.page * HOTBAR_SLOTS + i] ?? null);
    return out;
  }

  current(): HotbarItem | null {
    return this.items[this.page * HOTBAR_SLOTS + this.selected] ?? null;
  }

  select(index: number): void {
    if (index < 0 || index >= HOTBAR_SLOTS) return;
    this.selected = index;
    this.emit();
  }

  scroll(delta: number): void {
    this.selected = (this.selected + delta + HOTBAR_SLOTS) % HOTBAR_SLOTS;
    this.emit();
  }

  nextPage(dir = 1): void {
    this.page = (this.page + dir + this.pageCount) % this.pageCount;
    this.clamp();
    this.emit();
  }

  /** 按方块 id 选中（存档恢复 / 插件联动用） */
  selectBlock(blockId: number): boolean {
    const i = this.items.findIndex((it) => it.blockId === blockId);
    if (i < 0) return false;
    this.page = Math.floor(i / HOTBAR_SLOTS);
    this.selected = i % HOTBAR_SLOTS;
    this.emit();
    return true;
  }

  private clamp(): void {
    if (this.page >= this.pageCount) this.page = this.pageCount - 1;
    if (this.page < 0) this.page = 0;
    const count = Math.max(1, Math.min(HOTBAR_SLOTS, this.items.length - this.page * HOTBAR_SLOTS));
    if (this.selected >= count) this.selected = count - 1;
    if (this.selected < 0) this.selected = 0;
  }
}
