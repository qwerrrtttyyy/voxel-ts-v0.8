import type { IPluginHost, Plugin, PluginContext } from './types';
import type { PluginScope, ScopeDeps } from './PluginScope';
import { PluginScope as Scope } from './PluginScope';
import { PluginGraph } from './PluginGraph';

interface Loaded {
  plugin: Plugin;
  scope: PluginScope;
  order: number;
}

/** setup 成功后广播的生命周期相位；v0.6 补齐 EventMap 里声明过的三个值 */
type LoadPhase = 'loaded' | 'enabled' | 'reloaded';

/**
 * 插件宿主：注册 → 依赖/能力拓扑排序 → setup → 反序卸载。
 *
 * v0.5 全量 Cordis 化：每个插件同时是统一内核里的一个 Cordis 组件。
 *  - `use/mount` → graph.declare()：把 dependencies/provides 编译成 inject/provide 声明
 *  - `setupOne` → scope 复用该插件专属的 EffectStack（Cordis 可逆栈）
 *  - `teardown` → graph.deactivate()：由 Kernel 按依赖深度降序 LIFO 精确回滚
 *
 * 控制反转：Kernel 管「依赖图与可逆性」，PluginHost 管「确定性时序与异步 setup」。
 *
 * v0.6 加固：
 *  - `mount()` 会补齐未加载的依赖闭包，而不是只校验后报错
 *  - `enable/disable` 返回类型对称
 *  - 完整发出 loaded / enabled / reloaded 三种 lifecycle phase
 *  - 被 optionalDependencies 引用的 provider 卸载时，软依赖者收到
 *    `service:changed` 通知可重解析，而不是静默持有旧服务引用
 */
export class PluginHost implements IPluginHost {
  private readonly defs = new Map<string, Plugin>();
  private readonly loaded = new Map<string, Loaded>();
  private counter = 0;
  readonly graph: PluginGraph;

  /** ctx 里反过来引用 host，用惰性 provider 解开构造顺序的环 */
  constructor(
    private readonly getCtx: () => PluginContext,
    private readonly deps: ScopeDeps,
    graph?: PluginGraph,
  ) {
    this.graph = graph ?? new PluginGraph();
  }

  private get ctx(): PluginContext { return this.getCtx(); }

  use(plugin: Plugin): void {
    if (this.defs.has(plugin.id)) {
      throw new Error(`[PluginHost] duplicate plugin id: ${plugin.id}`);
    }
    this.defs.set(plugin.id, plugin);
    this.graph.declare(plugin);
  }

  useMany(plugins: readonly Plugin[]): void {
    for (const p of plugins) this.use(p);
  }

  list(): string[] { return [...this.defs.keys()]; }
  loadedIds(): string[] {
    return [...this.loaded.entries()].sort((a, b) => a[1].order - b[1].order).map(([id]) => id);
  }
  isLoaded(id: string): boolean { return this.loaded.has(id); }

  /** 预览「关掉它会连带关掉谁」；只统计已加载的硬依赖者 */
  impactOf(id: string): string[] {
    return this.dependentsOf(id).filter((pid) => pid !== id);
  }

  /** 无参：全部能力名；有参：声明了该能力的插件 id */
  capabilities(name?: string): string[] {
    if (name === undefined) {
      return [...new Set([...this.defs.values()].flatMap((p) => p.provides ?? []))];
    }
    return [...this.defs.entries()]
      .filter(([, p]) => (p.provides ?? []).includes(name))
      .map(([id]) => id);
  }

  async boot(): Promise<void> {
    for (const plugin of this.resolveOrder()) {
      if (!this.loaded.has(plugin.id)) await this.setupOne(plugin);
    }
  }

  /**
   * 运行时加载：同 id 先卸载，再按依赖闭包补齐缺失依赖，最后启动自己。
   * v0.6 之前只做 assertDeps，依赖尚未装载时直接抛错，导致「从控制台 mount
   * 单个插件」这条路径实际上不可用。
   */
  async mount(plugin: Plugin): Promise<void> {
    if (this.loaded.has(plugin.id)) await this.unmount(plugin.id);
    this.defs.set(plugin.id, plugin);
    this.graph.declare(plugin);
    await this.ensureDepsLoaded(plugin);
    await this.setupOne(plugin);
  }

  /** 递归补齐依赖闭包（含 cap: 解析出的全部 provider），带环保护 */
  private async ensureDepsLoaded(plugin: Plugin, seen = new Set<string>()): Promise<void> {
    if (seen.has(plugin.id)) return;
    seen.add(plugin.id);
    for (const d of this.resolveDeps(plugin)) {
      if (!this.defs.has(d)) {
        throw new Error(`[PluginHost] ${plugin.id} depends on unknown plugin ${d}`);
      }
      if (this.loaded.has(d)) continue;
      const dep = this.defs.get(d)!;
      await this.ensureDepsLoaded(dep, seen);
      if (!this.loaded.has(d)) await this.setupOne(dep);
    }
  }

  /** 卸载该插件，以及所有（传递）硬依赖它的已加载插件，按加载反序 */
  async unmount(id: string): Promise<void> {
    const targets = this.dependentsOf(id);
    // 软依赖者不卸载（optional 语义是「缺失静默降级」），但要通知它服务已消失，
    // 让订阅 service:changed 的实现重解析，而不是一直捏着旧的 provider 引用。
    const soft = this.softDependentsOf(id, new Set(targets));
    for (const target of targets) {
      const entry = this.loaded.get(target);
      if (!entry) continue;
      this.teardown(entry, 'unloaded');
    }
    for (const pid of soft) {
      if (this.loaded.has(pid)) {
        this.ctx.events.emit('service:changed', {
          tokenId: `plugin.id:${id}`, owner: id, action: 'removed',
        });
      }
    }
  }

  /**
   * 统一的单插件拆除：
   *  v0.5：先由统一内核停用组件（连带依赖者按深度降序、LIFO 精确回滚该插件的资源栈），
   *        scope.dispose() 作为幂等兜底；第三方 dispose 抛错也保证状态清理与事件广播。
   */
  private teardown(entry: Loaded, phase: 'unloaded' | 'disabled'): void {
    const id = entry.plugin.id;
    this.graph.deactivate([id]);       // 内核驱动：可逆效应精确回滚
    entry.scope.dispose();              // 幂等兜底（EffectStack.undo 自带 undone 标志）
    try {
      entry.plugin.dispose?.();
    } catch (err) {
      this.ctx.log(`[PluginHost] dispose failed for ${id}:`, err);
    }
    this.loaded.delete(id);
    this.ctx.events.emit('plugin:unloaded', {
      id, version: entry.plugin.version, phase,
    });
    this.ctx.log(`plugin ${phase}: ${id}`);
  }

  /** 重载会连带卸载依赖者，必须按原顺序把它们一起装回来，不能只恢复自己 */
  async reload(id: string): Promise<void> {
    const plugin = this.defs.get(id);
    if (!plugin) throw new Error(`[PluginHost] unknown plugin: ${id}`);
    const affected = this.dependentsOf(id).filter((pid) => this.defs.has(pid));
    await this.unmount(id);
    for (const pid of [...affected].reverse()) {
      await this.setupOne(this.defs.get(pid)!, pid === id ? 'reloaded' : 'loaded');
    }
  }

  async enable(id: string): Promise<void> {
    const p = this.defs.get(id);
    if (!p) throw new Error(`[PluginHost] unknown plugin: ${id}`);
    if (!this.loaded.has(id)) await this.setupOne(p, 'enabled');
  }

  /** v0.6：与 enable 对称返回 Promise；函数体仍同步执行，调用方不 await 也安全 */
  async disable(id: string): Promise<void> {
    const entry = this.loaded.get(id);
    if (!entry) return;
    this.teardown(entry, 'disabled');
  }

  dispose(): void {
    for (const id of [...this.loadedIds()].reverse()) void this.disable(id);
    this.defs.clear();
  }

  private async setupOne(plugin: Plugin, phase: LoadPhase = 'loaded'): Promise<void> {
    // v0.5：scope 复用该插件在统一内核里的专属可逆效应栈
    const scope = new Scope(plugin.id, this.deps, this.graph.stackFor(plugin.id));
    const view: PluginContext = {
      ...this.ctx,
      scope,
      pluginId: plugin.id,
      cfg: scope.cfg,
    };
    // 先激活组件（reset 空栈 + claim 能力 + settle），此时 setup 尚未登记资源，
    // 之后 Kernel 不会因同伴抖动而 reset 掉已登记的资源逆（代表 provider 稳定）。
    this.graph.activate(plugin.id);
    try {
      await plugin.setup(view);
    } catch (err) {
      scope.dispose();                 // 部分初始化不能留下脏资源
      this.graph.deactivate([plugin.id]);
      throw new Error(`[PluginHost] setup failed for ${plugin.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.loaded.set(plugin.id, { plugin, scope, order: this.counter++ });
    this.ctx.events.emit('plugin:loaded', {
      id: plugin.id, version: plugin.version, phase,
    });
    this.ctx.log(`plugin ready: ${plugin.id}@${plugin.version} (${scope.resourceCount} scoped resources)`);
  }

  /** 硬依赖 + cap: 能力依赖解析 */
  private resolveDeps(plugin: Plugin): string[] {
    const out: string[] = [];
    for (const d of plugin.dependencies ?? []) {
      if (d.startsWith('cap:')) {
        const providers = this.providersOf(d.slice(4));
        if (providers.length === 0) {
          throw new Error(`[PluginHost] ${plugin.id} needs capability "${d}" but no plugin provides it`);
        }
        out.push(...providers);
      } else {
        out.push(d);
      }
    }
    // 可选依赖：存在就排到前面，不存在静默跳过
    for (const d of plugin.optionalDependencies ?? []) {
      if (d.startsWith('cap:')) out.push(...this.providersOf(d.slice(4)));
      else if (this.defs.has(d)) out.push(d);
    }
    return [...new Set(out)];
  }

  private providersOf(cap: string): string[] {
    return [...this.defs.entries()]
      .filter(([, p]) => (p.provides ?? []).includes(cap))
      .map(([id]) => id);
  }

  private resolveOrder(): Plugin[] {
    const done = new Set<string>();
    const visiting = new Set<string>();
    const out: Plugin[] = [];

    const visit = (id: string): void => {
      if (done.has(id)) return;
      if (visiting.has(id)) throw new Error(`[PluginHost] circular dependency at ${id}`);
      const p = this.defs.get(id);
      if (!p) throw new Error(`[PluginHost] missing dependency: ${id}`);
      visiting.add(id);
      const deps = this.resolveDeps(p)
        .filter((d) => this.defs.has(d))
        .sort((a, b) => (this.defs.get(a)!.priority ?? 0) - (this.defs.get(b)!.priority ?? 0));
      for (const dep of deps) visit(dep);
      visiting.delete(id);
      done.add(id);
      out.push(p);
    };

    const roots = [...this.defs.values()]
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.id.localeCompare(b.id));
    for (const p of roots) visit(p.id);
    return out;
  }

  /** 找出（传递）硬依赖本插件的已加载插件，按加载顺序倒序返回 */
  private dependentsOf(id: string): string[] {
    const set = new Set<string>([id]);
    const capsOf = (pid: string): Set<string> =>
      new Set(this.defs.get(pid)?.provides ?? []);

    const hardDeps = (p: Plugin): string[] =>
      (p.dependencies ?? []).flatMap((d) =>
        d.startsWith('cap:')
          ? [...this.defs.entries()]
              .filter(([, q]) => (q.provides ?? []).includes(d.slice(4)))
              .map(([qid]) => qid)
          : [d],
      );

    let changed = true;
    while (changed) {
      changed = false;
      const caps = new Set([...set].flatMap((pid) => [...capsOf(pid)]));
      for (const [other, entry] of this.loaded) {
        if (set.has(other)) continue;
        const deps = hardDeps(entry.plugin);
        const byCap = (entry.plugin.dependencies ?? []).some(
          (d) => d.startsWith('cap:') && caps.has(d.slice(4)),
        );
        if (deps.some((d) => set.has(d)) || byCap) { set.add(other); changed = true; }
      }
    }

    return [...set]
      .sort((a, b) => (this.loaded.get(b)?.order ?? -1) - (this.loaded.get(a)?.order ?? -1));
  }

  /** 只通过 optionalDependencies 关联、且不在硬级联集合里的已加载插件 */
  private softDependentsOf(id: string, hard: ReadonlySet<string>): string[] {
    const caps = new Set(this.defs.get(id)?.provides ?? []);
    const out: string[] = [];
    for (const [other, entry] of this.loaded) {
      if (hard.has(other)) continue;
      const soft = entry.plugin.optionalDependencies ?? [];
      const hit = soft.some((d) =>
        d.startsWith('cap:') ? caps.has(d.slice(4)) : d === id,
      );
      if (hit) out.push(other);
    }
    return out;
  }
}
