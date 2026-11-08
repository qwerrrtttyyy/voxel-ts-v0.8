import * as THREE from 'three';
import { ATLAS_INITIAL_TILES } from '../config';
import type { Unregister } from '../core/ServiceRegistry';

/** tile 像素画笔：set(x, y, r, g, b)，y=0 是贴图底部（对应 v=0） */
export type TilePainter = (
  set: (x: number, y: number, r: number, g: number, b: number, a?: number) => void,
  size: number,
) => void;

export interface UvRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

interface TileEntry {
  index: number;
  owner: string;
  paint: TilePainter;
}

/**
 * 程序化 atlas。首版固定 64 格 + 运行时追加插件要重建材质，是扩展瓶颈；
 * 现在按需翻倍扩容，并通过 onTextureReplaced 通知材质换 map，
 * 插件在宿主启动之后注册贴图也完全无感。
 */
export class TextureAtlas {
  readonly tileSize = 16;
  private capacity = ATLAS_INITIAL_TILES;
  private readonly index = new Map<string, TileEntry>();
  private readonly rects = new Map<string, UvRect>();
  private readonly freeIndices: number[] = [];
  private data!: Uint8Array;
  private texture!: THREE.DataTexture;
  private readonly listeners = new Set<(t: THREE.DataTexture) => void>();

  constructor() {
    this.rebuildTexture(true);
  }

  get width(): number { return this.capacity * this.tileSize; }
  get height(): number { return this.tileSize; }
  get tileCount(): number { return this.index.size; }
  get pixels(): Uint8Array { return this.data; }

  /** 扩容导致 texture 对象被替换时通知（材质需要换 map） */
  onTextureReplaced(fn: (t: THREE.DataTexture) => void): Unregister {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 命名空间 tile；重复调用幂等，返回可直接填进 BlockDef.faces 的 key */
  define(owner: string, local: string, paint: TilePainter): string {
    const key = `${owner}:${local}`;
    const existing = this.index.get(key);
    if (existing) {
      // 热重载：重画同一格，UV 不变
      this.paintTile(existing.index, paint);
      this.texture.needsUpdate = true;
      return key;
    }
    const i = this.allocateIndex();
    this.index.set(key, { index: i, owner, paint });
    this.paintTile(i, paint);
    this.refreshRects();
    this.texture.needsUpdate = true;
    return key;
  }

  /** 兼容旧调用：直接按 key 注册（同 key 幂等） */
  registerTile(key: string, paint: TilePainter): number {
    const i = this.define('legacy', key, paint);
    return this.index.get(`legacy:${key}`)!.index;
  }

  releaseKey(key: string): void {
    const entry = this.index.get(key);
    if (!entry) return;
    this.index.delete(key);
    this.rects.delete(key);
    this.freeIndices.push(entry.index);
    this.clearTile(entry.index);
    this.texture.needsUpdate = true;
  }

  release(owner: string): void {
    for (const [key, e] of [...this.index]) if (e.owner === owner) this.releaseKey(key);
  }

  has(key: string): boolean { return this.index.has(key); }
  tileIndex(key: string): number { return this.index.get(key)?.index ?? 0; }
  uvRect(key: string): UvRect | null { return this.rects.get(key) ?? null; }

  /**
   * v0.3：取出单个 tile 的 RGBA 像素（16×16×4），供快捷栏图标与破坏粒子取色。
   * 图集是横条布局，不能整块 subarray，逐行拷贝。
   */
  tilePixels(key: string): Uint8Array | null {
    const e = this.index.get(key);
    if (!e) return null;
    const s = this.tileSize, width = this.width;
    const out = new Uint8Array(s * s * 4);
    for (let y = 0; y < s; y++) {
      const from = (y * width + e.index * s) * 4;
      out.set(this.data.subarray(from, from + s * 4), y * s * 4);
    }
    return out;
  }

  /** 返回当前 DataTexture；引用在扩容前保持不变 */
  build(): THREE.DataTexture { return this.texture; }

  dispose(): void {
    this.texture.dispose();
    this.listeners.clear();
  }

  private allocateIndex(): number {
    const reused = this.freeIndices.pop();
    if (reused !== undefined) return reused;
    if (this.index.size >= this.capacity) {
      this.capacity *= 2;
      this.rebuildTexture(false);
    }
    return this.index.size;
  }

  private rebuildTexture(initial: boolean): void {
    const s = this.tileSize;
    const old = initial ? null : this.texture;
    const oldData = initial ? null : this.data;
    const oldWidth = initial ? 0 : this.width / 2; // 扩容前的宽度

    const width = this.capacity * s;
    const next = new Uint8Array(width * heightPixels(s) * 4);
    for (let i = 0; i < next.length; i += 4) {
      next[i] = 255; next[i + 1] = 0; next[i + 2] = 220; next[i + 3] = 255;
    }
    // 逐行拷贝已有像素（每行宽度变了，不能整体 set）
    if (oldData && oldWidth > 0) {
      for (let y = 0; y < s; y++) {
        const from = y * oldWidth * 4;
        const to = y * width * 4;
        next.set(oldData.subarray(from, from + oldWidth * 4), to);
      }
    }
    this.data = next;

    const tex = new THREE.DataTexture(next, width, s, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    this.texture = tex;

    if (!initial) {
      this.refreshRects(); // width 变了，所有 UV 要按新图集宽度重算
      for (const fn of [...this.listeners]) fn(tex);
      old?.dispose();
    }
  }

  private paintTile(i: number, paint: TilePainter): void {
    const s = this.tileSize;
    const width = this.width;
    const tileX = i * s;
    const set = (x: number, y: number, r: number, g: number, b: number, a = 255): void => {
      if (x < 0 || x >= s || y < 0 || y >= s) return;
      const p = (y * width + tileX + x) * 4;
      this.data[p] = r; this.data[p + 1] = g; this.data[p + 2] = b; this.data[p + 3] = a;
    };
    paint(set, s);
  }

  private clearTile(i: number): void {
    this.paintTile(i, (set, s) => {
      for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) set(x, y, 255, 0, 220);
    });
  }

  private refreshRects(): void {
    const s = this.tileSize;
    const width = this.width;
    for (const [key, e] of this.index) {
      const tileX = e.index * s;
      this.rects.set(key, {
        u0: (tileX + 0.5) / width,
        u1: (tileX + s - 0.5) / width,
        v0: 0.5 / s,
        v1: (s - 0.5) / s,
      });
    }
  }
}

function heightPixels(s: number): number { return s; }
