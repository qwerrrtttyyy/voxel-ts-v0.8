import type { Unregister } from './ServiceRegistry';

export interface ConfigNamespace {
  get<T>(key: string, fallback: T): T;
  set<T>(key: string, value: T): void;
  has(key: string): boolean;
  all(): Readonly<Record<string, unknown>>;
  onChange(fn: (key: string, value: unknown) => void): Unregister;
}

/**
 * 插件私有配置命名空间。
 * 不用再各自维护模块级 let，也不会和别的插件撞 key；
 * 带 localStorage 持久化（浏览器），Node 环境自动退化为纯内存。
 */
export class ConfigStore {
  private readonly spaces = new Map<string, Map<string, unknown>>();
  private readonly listeners = new Map<string, Set<(k: string, v: unknown) => void>>();

  namespace(owner: string): ConfigNamespace {
    let data = this.spaces.get(owner);
    if (!data) {
      data = new Map();
      this.spaces.set(owner, data);
      this.restore(owner, data);
    }
    const store = this;
    return {
      get<T>(key: string, fallback: T): T {
        return (data!.has(key) ? data!.get(key) : fallback) as T;
      },
      set<T>(key: string, value: T): void {
        data!.set(key, value);
        store.persist(owner, data!);
        for (const fn of store.listeners.get(owner) ?? []) fn(key, value);
      },
      has(key: string): boolean { return data!.has(key); },
      all(): Readonly<Record<string, unknown>> { return Object.fromEntries(data!); },
      onChange(fn): Unregister {
        let set = store.listeners.get(owner);
        if (!set) { set = new Set(); store.listeners.set(owner, set); }
        set.add(fn);
        return () => set!.delete(fn);
      },
    };
  }

  owners(): string[] { return [...this.spaces.keys()]; }

  private storageKey(owner: string): string { return `voxel.cfg.${owner}`; }

  private persist(owner: string, data: Map<string, unknown>): void {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(this.storageKey(owner), JSON.stringify(Object.fromEntries(data)));
    } catch { /* 隐私模式 / 配额满：静默降级为内存 */ }
  }

  private restore(owner: string, data: Map<string, unknown>): void {
    try {
      if (typeof localStorage === 'undefined') return;
      const raw = localStorage.getItem(this.storageKey(owner));
      if (!raw) return;
      for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) data.set(k, v);
    } catch { /* 坏数据忽略 */ }
  }
}
