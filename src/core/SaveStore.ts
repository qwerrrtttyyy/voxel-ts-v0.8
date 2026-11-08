import { SAVE_DB, SAVE_STORE } from '../config';

export interface SaveMeta {
  slot: number;
  name: string;
  createdAt: number;
  bytes: number;
}

interface Record {
  meta: SaveMeta;
  buffer: ArrayBuffer;
}

/**
 * 二进制世界存档仓库。
 * 浏览器走 IndexedDB（ArrayBuffer 直接结构化克隆，不转 base64）；
 * Node / 隐私模式自动降级为内存 Map，所以逻辑验收脚本可以完整跑保存-读取链路。
 */
export class SaveStore {
  private readonly memory = new Map<number, Record>();
  private dbPromise: Promise<IDBDatabase | null> | null = null;
  /**
   * v0.6：db 连接可用但某次写事务失败时，该槽位降级到内存。
   * 读 / 列 / 删都必须走同一后端，否则「写成功」的存档会静默消失。
   */
  private readonly degraded = new Set<number>();
  readonly backend: 'indexeddb' | 'memory';

  constructor() {
    this.backend = typeof indexedDB === 'undefined' ? 'memory' : 'indexeddb';
  }

  private db(): Promise<IDBDatabase | null> {
    if (this.backend === 'memory') return Promise.resolve(null);
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(SAVE_DB, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(SAVE_STORE)) db.createObjectStore(SAVE_STORE, { keyPath: 'slot' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
    return this.dbPromise;
  }

  async list(): Promise<SaveMeta[]> {
    const db = await this.db();
    if (!db) return [...this.memory.values()].map((r) => ({ ...r.meta }));
    const fromDb = await new Promise<SaveMeta[]>((resolve) => {
      try {
        const tx = db.transaction(SAVE_STORE, 'readonly');
        const req = tx.objectStore(SAVE_STORE).getAll();
        req.onsuccess = () => resolve((req.result as Array<{ meta: SaveMeta }>).map((r) => r.meta));
        req.onerror = () => resolve([]);
      } catch { resolve([]); }
    });
    const merged = fromDb.filter((m) => !this.degraded.has(m.slot));
    for (const slot of this.degraded) {
      const rec = this.memory.get(slot);
      if (rec) merged.push({ ...rec.meta });
    }
    return merged.sort((a, b) => a.slot - b.slot);
  }

  async write(slot: number, name: string, buffer: ArrayBuffer): Promise<SaveMeta> {
    const meta: SaveMeta = { slot, name, createdAt: Date.now(), bytes: buffer.byteLength };
    const db = await this.db();
    if (!db) { this.memory.set(slot, { meta, buffer }); return meta; }
    return new Promise((resolve) => {
      const fallback = (): void => {
        this.memory.set(slot, { meta, buffer });
        this.degraded.add(slot);
        resolve(meta);
      };
      try {
        const tx = db.transaction(SAVE_STORE, 'readwrite');
        tx.objectStore(SAVE_STORE).put({ slot, meta, buffer });
        tx.oncomplete = () => { this.degraded.delete(slot); resolve(meta); };
        tx.onerror = fallback;
      } catch { fallback(); }
    });
  }

  async read(slot: number): Promise<ArrayBuffer | null> {
    if (this.degraded.has(slot)) return this.memory.get(slot)?.buffer ?? null;
    const db = await this.db();
    if (!db) return this.memory.get(slot)?.buffer ?? null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(SAVE_STORE, 'readonly');
        const req = tx.objectStore(SAVE_STORE).get(slot);
        req.onsuccess = () => resolve((req.result as { buffer: ArrayBuffer } | undefined)?.buffer ?? null);
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
  }

  async remove(slot: number): Promise<void> {
    this.memory.delete(slot);
    this.degraded.delete(slot);
    const db = await this.db();
    if (!db) return;
    try {
      const tx = db.transaction(SAVE_STORE, 'readwrite');
      tx.objectStore(SAVE_STORE).delete(slot);
    } catch { /* 只读模式：忽略 */ }
  }

  /** 导出为本地文件（浏览器） */
  download(name: string, buffer: ArrayBuffer): void {
    if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return;
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** 从 File 读回 ArrayBuffer（导入） */
  async upload(file: Blob): Promise<ArrayBuffer> {
    if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result as ArrayBuffer);
      fr.onerror = () => reject(fr.error);
      fr.readAsArrayBuffer(file);
    });
  }
}
