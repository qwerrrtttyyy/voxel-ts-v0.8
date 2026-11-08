import type { ConfigNamespace } from './ConfigStore';
import type { IPluginHost, Plugin, PluginMeta } from './types';
import { createSandboxedPlugin, validateCapabilities } from './Sandbox';

export type PluginSource = 'builtin' | 'extension' | 'community' | 'url' | 'source';

export interface CatalogEntry {
  id: string;
  version: string;
  label: string;
  description: string;
  category: NonNullable<PluginMeta['category']>;
  author: string;
  badge: string;
  source: PluginSource;
  origin: string;
  required: boolean;
  removable: boolean;
  enabled: boolean;
  loaded: boolean;
  error: string;
  /** v0.6：运行时热加载插件已被沙箱包装 */
  sandboxed: boolean;
  /** v0.6：该插件显式申请的特权能力，菜单里如实展示 */
  capabilities: readonly string[];
  provides: readonly string[];
  dependencies: readonly string[];
  /** 仅运行时持有，不序列化 */
  plugin: Plugin | null;
}

interface RemoteRecord {
  id: string;
  label: string;
  url?: string;
  code?: string;
}

type Notify = (text: string, kind?: 'info' | 'good' | 'warn') => void;

/**
 * 内置插件的展示信息放在清单层而不是插件源码里：
 * 既让主菜单可读，又完全不碰 v0.2 的 7 个插件对象（44/44 架构验收零改动）。
 */
const BUILTIN_INFO: Record<string, { label: string; description: string; badge: string }> = {
  'voxel.sky': { label: '渐变天空', description: 'Shader 天空球 + 同色雾；昼夜插件会接管它的日月与配色', badge: 'SK' },
  'voxel.blocks': { label: '基础方块', description: '草 / 泥土两种方块与程序化贴图，提供地形材质 id 表', badge: 'BL' },
  'voxel.terrain': { label: '小丘生成器', description: '内置兜底地形：多频噪声起伏；丰富地形插件会以更高优先级顶替', badge: 'TR' },
  'voxel.world-render': { label: '世界网格', description: 'chunk mesh 生命周期、图集材质、dirty 分帧重建', badge: 'WR' },
  'voxel.player': { label: '第一人称控制', description: '自写输入 → 相机 + 贴地兜底碰撞策略', badge: 'FP' },
  'voxel.render-submit': { label: '渲染提交', description: 'main 阶段末位提交 renderer.render', badge: 'RS' },
  'voxel.viewport': { label: '视口自适应', description: '窗口尺寸变化时同步相机与渲染器', badge: 'VP' },
};

function fallbackMeta(plugin: Plugin, source: PluginSource): Required<Pick<PluginMeta,
  'label' | 'description' | 'category' | 'author' | 'defaultEnabled' | 'required' | 'badge'>> {
  const category: PluginMeta['category'] =
    source === 'builtin' ? 'core'
      : source === 'extension' ? 'extension'
        : source === 'community' ? 'community' : 'remote';
  return {
    label: plugin.id,
    description: '未提供描述',
    category: category ?? 'extension',
    author: source === 'builtin' ? 'voxel-ts' : 'third-party',
    defaultEnabled: true,
    required: source === 'builtin',
    badge: plugin.id.slice(0, 2).toUpperCase(),
  };
}

/** 从 ESM 模块里挑出 Plugin：支持 default / plugin / 工厂函数 / 直接对象 */
function extract(mod: unknown): Plugin {
  const m = (mod ?? {}) as Record<string, unknown>;
  const raw = m.default ?? m.plugin ?? mod;
  const value = typeof raw === 'function' ? (raw as () => Plugin)() : raw;
  const p = value as Plugin | undefined;
  if (!p || typeof p.id !== 'string' || typeof p.setup !== 'function') {
    throw new Error('模块没有导出合法的 Plugin（需要 default / plugin 导出 id + setup）');
  }
  return p;
}

/**
 * 运行时插件市场 —— 把「构建期 import.meta.glob 自动发现」推进到真正的运行时编排：
 *
 * - 所有插件（内置 / 扩展 / 社区 / 远程）统一成一份可查询清单
 * - `installFromUrl` 用原生动态 import 从任意 ESM URL 装插件，不需要重新构建
 * - `installFromSource` 把粘贴的源码做成 Blob URL 直接 import，零文件落盘
 * - 开关状态与远程清单持久化，刷新页面后自动恢复
 * - 开关走宿主已有的 mount / unmount 热插拔，依赖级联卸载会同步回清单
 *
 * 主程序不再 `useMany([...builtinPlugins(), ...discoverPlugins()])`，
 * 只调用 `catalog.apply()`，插件集合完全由清单决定。
 */
export class PluginCatalog {
  private readonly entries = new Map<string, CatalogEntry>();
  private readonly listeners = new Set<() => void>();
  private booting = false;

  constructor(
    private readonly host: IPluginHost,
    private readonly cfg: ConfigNamespace,
    private readonly notify: Notify = () => {},
  ) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(): void {
    for (const fn of [...this.listeners]) {
      try { fn(); } catch { /* UI 订阅者隔离 */ }
    }
  }

  /** 注册静态插件（内置 / 扩展 / 构建期发现的社区插件） */
  register(plugins: readonly Plugin[], source: PluginSource): void {
    const saved = this.cfg.get<Record<string, boolean>>('enabled', {});
    for (const plugin of plugins) {
      if (this.entries.has(plugin.id)) continue;
      const meta = plugin.meta;
      const fb = fallbackMeta(plugin, source);
      const info = source === 'builtin' ? BUILTIN_INFO[plugin.id] : undefined;
      this.entries.set(plugin.id, {
        id: plugin.id,
        version: plugin.version,
        label: meta?.label ?? info?.label ?? fb.label,
        description: meta?.description ?? info?.description ?? fb.description,
        category: meta?.category ?? fb.category,
        author: meta?.author ?? fb.author,
        badge: meta?.badge ?? info?.badge ?? fb.badge,
        source,
        origin: source === 'community' ? 'build:glob' : source,
        required: meta?.required ?? fb.required,
        removable: source === 'url' || source === 'source',
        enabled: saved[plugin.id] ?? (meta?.defaultEnabled ?? fb.defaultEnabled),
        loaded: false,
        error: '',
        sandboxed: false,
        capabilities: [],
        provides: plugin.provides ?? [],
        dependencies: plugin.dependencies ?? [],
        plugin,
      });
    }
    this.emit();
  }

  list(): CatalogEntry[] { return [...this.entries.values()]; }
  get(id: string): CatalogEntry | undefined { return this.entries.get(id); }

  /** 预览停用该插件会连带停用的已加载插件，供菜单开关提示 */
  impactOf(id: string): string[] { return this.host.impactOf(id); }

  get stats(): { total: number; enabled: number; loaded: number; remote: number } {
    const all = this.list();
    return {
      total: all.length,
      enabled: all.filter((e) => e.enabled).length,
      loaded: all.filter((e) => e.loaded).length,
      remote: all.filter((e) => e.source === 'url' || e.source === 'source').length,
    };
  }

  /** 启动：恢复持久化的远程插件，然后把宿主状态对齐到清单 */
  async boot(): Promise<void> {
    if (this.booting) return;
    this.booting = true;
    try {
      await this.restoreRemotes();
      await this.apply();
    } finally {
      this.booting = false;
    }
  }

  private remoteRecords(): RemoteRecord[] {
    return this.cfg.get<RemoteRecord[]>('remote', []);
  }

  private saveRemoteRecords(list: RemoteRecord[]): void {
    this.cfg.set('remote', list);
  }

  private async restoreRemotes(): Promise<void> {
    for (const rec of this.remoteRecords()) {
      try {
        const plugin = rec.code
          ? await this.importSource(rec.code)
          : await this.importUrl(rec.url!);
        this.addEntry(plugin, rec.code ? 'source' : 'url', rec.code ? 'pasted source' : rec.url!, rec.label);
      } catch (err) {
        const entry = this.entries.get(rec.id);
        if (entry) { entry.error = String(err); entry.loaded = false; }
      }
    }
  }

  private async importUrl(url: string): Promise<Plugin> {
    // @vite-ignore 保留原生动态 import：URL 由用户在运行时提供，构建期无法静态分析
    // v0.8：原生 import 无法 abort，但至少不能让「卡住的 CDN」把菜单永久挂在
    // 「正在动态 import…」上；超时后给出明确错误，用户可重试。
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const mod = await Promise.race([
        import(/* @vite-ignore */ url),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`[catalog] 远程插件加载超时（15s）：${url}`)),
            15_000,
          );
        }),
      ]);
      return extract(mod);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async importSource(code: string): Promise<Plugin> {
    const blob = new Blob([code], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    try {
      const mod = await import(/* @vite-ignore */ url);
      return extract(mod);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  private addEntry(plugin: Plugin, source: PluginSource, origin: string, label?: string): CatalogEntry {
    const saved = this.cfg.get<Record<string, boolean>>('enabled', {});
    // v0.6：URL / 粘贴源码属于不可信代码，登记前先编译成受限插件。
    // 声明字段原样保留（拓扑、能力、优先级不变），只替换 setup 的上下文。
    const sandboxed = source === 'url' || source === 'source';
    const capabilities = sandboxed ? validateCapabilities(plugin) : [];
    const effective = sandboxed ? createSandboxedPlugin(plugin, origin) : plugin;
    const meta = effective.meta;
    const fb = fallbackMeta(effective, source);
    const entry: CatalogEntry = {
      id: plugin.id,
      version: plugin.version,
      label: label ?? meta?.label ?? fb.label,
      description: meta?.description ?? fb.description,
      category: meta?.category ?? 'remote',
      author: meta?.author ?? fb.author,
      badge: meta?.badge ?? fb.badge,
      source,
      origin,
      required: false,
      removable: true,
      enabled: saved[plugin.id] ?? true,
      loaded: false,
      error: '',
      provides: effective.provides ?? [],
      dependencies: effective.dependencies ?? [],
      sandboxed,
      capabilities,
      plugin: effective,
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  /** 从 URL 安装并立即热加载 */
  async installFromUrl(url: string): Promise<CatalogEntry> {
    const trimmed = url.trim();
    if (!trimmed) throw new Error('URL 不能为空');
    const plugin = await this.importUrl(trimmed);
    if (this.host.list().includes(plugin.id)) throw new Error(`插件 id 已存在：${plugin.id}`);
    const entry = this.addEntry(plugin, 'url', trimmed);
    const records = this.remoteRecords().filter((r) => r.id !== plugin.id);
    records.push({ id: plugin.id, label: entry.label, url: trimmed });
    this.saveRemoteRecords(records);
    await this.apply();
    this.notify(`已安装 ${entry.label}@${entry.version}`, 'good');
    return entry;
  }

  /** 粘贴源码 → Blob URL → 动态 import，全程不写磁盘、不需要重新构建 */
  async installFromSource(code: string): Promise<CatalogEntry> {
    if (!code.trim()) throw new Error('源码不能为空');
    const plugin = await this.importSource(code);
    if (this.host.list().includes(plugin.id)) throw new Error(`插件 id 已存在：${plugin.id}`);
    const entry = this.addEntry(plugin, 'source', 'pasted source');
    const records = this.remoteRecords().filter((r) => r.id !== plugin.id);
    records.push({ id: plugin.id, label: entry.label, code });
    this.saveRemoteRecords(records);
    await this.apply();
    this.notify(`已从源码热加载 ${entry.label}@${entry.version}`, 'good');
    return entry;
  }

  async remove(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || !entry.removable) return;
    if (this.host.isLoaded(id)) await this.host.unmount(id);
    this.entries.delete(id);
    this.saveRemoteRecords(this.remoteRecords().filter((r) => r.id !== id));
    this.persist();
    this.refresh();
    this.notify(`已移除 ${entry.label}`, 'info');
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || entry.required || entry.enabled === enabled) return;
    entry.enabled = enabled;
    this.persist();

    if (!enabled && this.host.isLoaded(id)) {
      const before = this.host.loadedIds();
      await this.host.unmount(id);
      const after = new Set(this.host.loadedIds());
      // 宿主会连带卸载依赖者：把它们的开关也同步下来，菜单状态才不会说谎
      const cascaded: string[] = [];
      for (const pid of before) {
        if (pid === id || after.has(pid)) continue;
        const other = this.entries.get(pid);
        if (other && other.enabled && !other.required) {
          other.enabled = false;
          cascaded.push(other.label);
        }
      }
      if (cascaded.length) this.notify(`连带停用 ${cascaded.length} 个依赖插件：${cascaded.join('、')}`, 'warn');
    }
    await this.apply();
    this.notify(`${enabled ? '启用' : '停用'} ${entry.label}`, enabled ? 'good' : 'info');
  }

  async reload(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    try {
      if (this.host.isLoaded(id)) await this.host.reload(id);
      else await this.apply();
      entry.error = '';
      this.notify(`已重载 ${entry.label}`, 'good');
    } catch (err) {
      entry.error = String(err);
      this.notify(`重载失败：${String(err)}`, 'warn');
    }
    this.refresh();
  }

  /** 把宿主的实际加载状态对齐到清单（拓扑顺序由本类负责，见 topo） */
  async apply(): Promise<void> {
    const enabled = this.list().filter((e) => e.enabled && e.plugin && !e.error);
    const target = new Map(enabled.map((e) => [e.id, e.plugin as Plugin]));

    // 1) 卸载不该存在的（按加载反序，unmount 自带级联）
    for (const id of [...this.host.loadedIds()].reverse()) {
      if (!target.has(id)) {
        try { await this.host.unmount(id); } catch (err) { console.warn('[catalog] unmount failed', id, err); }
      }
    }

    // 2) 补齐宿主 defs（mount 的 assertDeps 需要从 defs 解析 cap: 提供者）
    const known = new Set(this.host.list());
    for (const [id, plugin] of target) {
      if (!known.has(id)) { this.host.use(plugin); known.add(id); }
    }

    // 3) 按拓扑顺序装载缺失的插件
    for (const plugin of this.topo([...target.values()])) {
      if (this.host.isLoaded(plugin.id)) continue;
      try {
        await this.host.mount(plugin);
        const e = this.entries.get(plugin.id);
        if (e) e.error = '';
      } catch (err) {
        const e = this.entries.get(plugin.id);
        if (e) { e.error = String(err); e.enabled = false; }
        this.notify(`插件加载失败 ${plugin.id}：${String(err)}`, 'warn');
        console.error('[catalog] load failed', plugin.id, err);
      }
    }
    this.persist();
    this.refresh();
  }

  /** 依赖拓扑：支持 `cap:` 能力依赖与普通 id 依赖，环依赖时按 id 兜底 */
  private topo(list: Plugin[]): Plugin[] {
    const byId = new Map(list.map((p) => [p.id, p]));
    const caps = new Map<string, string[]>();
    for (const p of list) {
      for (const c of p.provides ?? []) {
        const arr = caps.get(c) ?? [];
        arr.push(p.id);
        caps.set(c, arr);
      }
    }
    const depsOf = (p: Plugin): string[] => {
      const out: string[] = [];
      for (const d of [...(p.dependencies ?? []), ...(p.optionalDependencies ?? [])]) {
        if (d.startsWith('cap:')) out.push(...(caps.get(d.slice(4)) ?? []));
        else if (byId.has(d)) out.push(d);
      }
      return [...new Set(out)].filter((d) => d !== p.id && byId.has(d));
    };

    const done = new Set<string>();
    const visiting = new Set<string>();
    const out: Plugin[] = [];
    const visit = (id: string): void => {
      if (done.has(id) || visiting.has(id)) return;
      const p = byId.get(id);
      if (!p) return;
      visiting.add(id);
      for (const d of depsOf(p)) visit(d);
      visiting.delete(id);
      done.add(id);
      out.push(p);
    };
    for (const p of [...list].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.id.localeCompare(b.id))) {
      visit(p.id);
    }
    return out;
  }

  private persist(): void {
    this.cfg.set('enabled', Object.fromEntries(this.list().map((e) => [e.id, e.enabled])));
  }

  private refresh(): void {
    const loaded = new Set(this.host.loadedIds());
    for (const e of this.entries.values()) e.loaded = loaded.has(e.id);
    this.emit();
  }
}
